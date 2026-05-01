import {
	type Offer,
	OfferActor,
	OfferState,
	type PrismaClient,
} from "@nolie/db";
import { errors } from "@nolie/errors/http";
import { OfferWithdrawErrorCode } from "@nolie/schemas/offer";

export interface WithdrawOfferInput {
	db: PrismaClient;
	offerId: string;
	userId: string;
}

export interface WithdrawOfferResult {
	offer: Offer;
	alreadyWithdrawn: boolean;
}

/**
 * Withdraw a buyer's pending offer.
 *
 * Authorization: only the proposer of the offer can withdraw it. PR1 only
 * has buyer-proposed offers (counter and seller-proposed Offer-to-Likers
 * land in PR2 / V2), so this checks `proposedBy === buyer && buyerId === userId`.
 *
 * Idempotency is structural — no separate idempotency key. A re-issued
 * withdraw on a row this caller already withdrew returns `alreadyWithdrawn:
 * true` with the current row. Any other terminal state (declined, expired,
 * canceled_*, etc.) throws OFFER_NO_LONGER_PENDING since the listing's
 * commercial state has moved past the buyer's window to withdraw.
 */
export async function withdrawOffer(
	input: WithdrawOfferInput,
): Promise<WithdrawOfferResult> {
	const { db, offerId, userId } = input;

	const offer = await db.offer.findUnique({ where: { id: offerId } });
	if (!offer) {
		throw errors.notFound("Offer not found", {
			code: OfferWithdrawErrorCode.not_found,
		});
	}

	const isProposer =
		offer.proposedBy === OfferActor.buyer && offer.buyerId === userId;
	if (!isProposer) {
		throw errors.forbidden("Only the proposer can withdraw an offer", {
			code: OfferWithdrawErrorCode.not_proposer,
		});
	}

	// Replay: this caller already withdrew this offer. Return current row.
	if (offer.state === OfferState.withdrawn && offer.resolvedBy === userId) {
		return { offer, alreadyWithdrawn: true };
	}

	// Pending-but-expired rows are "treated as expired in API responses"
	// per the doc — the reconciler hasn't run yet but the buyer has missed
	// their window to withdraw. Reject as if already terminal.
	if (offer.state === OfferState.pending && offer.expiresAt <= new Date()) {
		throw errors.conflict("Offer is no longer pending", {
			code: OfferWithdrawErrorCode.no_longer_pending,
		});
	}

	// CAS — only transitions a still-pending row. Narrows on
	// `expiresAt > now` so the natural expiry race is treated the same
	// as any other concurrent terminal transition.
	const now = new Date();
	const result = await db.offer.updateMany({
		where: {
			id: offerId,
			state: OfferState.pending,
			expiresAt: { gt: now },
		},
		data: {
			state: OfferState.withdrawn,
			resolvedAt: now,
			resolvedBy: userId,
		},
	});

	if (result.count === 0) {
		const refreshed = await db.offer.findUniqueOrThrow({
			where: { id: offerId },
		});
		if (
			refreshed.state === OfferState.withdrawn &&
			refreshed.resolvedBy === userId
		) {
			return { offer: refreshed, alreadyWithdrawn: true };
		}
		throw errors.conflict("Offer is no longer pending", {
			code: OfferWithdrawErrorCode.no_longer_pending,
		});
	}

	const refreshed = await db.offer.findUniqueOrThrow({
		where: { id: offerId },
	});
	return { offer: refreshed, alreadyWithdrawn: false };
}
