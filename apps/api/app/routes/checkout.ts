import {
	CheckoutClaimBodySchema,
	CheckoutClaimSuccessSchema,
} from "@nolie/schemas/checkout/claim";
import {
	CheckoutQuoteBodySchema,
	CheckoutQuoteResponseSchema,
} from "@nolie/schemas/checkout/quote";
import { claimCheckout } from "../lib/checkout/claim.js";
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
			});
			return reply.status(200).send(quote);
		},
	});

	create.post("/claim", {
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
				buyerId: request.session.user.id,
				body: request.body,
			});
			return reply.status(200).send(result);
		},
	});
});
