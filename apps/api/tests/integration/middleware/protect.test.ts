/**
 * Protect middleware tests.
 *
 * Tests authentication and authorization via test routes:
 * - Public routes allow unauthenticated access
 * - Protected routes require valid session
 * - Role-based access control
 * - Onboarding requirements
 */

import { prisma } from "@nolie/db";
import { OnboardingStep } from "@nolie/schemas/onboarding/step";
import { describe, expect, it } from "vitest";
import {
	createApiClient,
	createAuthenticatedUser,
	getApp,
	signInUser,
} from "../../helpers/index.js";

describe("Protect Middleware", () => {
	// =========================================================================
	// PUBLIC ROUTES
	// =========================================================================
	describe("Public Routes", () => {
		it("allows unauthenticated access to public routes", async () => {
			// Arrange: No authentication
			const app = getApp();

			// Act: Call public route without auth
			const response = await app.inject({
				method: "GET",
				url: "/test-public",
			});

			// Assert: Success
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ ok: true });
		});
	});

	// =========================================================================
	// AUTHENTICATION REQUIRED
	// =========================================================================
	describe("Authentication Required", () => {
		it("rejects requests without session", async () => {
			// Arrange: No authentication
			const app = getApp();

			// Act: Call protected route without auth
			const response = await app.inject({
				method: "GET",
				url: "/test-protected",
			});

			// Assert: 401 Unauthorized
			expect(response.statusCode).toBe(401);
			expect(response.json()).toMatchObject({
				code: "UNAUTHORIZED",
				message: "Unauthorized",
			});
		});

		it("allows authenticated users to access protected routes", async () => {
			// Arrange: Create authenticated fan
			const session = await createAuthenticatedUser({ role: "fan" });
			const api = createApiClient(session);

			// Act: Call protected route with auth
			const response = await api.get("/test-protected");

			// Assert: Success
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ ok: true });
		});
	});

	// =========================================================================
	// ROLE-BASED ACCESS CONTROL
	// =========================================================================
	describe("Role-Based Access Control", () => {
		it("allows admin to access admin-only routes", async () => {
			// Arrange: Create authenticated admin
			const session = await createAuthenticatedUser({ role: "admin" });
			const api = createApiClient(session);

			// Act: Call admin route
			const response = await api.get("/test-admin");

			// Assert: Success
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ ok: true });
		});

		it("rejects non-admin users from admin routes", async () => {
			// Arrange: Create authenticated creator (not admin)
			const session = await createAuthenticatedUser({ role: "creator" });
			const api = createApiClient(session);

			// Act: Call admin route
			const response = await api.get("/test-admin");

			// Assert: 403 Forbidden
			expect(response.statusCode).toBe(403);
			expect(response.json()).toMatchObject({
				code: "INSUFFICIENT_PERMISSIONS",
				message: "Forbidden",
			});
		});

		it("allows creator to access creator-only routes", async () => {
			// Arrange: Create authenticated creator
			const session = await createAuthenticatedUser({ role: "creator" });
			const api = createApiClient(session);

			// Act: Call creator route
			const response = await api.get("/test-creator");

			// Assert: Success
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ ok: true });
		});

		it("rejects non-creator users from creator routes", async () => {
			// Arrange: Create authenticated fan (not creator)
			const session = await createAuthenticatedUser({ role: "fan" });
			const api = createApiClient(session);

			// Act: Call creator route
			const response = await api.get("/test-creator");

			// Assert: 403 Forbidden
			expect(response.statusCode).toBe(403);
			expect(response.json()).toMatchObject({
				code: "INSUFFICIENT_PERMISSIONS",
				message: "Forbidden",
			});
		});

		it("allows any matching role from multiple roles", async () => {
			// Arrange: Create authenticated creator
			const creatorSession = await createAuthenticatedUser({ role: "creator" });
			const creatorApi = createApiClient(creatorSession);

			// Arrange: Create authenticated fan
			const fanSession = await createAuthenticatedUser({ role: "fan" });
			const fanApi = createApiClient(fanSession);

			// Act: Both call route that allows [creator, fan]
			const creatorResponse = await creatorApi.get("/test-creator-or-fan");
			const fanResponse = await fanApi.get("/test-creator-or-fan");

			// Assert: Both succeed
			expect(creatorResponse.statusCode).toBe(200);
			expect(fanResponse.statusCode).toBe(200);
		});

		it("rejects users not in allowed roles list", async () => {
			// Arrange: Create authenticated admin
			const session = await createAuthenticatedUser({ role: "admin" });
			const api = createApiClient(session);

			// Act: Call route that only allows [creator, fan]
			const response = await api.get("/test-creator-or-fan");

			// Assert: 403 Forbidden
			expect(response.statusCode).toBe(403);
			expect(response.json()).toMatchObject({
				code: "INSUFFICIENT_PERMISSIONS",
				message: "Forbidden",
			});
		});
	});

	// =========================================================================
	// ONBOARDING REQUIREMENTS
	// =========================================================================
	describe("Onboarding Requirements", () => {
		it("rejects incomplete onboarding when required", async () => {
			// Arrange: Create user with incomplete onboarding
			let session = await createAuthenticatedUser({ role: "creator" });

			// Set user to incomplete onboarding step
			await prisma.user.update({
				where: { id: session.user.id },
				data: { onboardingStep: OnboardingStep.profile },
			});

			// Sign in again to get fresh session with updated onboarding step
			const { signInUser } = await import("../../helpers/auth.js");
			session = await signInUser({
				email: session.user.email,
				password: session.password,
			});

			// Act: Call route requiring onboarding
			const api = createApiClient(session);
			const response = await api.get("/test-onboarded");

			// Assert: 403 Onboarding Required
			expect(response.statusCode).toBe(403);
			expect(response.json()).toMatchObject({
				code: "ONBOARDING_REQUIRED",
				message: "Onboarding is required before accessing this resource.",
			});
		});

		it("allows complete onboarding when required", async () => {
			// Arrange: Create user with complete onboarding
			let session = await createAuthenticatedUser({ role: "creator" });

			// Set user to complete onboarding
			await prisma.user.update({
				where: { id: session.user.id },
				data: { onboardingStep: OnboardingStep.done },
			});

			// Sign in again to get fresh session with updated onboarding step
			session = await signInUser({
				email: session.user.email,
				password: session.password,
			});

			// Act: Call route requiring onboarding
			const api = createApiClient(session);
			const response = await api.get("/test-onboarded");

			// Assert: Success
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ ok: true });
		});
	});
});
