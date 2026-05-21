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
 * Applies to BOTH parcel and letter rails. After this many business
 * days the cron flips the Order to `delivered`. Rail-specific behavior
 * lives in the cron handler:
 *   - Parcel: full delivery flow (deliveryConfirmed email, review
 *     prompts, payout release).
 *   - Letter: review prompts only with `deliveryConfirmed: false`
 *     copy — payout already released at day-3 via the letter rail.
 *
 * 10 business days = ~14 calendar days. Bumped from the original 7
 * after NL-285 live data showed real envelopes still landing past the
 * 7-business-day mark. Decoupled from buyer INR rights (user-initiated,
 * time-from-purchase, not status-gated).
 */
export const DEEMED_DELIVERED_BUSINESS_DAYS = 10;

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

/**
 * @deprecated Use `DEEMED_DELIVERED_BUSINESS_DAYS` (NL-314). Kept
 * exclusively for legacy
 * `apps/api/scripts/backfill-letter-deemed-delivered.ts` bit-for-bit
 * compatibility during the NL-314 rollout. Drop in a follow-up PR
 * once the new backfill has run.
 */
export const LETTER_DEEMED_DELIVERED_BUSINESS_DAYS =
	DEEMED_DELIVERED_BUSINESS_DAYS;

/** @deprecated Use `getDeemedDeliveredAt` (NL-314). See above. */
export function getLetterDeemedDeliveredAt(now: Date = new Date()): Date {
	return getDeemedDeliveredAt(now);
}
