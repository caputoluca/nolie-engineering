import type { CacheOf } from "@nolie/cache";
import { validateUserCanBid } from "@nolie/core/auctions";
import type { PrismaClient } from "@nolie/db";
import { errors, isHttpError } from "@nolie/errors/http";
import type { InboxOf } from "@nolie/inbox";
import type { QueueOf } from "@nolie/queues";
import { isRedisConnectionError } from "@nolie/redis/utils";
import type { AuctionItemTypeType } from "@nolie/schemas/auction/type";
import { v7 as uuidv7 } from "uuid";
import { logger } from "../../../logger.js";
import { reportWarning } from "../../observability/sentry/report.js";
import { getAuctionForBid, getUserForBidWithProfile } from "./utils.js";
import { validateBidOrThrow } from "./validate.js";

/**
 * Loads auction state from DB without populating the cache.
 *
 * IMPORTANT: We intentionally do NOT use cache.get()'s load callback here.
 * Using the load callback would call update() which does DEL + HSET on the cache.
 * Under high concurrency, multiple API requests can see a cache miss simultaneously,
 * and their slow DB queries can complete AFTER the worker's Lua script has already
 * updated the cache with new bid data. This causes stale DB data to clobber
 * the Lua's writes, leading to duplicate bids being accepted.
 *
 * The worker's getCachedAuctionState() is the only code that should populate this
 * cache, since drain jobs are processed sequentially per auction.
 */
async function fallbackLoadState(auctionId: string, db: PrismaClient) {
	const auction = await getAuctionForBid(db, auctionId);
	return {
		auctionId: auction.id,
		currentHighestBidAmount: auction.currentHighestBid,
		highestBidUserId: auction.currentHighestBidUserId,
		version: 1,
		startingBidAmount: auction.startingBid.toNumber(),
		sellerUserId: auction.sellerProfile.userId,
		itemType: auction.itemType,
		status: auction.status,
		endAt: auction.endAt,
	};
}

export async function validateBidFromCache(
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
	const auction =
		(await cache.get(auctionId)) ?? (await fallbackLoadState(auctionId, db));

	if (!auction) {
		throw errors.notFound("Auction not found", {
			code: "AUCTION_NOT_FOUND",
		});
	}

	logger.debug(
		{
			auctionId: auction.auctionId,
			status: auction.status,
			hasEndAt: !!auction.endAt,
		},
		"auction loaded from cache",
	);

	validateBidOrThrow({
		auction: {
			endAt: auction.endAt,
			status: auction.status,
			seller: { userId: auction.sellerUserId },
			startingBid: auction.startingBidAmount,
			currentHighestBid: auction.currentHighestBidAmount,
		},
		userId,
		amount,
	});

	return auction;
}

export async function validateUserFromCache(
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
			shippingCountry: user.defaultShippingAddress?.country ?? null,
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
			reportWarning("Failed to cache user caches", {
				operation: "update_user_caches",
				extra: { userId },
				error: err,
			});
			logger.warn({ err, userId }, "Failed to cache user eligibility/profile");
		});
	}

	const validationResult = validateUserCanBid(eligibility, { itemType });

	if (!validationResult.valid) {
		throw errors.badRequest(validationResult.message, {
			code: validationResult.code,
		});
	}

	return { eligibility, profile };
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
	try {
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
	} catch (error) {
		if (!isHttpError(error) && isRedisConnectionError(error)) {
			throw errors.serviceUnavailable("Unable to store bid for processing", {
				code: "REDIS_CONNECTION_ERROR",
			});
		}
		throw error;
	}
}
