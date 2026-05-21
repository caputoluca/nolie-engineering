import { addBusinessDays } from "../business-days.js";

/**
 * Payout release window: Number of days after marking as fulfilled
 * before the seller payout is automatically released.
 */
export const PAYOUT_RELEASE_WINDOW_IN_DAYS = 1;

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
 * Tighter than Whatnot's 10-day standard — bets that the loss-reserve
 * model can absorb the cases where a buyer files INR after a 3-day-old
 * payout has already released. Revisit if INR rates run higher than
 * the reserve covers.
 */
export const LETTER_PAYOUT_RELEASE_BUSINESS_DAYS = 3;

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
 * Letter-mail (NL-285) "deemed delivered" window. USPS scans ~40–50% of
 * FCML envelopes, so an unscanned order is normally a delivered order
 * with a missing scan — not a lost one. After this many business days,
 * the `flagLetterDelivered` reconciler flips the order to `delivered`
 * and fires a soft-worded review prompt (no "we confirmed delivery"
 * email — we didn't).
 *
 * 10 business days = ~14 calendar days; well past USPS's 1–5 business-
 * day FCML service objective with a comfortable cushion for late
 * deliveries. Bumped from the original 7 after live data showed real
 * envelopes still landing past the 7-business-day mark. The flip is
 * decoupled from payout (which already released at day-3) and from
 * buyer INR rights (user-initiated, time-from-purchase, not status-
 * gated).
 */
export const LETTER_DEEMED_DELIVERED_BUSINESS_DAYS = 10;

/**
 * Resolves the absolute timestamp at which a letter-mail order is
 * deemed delivered if no real EasyPost delivery scan has landed.
 * Computed once at label-creation time and persisted to
 * `ShippingLabel.deemedDeliveredAt` so the reconciler can do a trivial
 * indexed scan.
 */
export function getLetterDeemedDeliveredAt(now: Date = new Date()): Date {
	return addBusinessDays(now, LETTER_DEEMED_DELIVERED_BUSINESS_DAYS);
}
