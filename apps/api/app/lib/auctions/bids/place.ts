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
// INSTRUMENTATION START
import {
	decrementActiveTransactions,
	elapsedMs,
	incrementActiveTransactions,
	startTimer,
} from "./instrumentation.js";
import {
	extendAuction,
	getAuctionForBid,
	getUserForBid,
	triggerProxyProcessing,
} from "./utils.js";
import { validateBidOrThrow, validateUserCanBidOrThrow } from "./validate.js";

// INSTRUMENTATION END

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

		logger.info(
			{
				auctionId: auction.id,
				extendSeconds,
				newEndAt,
				originalEndAt: auction.endAt,
			},
			"extending auction",
		);
		// Use optimistic locking: only update if endAt hasn't changed since we read it
		// This prevents multiple concurrent transactions from extending multiple times
		const updated = await tx.auction.updateMany({
			where: {
				id: auction.id,
				endAt: auction.endAt,
			},
			data: { endAt: newEndAt },
		});

		// Only create extendedEvent if we actually updated the row
		// If updated.count === 0, another transaction already extended it, so we don't need to publish
		// This prevents duplicate realtime events from being published
		if (updated.count > 0) {
			logger.info(
				{
					auctionId: auction.id,
					newEndAt,
				},
				"extended auction",
			);
			extendedEvent = {
				auctionId: auction.id,
				newEndAt: new Date(newEndAt).toISOString(),
			};
		}
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
): Promise<
	// INSTRUMENTATION START
	{ realtimeMs: number; queueMs: number; postDbMs: number } | undefined
	// INSTRUMENTATION END
> {
	// INSTRUMENTATION START
	const postDbStart = startTimer();
	// INSTRUMENTATION END

	// Handle auction extension event (after transaction)
	if (extendedEvent) {
		await extendAuction(db, realtime, q, extendedEvent);
	}

	// INSTRUMENTATION START
	const realtimeStart = startTimer();
	// INSTRUMENTATION END

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

	// INSTRUMENTATION START
	const realtimeMs = elapsedMs(realtimeStart);
	const queueMs = realtimeMs; // Queue runs in parallel, approximate timing
	const postDbMs = elapsedMs(postDbStart);
	// INSTRUMENTATION END

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

	// INSTRUMENTATION START
	if (process.env.NODE_ENV === "test") {
		return { realtimeMs, queueMs, postDbMs };
	}
	// INSTRUMENTATION END
}

interface PlaceBidCoreParams extends PlaceBidInTransactionParams {
	shouldExcludeUserId: boolean;
}

// INSTRUMENTATION START
export interface BidTimingContext {
	preDbMs: number;
	txMs: number;
	postDbMs: number;
	postDbRealtimeMs?: number;
	postDbQueueMs?: number;
}
// INSTRUMENTATION END

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
	timingContext?: BidTimingContext,
): Promise<BidRecord> {
	// INSTRUMENTATION START
	const preDbStart = startTimer();
	let txStart = 0n; // Initialize outside try block
	let preDbMs = 0; // Store preDbMs for use in catch block
	// INSTRUMENTATION END

	try {
		// INSTRUMENTATION START
		// Calculate preDbMs BEFORE starting transaction timer
		preDbMs = elapsedMs(preDbStart);
		txStart = startTimer();
		incrementActiveTransactions();
		// INSTRUMENTATION END

		const { bid, extendedEvent } = await apiTx(db, async (tx) =>
			placeBidInTransaction(tx, params),
		);

		// INSTRUMENTATION START
		const txMs = elapsedMs(txStart);
		decrementActiveTransactions();
		// INSTRUMENTATION END

		const postDbTiming = await afterBidCreate(db, realtime, q, {
			auctionId: params.auctionId,
			userId: params.userId,
			shouldExcludeUserId: params.shouldExcludeUserId ?? true,
			extendedEvent,
			bid,
		});

		// INSTRUMENTATION START
		if (timingContext && postDbTiming) {
			timingContext.preDbMs = preDbMs;
			timingContext.txMs = txMs;
			timingContext.postDbMs = postDbTiming.postDbMs;
			timingContext.postDbRealtimeMs = postDbTiming.realtimeMs;
			timingContext.postDbQueueMs = postDbTiming.queueMs;
		} else if (timingContext) {
			timingContext.preDbMs = preDbMs;
			timingContext.txMs = txMs;
			timingContext.postDbMs = 0;
		}
		// INSTRUMENTATION END

		return bid;
	} catch (error) {
		// INSTRUMENTATION START
		decrementActiveTransactions();
		// Calculate timing even on error
		// If transaction never started, calculate preDbMs from start to now
		// Otherwise, preDbMs was already calculated before transaction started
		if (txStart === 0n) {
			preDbMs = elapsedMs(preDbStart);
		}
		const txMs = txStart !== 0n ? elapsedMs(txStart) : 0;

		// Update timingContext if provided, even on error
		if (timingContext) {
			timingContext.preDbMs = preDbMs;
			timingContext.txMs = txMs;
			timingContext.postDbMs = 0; // No post-DB work on error
		}
		// INSTRUMENTATION END

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
	// INSTRUMENTATION START
	timingContext?: BidTimingContext,
	// INSTRUMENTATION END
) {
	return placeBidCore(
		db,
		realtime,
		q,
		{
			auctionId,
			userId,
			amount: data.amount,
			isProxy: false,
			shouldExcludeUserId: true,
		},
		// INSTRUMENTATION START
		timingContext,
		// INSTRUMENTATION END
	);
}
