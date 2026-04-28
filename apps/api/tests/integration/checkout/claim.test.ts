/**
 * POST /checkout/claim integration tests.
 *
 * The claim handler is the heart of BIN checkout — it consumes a quote,
 * reserves listings (race resolver), creates a Stripe PaymentIntent, and
 * materializes one Order per seller group, all idempotently.
 *
 * Tests cover:
 *   - happy paths (single + multi-listing + multi-seller bundles)
 *   - race-to-claim atomicity (concurrent claims, all-or-nothing rollback)
 *   - quote validation (expired, consumed, wrong-buyer, drifted)
 *   - idempotency replay (path A: PI linked, path B: PI=null after Stripe fail)
 *   - business rules (self-purchase, missing wallet/PM/address)
 *
 * Real Postgres + real Fastify + mocked PaymentsClient. The mock's PI store
 * is keyed on idempotencyKey so replay-paths work end-to-end without Stripe.
 */
import {
	ListingStatus,
	OrderOriginationType,
	PaymentStatus,
	Prisma,
	prisma,
} from "@nolie/db";
import { fixtures } from "@nolie/testing";
import { describe, expect, it } from "vitest";
import {
	assertResponse,
	createApiClient,
	createFixedPriceListingForSeller,
	createTestSellerUser,
	createUnauthenticatedClient,
	getMockPayments,
	signInUser,
} from "../../helpers/index.js";
import {
	createQuoteFor,
	postClaim,
	setupReadyBuyer,
	setupSellerWithListing,
	uniqueIdempotencyKey,
} from "./_helpers.js";

// ─── tests ──────────────────────────────────────────────────────────────────

describe("POST /checkout/claim", () => {
	describe("auth + input validation", () => {
		it("returns 401 when unauthenticated", async () => {
			const api = createUnauthenticatedClient();
			const response = await api.post("/checkout/claim", {
				quoteId: "anything",
				paymentMethodId: "anything",
				idempotencyKey: "anything",
			});
			expect(response.statusCode).toBe(401);
		});

		it("returns 422 INVALID_QUOTE for an unknown quoteId", async () => {
			const buyer = await setupReadyBuyer();
			const response = await postClaim(buyer.api, {
				quoteId: "clx-does-not-exist",
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("k"),
			});
			const body = await assertResponse<{ code: string }>(response, 422);
			expect(body.code).toBe("INVALID_QUOTE");
		});
	});

	describe("happy path", () => {
		it("single-listing claim creates 1 Order, reserves the listing, returns clientSecret", async () => {
			const seller = await setupSellerWithListing({
				price: 50,
				itemType: "physical",
				shippingCostCents: 500,
			});
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			const idempotencyKey = uniqueIdempotencyKey("happy");

			const before = Date.now();
			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey,
			});
			const after = Date.now();

			const body = await assertResponse<{
				clientSecret: string;
				paymentIntentId: string;
				orderIds: string[];
			}>(response, 200);
			expect(body.orderIds).toHaveLength(1);
			expect(body.paymentIntentId).toMatch(/^pi_test_/);
			expect(body.clientSecret).toMatch(/_secret_test$/);

			const order = await prisma.order.findUniqueOrThrow({
				where: { id: body.orderIds[0] },
				include: { lineItems: true },
			});
			expect(order.buyerId).toBe(buyer.session.user.id);
			expect(order.sellerProfileId).toBe(seller.sellerProfileId);
			expect(order.paymentStatus).toBe(PaymentStatus.pending);
			expect(order.paymentIntentId).toBe(body.paymentIntentId);
			expect(order.idempotencyKey).toBe(idempotencyKey);
			expect(order.originationType).toBe(OrderOriginationType.checkout);
			expect(order.lineItems).toHaveLength(1);
			expect(order.lineItems[0]?.listingId).toBe(seller.listing.id);

			const listing = await prisma.listing.findUniqueOrThrow({
				where: { id: seller.listing.id },
			});
			expect(listing.status).toBe(ListingStatus.reserved);
			expect(listing.reservedByOrderId).toBe(order.id);
			expect(listing.reservedUntil).toBeInstanceOf(Date);
			const reservedAtMs = listing.reservedUntil?.getTime();
			const tenMin = 10 * 60 * 1000;
			expect(reservedAtMs).toBeGreaterThanOrEqual(before + tenMin - 1500);
			expect(reservedAtMs).toBeLessThanOrEqual(after + tenMin + 1500);

			const quote = await prisma.checkoutQuote.findUniqueOrThrow({
				where: { id: quoteId },
			});
			expect(quote.consumedByOrderId).toBe(order.id);
		});

		it("multi-listing single-seller claim → 1 Order with N OrderLineItems sharing 1 PaymentIntent", async () => {
			const seller = await setupSellerWithListing({
				price: 30,
				itemType: "physical",
				shippingCostCents: 200,
			});
			// Add a second listing under the same seller.
			const secondListing = await createFixedPriceListingForSeller(
				seller.sellerProfileId,
				{ price: 70, itemType: "physical" },
			);
			await prisma.listing.update({
				where: { id: secondListing.id },
				data: { shippingCostCents: 200 },
			});
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [
				seller.listing.id,
				secondListing.id,
			]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("multi-line"),
			});

			const body = await assertResponse<{
				orderIds: string[];
				paymentIntentId: string;
			}>(response, 200);
			expect(body.orderIds).toHaveLength(1);

			const order = await prisma.order.findUniqueOrThrow({
				where: { id: body.orderIds[0] },
				include: { lineItems: true },
			});
			expect(order.lineItems).toHaveLength(2);
			expect(order.lineItems.map((l) => l.listingId).sort()).toEqual(
				[seller.listing.id, secondListing.id].sort(),
			);

			const listings = await prisma.listing.findMany({
				where: { id: { in: [seller.listing.id, secondListing.id] } },
			});
			for (const l of listings) {
				expect(l.status).toBe(ListingStatus.reserved);
				expect(l.reservedByOrderId).toBe(order.id);
			}
		});

		it("multi-seller bundle → N Orders all sharing one PaymentIntent", async () => {
			const sellerA = await setupSellerWithListing({ itemType: "physical" });
			const sellerB = await setupSellerWithListing({ itemType: "physical" });
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [
				sellerA.listing.id,
				sellerB.listing.id,
			]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("multi-seller"),
			});

			const body = await assertResponse<{
				orderIds: string[];
				paymentIntentId: string;
			}>(response, 200);
			expect(body.orderIds).toHaveLength(2);

			const orders = await prisma.order.findMany({
				where: { id: { in: body.orderIds } },
				include: { lineItems: true },
			});
			expect(orders).toHaveLength(2);
			// All N Orders share the same PaymentIntent.
			const piIds = new Set(orders.map((o) => o.paymentIntentId));
			expect(piIds.size).toBe(1);
			expect([...piIds][0]).toBe(body.paymentIntentId);
			// Each Order is scoped to one seller; line items all belong to that seller.
			const sellerProfileIds = new Set(orders.map((o) => o.sellerProfileId));
			expect(sellerProfileIds.size).toBe(2);

			const orderForSellerA = orders.find(
				(o) => o.sellerProfileId === sellerA.sellerProfileId,
			);
			expect(orderForSellerA?.lineItems).toHaveLength(1);
			expect(orderForSellerA?.lineItems[0]?.listingId).toBe(sellerA.listing.id);
		});

		it("emits a Stripe PaymentIntent keyed on the claim idempotencyKey", async () => {
			const mockPayments = getMockPayments();
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			const idempotencyKey = uniqueIdempotencyKey("pi-key");

			await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey,
			});

			const stored =
				mockPayments._getPaymentIntentByIdempotencyKey(idempotencyKey);
			expect(stored).toBeDefined();
			expect(stored?.customerId).toBe(buyer.customerId);
		});
	});

	describe("race-to-claim atomicity", () => {
		it("two concurrent claims on the same listing → exactly one wins, other gets 409 UNAVAILABLE_LISTINGS", async () => {
			const seller = await setupSellerWithListing();
			const buyerA = await setupReadyBuyer();
			const buyerB = await setupReadyBuyer();
			const quoteA = await createQuoteFor(buyerA.api, [seller.listing.id]);
			const quoteB = await createQuoteFor(buyerB.api, [seller.listing.id]);

			const [resA, resB] = await Promise.all([
				postClaim(buyerA.api, {
					quoteId: quoteA,
					paymentMethodId: buyerA.paymentMethodId,
					idempotencyKey: uniqueIdempotencyKey("race-a"),
				}),
				postClaim(buyerB.api, {
					quoteId: quoteB,
					paymentMethodId: buyerB.paymentMethodId,
					idempotencyKey: uniqueIdempotencyKey("race-b"),
				}),
			]);

			const codes = [resA.statusCode, resB.statusCode].sort();
			expect(codes).toEqual([200, 409]);

			const winnerRes = resA.statusCode === 200 ? resA : resB;
			const loserRes = resA.statusCode === 200 ? resB : resA;
			const winnerBody = (await winnerRes.json()) as { orderIds: string[] };
			const loserBody = (await loserRes.json()) as {
				code: string;
				data: { unavailableListingIds: string[] };
			};
			expect(loserBody.code).toBe("UNAVAILABLE_LISTINGS");
			expect(loserBody.data.unavailableListingIds).toEqual([seller.listing.id]);

			// Exactly one Order exists; listing is reserved by it.
			const orders = await prisma.order.findMany({
				where: { lineItems: { some: { listingId: seller.listing.id } } },
			});
			expect(orders).toHaveLength(1);
			expect(orders[0]?.id).toBe(winnerBody.orderIds[0]);

			const listing = await prisma.listing.findUniqueOrThrow({
				where: { id: seller.listing.id },
			});
			expect(listing.reservedByOrderId).toBe(winnerBody.orderIds[0]);

			// Loser's quote stays unconsumed — buyer can retry on a different listing.
			const losingBuyer = resA.statusCode === 200 ? buyerB : buyerA;
			const losingQuoteId = resA.statusCode === 200 ? quoteB : quoteA;
			const losingQuote = await prisma.checkoutQuote.findUniqueOrThrow({
				where: { id: losingQuoteId },
			});
			expect(losingQuote.consumedByOrderId).toBeNull();
			expect(losingQuote.buyerId).toBe(losingBuyer.session.user.id);
		});
	});

	describe("quote validation", () => {
		it("rejects expired quote with 410 QUOTE_EXPIRED", async () => {
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			// Expire it directly.
			await prisma.checkoutQuote.update({
				where: { id: quoteId },
				data: { expiresAt: new Date(Date.now() - 1000) },
			});

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("expired"),
			});

			const body = await assertResponse<{ code: string }>(response, 410);
			expect(body.code).toBe("QUOTE_EXPIRED");
		});

		it("rejects already-consumed quote with 422 INVALID_QUOTE", async () => {
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			// First claim succeeds and consumes the quote.
			await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("first"),
			});

			// Second claim, fresh idempotencyKey, against the same (now-consumed) quote.
			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("second"),
			});

			const body = await assertResponse<{ code: string }>(response, 422);
			expect(body.code).toBe("INVALID_QUOTE");
		});

		it("rejects a quote owned by another buyer with 422 INVALID_QUOTE", async () => {
			const seller = await setupSellerWithListing();
			const buyerA = await setupReadyBuyer();
			const buyerB = await setupReadyBuyer();
			const quoteAId = await createQuoteFor(buyerA.api, [seller.listing.id]);

			const response = await postClaim(buyerB.api, {
				quoteId: quoteAId,
				paymentMethodId: buyerB.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("wrong-buyer"),
			});

			const body = await assertResponse<{ code: string }>(response, 422);
			expect(body.code).toBe("INVALID_QUOTE");
		});

		it("returns 409 PRICE_CHANGED with newQuoteId when price drifts; original quote untouched", async () => {
			const seller = await setupSellerWithListing({
				price: 50,
				itemType: "digital",
			});
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			// Listing price jumps after the quote was built.
			await prisma.listing.update({
				where: { id: seller.listing.id },
				data: { price: new Prisma.Decimal(99) },
			});

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("drift"),
			});

			const body = await assertResponse<{
				code: string;
				data: {
					newQuoteId: string;
					oldTotalCents: number;
					newTotalCents: number;
					diffByListing: Array<{
						listingId: string;
						oldTotals: { totalCents: number };
						newTotals: { totalCents: number };
					}>;
				};
			}>(response, 409);
			expect(body.code).toBe("PRICE_CHANGED");
			expect(body.data.oldTotalCents).toBe(5000);
			expect(body.data.newTotalCents).toBe(9900);
			expect(body.data.diffByListing).toHaveLength(1);
			expect(body.data.diffByListing[0]?.listingId).toBe(seller.listing.id);

			// Original quote NOT consumed; listing NOT reserved.
			const oldQuote = await prisma.checkoutQuote.findUniqueOrThrow({
				where: { id: quoteId },
			});
			expect(oldQuote.consumedByOrderId).toBeNull();
			const listing = await prisma.listing.findUniqueOrThrow({
				where: { id: seller.listing.id },
			});
			expect(listing.status).toBe(ListingStatus.active);

			// New quote was created with the fresh totals — buyer can re-confirm.
			const newQuote = await prisma.checkoutQuote.findUniqueOrThrow({
				where: { id: body.data.newQuoteId },
			});
			expect(newQuote.totalCents).toBe(9900);
			expect(newQuote.buyerId).toBe(buyer.session.user.id);
		});

		it("buyer can re-claim with the newQuoteId returned on price drift", async () => {
			const seller = await setupSellerWithListing({
				price: 50,
				itemType: "digital",
			});
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			await prisma.listing.update({
				where: { id: seller.listing.id },
				data: { price: new Prisma.Decimal(99) },
			});

			const drift = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("drift"),
			});
			const driftBody = await assertResponse<{
				data: { newQuoteId: string };
			}>(drift, 409);

			const retry = await postClaim(buyer.api, {
				quoteId: driftBody.data.newQuoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("retry"),
			});
			const retryBody = await assertResponse<{ orderIds: string[] }>(
				retry,
				200,
			);
			expect(retryBody.orderIds).toHaveLength(1);
		});
	});

	describe("idempotency replay", () => {
		it("replay path A — same key with PI already linked returns the same Order + same clientSecret", async () => {
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			const idempotencyKey = uniqueIdempotencyKey("replay-a");

			const first = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey,
			});
			const firstBody = await assertResponse<{
				orderIds: string[];
				clientSecret: string;
				paymentIntentId: string;
			}>(first, 200);

			const second = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey,
			});
			const secondBody = await assertResponse<{
				orderIds: string[];
				clientSecret: string;
				paymentIntentId: string;
			}>(second, 200);

			expect(secondBody.orderIds).toEqual(firstBody.orderIds);
			expect(secondBody.paymentIntentId).toBe(firstBody.paymentIntentId);
			expect(secondBody.clientSecret).toBe(firstBody.clientSecret);

			// Exactly one Order exists.
			const orders = await prisma.order.findMany({
				where: {
					buyerId: buyer.session.user.id,
					idempotencyKey,
				},
			});
			expect(orders).toHaveLength(1);
		});

		it("replay path A — returns 410 when the linked PaymentIntent is canceled", async () => {
			const mockPayments = getMockPayments();
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			const idempotencyKey = uniqueIdempotencyKey("replay-a-410");

			const first = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey,
			});
			const firstBody = await assertResponse<{ paymentIntentId: string }>(
				first,
				200,
			);

			mockPayments._setPaymentIntentStatus(
				firstBody.paymentIntentId,
				"canceled",
			);

			const second = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey,
			});
			expect(second.statusCode).toBe(410);
			const body = (await second.json()) as { code: string };
			expect(body.code).toBe("REPLAY_PI_TERMINAL");
		});

		it("replay path B — Stripe failed mid-claim, retry resumes and links the same Orders", async () => {
			const mockPayments = getMockPayments();
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			const idempotencyKey = uniqueIdempotencyKey("replay-b");

			// First attempt: Tx A succeeds, Stripe call fails.
			mockPayments._failNextCheckoutPaymentIntent({
				success: false,
				error: "payment_failed",
				message: "simulated stripe failure",
			});

			const first = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey,
			});
			expect(first.statusCode).toBe(500);

			// Orders exist with paymentIntentId=null; quote consumed; listing reserved.
			const ordersAfterFail = await prisma.order.findMany({
				where: {
					buyerId: buyer.session.user.id,
					idempotencyKey,
				},
			});
			expect(ordersAfterFail).toHaveLength(1);
			expect(ordersAfterFail[0]?.paymentIntentId).toBeNull();
			const listingAfterFail = await prisma.listing.findUniqueOrThrow({
				where: { id: seller.listing.id },
			});
			expect(listingAfterFail.status).toBe(ListingStatus.reserved);

			// Retry — replay path B fires; Stripe call succeeds this time.
			const retry = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey,
			});
			const retryBody = await assertResponse<{
				orderIds: string[];
				paymentIntentId: string;
			}>(retry, 200);
			expect(retryBody.orderIds).toEqual([ordersAfterFail[0]?.id]);

			const linkedOrder = await prisma.order.findUniqueOrThrow({
				where: { id: retryBody.orderIds[0] },
			});
			expect(linkedOrder.paymentIntentId).toBe(retryBody.paymentIntentId);
		});

		it("Stripe rate limit on first attempt → 429, retry succeeds", async () => {
			const mockPayments = getMockPayments();
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			const idempotencyKey = uniqueIdempotencyKey("rate-limit");

			mockPayments._failNextCheckoutPaymentIntent({
				success: false,
				error: "rate_limit_exceeded",
				message: "Stripe rate limit exceeded",
			});

			const first = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey,
			});
			expect(first.statusCode).toBe(429);

			const retry = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey,
			});
			await assertResponse(retry, 200);
		});
	});

	describe("business rules", () => {
		it("self-purchase (buyer === seller) → 403 SELF_PURCHASE", async () => {
			// Build a user who is both an onboarded seller and a checkout-ready buyer.
			const seller = await createTestSellerUser({ onboarded: true });
			await fixtures.users.createPaymentMethod(seller.user.id);
			await prisma.userBilling.update({
				where: { userId: seller.user.id },
				data: { customerId: `cus_test_${Date.now()}` },
			});
			const fresh = await signInUser({
				email: seller.user.email,
				password: seller.password,
			});
			const api = createApiClient(fresh);
			const sellerProfile = await prisma.sellerProfile.findUniqueOrThrow({
				where: { userId: seller.user.id },
			});
			const listing = await createFixedPriceListingForSeller(sellerProfile.id);
			const pm = await prisma.paymentMethod.findFirstOrThrow({
				where: { userBilling: { userId: seller.user.id } },
			});

			const quoteId = await createQuoteFor(api, [listing.id]);
			const response = await postClaim(api, {
				quoteId,
				paymentMethodId: pm.id,
				idempotencyKey: uniqueIdempotencyKey("self"),
			});

			const body = await assertResponse<{ code: string }>(response, 403);
			expect(body.code).toBe("SELF_PURCHASE");

			// Listing is NOT reserved (the guard fires before reservation).
			const refreshed = await prisma.listing.findUniqueOrThrow({
				where: { id: listing.id },
			});
			expect(refreshed.status).toBe(ListingStatus.active);
		});

		it("buyer with no Stripe customerId → 400 BUYER_MISSING_WALLET", async () => {
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			// Strip the customerId we set up.
			await prisma.userBilling.update({
				where: { userId: buyer.session.user.id },
				data: { customerId: null },
			});

			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("no-customer"),
			});

			const body = await assertResponse<{ code: string }>(response, 400);
			expect(body.code).toBe("BUYER_MISSING_WALLET");
		});

		it("unknown paymentMethodId → 400 PAYMENT_METHOD_NOT_FOUND", async () => {
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: "pm-does-not-belong-to-this-buyer",
				idempotencyKey: uniqueIdempotencyKey("bad-pm"),
			});

			const body = await assertResponse<{ code: string }>(response, 400);
			expect(body.code).toBe("PAYMENT_METHOD_NOT_FOUND");
		});

		it("shipping address deleted between quote and claim → 400 SHIPPING_ADDRESS_NOT_FOUND, quote unconsumed", async () => {
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			// Buyer manages their addresses and removes the one referenced by the quote.
			// The quote's `shippingAddressId` is a plain string with no FK, so this
			// doesn't cascade — claim re-fetches and fails closed.
			await prisma.user.update({
				where: { id: buyer.session.user.id },
				data: { defaultShippingAddressId: null },
			});
			await prisma.shippingAddress.delete({
				where: { id: buyer.shippingAddressId },
			});

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("addr-gone"),
			});

			const body = await assertResponse<{ code: string }>(response, 400);
			expect(body.code).toBe("SHIPPING_ADDRESS_NOT_FOUND");

			const quote = await prisma.checkoutQuote.findUniqueOrThrow({
				where: { id: quoteId },
			});
			expect(quote.consumedByOrderId).toBeNull();
		});

		it("seller with no shipping-from address → 400 SELLER_MISSING_SHIP_FROM", async () => {
			const seller = await setupSellerWithListing();
			// Detach the seller's ship-from to simulate the V1 invariant violation.
			await prisma.sellerProfile.update({
				where: { id: seller.sellerProfileId },
				data: { shippingFromAddressId: null },
			});
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("no-ship-from"),
			});

			const body = await assertResponse<{ code: string }>(response, 400);
			expect(body.code).toBe("SELLER_MISSING_SHIP_FROM");
		});
	});
});
