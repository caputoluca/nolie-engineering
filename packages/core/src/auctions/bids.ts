import { type AuctionOut, AuctionStatus } from "@mazal/schemas/auction";
import { auctionsConfig } from "./config";

export function canBid(auction: Pick<AuctionOut, "status" | "endAt">) {
	return (
		auction.status === AuctionStatus.active &&
		new Date(auction.endAt) > new Date()
	);
}

export function shouldExtendAuction(
	auction: Pick<AuctionOut, "status" | "endAt" | "bids">,
) {
	const now = Date.now();

	if (auction.status !== AuctionStatus.active) {
		return { shouldExtend: false, extendSeconds: 0 };
	}

	const timeLeftSeconds = (new Date(auction.endAt).getTime() - now) / 1000;

	const shouldExtend = timeLeftSeconds <= auctionsConfig.extensionWindowSeconds;

	return {
		shouldExtend,
		extendSeconds: shouldExtend ? auctionsConfig.extendBySeconds : 0,
	};
}
export function getMinimumIncrement(amount: number): number {
	if (amount < 100) return 1;
	if (amount < 250) return 5;
	if (amount < 500) return 10;
	if (amount < 1000) return 25;
	if (amount < 5000) return 50;
	return 100;
}

export function computeNextBidAmount({
	current,
	startingBid,
}: {
	current: number | null;
	startingBid: number;
}): number {
	if (current === null) {
		return startingBid;
	}
	return current + getMinimumIncrement(current);
}

export type ValidateBidResult =
	| { valid: true }
	| { valid: false; message: string; code: string };

export function validateBid(
	auction: Pick<AuctionOut, "status" | "endAt" | "startingBid" | "bids"> & {
		creatorUserId: string;
	},
	bid: { amount: number; currentHighest: number | null },
	{
		userId,
	}: {
		userId: string;
	},
): ValidateBidResult {
	// 1. Cannot bid if auction not active
	if (!canBid(auction)) {
		return {
			valid: false,
			message: "Auction has ended",
			code: "AUCTION_ENDED",
		};
	}

	// 2. Cannot bid on own auction
	if (userId === auction.creatorUserId) {
		return {
			valid: false,
			message: "Cannot bid on your own auction",
			code: "CANNOT_BID_ON_OWN_AUCTION",
		};
	}

	// 3. Amount must exceed highest bid
	const nextBidAmount = computeNextBidAmount({
		current: bid.currentHighest,
		startingBid: auction.startingBid,
	});

	if (bid.amount < nextBidAmount) {
		return {
			valid: false,
			message: "Your bid is too low",
			code: "BID_TOO_LOW",
		};
	}

	// 5. Reject absurdly high bids for safety
	if (bid.amount > auctionsConfig.maxBidAmount) {
		return {
			valid: false,
			message: "Bid amount invalid",
			code: "BID_TOO_HIGH",
		};
	}

	return { valid: true };
}
