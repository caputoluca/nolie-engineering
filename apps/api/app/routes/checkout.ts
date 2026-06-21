import { errors } from "@nolie/errors/http";
import {
	CheckoutClaimBodySchema,
	CheckoutClaimSuccessSchema,
} from "@nolie/schemas/checkout/claim";
import {
	CheckoutConfirmationQuerySchema,
	CheckoutConfirmationResponseSchema,
} from "@nolie/schemas/checkout/confirmation";
import {
	CheckoutQuoteBodySchema,
	CheckoutQuoteResponseSchema,
	type GuestCheckoutInput,
	type GuestCheckoutShipTo,
} from "@nolie/schemas/checkout/quote";
import {
	CheckoutQuoteLightBodySchema,
	CheckoutQuoteLightResponseSchema,
} from "@nolie/schemas/checkout/quote-light";
import { claimCheckout } from "../lib/checkout/claim.js";
import { getCheckoutConfirmation } from "../lib/checkout/confirmation.js";
import {
	getGuestClaimContext,
	onboardGuestOnFirstPurchase,
	resolveCheckoutBuyer,
} from "../lib/checkout/guest-buyer.js";
import { buildCheckoutQuote } from "../lib/checkout/quote.js";
import { createRoutes } from "../lib/factory.js";

export const checkoutRoutes = createRoutes((create, app) => {
	// Resolve the buyer for a quote (NL-298 guest checkout). Signed in →
	// the session user. Signed out → mint-or-dedupe a passwordless `User` from
	// the email on the body (the mint point); the typed ship-to rides back as
	// `guestShipTo`. No identity at all → 401, since we can't build a quote.
	async function resolveQuoteBuyer(
		sessionUserId: string | undefined,
		guest: GuestCheckoutInput | undefined,
	): Promise<{ buyerId: string; guestShipTo: GuestCheckoutShipTo | null }> {
		if (sessionUserId) return { buyerId: sessionUserId, guestShipTo: null };
		if (!guest) {
			throw errors.unauthorized(
				"Enter your email to check out as a guest, or sign in.",
				{ code: "CHECKOUT_IDENTITY_REQUIRED" },
			);
		}
		const { userId } = await resolveCheckoutBuyer({
			db: app.prisma,
			auth: app.auth,
			email: guest.email,
			firstName: guest.firstName,
			lastName: guest.lastName,
		});
		return { buyerId: userId, guestShipTo: guest.shippingAddress ?? null };
	}

	// POST not GET — building a quote inserts a CheckoutQuote row + calls
	// Stripe Tax. Side-effectful, so it shouldn't be cacheable / idempotent.
	create.post("/", {
		auth: { optional: true },
		schema: {
			body: CheckoutQuoteBodySchema,
			response: {
				200: CheckoutQuoteResponseSchema,
				400: app.getErrorSchema("badRequest"),
				401: app.getErrorSchema("unauthorized"),
				404: app.getErrorSchema("notFound"),
			},
		},
		handler: async (request, reply) => {
			const { buyerId, guestShipTo } = await resolveQuoteBuyer(
				request.session?.user?.id,
				request.body.guest,
			);
			const quote = await buildCheckoutQuote({
				db: app.prisma,
				payments: app.payments,
				buyerId,
				listingIds: request.body.listingIds,
				requestedShippingAddressId: request.body.shippingAddressId,
				fulfillmentChoiceByListing: request.body.fulfillment,
				useCredit: request.body.useCredit,
				guestShipTo,
			});
			return reply.status(200).send(quote);
		},
	});

	// Light recompute — same lib as POST /checkout, response trimmed to just
	// the quote-derived fields. Wallet/addresses/payment-methods stay stable
	// across recomputes within a single page session, so the FE keeps the
	// values from the bundled init call. Cart-hash dedupe (in the lib) skips
	// the Stripe Tax call when the buyer toggles back to a recently-seen state.
	create.post("/quote", {
		auth: { optional: true },
		schema: {
			body: CheckoutQuoteLightBodySchema,
			response: {
				200: CheckoutQuoteLightResponseSchema,
				400: app.getErrorSchema("badRequest"),
				401: app.getErrorSchema("unauthorized"),
				404: app.getErrorSchema("notFound"),
			},
		},
		handler: async (request, reply) => {
			const { buyerId, guestShipTo } = await resolveQuoteBuyer(
				request.session?.user?.id,
				request.body.guest,
			);
			const full = await buildCheckoutQuote({
				db: app.prisma,
				payments: app.payments,
				buyerId,
				listingIds: request.body.listingIds,
				requestedShippingAddressId: request.body.shippingAddressId,
				fulfillmentChoiceByListing: request.body.fulfillment,
				useCredit: request.body.useCredit,
				guestShipTo,
			});
			return reply.status(200).send({
				quoteId: full.quoteId,
				expiresAt: full.expiresAt,
				lineItems: full.lineItems,
				groups: full.groups,
				totals: full.totals,
				unavailableItems: full.unavailableItems,
				isTaxExempt: full.isTaxExempt,
				bnplEligible: full.bnplEligible,
				selectedShippingAddressId: full.selectedShippingAddressId,
				shippingCountryNotSupported: full.shippingCountryNotSupported,
			});
		},
	});

	// Powers the post-checkout success page. Authed → buyer-scoped lookup by
	// PaymentIntent ID. Guest (no session) → token-scoped by PaymentIntent ID
	// alone (the high-entropy PI id Stripe appends to the return_url is the
	// bearer capability; no session is minted on the guest path). URL
	// `client_secret` is intentionally ignored.
	create.get("/confirmation", {
		auth: { optional: true },
		schema: {
			query: CheckoutConfirmationQuerySchema,
			response: {
				200: CheckoutConfirmationResponseSchema,
				400: app.getErrorSchema("badRequest"),
				404: app.getErrorSchema("notFound"),
			},
		},
		handler: async (request, reply) => {
			const result = await getCheckoutConfirmation({
				db: app.prisma,
				buyerId: request.session?.user?.id ?? null,
				paymentIntentId: request.query.paymentIntentId,
				orderId: request.query.orderId,
			});
			return reply.status(200).send(result);
		},
	});

	create.post("/claim", {
		auth: { optional: true },
		config: {
			rateLimit: {
				max: app.rateLimiting.limits.checkoutClaim.max,
				timeWindow: app.rateLimiting.limits.checkoutClaim.timeWindow,
				keyGenerator: app.rateLimiting.keyGenerators.checkoutClaim,
			},
		},
		schema: {
			body: CheckoutClaimBodySchema,
			response: {
				200: CheckoutClaimSuccessSchema,
				400: app.getErrorSchema("badRequest"),
				403: app.getErrorSchema("forbidden"),
				404: app.getErrorSchema("notFound"),
				429: app.getErrorSchema("tooManyRequests"),
			},
		},
		handler: async (request, reply) => {
			const sessionUserId = request.session?.user?.id;
			// Guest claim (NL-298) has no session: the buyer + ship-to come off
			// the quote (the quote cuid is the bearer capability). Resolved before
			// the claim so `claimCheckout`'s `quote.buyerId === buyerId` check
			// passes by construction.
			let buyerId: string;
			let guestContext: Awaited<
				ReturnType<typeof getGuestClaimContext>
			> | null = null;
			if (sessionUserId) {
				buyerId = sessionUserId;
			} else {
				guestContext = await getGuestClaimContext({
					db: app.prisma,
					quoteId: request.body.quoteId,
				});
				buyerId = guestContext.buyerId;
			}

			const result = await claimCheckout({
				db: app.prisma,
				payments: app.payments,
				queues: app.queues,
				realtime: app.realtime,
				analytics: app.analytics,
				marketing: app.marketing,
				buyerId,
				body: request.body,
				requestReferrer: request.referrer,
			});

			// First-purchase onboarding (exactly-once via the `guestOnboardedAt`
			// CAS) — fires the deferred signup side-effects and saves the ship-to
			// as the new account's default address. Runs only on the sessionless
			// guest path; the CAS no-ops for a deduped real account, so a typed
			// email never mutates someone else's account.
			if (guestContext) {
				await onboardGuestOnFirstPurchase({
					db: app.prisma,
					queues: app.queues,
					analytics: app.analytics,
					marketing: app.marketing,
					userId: buyerId,
					ipAddress: request.ip,
					userAgent: request.headers["user-agent"] ?? null,
					referralHeaders: request.headers,
					guestShipTo: guestContext.shipTo,
				});
			}

			return reply.status(200).send(result);
		},
	});
});
