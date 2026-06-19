import { releaseOrdersTx } from "@nolie/checkout";
import type { PrismaClient } from "@nolie/db";
import { OrderOriginationType, PaymentStatus } from "@nolie/db";
import { errors, HttpError } from "@nolie/errors/http";
import type { PaymentsClient } from "@nolie/payments";
import { isStripeRateLimitError } from "@nolie/payments/utils";
import { CheckoutClaimErrorCode } from "@nolie/schemas/checkout/claim";
import { logger } from "../../logger.js";
import { apiTx } from "../db/tx.js";

interface ResolveInFlightCheckoutInput {
	db: PrismaClient;
	payments: PaymentsClient;
	buyerId: string;
	/** The quote's listing ids — the cart the buyer is (re)claiming. */
	listingIds: string[];
}

/**
 * NL-378 — resume/supersede guard. A buyer who abandons a checkout (closes the
 * Affirm/Klarna page, hits the browser back button mid-3DS, reloads) and
 * returns starts a *fresh* checkout session with a new `idempotencyKey`, so the
 * `replayIfExists` path in `claim.ts` can't match. Without this guard the next
 * claim would reserve + open a **second** PaymentIntent for a cart that already
 * has one in flight — a real double charge if the first PI already committed.
 *
 * Stripe does not dedupe across distinct PaymentIntents, and idempotency keys
 * only cover identical requests within 24h, so a new session defeats them. The
 * only correct defense is to look up the buyer's in-flight order — *without*
 * the idempotency key — and reuse-or-supersede it:
 *
 *   - PI uncommitted (`requires_*`) → cancel it (`abandoned`) and supersede:
 *     void the old order(s), release their listing holds, then let the caller
 *     re-reserve + create a fresh PI for whatever rail the buyer now picked
 *     (including switching off BNPL — nothing was captured, so it's safe).
 *   - PI committed (`processing` / `succeeded`) → **block**: throw
 *     `payment_in_progress` so the FE routes to that order's confirmation.
 *     Never open a second PI.
 *   - No PI linked yet (a prior attempt died before Tx B) → nothing committed
 *     at Stripe; release the stale order locally and proceed fresh.
 *
 * The cancel call is the concurrency gate for the card-3DS race: cards settle
 * fast, so between our read and our cancel the buyer can finish 3DS and the PI
 * commits. `cancelPaymentIntent` treats that as a no-op (`canceledNow: false`)
 * and returns the now-committed status — we treat any non-`canceled` result as
 * committed and block, so we never recreate after a PI has actually charged.
 *
 * Runs before the claim's pre-flight reads, so by the time
 * `partitionCheckoutListings` runs the superseded listings are back to
 * `active` — the availability check stays a plain "is it active?" with no
 * buyer-awareness needed.
 *
 * Returns nothing on the proceed-fresh path; throws `payment_in_progress`
 * (409) when blocked.
 */
export async function resolveInFlightCheckout(
	input: ResolveInFlightCheckoutInput,
): Promise<void> {
	const { db, payments, buyerId, listingIds } = input;

	// Buyer's own still-pending BIN orders holding any of these listings. Scoped
	// to `checkout` origin — offer-accepted orders have their own accept flow
	// and are out of scope for the BNPL resume. A live line item (not voided) is
	// the "this listing is tied up in an in-flight order" signal.
	const inFlight = await db.order.findMany({
		where: {
			buyerId,
			paymentStatus: PaymentStatus.pending,
			originationType: OrderOriginationType.checkout,
			lineItems: { some: { listingId: { in: listingIds }, voidedAt: null } },
		},
		select: { id: true, paymentIntentId: true },
	});
	if (inFlight.length === 0) return;

	// A multi-seller cart materializes N orders that share one PaymentIntent.
	// Group by PI so we make one reuse/supersede decision per PI and act on the
	// whole group atomically. `null` = a prior attempt that died before linking.
	const orderIdsByPi = new Map<string | null, string[]>();
	for (const o of inFlight) {
		const group = orderIdsByPi.get(o.paymentIntentId);
		if (group) group.push(o.id);
		else orderIdsByPi.set(o.paymentIntentId, [o.id]);
	}

	for (const [paymentIntentId, orderIds] of orderIdsByPi) {
		if (paymentIntentId === null) {
			// No PI ever linked — nothing committed at Stripe. Release locally.
			await supersede(db, orderIds);
			continue;
		}

		// Cancel is the gate. A cancelable (uncommitted) PI → `canceled`. A PI
		// that raced to a committed state → Stripe refuses, `cancelPaymentIntent`
		// returns the current committed status with `canceledNow: false`.
		let result: Awaited<
			ReturnType<typeof payments.customer.cancelPaymentIntent>
		>;
		try {
			result = await payments.customer.cancelPaymentIntent({
				paymentIntentId,
				cancellationReason: "abandoned",
			});
		} catch (err) {
			if (isStripeRateLimitError(err)) {
				throw errors.tooManyRequests(
					"We are experiencing high demand. Please try again in a moment.",
					{ code: "STRIPE_RATE_LIMIT_EXCEEDED" },
				);
			}
			throw err;
		}

		if (result.status !== "canceled") {
			// The PI raced to a committed state (`processing` / `succeeded`) between
			// our read and our cancel — these auto-capture PIs never sit at
			// `requires_capture`. The buyer already owns this payment; refuse a
			// second PI and let the FE route them to the existing order's confirmation.
			logger.info(
				{ buyerId, paymentIntentId, orderIds, status: result.status },
				"checkout.resume: blocked — in-flight PI already committed",
			);
			throw new HttpError(
				"You already have a payment in progress for these items",
				CheckoutClaimErrorCode.payment_in_progress,
				{
					statusCode: 409,
					data: { paymentIntentId, orderIds, status: result.status },
				},
			);
		}

		logger.info(
			{ buyerId, paymentIntentId, orderIds },
			"checkout.resume: superseded abandoned in-flight order",
		);
		await supersede(db, orderIds);
	}
}

/**
 * Void the buyer's superseded order(s) and release their listing holds back to
 * `active`, so the claim's next step can re-reserve. Reuses the shared
 * terminal-release body — same writes the `payment_intent.canceled` webhook
 * makes, so the webhook our `cancelPaymentIntent` triggers lands as an
 * idempotent no-op (orders already `voided`; the listing release is scoped to
 * these order ids, never clobbering a fresh re-reservation).
 */
async function supersede(db: PrismaClient, orderIds: string[]): Promise<void> {
	if (orderIds.length === 0) return;
	await apiTx(db, (tx) =>
		releaseOrdersTx({
			tx,
			// The caller scopes the in-flight query to `checkout` origin, so these
			// are never offer-accepted: `acceptedOfferId` is always null and there's
			// no linked offer to void. Build the minimal shape `releaseOrdersTx`
			// reads (`id` + `acceptedOfferId`) rather than re-fetching the full
			// finalization select.
			orders: orderIds.map((id) => ({
				id,
				originationType: OrderOriginationType.checkout,
				acceptedOfferId: null,
			})),
			terminalStatus: PaymentStatus.voided,
		}),
	);
}
