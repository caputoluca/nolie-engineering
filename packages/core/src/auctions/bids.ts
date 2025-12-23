import { type AuctionOut, AuctionStatus } from "@nolie/schemas/auction";
import {
	BidValidationCode,
	type BidValidationCodeType,
} from "@nolie/schemas/auction/bid-validation";
import { auctionsConfig } from "./config";
import { auctionRequiresShipping } from "./helpers";

export function canBid(auction: Pick<AuctionOut, "status" | "endAt">) {
	return (
		auction.status === AuctionStatus.scheduled ||
		auction.status === AuctionStatus.active
	);
}

export function shouldExtendAuction(
	auction: Pick<AuctionOut, "status" | "endAt">,
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
	| { valid: false; message: string; code: BidValidationCodeType };

type ValidateBidAuction = Pick<
	AuctionOut,
	"status" | "endAt" | "startingBid"
> & {
	creatorUserId: string;
};

export interface ValidateBidInput {
	amount: number;
	currentHighest: number | null;
	userId: string;
	allowEqualToCurrentBid?: boolean;
}

export function validateBid(
	auction: ValidateBidAuction,
	{ userId, ...bid }: ValidateBidInput,
): ValidateBidResult {
	// 1. Cannot bid if auction not active
	if (!canBid(auction)) {
		return {
			valid: false,
			message: "Auction has ended",
			code: BidValidationCode.auction_ended,
		};
	}

	// 2. Cannot bid on own auction
	if (userId === auction.creatorUserId) {
		return {
			valid: false,
			message: "Cannot bid on your own auction",
			code: BidValidationCode.cannot_bid_on_own_auction,
		};
	}

	// 3. Amount must exceed highest bid
	const nextBidAmount = computeNextBidAmount({
		current: bid.currentHighest,
		startingBid: auction.startingBid,
	});

	if (bid.amount < nextBidAmount) {
		if (bid.allowEqualToCurrentBid && bid.amount === bid.currentHighest) {
			return { valid: true };
		}
		return {
			valid: false,
			message: "Your bid is too low",
			code: BidValidationCode.bid_too_low,
		};
	}

	// 5. Reject absurdly high bids for safety
	if (bid.amount > auctionsConfig.maxBidAmount) {
		return {
			valid: false,
			message: "Bid amount invalid",
			code: BidValidationCode.bid_too_high,
		};
	}

	return { valid: true };
}

interface ValidateProxyBidInput extends ValidateBidInput {
	proxyMaxAmount: number;
	proxyBidAmount: number;
}

export function validateProxyBid(
	auction: ValidateBidAuction,
	{
		proxyBidAmount,
		proxyMaxAmount,
		...input
	}: Omit<ValidateProxyBidInput, "amount" | "allowEqualToCurrentBid">,
): ValidateBidResult {
	// for tie breaking proxies, we allow the bid to be equal to the current bid
	const validation = validateBid(auction, {
		...input,
		amount: proxyBidAmount,
		allowEqualToCurrentBid: true,
	});
	if (!validation.valid) {
		return validation;
	}

	// 4. Proxy max amount must exceed highest bid
	if (proxyBidAmount > proxyMaxAmount) {
		return {
			valid: false,
			message: "Proxy amount is too high",
			code: BidValidationCode.proxy_amount_too_high,
		};
	}
	return validation;
}

export interface ValidateUserInput {
	billing: {
		defaultPaymentMethodId: string | null;
	} | null;
	defaultShippingAddressId: string | null;
}

export type UserCanBidResult =
	| { valid: true }
	| { valid: false; message: string; code: BidValidationCodeType };

export function validateUserCanBid(
	user: ValidateUserInput,
	auction: Pick<AuctionOut, "itemType">,
): UserCanBidResult {
	if (!user.billing?.defaultPaymentMethodId) {
		return {
			valid: false,
			message: "User has not specified a payment method",
			code: BidValidationCode.requires_payment_method,
		};
	}
	if (auctionRequiresShipping(auction)) {
		if (!user.defaultShippingAddressId) {
			return {
				valid: false,
				message: "User has not specified a shipping address",
				code: BidValidationCode.requires_shipping_address,
			};
		}
	}
	return { valid: true };
}
