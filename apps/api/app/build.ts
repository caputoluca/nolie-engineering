// deploy-trigger: 2026-05-20
import type { S3Client } from "@aws-sdk/client-s3";
import fastifyCookie from "@fastify/cookie";
import corsPlugin from "@fastify/cors";
import type { PaymentsClient } from "@nolie/payments";
import type { NoLieQueues } from "@nolie/queues";
import type { createRestClient, RestClient } from "@nolie/realtime/server";
import type { ShippingClient } from "@nolie/shipping";
import Fastify from "fastify";
import fastifyRawBody from "fastify-raw-body";
import hyperid from "hyperid";
import { logger } from "./logger.js";
import { type AIClient, aiPlugin } from "./plugins/ai.js";
import { authPlugin } from "./plugins/auth.js";
import { cachePlugin } from "./plugins/cache.js";
import { envPlugin } from "./plugins/config.js";
import { prismaPlugin } from "./plugins/db.js";
import { errorsPlugin } from "./plugins/errors.js";
import { eventsPlugin } from "./plugins/events.js";
import { inboxPlugin } from "./plugins/inbox.js";
import {
	type ModerationClient,
	moderationPlugin,
} from "./plugins/moderations.js";
import { paymentsPlugin } from "./plugins/payments.js";
import { protectPlugin } from "./plugins/protect.js";
import { queuesPlugin } from "./plugins/queues.js";
import { rateLimitPlugin } from "./plugins/rate-limit.js";
import { realtimePlugin } from "./plugins/realtime.js";
import { redisPlugin } from "./plugins/redis.js";
import { schemasPlugin } from "./plugins/schemas.js";
import { shippingPlugin } from "./plugins/shipping.js";
import { storagePlugin } from "./plugins/storage.js";
import { underPressurePlugin } from "./plugins/under-pressure.js";
import { adminRoutes } from "./routes/admin.js";
import { agreementsRoutes } from "./routes/agreements.js";
import { authRoutes } from "./routes/auth/index.js";
import { cartRoutes } from "./routes/cart.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { contactRoutes } from "./routes/contact.js";
import { exploreRoutes } from "./routes/explore.js";
import { handlesRoutes } from "./routes/handles.js";
import { healthRoutes } from "./routes/health.js";
import { listingRoutes } from "./routes/listings/index.js";
import { meRoutes } from "./routes/me/index.js";
import { moderationRoutes } from "./routes/moderations.js";
import { offerRoutes } from "./routes/offers.js";
import { realtimeRoutes } from "./routes/realtime.js";
import { savedRoutes } from "./routes/saves.js";
import { sellersRoutes } from "./routes/sellers.js";
import { shippingRoutes } from "./routes/shipping.js";
import { sitemapRoutes } from "./routes/sitemap.js";
import { stripeRoutes } from "./routes/stripe.js";
import { uploadsRoutes } from "./routes/uploads.js";
import { usersRoutes } from "./routes/users.js";
import { easypostWebhookRoutes } from "./routes/webhooks/easypost.js";

const REQUEST_TIMEOUT = 20_000; // 20 seconds

const idGenerator = hyperid();

export interface BuildAppOptions {
	realtime?: RestClient;
	realtimeTokenAuthorizer?: ReturnType<typeof createRestClient>;
	payments?: PaymentsClient;
	shipping?: ShippingClient;
	ai?: AIClient;
	moderation?: ModerationClient;
	queues?: NoLieQueues;
	storage?: S3Client;
}

export async function buildApp(options?: BuildAppOptions) {
	const fastify = Fastify({
		loggerInstance: logger,
		genReqId: idGenerator,
		trustProxy: true,
		requestTimeout: REQUEST_TIMEOUT,
		maxParamLength: 120,
	});

	fastify.log.info("Starting NoLie API server...");

	fastify.log.debug("Loading environment configuration");
	await fastify.register(envPlugin); // ensure env is loaded first

	/* --------------- Plugins --------------- */
	// Third party plugins
	fastify.log.debug("Registering cookie support");
	await fastify.register(fastifyCookie);

	fastify.log.debug("Configuring CORS");
	await fastify.register(corsPlugin, {
		origin: fastify.config.trusted_origins,
		methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowedHeaders: [
			"Content-Type",
			"Authorization",
			"X-Requested-With",
			"X-NL-Referrer-Query-Id",
			"X-NL-Referrer-Rank-Position",
			"X-NL-Referrer-Surface",
		],
		// Browsers hide non-"simple" response headers from JS by default.
		// Expose Retry-After so the client can read it on 429 and show
		// "try again in ~X min".
		exposedHeaders: ["retry-after"],
		credentials: true,
		maxAge: 86400,
	});

	fastify.log.debug("Configuring raw body support");
	await fastify.register(fastifyRawBody, { global: false });

	fastify.log.debug("Configuring under-pressure (load shedding)");
	await fastify.register(underPressurePlugin);

	fastify.log.debug("Verifying Redis connection");
	await fastify.register(redisPlugin);

	fastify.log.debug("Connecting to database");
	await fastify.register(prismaPlugin); // connect to db

	fastify.log.debug("Initializing realtime client");
	await fastify.register(realtimePlugin, {
		instance: options?.realtime,
		tokenAuthorizer: options?.realtimeTokenAuthorizer,
	}); // connect to realtime

	fastify.log.debug("Initializing queues");
	await fastify.register(queuesPlugin, { instance: options?.queues }); // connect to queues

	fastify.log.debug("Initializing engagement event hook");
	await fastify.register(eventsPlugin);

	fastify.log.debug("Initializing cache");
	await fastify.register(cachePlugin); // connect to cache

	fastify.log.debug("Initializing rate limiting");
	await fastify.register(rateLimitPlugin); // rate limiting with Redis

	fastify.log.debug("Initializing inbox");
	await fastify.register(inboxPlugin); // connect to inbox

	fastify.log.debug("Initializing AI client");
	await fastify.register(aiPlugin, { instance: options?.ai }); // AI client (OpenAI)

	fastify.log.debug("Initializing content moderation");
	await fastify.register(moderationPlugin, { instance: options?.moderation }); // content moderation

	fastify.log.debug("Registering error handling");
	await fastify.register(errorsPlugin); // add errors to fastify instance

	fastify.log.debug("Setting up authentication");
	await fastify.register(authPlugin); // add auth to fastify instance

	fastify.log.debug("Configuring authentication protection");
	await fastify.register(protectPlugin); // Add authentication protection

	fastify.log.debug("Loading schemas");
	await fastify.register(schemasPlugin);

	fastify.log.debug("Initializing payments");
	await fastify.register(paymentsPlugin, { instance: options?.payments });

	fastify.log.debug("Initializing shipping");
	await fastify.register(shippingPlugin, { instance: options?.shipping });

	fastify.log.debug("Initializing storage");
	await fastify.register(storagePlugin, { instance: options?.storage });
	/* ------------------- End Plugins ------------------- */

	/* --------------- Routes --------------- */
	fastify.log.debug("Registering API routes");
	await fastify.register(healthRoutes, { prefix: "/health" });
	await fastify.register(authRoutes, { prefix: "/api/auth" });
	await fastify.register(meRoutes, { prefix: "/me" });
	await fastify.register(adminRoutes, { prefix: "/admin" });
	await fastify.register(agreementsRoutes, { prefix: "/agreements" });
	await fastify.register(contactRoutes, { prefix: "/contact" });
	await fastify.register(uploadsRoutes, { prefix: "/uploads" });
	await fastify.register(realtimeRoutes, { prefix: "/realtime" });
	await fastify.register(handlesRoutes, { prefix: "/handles" });
	await fastify.register(listingRoutes, { prefix: "/listings" });
	await fastify.register(offerRoutes, { prefix: "/offers" });
	await fastify.register(checkoutRoutes, { prefix: "/checkout" });
	await fastify.register(cartRoutes, { prefix: "/cart" });
	await fastify.register(savedRoutes, { prefix: "/saved" });
	await fastify.register(stripeRoutes, { prefix: "/stripe" });
	await fastify.register(shippingRoutes, { prefix: "/shipping" });
	await fastify.register(easypostWebhookRoutes, {
		prefix: "/shipping/easypost",
	});
	await fastify.register(moderationRoutes, { prefix: "/moderations" });
	await fastify.register(sitemapRoutes, { prefix: "/sitemap" });
	await fastify.register(exploreRoutes, { prefix: "/explore" });
	await fastify.register(sellersRoutes, { prefix: "/sellers" });
	await fastify.register(usersRoutes, { prefix: "/users" });
	/* ------------------- End Routes ------------------- */
	fastify.log.info(
		{
			port: fastify.config.port,
			host: fastify.config.host,
			environment: fastify.config.environment,
		},
		"Server configuration complete",
	);

	return fastify;
}

export type NoLieApp = Awaited<ReturnType<typeof buildApp>>;
