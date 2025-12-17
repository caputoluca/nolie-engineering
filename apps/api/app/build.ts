import fastifyCookie from "@fastify/cookie";
import corsPlugin from "@fastify/cors";
import Fastify from "fastify";
import fastifyRawBody from "fastify-raw-body";
import hyperid from "hyperid";
import { logger } from "./logger.js";
import { authPlugin } from "./plugins/auth.js";
import { envPlugin } from "./plugins/config.js";
import { prismaPlugin } from "./plugins/db.js";
import { errorsPlugin } from "./plugins/errors.js";
import { paymentsPlugin } from "./plugins/payments.js";
import { protectPlugin } from "./plugins/protect.js";
import { queuesPlugin } from "./plugins/queues.js";
import { realtimePlugin } from "./plugins/realtime.js";
import { schemasPlugin } from "./plugins/schemas.js";
import { agreementsRoutes } from "./routes/agreements.js";
import { auctionRoutes } from "./routes/auctions/index.js";
import { authRoutes } from "./routes/auth/index.js";
import { contactRoutes } from "./routes/contact.js";
import { handlesRoutes } from "./routes/handles.js";
import { meRoutes } from "./routes/me/index.js";
import { realtimeRoutes } from "./routes/realtime.js";
import { stripeRoutes } from "./routes/stripe.js";
import { uploadsRoutes } from "./routes/uploads.js";
import { waitlistRoutes } from "./routes/waitlist.js";

const REQUEST_TIMEOUT = 20_000; // 20 seconds

const idGenerator = hyperid();

export async function buildApp() {
	const fastify = Fastify({
		loggerInstance: logger,
		genReqId: idGenerator,
		trustProxy: true,
		requestTimeout: REQUEST_TIMEOUT,
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
		methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
		credentials: true,
		maxAge: 86400,
	});

	fastify.log.debug("Configuring raw body support");
	await fastify.register(fastifyRawBody, { global: false });

	fastify.log.debug("Connecting to database");
	await fastify.register(prismaPlugin); // connect to db

	fastify.log.debug("Initializing realtime client");
	await fastify.register(realtimePlugin); // connect to realtime

	fastify.log.debug("Initializing queues");
	await fastify.register(queuesPlugin); // connect to queues

	fastify.log.debug("Registering error handling");
	await fastify.register(errorsPlugin); // add errors to fastify instance

	fastify.log.debug("Setting up authentication");
	await fastify.register(authPlugin); // add auth to fastify instance

	fastify.log.debug("Configuring authentication protection");
	await fastify.register(protectPlugin); // Add authentication protection

	fastify.log.debug("Loading schemas");
	await fastify.register(schemasPlugin);

	fastify.log.debug("Initializing payments");
	await fastify.register(paymentsPlugin);
	/* ------------------- End Plugins ------------------- */

	/* --------------- Routes --------------- */
	fastify.log.debug("Registering API routes");
	await fastify.register(authRoutes, { prefix: "/api/auth" });
	await fastify.register(meRoutes, { prefix: "/me" });
	await fastify.register(agreementsRoutes, { prefix: "/agreements" });
	await fastify.register(contactRoutes, { prefix: "/contact" });
	await fastify.register(uploadsRoutes, { prefix: "/uploads" });
	await fastify.register(realtimeRoutes, { prefix: "/realtime" });
	await fastify.register(handlesRoutes, { prefix: "/handles" });
	await fastify.register(auctionRoutes, { prefix: "/auctions" });
	await fastify.register(waitlistRoutes, { prefix: "/waitlist" });
	await fastify.register(stripeRoutes, { prefix: "/stripe" });
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
