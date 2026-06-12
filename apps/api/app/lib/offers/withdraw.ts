import { offerWithdrawn } from "@nolie/analytics/events";
import type { ServerAnalytics } from "@nolie/analytics/server";
import {
	type Offer,
	OfferActor,
	OfferState,
	type PrismaClient,
} from "@nolie/db";
import { errors } from "@nolie/errors/http";
import type { RestClient } from "@nolie/realtime/server";
import { OfferWithdrawErrorCode } from "@nolie/schemas/offer";
import { reportError } from "../observability/sentry/report.js";
import { toOfferOut } from "./transform.js";

export interface WithdrawOfferInput {
	db: PrismaClient;
	realtime: RestClient;
	analytics: ServerAnalytics;
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
	const { db, realtime, analytics, offerId, userId } = input;

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

	// Read-time terminal short-circuit. Any non-pending state (or
	// pending-but-expired — wall clock past TTL even if the reconciler
	// hasn't transitioned the row yet) means the buyer has missed their
	// window to withdraw. We already have the row, so no refetch needed.
	const now = new Date();
	if (offer.state !== OfferState.pending || offer.expiresAt <= now) {
		throw errors.conflict("Offer is no longer pending", {
			code: OfferWithdrawErrorCode.no_longer_pending,
		});
	}

	// CAS — only transitions a still-pending row. Narrows on
	// `expiresAt > now` so the natural expiry race is treated the same
	// as any other concurrent terminal transition.
	const result = await db.offer.updateMany({
		where: { id: offerId, state: OfferState.pending, expiresAt: { gt: now } },
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

	// offer_withdrawn (NL-370) — terminal offer-funnel leg, buyer-keyed.
	// First-write path only; alreadyWithdrawn replays returned above.
	analytics.capture(
		refreshed.buyerId,
		offerWithdrawn({
			offerId: refreshed.id,
			listingId: refreshed.listingId,
			sellerId: refreshed.sellerId,
			buyerId: refreshed.buyerId,
			offerAmountCents: refreshed.amountCents,
			proposedBy: refreshed.proposedBy,
		}),
	);

	// Notify the counterparty (the seller, since V1 only has buyer-proposed
	// offers). No email — the V1 matrix doesn't include withdraw emails;
	// realtime is enough for the seller's open inbox UI.
	void realtime.offer.update.withdrawn
		.publish({ userId: refreshed.sellerId, offer: toOfferOut(refreshed) })
		.catch((err) => {
			reportError(err, {
				operation: "publish_offer_update_withdrawn",
				extra: { offerId, sellerId: refreshed.sellerId },
			});
		});

	// Public removal signal on the listing channel so the activity rail
	// drops the now-withdrawn row for every viewer (including the buyer's
	// other tabs). Minimum payload — the original `created` event already
	// carried buyer/amount publicly; we don't rebroadcast that here.
	if (refreshed.listingId) {
		void realtime.offer.activity.withdrawn
			.publish({ listingId: refreshed.listingId, eventId: refreshed.id })
			.catch((err) => {
				reportError(err, {
					operation: "publish_offer_activity_withdrawn",
					extra: { offerId, listingId: refreshed.listingId },
				});
			});
	}

	return { offer: refreshed, alreadyWithdrawn: false };
}
