import fp from "fastify-plugin";
import type { auth } from "../lib/auth.js";

declare module "fastify" {
	interface FastifyRequest {
		session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
	}
	interface FastifyContextConfig {
		/** Whether the route should skip authentication */
		public?: boolean;

		/** Restrict access to users with specific roles */
		// roles?: string[];
	}
}

export const protectPlugin = fp(async (fastify) => {
	fastify.addHook("preHandler", async (request, reply) => {
		// Access route config through the route context
		const isPublic = request.routeOptions.config?.public;
		if (isPublic) {
			return;
		}

		try {
			const session = await fastify.auth.api.getSession({
				headers: request.headers,
			});
			if (!session) {
				return reply
					.status(401)
					.send({ error: "Unauthorized", code: "UNAUTHORIZED" });
			}
			request.session = session;
		} catch (error) {
			fastify.log.error(error, "Internal error in route protector plugin");
			// TODO: handle error with custom error
		}
	});
});
