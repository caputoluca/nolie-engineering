import { type AuctionOut, AuctionStatus } from "@mazal/schemas/auction";
import { auctionsConfig } from "./config";

export function canBid(auction: Pick<AuctionOut, "status" | "endAt">) {
	return auction.status === AuctionStatus.active && auction.endAt > new Date();
}

export function shouldExtendAuction(
	auction: Pick<AuctionOut, "status" | "endAt" | "bids">,
) {
	const now = Date.now();

	if (auction.status !== AuctionStatus.active) {
		return { shouldExtend: false, extendSeconds: 0 };
	}

	const timeLeftSeconds = (auction.endAt.getTime() - now) / 1000;

	const shouldExtend = timeLeftSeconds <= auctionsConfig.extensionWindowSeconds;

	return {
		shouldExtend,
		extendSeconds: shouldExtend ? auctionsConfig.extendBySeconds : 0,
	};
}

export type ValidateBidResult =
	| { valid: true }
	| { valid: false; message: string; code: string };

export function validateBid(
	auction: Pick<
		AuctionOut,
		"status" | "endAt" | "startingBid" | "bids" | "creatorId"
	>,
	amount: number,
	userId: string,
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
	if (auction.creatorId === userId) {
		return {
			valid: false,
			message: "Cannot bid on your own auction",
			code: "CANNOT_BID_ON_OWN_AUCTION",
		};
	}

	// 3. Amount must exceed highest bid
	const currentHighest = auction.bids[0]?.amount ?? auction.startingBid ?? 0;

	if (amount <= currentHighest) {
		return {
			valid: false,
			message: "Bid must be higher than current highest bid",
			code: "LOW_BID",
		};
	}

	// 5. Reject absurdly high bids for safety
	if (amount > auctionsConfig.maxBidAmount) {
		return {
			valid: false,
			message: "Bid amount invalid",
			code: "BID_TOO_HIGH",
		};
	}

	return { valid: true };
}
