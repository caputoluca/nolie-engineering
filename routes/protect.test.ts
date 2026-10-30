/**
 * Protect middleware tests.
 *
 * Tests authentication and authorization via test routes:
 * - Public routes allow unauthenticated access
 * - Protected routes require valid session
 * - Admin role-based access control
 */

import { describe, expect, it } from "vitest";
import {
	createApiClient,
	createAuthenticatedUser,
	getApp,
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
			const session = await createAuthenticatedUser();
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
			const session = await createAuthenticatedUser();
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
	});
});
