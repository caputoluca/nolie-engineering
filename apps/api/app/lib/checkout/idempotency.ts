import { createHash } from "node:crypto";
import { errors } from "@nolie/errors/http";

/**
 * Format gate for client-supplied idempotency keys on POST /checkout/claim.
 * URL-safe characters only; 16-64 length matches the IETF draft + Stripe /
 * Square / AWS conventions.
 *
 * 16 chars min keeps random-key entropy >= ~80 bits (the lower-bound nanoid
 * default is 21 chars / ~126 bits — well within range). Below 16 chars,
 * collision probability becomes meaningful at our request volume.
 *
 * 64 chars max bounds payload + response storage. Stripe accepts up to 255;
 * we cap tighter because the key sits on Order rows forever.
 */
const IDEMPOTENCY_KEY_FORMAT = /^[A-Za-z0-9_-]{16,64}$/;

export function validateIdempotencyKeyFormat(key: string): void {
	if (!IDEMPOTENCY_KEY_FORMAT.test(key)) {
		throw errors.badRequest("idempotencyKey format invalid", {
			code: "INVALID_IDEMPOTENCY_KEY_FORMAT",
		});
	}
}

/**
 * SHA-256 hash of the claim payload that determines the resulting Order +
 * PaymentIntent. Persisted on `Order.idempotencyPayloadHash` at materialize
 * time. On replay we recompute and compare:
 *
 *   - hashes match → safe replay; return the cached response
 *   - hashes differ → SPA bug (e.g. stale key reused with a new quote or
 *     payment method); throw 422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
 *
 * Standard Stripe / Square / Brandur pattern. Catches an entire class of
 * caller bugs that would otherwise silently confirm a payment for the wrong
 * cart / wrong card.
 */
export function computeIdempotencyPayloadHash(input: {
	quoteId: string;
	paymentMethodId: string;
}): string {
	const canonical = JSON.stringify({
		quoteId: input.quoteId,
		paymentMethodId: input.paymentMethodId,
	});
	return createHash("sha256").update(canonical).digest("hex");
}
