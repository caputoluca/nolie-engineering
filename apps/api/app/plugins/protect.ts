import type { UserRoleType } from "@mazal/schemas/user";
import fp from "fastify-plugin";
import type { auth } from "../lib/auth.js";

export interface AuthConfig {
	public?: boolean;
	role?: UserRoleType | UserRoleType[];
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
		// Skip /auth routes (sign-in, callback, etc.)
		if (request.url.startsWith("/auth")) return;

		// Skip Fastify’s own 404 handler
		if (
			!fastify.hasRoute({
				method: request.method,
				url: request.url,
			})
		) {
			return;
		}

		const authConfig = request.routeOptions.config?.auth || {};
		if (authConfig?.public) {
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

			const { role } = authConfig;
			if (role) {
				const requiredRoles = Array.isArray(role) ? role : [role];
				const userRole = session.user.role as UserRoleType;

				if (!requiredRoles.includes(userRole)) {
					return reply
						.status(403)
						.send({ error: "Forbidden", code: "FORBIDDEN" });
				}
			}

			request.session = session;
		} catch (error) {
			fastify.log.error(error, "Error in protectPlugin");
			fastify.errors.internal();
		}
	});
});
