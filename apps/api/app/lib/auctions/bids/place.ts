import type { CacheOf } from "@nolie/cache";
import type { PrismaClient } from "@nolie/db";
import { errors, isHttpError } from "@nolie/errors/http";
import type { InboxOf } from "@nolie/inbox";
import type { QueueOf } from "@nolie/queues";
import { isRedisConnectionError } from "@nolie/redis/utils";
import type { AuctionItemTypeType } from "@nolie/schemas/auction/type";
import { v7 as uuidv7 } from "uuid";
import { logger } from "../../../logger.js";
import { getAuctionForBid, getUserForBidWithProfile } from "./utils.js";
import { validateBidOrThrow } from "./validate.js";

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
			creator: { userId: auction.creatorUserId },
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
