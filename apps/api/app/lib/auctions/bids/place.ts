import { shouldExtendAuction } from "@nolie/core/auctions";
import type { PrismaClient } from "@nolie/db";
import { errors } from "@nolie/errors/http";
import type { QueueOf } from "@nolie/queues";
import type { RestClient } from "@nolie/realtime/server";
import type { BidCreate } from "@nolie/schemas/auction/bid";
import { logger } from "../../../logger.js";
import { bidSelect } from "../select.js";
import type { BidRecord } from "../transform.js";
import { toBidEvent } from "../transform.js";
import {
	extendAuction,
	getAuctionForBid,
	getUserForBid,
	triggerProxyProcessing,
} from "./utils.js";
import { validateBidOrThrow, validateUserCanBidOrThrow } from "./validate.js";

/**
 * Core function that places a bid (manual or proxy) with all common logic.
 *
 * This function handles the complete bid placement flow:
 * 1. Re-reads auction state within a transaction (handles race conditions)
 * 2. Validates auction is active and user can bid
 * 3. Validates bid amount meets requirements
 * 4. Handles auction extension if bid is placed near end time
 * 5. Creates the bid record with `isProxy` flag
 * 6. Publishes realtime events and triggers proxy processing
 *
 * **Proxy Processing Trigger**: After a successful bid, this function asynchronously
 * triggers `processProxies` with `excludeUserId` set to the bidder. This ensures:
 * - Other proxies can compete immediately
 * - The bidder's own proxy won't reprocess (preventing loops)
 * - Proxy processing happens in the background without blocking the API response
 *
 * @param db - Database client
 * @param realtime - Realtime client for publishing events
 * @param q - Queue client for auction operations
 * @param params - Parameters including auctionId, userId, amount, and isProxy flag
 * @returns The created bid record
 * @throws {BadRequestError} If auction is not active or bid is invalid
 */
export async function placeBidCore(
	db: PrismaClient,
	realtime: RestClient,
	q: QueueOf<"auction">,
	{
		auctionId,
		userId,
		amount,
		isProxy,
		shouldExcludeUserId = true,
		priorityAt,
	}: {
		auctionId: string;
		userId: string;
		amount: number;
		isProxy: boolean;
		shouldExcludeUserId?: boolean;
		priorityAt?: Date;
	},
): Promise<BidRecord> {
	let extendedEvent: { auctionId: string; newEndAt: string } | null = null;

	const bid = await db.$transaction(async (tx) => {
		// Re-read auction state (handles race conditions)
		const [auction, user] = await Promise.all([
			getAuctionForBid(tx, auctionId),
			getUserForBid(tx, userId),
		]);

		// Validate auction is still active (for proxy bids, manual bids validated elsewhere)
		if (isProxy && auction.status !== "active") {
			throw errors.badRequest("Auction is not active", {
				code: "AUCTION_NOT_ACTIVE",
			});
		}

		// Validate user can still bid
		validateUserCanBidOrThrow(user, { itemType: auction.itemType });

		// Validate bid amount (reuse existing validation)
		validateBidOrThrow({
			auction,
			userId,
			amount,
		});

		// Handle auction extension (reuse existing logic)
		const { shouldExtend, extendSeconds } = shouldExtendAuction(auction);
		if (shouldExtend) {
			const endTime = new Date(auction.endAt).getTime();
			const newEndAt = new Date(endTime + extendSeconds * 1000);

			await tx.auction.update({
				where: { id: auction.id },
				data: { endAt: newEndAt },
			});

			extendedEvent = {
				auctionId: auction.id,
				newEndAt: new Date(newEndAt).toISOString(),
			};
		}

		// Create bid record with isProxy flag
		// Note: For proxy bids, we use priorityAt (when proxy was created) as createdAt
		// for tie-breaking correctness. This ensures consistent tie-breaking logic
		// whether the bid is placed synchronously (API) or asynchronously (worker).
		return await tx.bid.create({
			data: {
				auctionId,
				userId,
				amount,
				isProxy,
				...(priorityAt ? { createdAt: priorityAt } : {}),
			},
			select: bidSelect,
		});
	});

	// Handle auction extension event (after transaction)
	if (extendedEvent) {
		await extendAuction(db, realtime, q, extendedEvent);
	}

	const [realtimeResult, processProxiesResult] = await Promise.allSettled([
		realtime.auction.bids.publish(toBidEvent(bid)),
		triggerProxyProcessing(q, {
			// Always exclude the userId who just bid to prevent reprocessing their proxy in the same cycle
			// unless their bid comes from proxy creation,
			// since their proxy will have to be processed immediately in the worker if they are losing
			auctionId,
			excludeUserId: shouldExcludeUserId ? userId : undefined,
		}),
	]);

	if (realtimeResult.status === "rejected") {
		logger.error(
			{ auctionId, userId, error: realtimeResult.reason },
			"Failed to publish bid event (non-blocking)",
		);
	}

	if (processProxiesResult.status === "rejected") {
		logger.error(
			{ auctionId, userId, error: processProxiesResult.reason },
			"Failed to process proxies (non-blocking)",
		);
	}

	return bid;
}

export async function placeBid(
	db: PrismaClient,
	data: BidCreate,
	realtime: RestClient,
	q: QueueOf<"auction">,
	{ userId, auctionId }: { userId: string; auctionId: string },
) {
	return placeBidCore(db, realtime, q, {
		auctionId,
		userId,
		amount: data.amount,
		isProxy: false,
		shouldExcludeUserId: true,
	});
}
