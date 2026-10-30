/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 * Left out: addBusinessDays, which skips weekends and US federal holidays.
 */

import { addBusinessDays } from "../business-days.js";

/**
 * Payout release window: Number of days after marking as fulfilled
 * before the seller payout is automatically released. Tracks the 2-day
 * post-delivery dispute window (`DISPUTE_WINDOW_DAYS_AFTER_FULFILLMENT`)
 * so payout never releases while the buyer can still dispute — closing the
 * 1-day gap that forced a clawback. Propagates via `getPayoutReleaseDelayMs()`,
 * applied at every parcel release site (delivery webhook, pickup auto-complete,
 * deemed-delivered timeout). Fast payouts release at label purchase by design
 * and are unaffected.
 */
export const PAYOUT_RELEASE_WINDOW_IN_DAYS = 2;

/**
 * Calculates the payout release delay in milliseconds.
 * This is the delay used when scheduling payout jobs.
 */
export function getPayoutReleaseDelayMs(): number {
	return PAYOUT_RELEASE_WINDOW_IN_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Letter-mail (USPS First-Class Mail Letter) payout window. FCML has no
 * reliable delivery scan, so we release on a clock instead of on a
 * `delivered` event. Business days, not calendar days, so a Friday-printed
 * label still gets the full buyer-noticing window before payout.
 *
 * Set just under Whatnot's 10-day standard, leaving a gap below the
 * deemed-delivered review-prompt clock (DEEMED_DELIVERED_BUSINESS_DAYS,
 * 10 BD) so the buyer-noticing window always leads payout. Widened from the
 * original 3 days: the
 * loss-reserve model couldn't reliably absorb buyers filing INR after a
 * payout had already released, so the buyer-noticing window now leads the
 * payout. Revisit if INR rates stay well inside what the reserve covers.
 */
export const LETTER_PAYOUT_RELEASE_BUSINESS_DAYS = 7;

/**
 * Resolves the absolute timestamp at which a letter-mail label's payout
 * becomes eligible for release. Computed once at label-creation time and
 * persisted to `ShippingLabel.payoutReleaseAt` so the reconciler can do a
 * trivial indexed scan.
 */
export function getLetterPayoutReleaseAt(now: Date = new Date()): Date {
	return addBusinessDays(now, LETTER_PAYOUT_RELEASE_BUSINESS_DAYS);
}

/**
 * Time-based "deemed shipped" window (NL-314). Applies to BOTH parcel
 * and letter rails. If no carrier "shipped"/`in_transit` scan arrives
 * within this many business days of label purchase, the
 * `promoteStaleOrders` cron flips the Order from `awaiting_shipment`
 * → `shipped`. The carrier's `trackingStatus` is intentionally left
 * untouched (we *deem* it shipped — we don't know).
 */
export const DEEMED_SHIPPED_BUSINESS_DAYS = 2;

/**
 * Time-based "deemed delivered" window (NL-314, generalizing NL-285).
 * Both rails. After this many business days `promoteStaleOrders` flips
 * the Order to `delivered` when no real `delivered` scan landed first:
 *   - Parcel: full delivery flow (deliveryConfirmed email, review
 *     prompts, payout release). Rarely hit — parcels carry a reliable
 *     delivery scan that flips them first.
 *   - Letter: review prompts with `deliveryConfirmed: false` soft copy;
 *     payout via its own `releaseLetterPayouts` clock (same 7-BD beat).
 *     The main path for the letters that never emit a usable scan.
 *
 * 10 business days ≈ 14 calendar days. Widened back from 7 after parcels
 * were deem-flipped to `delivered` while genuinely still in transit: 10 BD
 * clears USPS Ground Advantage's realistic transit tail (2-5 BD quoted, plus
 * the slow / late-scan long tail), so the clock rarely fires ahead of a real
 * delivery scan. The parcel rail is additionally scan-guarded — a package the
 * carrier still shows actively moving is held past this clock (see
 * `PARCEL_ACTIVE_TRANSIT_GRACE_BUSINESS_DAYS` below). Restores NL-285's
 * original 10-BD intent that `LETTER_PAYOUT_RELEASE_BUSINESS_DAYS` still
 * documents itself as sitting just under.
 * Decoupled from buyer INR rights (user-initiated, time-from-purchase,
 * not status-gated).
 */
export const DEEMED_DELIVERED_BUSINESS_DAYS = 10;

/**
 * Parcel-rail active-transit grace — the "not recently moving" half of the
 * deemed-delivered scan guard (mirrors Walmart's "N days no movement" terminal
 * check and the stalled-scan signal Route/ShipBob/Wonderment productize). The
 * `promoteStaleOrders` cron will NOT deem a parcel `delivered` if the carrier
 * posted an `in_transit` scan within this many business days — the package is
 * demonstrably still moving, so the missed-scan backstop doesn't apply yet.
 * Everything else still flips: `out_for_delivery` (reached destination, missed
 * the final scan), a stale `in_transit` (moving a week ago, silent since), and
 * never-scanned parcels. Letter rail is exempt (it rarely scans at all).
 *
 * 5 BD ≈ 7 calendar days, matching USPS's own missing-mail search floor — the
 * defensible low end for "no longer actively moving" (below ~5 days of silence
 * false-positives heavily, since normal transit scan gaps run 24-72h). Business
 * days so a routine weekend gap between scans never reads as stalled.
 */
export const PARCEL_ACTIVE_TRANSIT_GRACE_BUSINESS_DAYS = 5;

/**
 * Resolves the absolute timestamp at which a label is deemed shipped
 * if no carrier scan has elevated it past `pre_transit` first.
 * Computed once at physical label purchase and persisted to
 * `ShippingLabel.deemedShippedAt` so the cron can do an indexed scan.
 */
export function getDeemedShippedAt(now: Date = new Date()): Date {
	return addBusinessDays(now, DEEMED_SHIPPED_BUSINESS_DAYS);
}

/**
 * Resolves the absolute timestamp at which an order is deemed
 * delivered if no real carrier delivery scan has landed. Computed
 * once at physical label purchase and persisted to
 * `ShippingLabel.deemedDeliveredAt`.
 */
export function getDeemedDeliveredAt(now: Date = new Date()): Date {
	return addBusinessDays(now, DEEMED_DELIVERED_BUSINESS_DAYS);
}

// ─────────────────────────────────────────────────────────────
//  Seller wallet withdrawals (NL-263)
// ─────────────────────────────────────────────────────────────

/**
 * Minimum cents per withdrawal — Stripe's own floor for a payout. Applies to
 * both standard and instant.
 */
export const WITHDRAWAL_MIN_CENTS = 50;

/**
 * Maximum cents per INSTANT withdrawal ($9,999). Stripe caps a single instant
 * payout; over this the seller uses the free standard lane. Standard has no
 * per-payout cap of ours.
 */
export const INSTANT_WITHDRAWAL_MAX_CENTS = 999_900;

/**
 * Instant withdrawal fee: 1.75% with a $0.50 floor and NO cap (Stripe's instant
 * cost is a flat uncapped 1%, so a low cap would lose money on large payouts;
 * the free standard lane is the escape valve). Configured for real in the Stripe
 * Platform Pricing Tool — Stripe collects it automatically. These mirror that
 * config so we can quote the seller and record `feeChargedCents`/`platformFeeCents`.
 */
export const INSTANT_WITHDRAWAL_FEE_BPS = 175;
export const INSTANT_WITHDRAWAL_FEE_MIN_CENTS = 50;

/**
 * The fee a seller pays for an instant withdrawal of `amountCents`. Half-up
 * integer math (BigInt) so we never drift a cent against Stripe's own rounding,
 * then the $0.50 floor. Stripe's ~1% cost is recorded separately as the cost
 * basis; this is what the seller is charged (== our gross take).
 */
export function computeInstantWithdrawalFeeCents(amountCents: number): number {
	const proportional = Number(
		(BigInt(INSTANT_WITHDRAWAL_FEE_BPS) * BigInt(amountCents) + BigInt(5000)) /
			BigInt(10000),
	);
	return Math.max(INSTANT_WITHDRAWAL_FEE_MIN_CENTS, proportional);
}

/**
 * Stripe's own instant-payout cost to US: a flat, uncapped 1% of the payout
 * amount. Stripe bills the PLATFORM for this (separately from the markup we
 * collect from the seller), so it is NOT exposed on the connected-account payout
 * object — we record this computed cost basis for margin reporting. The exact
 * figure lives in Stripe's platform fee reporting; net margin ≈ our fee − this.
 */
export const STRIPE_INSTANT_PAYOUT_COST_BPS = 100; // 1%

export function computeStripeInstantCostCents(
	payoutAmountCents: number,
): number {
	// Half-up integer math (BigInt) to mirror the fee helper above.
	return Number(
		(BigInt(STRIPE_INSTANT_PAYOUT_COST_BPS) * BigInt(payoutAmountCents) +
			BigInt(5000)) /
			BigInt(10000),
	);
}
