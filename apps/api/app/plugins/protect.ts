import { isOnboardingComplete } from "@nolie/core/onboarding";
import type { OnboardingStepType } from "@nolie/schemas/onboarding/step";
import type { UserRoleType } from "@nolie/schemas/user";
import type { RequestRouteOptions } from "fastify/types/request.js";
import fp from "fastify-plugin";
import type { auth } from "../lib/auth.js";
import {
	identifyObservabilityUser,
	resetObservabilityUser,
} from "../lib/observability/identify.js";

export interface AuthConfig {
	public?: boolean;
	role?: UserRoleType | UserRoleType[];
	requireOnboarded?: boolean;
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
					return reply.status(401).send({
						code: "UNAUTHORIZED",
						message: "Unauthorized",
					});
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
						return reply.status(403).send({
							code: "INSUFFICIENT_PERMISSIONS",
							message: "Forbidden",
						});
					}
				}

				const { requireOnboarded } = authConfig || {};

				if (
					requireOnboarded &&
					session.user.onboardingStep &&
					!isOnboardingComplete(
						session.user.onboardingStep as OnboardingStepType,
					)
				) {
					fastify.log.warn(
						{
							userId: session.user.id,
							userRole: session.user.role,
							url: request.url,
						},
						"User tried to access resource without onboarding",
					);
					return reply.status(403).send({
						code: "ONBOARDING_REQUIRED",
						message: "Onboarding is required before accessing this resource.",
					});
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
