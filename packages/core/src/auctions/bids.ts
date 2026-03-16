import { type AuctionOut, AuctionStatus } from "@nolie/schemas/auction";
import {
	BidValidationCode,
	type BidValidationCodeType,
} from "@nolie/schemas/auction/bid-validation";
import { auctionsConfig } from "./config";
import { auctionRequiresShipping } from "./helpers";

/**
 * Checks if a bid can be placed on an auction
 */
export function canBid(auction: Pick<AuctionOut, "status" | "endAt">) {
	return (
		auction.status === AuctionStatus.active &&
		new Date(auction.endAt) > new Date()
	);
}

/**
 * Determines if an auction should be extended due to a late bid (anti-sniping).
 *
 * If a bid is placed within the extension window (last N seconds of the auction),
 * the auction end time is reset to N seconds from now. This prevents last-second
 * sniping by giving all bidders a fair opportunity to respond.
 *
 * @param auction - The auction to check
 * @returns Object containing:
 *   - shouldExtend: Whether the auction should be extended
 *   - newEndAt: New end date/time if extending, null otherwise
 */
export function shouldExtendAuction(
	auction: Pick<AuctionOut, "status" | "endAt">,
) {
	if (auction.status !== AuctionStatus.active) {
		return { shouldExtend: false, newEndAt: null } as const;
	}

	const timeLeftSeconds =
		(new Date(auction.endAt).getTime() - Date.now()) / 1000;

	const shouldExtend = timeLeftSeconds <= auctionsConfig.extensionWindowSeconds;

	if (shouldExtend) {
		return {
			shouldExtend: true,
			newEndAt: new Date(
				Date.now() + auctionsConfig.extensionWindowSeconds * 1000,
			),
		} as const;
	}

	return {
		shouldExtend: false,
		newEndAt: null,
	} as const;
}

/**
 * Minimum bid increment by price tier.
 *
 * $1–$9 → +$1
 * $10–$24 → +$2
 * $25–$99 → +$5
 * $100–$499 → +$10
 * $500–$999 → +$25
 * $1,000–$2,499 → +$50
 * $2,500–$4,999 → +$100
 * $5,000–$9,999 → +$250
 * $10,000+ → +$500
 *
 * ⚠️ DUPLICATED in Lua for atomic Redis validation.
 * If you change this, also update:
 * apps/worker/app/lib/bids/scripts/validate-and-accept.ts
 */
export function getMinimumIncrement(amount: number): number {
	if (amount < 10) return 1;
	if (amount < 25) return 2;
	if (amount < 100) return 5;
	if (amount < 500) return 10;
	if (amount < 1000) return 25;
	if (amount < 2500) return 50;
	if (amount < 5000) return 100;
	if (amount < 10000) return 250;
	return 500;
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
	// 1. Cannot bid if auction has not started yet
	if (
		auction.status === AuctionStatus.pending ||
		auction.status === AuctionStatus.scheduled
	) {
		return {
			valid: false,
			message: "Auction has not started yet",
			code: BidValidationCode.auction_not_active,
		};
	}

	if (auction.status === AuctionStatus.cancelled) {
		return {
			valid: false,
			message: "Auction has been cancelled",
			code: BidValidationCode.auction_cancelled,
		};
	}

	// 2. Cannot bid if auction ended or not active
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
	hasPaymentMethod: boolean;
	hasShippingAddress: boolean;
	shippingCountry: string | null;
}

export type UserCanBidResult =
	| { valid: true }
	| { valid: false; message: string; code: BidValidationCodeType };

const COUNTRY_CODE_US = "US";

export function validateUserCanBid(
	user: ValidateUserInput,
	auction: Pick<AuctionOut, "itemType">,
): UserCanBidResult {
	if (!user.hasPaymentMethod) {
		return {
			valid: false,
			message: "User has not specified a payment method",
			code: BidValidationCode.requires_payment_method,
		};
	}
	if (auctionRequiresShipping(auction)) {
		if (!user.hasShippingAddress) {
			return {
				valid: false,
				message: "User has not specified a shipping address",
				code: BidValidationCode.requires_shipping_address,
			};
		}

		if (user.shippingCountry?.toUpperCase() !== COUNTRY_CODE_US) {
			return {
				valid: false,
				message: "Shipping is only available in the United States",
				code: BidValidationCode.shipping_country_not_supported,
			};
		}
	}
	return { valid: true };
}
