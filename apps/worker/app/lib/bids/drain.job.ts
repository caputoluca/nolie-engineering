import { shouldExtendAuction } from "@nolie/core/auctions";
import { JobIdUnique } from "@nolie/queues";
import { isRedisConnectionError } from "@nolie/redis/utils";
import { logger } from "../../logger.js";
import { createAssetURL } from "../auctions/utils.js";
import type { BidsContext } from "./context.js";
import { drainBidsInbox } from "./drain-bids.js";
import { extendAuction } from "./extend-auction.js";
import type { BidJob } from "./types.js";
import { validateAndAcceptBid } from "./validate-and-accept-bid.js";
import { withBidIdempotency } from "./with-bid-idempotency.js";

export function drain(job: BidJob<"drain">, ctx: BidsContext) {
	return drainBidsInbox(
		withBidIdempotency(async (item) => {
			const {
				auctionId,
				userId,
				amount,
				requestId,
				user,
				isExhaustion,
				isProxy,
			} = item;

			// Get auction state (from cache or DB fallback)
			let auctionState: Awaited<ReturnType<typeof ctx.cache.auctionState.get>>;
			try {
				auctionState = await ctx.cache.auctionState.get(auctionId, {
					load: async () => {
						const res = await ctx.prisma.auction.findUnique({
							where: { id: auctionId },
							select: {
								id: true,
								endAt: true,
								status: true,
								startingBid: true,
								itemType: true,
								creator: { select: { userId: true } },
								bids: {
									orderBy: [{ amount: "desc" }, { priorityAt: "asc" }],
									take: 1,
									select: { amount: true, userId: true },
								},
							},
						});
						if (!res) {
							throw Error("Auction not found");
						}
						const highestBid = res.bids[0];
						return {
							itemType: res.itemType,
							status: res.status,
							auctionId: res.id,
							version: 1,
							endAt: res?.endAt?.toISOString(),
							currentHighestBidAmount: highestBid?.amount?.toNumber() ?? null,
							highestBidUserId: highestBid?.userId ?? null,
							startingBidAmount: res.startingBid.toNumber(),
							creatorUserId: res.creator.userId,
						};
					},
				});
				if (!auctionState) {
					throw Error("Auction not found");
				}
			} catch (error) {
				if (isRedisConnectionError(error)) {
					logger.error(
						{
							auctionId,
							userId,
							amount,
							requestId,
							error,
							event: "bids_drain_redis_error",
						},
						"bids.drain: Redis connection error, failing job for retry",
					);
					throw error;
				}
				logger.error(
					{
						auctionId,
						userId,
						amount,
						requestId,
						event: "bids_drain_cache_not_found",
					},
					"bids.drain: Cached state not found, assuming auction does not exist and skipping.",
				);
				return;
			}

			const result = await validateAndAcceptBid(
				auctionId,
				{
					amount,
					userId,
					isExhaustion: item.isExhaustion ?? false,
				},
				ctx.cache,
				ctx.redis,
			);

			if (!result.accepted) {
				logger.info({
					event: "bids_drain_bid_rejected",
					...result,
				});
				await ctx.realtime().bid.result.publish({
					userId,
					success: false,
					requestId,
					auctionId,
					reason: result.reason,
				});
				return;
			}

			// Use requestId as bidId for idempotency
			const bidId = requestId;
			const createdAt = new Date().toISOString();

			// Check if auction should extend (anti-sniping)
			let extendToEndAt: string | null = null;
			if (!isExhaustion) {
				const { shouldExtend, extendSeconds } = shouldExtendAuction({
					status: auctionState.status,
					endAt: auctionState.endAt,
				});
				if (shouldExtend) {
					const endTime = new Date(auctionState.endAt).getTime();
					extendToEndAt = new Date(
						endTime + extendSeconds * 1000,
					).toISOString();

					// Immediate effects: reschedule close job, update Redis, publish event
					extendAuction(
						ctx.realtime(),
						ctx.queues.auction,
						ctx.cache.auctionState,
						ctx.cache.auctionView,
						{ auctionId, newEndAt: extendToEndAt },
					).catch((err) => {
						logger.error({ err, auctionId }, "Failed to extend auction");
					});
				}
			}

			const bidPriorityAt = item.proxyPriorityAt ?? createdAt;

			// Await persisting - required for correctness
			await ctx.queues.bids.persist(
				{
					bidId,
					auctionId,
					userId,
					amount,
					createdAt,
					priorityAt: bidPriorityAt,
					isProxy: !!isProxy,
					extendToEndAt, // DB update happens in persist job
					isExhaustion,
				},
				{ jobId: JobIdUnique, removeOnComplete: true },
			);

			// Fire and forget: cache updates and realtime publishes
			if (
				isExhaustion ||
				(isProxy && amount >= (item.proxyMaxAmount ?? Infinity))
			) {
				void ctx.cache.auctionProxies
					.exhaust(auctionId, userId)
					.catch((err) => {
						logger.error({
							err,
							event: "bids_drain_exhaust_proxy_failed",
							bidId,
							auctionId,
							userId,
						});
					});
			}

			if (!isExhaustion) {
				void ctx.cache.auctionState
					.updateFields(auctionId, {
						currentHighestBidAmount: result.newAmount,
						highestBidUserId: userId,
					})
					.catch((err) => {
						logger.error({
							err,
							event: "bids_drain_update_state_failed",
							bidId,
							auctionId,
							userId,
						});
					});
			}

			// NOTE: We intentionally DON'T invalidate auctionView here.
			// The bid isn't persisted to DB yet, so invalidating would cause
			// a race condition where the cache gets repopulated from DB
			// before the bid is written, resulting in stale data.
			// For live auctions, clients use WebSocket for real-time updates.
			// auctionView staleness (up to TTL) is acceptable for initial page loads.

			// User profile comes from inbox (cached at API layer)
			const bidEvent = {
				id: bidId,
				amount: result.newAmount,
				isProxy: !!isProxy,
				createdAt,
				priorityAt: bidPriorityAt,
				user: {
					id: userId,
					image: user.image ? createAssetURL(user.image) : null,
					firstName: user.firstName ?? "",
					lastName: user.lastName ?? "",
					handle: user.handle,
				},
				auctionId,
			};

			void ctx
				.realtime()
				.auction.bids.publish(bidEvent)
				.catch((err) => {
					logger.error({
						err,
						event: "bids_drain_publish_event_failed",
						bidId,
						auctionId,
						userId,
					});
				});
			void ctx
				.realtime()
				.bid.result.publish({
					userId,
					success: true,
					requestId,
					auctionId,
					bid: bidEvent,
				})
				.catch((err) => {
					logger.error(
						{
							err,
							event: "bids_drain_publish_result_failed",
							bidId,
							auctionId,
							userId,
						},
						"bids.drain: Failed to publish bid result.",
					);
				});

			// Trigger proxy responses for manual bids only
			if (!isProxy && !isExhaustion) {
				ctx.queues.bids
					.triggerProxies(
						{
							auctionId,
							currentHighestBidAmount: result.newAmount,
							currentHighestBidUserId: userId,
							startingBidAmount: auctionState.startingBidAmount,
						},
						{ removeOnComplete: true },
					)
					.catch((err) => {
						logger.error(
							{ err, auctionId, event: "bids_drain_trigger_proxies_failed" },
							"Failed to trigger proxy responses",
						);
					});
			}
		}),
		ctx.inbox,
		logger,
	)(job);
}
