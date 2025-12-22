import type { AuctionState, CacheOf } from "@nolie/cache";
import { shouldExtendAuction } from "@nolie/core/auctions";
import type { DbClient, PrismaClient } from "@nolie/db";
import { isPrismaTransactionAPIError } from "@nolie/db";
import { errors, HttpError } from "@nolie/errors/http";
import type { InboxOf } from "@nolie/inbox";
import type { QueueOf } from "@nolie/queues";
import type { RestClient } from "@nolie/realtime/server";
import type { BidCreate } from "@nolie/schemas/auction/bid";
import type { AuctionItemTypeType } from "@nolie/schemas/auction/type";
import { v7 as uuidv7 } from "uuid";
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
	getUserForBidWithProfile,
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
	cache: CacheOf<"auctionState"> | undefined,
	{
		auctionId,
		userId,
		shouldExcludeUserId,
		extendedEvent,
		bid,
		cachedState,
	}: {
		auctionId: string;
		userId: string;
		shouldExcludeUserId: boolean;
		extendedEvent: { auctionId: string; newEndAt: string } | null;
		bid: BidRecord;
		cachedState?: Omit<AuctionState, "auctionId" | "currentHighestBidAmount">;
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

	const [realtimeResult, processProxiesResult, cacheUpdateResult] =
		await Promise.allSettled([
			realtime.auction.bids.publish(toBidEvent(bid)),
			triggerProxyProcessing(q, {
				// Always exclude the userId who just bid to prevent reprocessing their proxy in the same cycle
				// unless their bid comes from proxy creation,
				// since their proxy will have to be processed immediately in the worker if they are losing
				auctionId,
				excludeUserId: shouldExcludeUserId ? userId : undefined,
			}),
			// Update cache after successful bid (non-blocking)
			cache && cachedState
				? cache.update(auctionId, {
						auctionId,
						currentHighestBidAmount: bid.amount.toNumber(),
						highestBidUserId: userId,
						version: cachedState.version + 1,
						startingBidAmount: cachedState.startingBidAmount,
						creatorUserId: cachedState.creatorUserId,
						itemType: cachedState.itemType,
						status: cachedState.status,
						endAt: extendedEvent?.newEndAt ?? cachedState.endAt,
					})
				: Promise.resolve(),
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

	if (cacheUpdateResult.status === "rejected") {
		logger.error(
			{ auctionId, userId, error: cacheUpdateResult.reason },
			"Failed to update cache (non-blocking), invalidating to prevent stale data",
		);
		// Invalidate cache on update failure to prevent serving stale data
		// Next request will load fresh data from DB
		if (cache) {
			await cache.invalidate(auctionId).catch((error) => {
				logger.error(
					{ auctionId, userId, error },
					"Failed to invalidate cache after update failure (non-blocking)",
				);
			});
		}
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
	cache?: CacheOf<"auctionState">,
	cachedState?: Omit<AuctionState, "auctionId" | "currentHighestBidAmount">,
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

		const postDbTiming = await afterBidCreate(db, realtime, q, cache, {
			auctionId: params.auctionId,
			userId: params.userId,
			shouldExcludeUserId: params.shouldExcludeUserId ?? true,
			extendedEvent,
			bid,
			cachedState,
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

async function validateBidFromCache(
	cache: CacheOf<"auctionState">,
	db: PrismaClient,
	{
		auctionId,
		userId,
		amount,
	}: {
		auctionId: string;
		userId: string;
		amount: number;
	},
) {
	const auction = await cache.get(auctionId, {
		load: async () => {
			const auction = await getAuctionForBid(db, auctionId);
			return {
				auctionId: auction.id,
				currentHighestBidAmount: auction.currentHighestBid,
				highestBidUserId: auction.currentHighestBidUserId,
				version: 1,
				startingBidAmount: auction.startingBid.toNumber(),
				creatorUserId: auction.creator.userId,
				itemType: auction.itemType,
				status: auction.status,
				endAt: auction.endAt,
			};
		},
	});

	if (!auction) {
		throw errors.notFound("Auction not found", {
			code: "AUCTION_NOT_FOUND",
		});
	}

	validateBidOrThrow({
		auction: {
			endAt: auction.endAt,
			status: auction.status,
			creator: { userId: auction.creatorUserId },
			startingBid: auction.startingBidAmount,
			currentHighestBid: auction.currentHighestBidAmount,
		},
		userId,
		amount,
	});

	return auction;
}

async function validateUserFromCache(
	eligibilityCache: CacheOf<"userEligibility">,
	profileCache: CacheOf<"userProfile">,
	db: PrismaClient,
	{
		userId,
		itemType,
	}: {
		userId: string;
		itemType: AuctionItemTypeType;
	},
) {
	// Try to get both from cache first
	let [eligibility, profile] = await Promise.all([
		eligibilityCache.get(userId),
		profileCache.get(userId),
	]);

	// If either is missing, fetch from DB and populate both caches
	if (!eligibility || !profile) {
		const user = await getUserForBidWithProfile(db, userId);

		eligibility = {
			userId,
			hasPaymentMethod: !!user.billing?.defaultPaymentMethodId,
			hasShippingAddress: !!user.defaultShippingAddressId,
		};

		profile = {
			userId,
			firstName: user.firstName,
			lastName: user.lastName,
			handle: user.handle,
			image: user.image,
		};

		// Populate both caches (fire-and-forget, don't block validation)
		Promise.all([
			eligibilityCache.update(userId, eligibility),
			profileCache.update(userId, profile),
		]).catch((err) => {
			logger.warn({ err, userId }, "Failed to cache user eligibility/profile");
		});
	}

	// Validate eligibility
	if (!eligibility.hasPaymentMethod) {
		throw errors.badRequest("Payment method required to place bids", {
			code: "REQUIRES_PAYMENT_METHOD",
		});
	}

	if (itemType === "physical" && !eligibility.hasShippingAddress) {
		throw errors.badRequest("Shipping address required for physical items", {
			code: "REQUIRES_SHIPPING_ADDRESS",
		});
	}

	return { eligibility, profile };
}

export async function __placeBid(
	db: PrismaClient,
	data: BidCreate,
	realtime: RestClient,
	q: QueueOf<"auction">,
	cache: CacheOf<"auctionState">,
	{ userId, auctionId }: { userId: string; auctionId: string },
	// INSTRUMENTATION START
	timingContext?: BidTimingContext,
	// INSTRUMENTATION END
): Promise<BidRecord> {
	// INSTRUMENTATION START
	const preDbStart = startTimer();
	let cached: Awaited<ReturnType<typeof validateBidFromCache>>;
	try {
		// Fast path: validate using cache (fail fast for invalid bids)
		cached = await validateBidFromCache(cache, db, {
			auctionId,
			userId,
			amount: data.amount,
		});
	} finally {
		// Always capture preDbMs timing, even if validation throws
		if (timingContext) {
			timingContext.preDbMs = elapsedMs(preDbStart);
		}
	}
	// INSTRUMENTATION END

	// Place bid (re-validates inside transaction using DB)
	// placeBidCore handles realtime events, proxy processing, and cache updates
	const bid = await placeBidCore(
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
		cache,
		{
			version: cached.version,
			startingBidAmount: cached.startingBidAmount,
			endAt: cached.endAt,
			creatorUserId: cached.creatorUserId,
			itemType: cached.itemType,
			status: cached.status,
			highestBidUserId: cached.highestBidUserId,
		},
	);

	return bid;
}

export async function placeBid(
	q: QueueOf<"bids">,
	stateCache: CacheOf<"auctionState">,
	userEligibilityCache: CacheOf<"userEligibility">,
	userProfileCache: CacheOf<"userProfile">,
	db: PrismaClient,
	inbox: InboxOf<"bids">,
	data: { userId: string; auctionId: string; amount: number },
) {
	// Validate auction first to get itemType for user eligibility check
	const auction = await validateBidFromCache(stateCache, db, data);

	// Validate user eligibility and get profile (single DB query if cache miss)
	const { profile } = await validateUserFromCache(
		userEligibilityCache,
		userProfileCache,
		db,
		{
			userId: data.userId,
			itemType: auction.itemType,
		},
	);

	const requestId = uuidv7();
	await inbox.pushAndMarkDirty(data.auctionId, {
		userId: data.userId,
		auctionId: data.auctionId,
		amount: data.amount,
		requestId,
		// Include profile for realtime publish in worker
		user: {
			firstName: profile.firstName,
			lastName: profile.lastName,
			handle: profile.handle,
			image: profile.image,
		},
	});

	await q.drain({ auctionId: data.auctionId }, { removeOnComplete: true });

	return {
		status: "processing",
		requestId,
	};
}
