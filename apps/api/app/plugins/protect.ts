import type { UserRoleType } from "@nolie/schemas/user";
import type { RequestRouteOptions } from "fastify/types/request.js";
import fp from "fastify-plugin";
import type { auth } from "../lib/auth.js";
import { getSession } from "../lib/authentication/sessions.js";
import {
	identifyObservabilityUser,
	resetObservabilityUser,
} from "../lib/observability/identify.js";

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

/**
 * Check if a route exists. Fastify sets both method and url for valid routes.
 */
function routeExists({ method, url }: RequestRouteOptions): boolean {
	return Boolean(method && url);
}

export const protectPlugin = fp(
	async (fastify) => {
		fastify.addHook("onResponse", async () => {
			resetObservabilityUser();
		});
		fastify.addHook("preHandler", async (request, reply) => {
			// Skip Fastify's own 404 handler
			if (!routeExists(request.routeOptions)) {
				return;
			}

			const authConfig = request.routeOptions.config?.auth;
			if (authConfig?.public) {
				return;
			}

			try {
				const session = await getSession(request.headers, fastify.auth);

				if (!session) {
					fastify.log.warn(
						{
							url: request.url,
							ip: request.ip,
						},
						"Unauthorized access attempt",
					);
					const err = fastify.errors.unauthorized("Unauthorized");
					return reply
						.status(err.statusCode)
						.send(err.toJSON({ traceId: request.id }));
				}

				const { role } = authConfig || {};
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
						const err = fastify.errors.forbidden("Forbidden", {
							code: "INSUFFICIENT_PERMISSIONS",
						});
						return reply
							.status(err.statusCode)
							.send(err.toJSON({ traceId: request.id }));
					}
				}

				request.session = session;
				identifyObservabilityUser(session.user.id, {
					email: session.user.email,
					role: session.user.role as UserRoleType,
					handle: session.user.handle ?? null,
				});
			} catch (error) {
				fastify.log.error(
					{
						error,
						url: request.url,
						method: request.method,
					},
					"Error in protectPlugin",
				);
				// Safety check: ensure errors plugin is loaded
				if (fastify.errors) {
					throw fastify.errors.internal();
				}
				// Fallback if errors plugin not loaded (shouldn't happen, but fail-safe)
				throw new Error("Internal server error");
			}
		});
	},
	{ name: "protect-plugin" },
);
