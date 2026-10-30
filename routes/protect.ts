/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 *
 * Left out of this folder:
 * - getSession: asks better-auth for the session behind the request's cookie.
 *   A cookie for a session that no longer exists counts as no session (a 401),
 *   not an error (a 500).
 * - auth: the better-auth client; its session type is what the factory hands
 *   a signed-in handler.
 * Everything else is plumbing: role types, observability.
 */

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
	/**
	 * Optional auth (NL-298): resolve the session when a cookie is present, but
	 * continue without one instead of 401ing. Distinct from `public`, which
	 * skips session resolution entirely — that would blind the route to a
	 * logged-in cookie and treat every caller as anonymous. Use this for routes
	 * that serve both signed-in and signed-out callers (guest checkout), then
	 * read `request.session?.user?.id`.
	 */
	optional?: boolean;
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
					// Optional-auth routes serve anonymous callers (guest checkout):
					// no session is fine, just continue with `request.session` unset.
					if (authConfig?.optional) {
						return;
					}
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
