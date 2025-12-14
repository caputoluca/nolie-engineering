import {
	auctionRequiresShipping,
	shouldExtendAuction,
	validateBid,
} from "@nolie/core/auctions";
import type { PrismaClient } from "@nolie/db";
import { errors } from "@nolie/errors/http";
import type { QueueOf } from "@nolie/queues";
import type { RestClient } from "@nolie/realtime/server";
import type { BidCreate } from "@nolie/schemas/auction/bid";
import { logger } from "../../../logger.js";
import { bidSelect } from "../select.js";
import { toBidEvent } from "../transform.js";
import { getAuctionForBid } from "./utils.js";
import { validateUser } from "./validate.js";

async function extendAuction(
	db: PrismaClient,
	realtime: RestClient,
	q: QueueOf<"auction">,
	extendedEvent: { auctionId: string },
) {
	const { auctionId } = extendedEvent;
	// Re-read endAt from DB to get committed value (handles race conditions)
	const auction = await db.auction.findUnique({
		where: { id: auctionId },
		select: { endAt: true },
	});

	if (!auction) {
		logger.error(
			{ auctionId },
			"Auction not found after transaction (unexpected)",
		);
		return;
	} else {
		const newEndAt = auction.endAt;
		// Use Promise.allSettled so both operations complete independently
		const [realtimeResult, rescheduleResult] = await Promise.allSettled([
			realtime.auction.extensions.publish({
				auctionId,
				newEndAt: newEndAt.toISOString(),
			}),
			q.extend({ auctionId, newEndAt }, logger),
		]);

		// Log any failures but don't throw (bid already succeeded)
		if (realtimeResult.status === "rejected") {
			logger.error(
				{ auctionId, error: realtimeResult.reason },
				"Failed to publish extension event (non-blocking)",
			);
		}

		if (rescheduleResult.status === "rejected") {
			logger.error(
				{ auctionId, error: rescheduleResult.reason },
				"Failed to reschedule close job (non-blocking)",
			);
		}
	}
}

export async function placeBid(
	db: PrismaClient,
	data: BidCreate,
	realtime: RestClient,
	q: QueueOf<"auction">,
	{ userId, auctionId }: { userId: string; auctionId: string },
) {
	let extendedEvent: { auctionId: string; newEndAt: string } | null = null;

	const result = await db.$transaction(async (tx) => {
		const [auction, user] = await Promise.all([
			getAuctionForBid(tx, auctionId),
			tx.user.findUnique({
				where: { id: userId },
				select: {
					billing: { select: { id: true, defaultPaymentMethodId: true } },
					defaultShippingAddressId: true,
				},
			}),
		]);

		if (!auction) {
			throw errors.notFound("Auction not found", {
				code: "AUCTION_NOT_FOUND",
			});
		}

		validateUser(user, { requiresShipping: auctionRequiresShipping(auction) });

		// 1. Validate bid
		const validation = validateBid(
			{
				...auction,
				creatorUserId: auction.creator.userId,
				startingBid: auction.startingBid.toNumber(),
				endAt: auction.endAt,
			},
			{
				amount: data.amount,
				currentHighest: auction.currentHighestBid,
				userId,
			},
		);
		if (!validation.valid) {
			throw errors.badRequest(validation.message, { code: validation.code });
		}

		// 2. Soft-close extension
		const { shouldExtend, extendSeconds } = shouldExtendAuction(auction);

		if (shouldExtend) {
			const endTime = new Date(auction.endAt).getTime();
			const newEndAt = new Date(endTime + extendSeconds * 1000);

			await tx.auction.update({
				where: { id: auction.id },
				data: { endAt: newEndAt },
			});

			// store event to emit after transaction
			extendedEvent = {
				auctionId: auction.id,
				newEndAt: new Date(newEndAt).toISOString(),
			};
		}

		// 3. Create bid
		return await tx.bid.create({
			data: {
				...data,
				auctionId,
				userId,
			},
			select: bidSelect,
		});
	});

	// --- AFTER TRANSACTION ---

	// 4A. If extended, publish extend event
	if (extendedEvent) {
		await extendAuction(db, realtime, q, extendedEvent);
	}

	// 4B. Always publish bid event
	await realtime.auction.bids.publish(toBidEvent(result));

	return result;
}
