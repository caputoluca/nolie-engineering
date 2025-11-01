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
		console.log("running protect plugin", request.url);
		// Skip /auth routes (sign-in, callback, etc.)
		if (request.url.startsWith("/auth")) {
			fastify.log.debug(
				{ url: request.url },
				"Skipping auth protection for auth route",
			);
			return;
		}
		// Skip Fastify's own 404 handler
		if (
			!fastify.hasRoute({
				method: request.method,
				url: request.url,
			})
		) {
			fastify.log.debug(
				{ url: request.url },
				"Skipping auth protection for non-existent route",
			);
			return;
		}
		const authConfig = request.routeOptions.config?.auth || {};
		if (authConfig?.public) {
			fastify.log.debug(
				{ url: request.url },
				"Skipping auth protection for public route",
			);
			return;
		}

		fastify.log.debug(
			{
				url: request.url,
				method: request.method,
				hasAuthHeader: !!request.headers.authorization,
			},
			"Checking authentication",
		);

		try {
			// Debug: Log all cookies being sent
			const cookieHeader = request.headers.cookie;
			fastify.log.debug(
				{
					cookieHeader,
					allHeaders: Object.keys(request.headers),
				},
				"Cookies received for session validation",
			);

			const session = await fastify.auth.api.getSession({
				headers: request.headers,
			});

			if (!session) {
				fastify.log.warn(
					{
						url: request.url,
						ip: request.ip,
					},
					"Unauthorized access attempt",
				);
				return reply
					.status(401)
					.send({ error: "Unauthorized", code: "UNAUTHORIZED" });
			}

			fastify.log.debug(
				{
					userId: session.user.id,
					role: session.user.role,
					url: request.url,
				},
				"User authenticated successfully",
			);

			const { role } = authConfig;
			if (role) {
				const requiredRoles = Array.isArray(role) ? role : [role];
				const userRole = session.user.role as UserRoleType;

				if (!requiredRoles.includes(userRole)) {
					fastify.log.warn(
						{
							userId: session.user.id,
							userRole,
							requiredRoles,
							url: request.url,
						},
						"Insufficient permissions",
					);
					return reply
						.status(403)
						.send({ error: "Forbidden", code: "FORBIDDEN" });
				}

				fastify.log.debug(
					{
						userId: session.user.id,
						userRole,
						requiredRoles,
					},
					"Role authorization successful",
				);
			}

			request.session = session;
		} catch (error) {
			fastify.log.error(
				{
					error,
					url: request.url,
					method: request.method,
				},
				"Error in protectPlugin",
			);
			throw fastify.errors.internal();
		}
	});
});
