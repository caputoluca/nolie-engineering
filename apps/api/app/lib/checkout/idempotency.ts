import { createHash } from "node:crypto";

export { validateIdempotencyKeyFormat } from "../utils/idempotency.js";

/**
 * SHA-256 hash of the claim payload that determines the resulting Order +
 * PaymentIntent. Persisted on `Order.idempotencyPayloadHash` at materialize
 * time. On replay we recompute and compare:
 *
 *   - hashes match → safe replay; return the cached response
 *   - hashes differ → SPA bug (e.g. stale key reused with a new quote, payment
 *     method, or payment rail); throw 422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
 *
 * Standard Stripe / Square / Brandur pattern. Catches an entire class of
 * caller bugs that would otherwise silently confirm a payment for the wrong
 * cart / wrong card / wrong rail.
 *
 * The payment selection is a union (NL-378): a saved card (`paymentMethodId`)
 * or a BNPL provider (`bnpl`). Each contributes its own discriminant to the
 * canonical payload so a card↔BNPL key reuse is caught like any other mismatch.
 */
export function computeIdempotencyPayloadHash(
	input:
		| { quoteId: string; paymentMethodId: string }
		| { quoteId: string; bnpl: string },
): string {
	const canonical =
		"bnpl" in input
			? JSON.stringify({ quoteId: input.quoteId, bnpl: input.bnpl })
			: JSON.stringify({
					quoteId: input.quoteId,
					paymentMethodId: input.paymentMethodId,
				});
	return createHash("sha256").update(canonical).digest("hex");
}
