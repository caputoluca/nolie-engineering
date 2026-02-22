import { isPrismaUniqueError } from "@nolie/db";
import { workerTx } from "../../db/tx.js";
import { logger } from "../../logger.js";
import { reportError } from "../observability/sentry/report.js";
import type { BidsContext } from "./context.js";
import { pendingBidsCache } from "./pending-bids-cache.js";
import type { BidPersistJob } from "./types.js";

const OUTBID_NOTIFICATION_DELAY = 1000 * 5; // 5 seconds

export async function persist(job: BidPersistJob<"persist">, ctx: BidsContext) {
	const {
		bidId,
		auctionId,
		userId,
		amount,
		createdAt,
		priorityAt,
		isProxy,
		extendToEndAt,
		isExhaustion,
		previousHighestUserId,
	} = job.data;

	try {
		// Use transaction to atomically create bid and update auction endAt
		await workerTx(ctx.prisma, async (tx) => {
			await Promise.all([
				tx.bid.create({
					data: {
						id: bidId,
						isProxy,
						auctionId,
						userId,
						amount,
						createdAt,
						priorityAt,
					},
				}),
				// Update auction endAt if extension was triggered
				...(extendToEndAt
					? [
							tx.auction.update({
								where: { id: auctionId },
								data: { endAt: new Date(extendToEndAt) },
							}),
						]
					: []),
				...(isExhaustion
					? [
							tx.bidProxy.update({
								where: { auctionId_userId: { auctionId, userId } },
								data: { exhausted: true },
							}),
						]
					: []),
			]);
		});

		// Invalidate auctionView AFTER bid is in DB (no race condition)
		await ctx.cache.auctionView.invalidate(auctionId).catch((err) => {
			reportError(err, {
				operation: "invalidate_auction_view_cache",
				extra: { auctionId, bidId },
			});
			logger.warn(
				{ err, auctionId, bidId },
				"bids.persist: Failed to invalidate auctionView cache",
			);
		});
		await pendingBidsCache.decrement(auctionId);

		// Fire-and-forget: queue notifications
		void ctx.queues.notifications
			.bidPlaced({ auctionId, userId, amount, isProxy }, { jobId: bidId })
			.catch((err) => {
				reportError(err, {
					operation: "queue_bid_placed_notification",
					extra: { auctionId, bidId, userId, amount, isProxy },
				});
				logger.warn(
					{ err, auctionId, bidId, userId },
					"bids.persist: Failed to queue bid placed notification",
				);
			});
		if (isExhaustion) {
			// Exhaustion bid = proxy couldn't keep up, user lost
			// Notify the proxy owner (userId) that they've been outbid
			void ctx.queues.notifications
				.outbid(
					{ auctionId, userId, bidId },
					{ jobId: `${bidId}-${userId}`, delay: OUTBID_NOTIFICATION_DELAY },
				)
				.catch((err) => {
					reportError(err, {
						operation: "queue_outbid_notification_exhaustion",
						extra: { auctionId, bidId, userId },
					});
				});
		} else if (previousHighestUserId && previousHighestUserId !== userId) {
			// Fast path: skip notification if user has an active proxy (it will respond).
			// This catches ~99% of cases. The rare race where triggerProxies exhausts
			// the proxy from Redis before this check runs is caught by the DB guard
			// in the outbid notification job (which runs after OUTBID_NOTIFICATION_DELAY).
			const hasActiveProxy = await ctx.cache.auctionProxies
				.hasActive(auctionId, previousHighestUserId)
				.catch(() => false);

			if (!hasActiveProxy) {
				void ctx.queues.notifications
					.outbid(
						{ auctionId, userId: previousHighestUserId, bidId },
						{
							jobId: `${bidId}-${previousHighestUserId}`,
							delay: OUTBID_NOTIFICATION_DELAY,
						},
					)
					.catch((err) => {
						reportError(err, {
							operation: "queue_outbid_notification",
							extra: { auctionId, bidId, userId },
						});
					});
			}
		}
	} catch (error) {
		if (isPrismaUniqueError(error)) {
			// Idempotency: bid already exists = success, don't throw
			logger.info(
				{
					bidId,
					auctionId,
					userId,
					event: "bids_persist_bid_already_exists",
				},
				"bids.persist: Bid already exists (idempotent retry).",
			);

			// Still invalidate - previous attempt may have failed to invalidate
			await ctx.cache.auctionView.invalidate(auctionId).catch((err) => {
				reportError(err, {
					operation: "invalidate_auction_view_cache_duplicate",
					extra: { auctionId, bidId },
				});
				logger.warn(
					{ err, auctionId, bidId },
					"bids.persist: Failed to invalidate auctionView cache (duplicate)",
				);
			});
			return;
		}
		throw error;
	}
}
