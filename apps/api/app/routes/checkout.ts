import {
	CheckoutClaimBodySchema,
	CheckoutClaimSuccessSchema,
} from "@nolie/schemas/checkout/claim";
import {
	CheckoutQueryParamsSchema,
	CheckoutQuoteResponseSchema,
} from "@nolie/schemas/checkout/quote";
import { claimCheckout } from "../lib/checkout/claim.js";
import { buildCheckoutQuote } from "../lib/checkout/quote.js";
import { createRoutes } from "../lib/factory.js";

export const checkoutRoutes = createRoutes((create, fastify) => {
	create.get("/", {
		schema: {
			query: CheckoutQueryParamsSchema,
			response: {
				200: CheckoutQuoteResponseSchema,
				400: fastify.getErrorSchema("badRequest"),
				401: fastify.getErrorSchema("unauthorized"),
				404: fastify.getErrorSchema("notFound"),
			},
		},
		handler: async (request, reply) => {
			const listingIds = Array.isArray(request.query.listingIds)
				? request.query.listingIds
				: [request.query.listingIds];

			const quote = await buildCheckoutQuote({
				db: fastify.prisma,
				payments: fastify.payments,
				buyerId: request.session.user.id,
				listingIds,
				requestedShippingAddressId: request.query.shippingAddressId,
			});
			return reply.status(200).send(quote);
		},
	});

	create.post("/claim", {
		schema: {
			body: CheckoutClaimBodySchema,
			response: {
				200: CheckoutClaimSuccessSchema,
				400: fastify.getErrorSchema("badRequest"),
				401: fastify.getErrorSchema("unauthorized"),
				403: fastify.getErrorSchema("forbidden"),
				404: fastify.getErrorSchema("notFound"),
				429: fastify.getErrorSchema("tooManyRequests"),
			},
		},
		handler: async (request, reply) => {
			const result = await claimCheckout({
				db: fastify.prisma,
				payments: fastify.payments,
				buyerId: request.session.user.id,
				body: request.body,
			});
			return reply.status(200).send(result);
		},
	});
});
