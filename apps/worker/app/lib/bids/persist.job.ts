import { isPrismaUniqueError } from "@nolie/db";
import { workerTx } from "../../db/tx.js";
import { logger } from "../../logger.js";
import type { BidsContext } from "./context.js";
import { pendingBidsCache } from "./pending-bids-cache.js";
import type { BidJob } from "./types.js";

export async function persist(job: BidJob<"persist">, ctx: BidsContext) {
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
			logger.warn(
				{ err, auctionId, bidId },
				"bids.persist: Failed to invalidate auctionView cache",
			);
		});
		await pendingBidsCache.decrement(auctionId);
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
