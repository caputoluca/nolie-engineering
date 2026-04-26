import { shouldExtendAuction } from "@nolie/core/auctions";
import { JobIdUnique } from "@nolie/queues";
import { logger } from "../../logger.js";
import { createAssetURL } from "../auctions/utils.js";
import { reportError } from "../observability/sentry/report.js";
import type { BidsContext } from "./context.js";
import { drainBidsInbox } from "./drain-bids.js";
import { extendAuction } from "./extend-auction.js";
import { getCachedAuctionState } from "./get-cached-auction-state.js";
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
				allowEqualToCurrentBid,
			} = item;

			// Get auction state (from cache or DB fallback)
			const auctionState = await getCachedAuctionState(
				auctionId,
				ctx.cache.auctionState,
				ctx.prisma,
			);
			if (!auctionState) {
				return;
			}

			const result = await validateAndAcceptBid(
				auctionId,
				{
					amount,
					userId,
					isExhaustion: item.isExhaustion ?? false,
					allowEqualToCurrentBid: allowEqualToCurrentBid ?? false,
				},
				ctx.cache,
				ctx.redis,
			);

			if (!result.accepted) {
				logger.info({
					event: "bids_drain_bid_rejected",
					bidAmount: amount,
					...result,
				});
				void ctx
					.realtime()
					.bid.result.publish({
						userId,
						success: false,
						requestId,
						auctionId,
						reason: result.reason,
						currentHighestBidAmount: result.currentHighest || undefined,
					})
					.catch((error) => {
						reportError(error, {
							operation: "publish_bid_result_rejected",
							extra: { auctionId, userId, requestId, reason: result.reason },
						});
						logger.error(
							{
								error,
								auctionId,
								userId,
								requestId,
								event: "bids_drain_publish_bid_result_failed",
							},
							"Failed to publish bid result",
						);
					});
				return;
			}

			// Log accepted bid for load test analytics
			logger.info({
				event: "bids_drain_bid_accepted",
				auctionId,
				userId,
				amount: result.newAmount,
				previousHighest: result.previousHighest,
				requestId,
			});

			// Use requestId as bidId for idempotency
			const bidId = requestId;
			const createdAt = new Date().toISOString();

			// Check if auction should extend (anti-sniping)
			let extendToEndAt: string | null = null;
			if (!isExhaustion) {
				const { shouldExtend, newEndAt } = shouldExtendAuction({
					status: auctionState.status,
					endAt: auctionState.endAt,
				});
				if (shouldExtend) {
					extendToEndAt = newEndAt.toISOString();

					// Immediate effects: reschedule close job, update Redis, publish event
					extendAuction(
						ctx.realtime(),
						ctx.queues.auction,
						ctx.cache.auctionState,
						ctx.cache.listingView,
						{ auctionId, newEndAt: extendToEndAt },
					).catch((err) => {
						reportError(err, {
							operation: "extend_auction",
							extra: { auctionId, newEndAt: extendToEndAt },
						});
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
					previousHighestUserId: result.previousHighestUserId,
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
						reportError(err, {
							operation: "exhaust_proxy_cache",
							extra: { auctionId, userId, bidId, isExhaustion },
						});
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
						reportError(err, {
							operation: "update_auction_state_cache",
							extra: { auctionId, userId, bidId, newAmount: result.newAmount },
						});
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
					reportError(err, {
						operation: "publish_auction_bids",
						extra: { auctionId, userId, bidId, amount: result.newAmount },
					});
					logger.error({
						err,
						event: "bids_drain_publish_auction_bids_failed",
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
					reportError(err, {
						operation: "publish_bid_result_accepted",
						extra: { auctionId, userId, bidId, requestId },
					});
					logger.error(
						{
							err,
							event: "bids_drain_publish_bid_result_failed",
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
						reportError(err, {
							operation: "queue_trigger_proxies",
							extra: { auctionId, userId, newAmount: result.newAmount },
						});
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
