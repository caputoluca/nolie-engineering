import { shouldExtendAuction } from "@nolie/core/auctions";
import type { DbClient, PrismaClient } from "@nolie/db";
import { isPrismaTransactionAPIError } from "@nolie/db";
import { errors, HttpError } from "@nolie/errors/http";
import type { QueueOf } from "@nolie/queues";
import type { RestClient } from "@nolie/realtime/server";
import type { BidCreate } from "@nolie/schemas/auction/bid";
import { logger } from "../../../logger.js";
import { apiTx } from "../../db/tx.js";
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

interface PlaceBidInTransactionParams {
	auctionId: string;
	userId: string;
	amount: number;
	isProxy: boolean;
	priorityAt?: Date;
}

export async function placeBidInTransaction(
	tx: DbClient,
	params: PlaceBidInTransactionParams,
) {
	let extendedEvent: { auctionId: string; newEndAt: string } | null = null;
	const { auctionId, userId, amount, isProxy, priorityAt } = params;
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
	// createdAt = actual bid placement time (always)
	// priorityAt = proxy creation time for proxy bids (for tie-breaking), same as createdAt for manual bids
	return {
		bid: await tx.bid.create({
			data: {
				auctionId,
				userId,
				amount,
				isProxy,
				...(priorityAt ? { priorityAt } : {}),
			},
			select: bidSelect,
		}),
		extendedEvent,
	};
}

export async function afterBidCreate(
	db: PrismaClient,
	realtime: RestClient,
	q: QueueOf<"auction">,
	{
		auctionId,
		userId,
		shouldExcludeUserId,
		extendedEvent,
		bid,
	}: {
		auctionId: string;
		userId: string;
		shouldExcludeUserId: boolean;
		extendedEvent: { auctionId: string; newEndAt: string } | null;
		bid: BidRecord;
	},
) {
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
}

interface PlaceBidCoreParams extends PlaceBidInTransactionParams {
	shouldExcludeUserId: boolean;
}

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
	params: PlaceBidCoreParams,
): Promise<BidRecord> {
	try {
		const { bid, extendedEvent } = await apiTx(db, async (tx) =>
			placeBidInTransaction(tx, params),
		);
		await afterBidCreate(db, realtime, q, {
			auctionId: params.auctionId,
			userId: params.userId,
			shouldExcludeUserId: params.shouldExcludeUserId ?? true,
			extendedEvent,
			bid,
		});

		return bid;
	} catch (error) {
		if (isPrismaTransactionAPIError(error)) {
			logger.info(
				{
					auctionId: params.auctionId,
					userId: params.userId,
				},
				"Unable to place bid due to transaction conflict.",
			);
			throw new HttpError(
				"Currently processing another bid. Please try again later.",
				"CURRENTLY_PROCESSING_BID",
				{
					statusCode: 409,
				},
			);
		}
		throw error;
	}
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
