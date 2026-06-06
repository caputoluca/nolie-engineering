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
} from "@nolie/schemas/checkout/quote";
import {
	CheckoutQuoteLightBodySchema,
	CheckoutQuoteLightResponseSchema,
} from "@nolie/schemas/checkout/quote-light";
import { claimCheckout } from "../lib/checkout/claim.js";
import { getCheckoutConfirmation } from "../lib/checkout/confirmation.js";
import { buildCheckoutQuote } from "../lib/checkout/quote.js";
import { createRoutes } from "../lib/factory.js";

export const checkoutRoutes = createRoutes((create, app) => {
	// POST not GET — building a quote inserts a CheckoutQuote row + calls
	// Stripe Tax. Side-effectful, so it shouldn't be cacheable / idempotent.
	create.post("/", {
		schema: {
			body: CheckoutQuoteBodySchema,
			response: {
				200: CheckoutQuoteResponseSchema,
				400: app.getErrorSchema("badRequest"),
				404: app.getErrorSchema("notFound"),
			},
		},
		handler: async (request, reply) => {
			const quote = await buildCheckoutQuote({
				db: app.prisma,
				payments: app.payments,
				buyerId: request.session.user.id,
				listingIds: request.body.listingIds,
				requestedShippingAddressId: request.body.shippingAddressId,
				fulfillmentChoiceByListing: request.body.fulfillment,
				useCredit: request.body.useCredit,
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
		schema: {
			body: CheckoutQuoteLightBodySchema,
			response: {
				200: CheckoutQuoteLightResponseSchema,
				400: app.getErrorSchema("badRequest"),
				404: app.getErrorSchema("notFound"),
			},
		},
		handler: async (request, reply) => {
			const full = await buildCheckoutQuote({
				db: app.prisma,
				payments: app.payments,
				buyerId: request.session.user.id,
				listingIds: request.body.listingIds,
				requestedShippingAddressId: request.body.shippingAddressId,
				fulfillmentChoiceByListing: request.body.fulfillment,
				useCredit: request.body.useCredit,
			});
			return reply.status(200).send({
				quoteId: full.quoteId,
				expiresAt: full.expiresAt,
				lineItems: full.lineItems,
				groups: full.groups,
				totals: full.totals,
				unavailableItems: full.unavailableItems,
				isTaxExempt: full.isTaxExempt,
				selectedShippingAddressId: full.selectedShippingAddressId,
				shippingCountryNotSupported: full.shippingCountryNotSupported,
			});
		},
	});

	// Powers the post-checkout success page. Buyer-scoped lookup by
	// PaymentIntent ID — converges the 3DS-redirect path (Stripe appends
	// `?payment_intent=…` to the return_url) and the synchronous path on a
	// single shape. URL `client_secret` is intentionally ignored; we auth
	// via session.
	create.get("/confirmation", {
		schema: {
			query: CheckoutConfirmationQuerySchema,
			response: {
				200: CheckoutConfirmationResponseSchema,
				404: app.getErrorSchema("notFound"),
			},
		},
		handler: async (request, reply) => {
			const result = await getCheckoutConfirmation({
				db: app.prisma,
				buyerId: request.session.user.id,
				paymentIntentId: request.query.paymentIntentId,
				orderId: request.query.orderId,
			});
			return reply.status(200).send(result);
		},
	});

	create.post("/claim", {
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
			const result = await claimCheckout({
				db: app.prisma,
				payments: app.payments,
				queues: app.queues,
				realtime: app.realtime,
				analytics: app.analytics,
				marketing: app.marketing,
				buyerId: request.session.user.id,
				body: request.body,
				requestReferrer: request.referrer,
			});
			return reply.status(200).send(result);
		},
	});
});
