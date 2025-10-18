import fp from "fastify-plugin";
import type { auth } from "../lib/auth.js";

type Role = "admin" | "entrant" | "creator";
export interface AuthConfig {
	public?: boolean;
	role?: Role | Role[];
}
declare module "fastify" {
	interface FastifyRequest {
		session: NonNullable<
			Awaited<ReturnType<typeof auth.api.getSession>>
		> | null;
	}
	interface FastifyContextConfig {
		auth?: AuthConfig;
	}
}

export const protectPlugin = fp(async (fastify) => {
	fastify.addHook("preHandler", async (request, reply) => {
		// Access route config through the route context
		const isAuthRoute = request.url.startsWith("/auth");
		if (
			!isAuthRoute &&
			!fastify.hasRoute({ method: request.method, url: request.url })
		) {
			return; // this will pipe to default not found handler.
		}
		const { public: isPublic } = request.routeOptions.config?.auth || {};

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
			fastify.errors.internal();
		}
	});
});
