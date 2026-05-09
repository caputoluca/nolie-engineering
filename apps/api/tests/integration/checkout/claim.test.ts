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
	addPickupListingToSeller,
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

		it("returns 400 INVALID_IDEMPOTENCY_KEY_FORMAT for malformed keys", async () => {
			const buyer = await setupReadyBuyer();

			// Too short (15 chars) → 400.
			const tooShort = await postClaim(buyer.api, {
				quoteId: "irrelevant",
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: "abcdefghijklmno",
			});
			const tooShortBody = await assertResponse<{ code: string }>(
				tooShort,
				400,
			);
			expect(tooShortBody.code).toBe("INVALID_IDEMPOTENCY_KEY_FORMAT");

			// Disallowed character (space) → 400.
			const badChar = await postClaim(buyer.api, {
				quoteId: "irrelevant",
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: "has space in middle of key",
			});
			const badCharBody = await assertResponse<{ code: string }>(badChar, 400);
			expect(badCharBody.code).toBe("INVALID_IDEMPOTENCY_KEY_FORMAT");

			// Too long (65 chars) → 400.
			const tooLong = await postClaim(buyer.api, {
				quoteId: "irrelevant",
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: "a".repeat(65),
			});
			const tooLongBody = await assertResponse<{ code: string }>(tooLong, 400);
			expect(tooLongBody.code).toBe("INVALID_IDEMPOTENCY_KEY_FORMAT");
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

			// Fee math, single-line. Default platformFeeRate is 0.20 (see
			// `createFixedPriceListingForSeller` fixture). Mock tax is 8% of price.
			// Processing pass-through temporarily zeroed (see @nolie/config) —
			// platform absorbs the actual Stripe fee for the May 2026 promo.
			expect(order.subtotalCents).toBe(5000);
			expect(order.shippingCents).toBe(500);
			expect(order.taxCents).toBe(400);
			expect(order.applicationFeeCents).toBe(1000); // 20% of 5000
			expect(order.processingFeeCents).toBe(0);
			expect(order.totalCents).toBe(5900);
			expect(order.lineItems[0]?.priceCents).toBe(5000);
			expect(order.lineItems[0]?.applicationFeeCents).toBe(1000);
			expect(order.lineItems[0]?.processingFeeCents).toBe(0);
			expect(order.lineItems[0]?.sellerEarningCents).toBe(4000); // 5000 - 1000
			expect(order.lineItems[0]?.taxCents).toBe(400);

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

			// Fee math: $30 + $70 at 20% rate. Per-line fees ($600 + $1400) sum
			// to the Order aggregate. Bundle shipping = max(200, 200) = 200.
			// Processing pass-through temporarily zeroed (see @nolie/config).
			expect(order.subtotalCents).toBe(10000);
			expect(order.applicationFeeCents).toBe(2000);
			expect(order.processingFeeCents).toBe(0);
			expect(order.shippingCents).toBe(200);
			expect(order.taxCents).toBe(800); // 8% of subtotal
			expect(order.totalCents).toBe(11000);

			// Per-line fees are computed independently — catches a regression
			// where we'd accidentally compute the fee on the bundle total.
			const line30 = order.lineItems.find((l) => l.priceCents === 3000);
			const line70 = order.lineItems.find((l) => l.priceCents === 7000);
			expect(line30?.applicationFeeCents).toBe(600);
			expect(line30?.processingFeeCents).toBe(0);
			expect(line30?.sellerEarningCents).toBe(2400); // 3000 - 600
			expect(line70?.applicationFeeCents).toBe(1400);
			expect(line70?.processingFeeCents).toBe(0);
			expect(line70?.sellerEarningCents).toBe(5600); // 7000 - 1400

			// Order aggregates are the sum of per-line values.
			const lineFeesSum = order.lineItems.reduce(
				(s, l) => s + l.applicationFeeCents,
				0,
			);
			const lineProcessingSum = order.lineItems.reduce(
				(s, l) => s + l.processingFeeCents,
				0,
			);
			const linePricesSum = order.lineItems.reduce(
				(s, l) => s + l.priceCents,
				0,
			);
			expect(order.applicationFeeCents).toBe(lineFeesSum);
			expect(order.processingFeeCents).toBe(lineProcessingSum);
			expect(order.subtotalCents).toBe(linePricesSum);

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

	describe("cart hand-off", () => {
		it("leaves the cart intact on a successful claim — cart clear rides the payment_intent.succeeded webhook", async () => {
			const sellerA = await setupSellerWithListing({ price: 50 });
			const sellerB = await setupSellerWithListing({ price: 75 });
			const buyer = await setupReadyBuyer();

			await buyer.api.post("/cart", { listingId: sellerA.listing.id });
			await buyer.api.post("/cart", { listingId: sellerB.listing.id });

			const quoteId = await createQuoteFor(buyer.api, [
				sellerA.listing.id,
				sellerB.listing.id,
			]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("cart-untouched-claim"),
			});
			await assertResponse(response, 200);

			// Claim only creates Orders + PI; the actual charge happens on
			// stripe.confirmPayment. Cart drop must wait for the webhook so a
			// card decline doesn't leave the buyer with an empty cart and no
			// money taken.
			const stillThere = await prisma.cartItem.findMany({
				where: { buyerId: buyer.session.user.id },
				select: { listingId: true },
			});
			expect(stillThere.map((r) => r.listingId).sort()).toEqual(
				[sellerA.listing.id, sellerB.listing.id].sort(),
			);
		});

		it("keeps cart intact when claim fails before Tx A (unknown paymentMethodId)", async () => {
			const seller = await setupSellerWithListing({ price: 50 });
			const buyer = await setupReadyBuyer();
			await buyer.api.post("/cart", { listingId: seller.listing.id });

			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: "pm-does-not-exist",
				idempotencyKey: uniqueIdempotencyKey("cart-keep"),
			});
			expect(response.statusCode).toBe(400);

			const stillThere = await prisma.cartItem.findMany({
				where: { buyerId: buyer.session.user.id },
				select: { listingId: true },
			});
			expect(stillThere.map((r) => r.listingId)).toEqual([seller.listing.id]);
		});

		it("keeps cart intact when Stripe PI creation fails after Tx A — buyer's cart survives the failure", async () => {
			const mockPayments = getMockPayments();
			const seller = await setupSellerWithListing({ price: 50 });
			const buyer = await setupReadyBuyer();

			await buyer.api.post("/cart", { listingId: seller.listing.id });

			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			const idempotencyKey = uniqueIdempotencyKey("cart-keep-pi-fail");

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

			// Orders exist (Tx A committed) but no money moved — cart must
			// stay so a refresh doesn't show an empty cart while the PI is
			// in limbo. The webhook is what eventually clears it.
			const afterFail = await prisma.cartItem.findMany({
				where: { buyerId: buyer.session.user.id },
				select: { listingId: true },
			});
			expect(afterFail.map((r) => r.listingId)).toEqual([seller.listing.id]);
		});
	});

	describe("happy path — pickup", () => {
		it("all-pickup claim creates an Order with pickup snapshot and null ship-to/ship-from", async () => {
			const seller = await setupSellerWithListing({
				price: 50,
				itemType: "physical",
				fulfillmentMode: "pickup",
			});
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("pickup-happy"),
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
			expect(order.fulfillmentMode).toBe("pickup");
			expect(order.shippingCents).toBe(0);

			// Ship-to and ship-from are null for pickup orders.
			expect(order.shipToName).toBeNull();
			expect(order.shipToLine1).toBeNull();
			expect(order.shipToCity).toBeNull();
			expect(order.shipFromName).toBeNull();
			expect(order.shipFromLine1).toBeNull();
			expect(order.shipFromCity).toBeNull();

			// Pickup snapshot is populated from the seller's PickupLocation.
			expect(order.pickupLocationId).toBe(seller.pickupLocation?.id);
			expect(order.pickupLocationName).toBe(seller.pickupLocation?.name);
			expect(order.pickupLine1).toBe(seller.pickupLocation?.line1);
			expect(order.pickupCity).toBe(seller.pickupLocation?.city);
			expect(order.pickupState).toBe(seller.pickupLocation?.state);
			expect(order.pickupPostalCode).toBe(seller.pickupLocation?.postalCode);
			expect(order.pickupCountry).toBe(seller.pickupLocation?.country);

			// Listing reserved as in the shipping happy path.
			const listing = await prisma.listing.findUniqueOrThrow({
				where: { id: seller.listing.id },
			});
			expect(listing.status).toBe(ListingStatus.reserved);
			expect(listing.reservedByOrderId).toBe(order.id);
		});

		it("all-pickup claim succeeds even when buyer has no shipping address", async () => {
			// SHIPPING_ADDRESS_NOT_FOUND must not fire when the quote is all-pickup
			// (CheckoutQuote.shippingAddressId is null in that case).
			const seller = await setupSellerWithListing({
				price: 50,
				itemType: "digital",
				fulfillmentMode: "pickup",
			});
			const buyer = await setupReadyBuyer({ withShippingAddress: false });
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("pickup-no-addr"),
			});

			const body = await assertResponse<{ orderIds: string[] }>(response, 200);
			expect(body.orderIds).toHaveLength(1);
		});

		it("all-pickup claim succeeds even when seller has no shippingFromAddress", async () => {
			// SELLER_MISSING_SHIP_FROM is only loaded for sellers with at least one
			// shipping group. A pure-pickup seller with no ship-from is fine.
			const seller = await setupSellerWithListing({
				price: 50,
				itemType: "digital",
				fulfillmentMode: "pickup",
			});
			await prisma.sellerProfile.update({
				where: { id: seller.sellerProfileId },
				data: { shippingFromAddressId: null },
			});

			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("pickup-no-shipfrom"),
			});

			await assertResponse(response, 200);
		});
	});

	describe("mixed-mode claim", () => {
		it("single seller with [ship + pickup] → 2 Orders sharing one PaymentIntent", async () => {
			// This is the canary for the schema unique-index change. The old
			// `@@unique([buyerId, idempotencyKey, sellerProfileId])` would block
			// the second insert; the migration replaced it with a partial index
			// on `(buyerId, idempotencyKey, sellerProfileId, fulfillmentMode,
			// pickupLocationId) NULLS NOT DISTINCT`, which permits the fan-out.
			const seller = await setupSellerWithListing({
				price: 50,
				itemType: "physical",
				shippingCostCents: 500,
			});
			const { listing: pickupListing, pickupLocation } =
				await addPickupListingToSeller(seller.sellerProfileId, {
					price: 40,
					itemType: "physical",
				});
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [
				seller.listing.id,
				pickupListing.id,
			]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("mixed-1seller"),
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
			// Shared PI across both Orders.
			const piIds = new Set(orders.map((o) => o.paymentIntentId));
			expect(piIds.size).toBe(1);
			expect([...piIds][0]).toBe(body.paymentIntentId);

			// Both Orders belong to the same seller, but split by mode.
			const shipping = orders.find((o) => o.fulfillmentMode === "shipping");
			const pickup = orders.find((o) => o.fulfillmentMode === "pickup");
			expect(shipping).toBeDefined();
			expect(pickup).toBeDefined();
			expect(shipping?.sellerProfileId).toBe(seller.sellerProfileId);
			expect(pickup?.sellerProfileId).toBe(seller.sellerProfileId);

			// Shipping Order has ship-to/ship-from + zero pickup snapshot.
			expect(shipping?.shipToName).not.toBeNull();
			expect(shipping?.shipFromName).not.toBeNull();
			expect(shipping?.pickupLocationId).toBeNull();
			expect(shipping?.shippingCents).toBe(500);
			expect(shipping?.lineItems).toHaveLength(1);
			expect(shipping?.lineItems[0]?.listingId).toBe(seller.listing.id);

			// Pickup Order has pickup snapshot + null ship-to/ship-from.
			expect(pickup?.shipToName).toBeNull();
			expect(pickup?.shipFromName).toBeNull();
			expect(pickup?.pickupLocationId).toBe(pickupLocation.id);
			expect(pickup?.shippingCents).toBe(0);
			expect(pickup?.lineItems).toHaveLength(1);
			expect(pickup?.lineItems[0]?.listingId).toBe(pickupListing.id);
		});

		it("multi-seller mixed (one pickup seller, one shipping seller) → 2 Orders, 1 PI", async () => {
			const sellerShip = await setupSellerWithListing({
				price: 50,
				itemType: "physical",
				shippingCostCents: 500,
			});
			const sellerPickup = await setupSellerWithListing({
				price: 80,
				itemType: "physical",
				fulfillmentMode: "pickup",
			});
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [
				sellerShip.listing.id,
				sellerPickup.listing.id,
			]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("mixed-2seller"),
			});

			const body = await assertResponse<{
				orderIds: string[];
				paymentIntentId: string;
			}>(response, 200);
			expect(body.orderIds).toHaveLength(2);

			const orders = await prisma.order.findMany({
				where: { id: { in: body.orderIds } },
			});
			const shipOrder = orders.find(
				(o) => o.sellerProfileId === sellerShip.sellerProfileId,
			);
			const pickupOrder = orders.find(
				(o) => o.sellerProfileId === sellerPickup.sellerProfileId,
			);

			expect(shipOrder?.fulfillmentMode).toBe("shipping");
			expect(shipOrder?.shippingCents).toBe(500);
			expect(shipOrder?.shipToName).not.toBeNull();
			expect(shipOrder?.pickupLocationId).toBeNull();

			expect(pickupOrder?.fulfillmentMode).toBe("pickup");
			expect(pickupOrder?.shippingCents).toBe(0);
			expect(pickupOrder?.shipToName).toBeNull();
			expect(pickupOrder?.pickupLocationId).toBe(
				sellerPickup.pickupLocation?.id,
			);

			// Single PaymentIntent across the whole bundle.
			expect(shipOrder?.paymentIntentId).toBe(pickupOrder?.paymentIntentId);
			expect(shipOrder?.paymentIntentId).toBe(body.paymentIntentId);
		});
	});

	describe("fee math", () => {
		it("computes applicationFeeCents per-line from each listing's own platformFeeRate", async () => {
			// Same seller, two listings with different fee rates. The per-line
			// fee uses the listing's own rate; the Order aggregate is the sum.
			// Catches a regression where we'd accidentally apply one rate to
			// the whole bundle.
			const seller = await setupSellerWithListing({
				price: 50,
				itemType: "physical",
				shippingCostCents: 0,
				platformFeeRate: 0.2,
			});
			const second = await createFixedPriceListingForSeller(
				seller.sellerProfileId,
				{ price: 100, itemType: "physical" },
			);
			await prisma.listing.update({
				where: { id: second.id },
				data: {
					shippingCostCents: 0,
					platformFeeRate: new Prisma.Decimal(0.1),
				},
			});
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [
				seller.listing.id,
				second.id,
			]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("fee-mixed"),
			});

			const body = await assertResponse<{ orderIds: string[] }>(response, 200);
			const order = await prisma.order.findUniqueOrThrow({
				where: { id: body.orderIds[0] },
				include: { lineItems: true },
			});

			// Per-line fees come from each listing's own rate.
			// Processing pass-through temporarily zeroed (see @nolie/config).
			const line50 = order.lineItems.find((l) => l.priceCents === 5000);
			const line100 = order.lineItems.find((l) => l.priceCents === 10000);
			expect(line50?.applicationFeeCents).toBe(1000); // 20% of 5000
			expect(line50?.processingFeeCents).toBe(0);
			expect(line50?.sellerEarningCents).toBe(4000); // 5000 - 1000
			expect(line100?.applicationFeeCents).toBe(1000); // 10% of 10000
			expect(line100?.processingFeeCents).toBe(0);
			expect(line100?.sellerEarningCents).toBe(9000); // 10000 - 1000

			// Order aggregate is the sum.
			expect(order.applicationFeeCents).toBe(2000);
			expect(order.processingFeeCents).toBe(0);
			expect(order.subtotalCents).toBe(15000);
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

		it("replay path A — re-attaches the saved card when the PI is in requires_payment_method (post-decline retry)", async () => {
			// After a card decline, Stripe transitions the PI to
			// `requires_payment_method` and clears the PM slot. Without
			// re-attaching, the next stripe.confirmPayment hits Stripe with no
			// PM and surfaces a generic processing-error. Replay must put the
			// saved card back so the retry actually attempts a charge.
			const mockPayments = getMockPayments();
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			const idempotencyKey = uniqueIdempotencyKey("replay-a-reattach");

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

			mockPayments._setPaymentIntentStatus(
				firstBody.paymentIntentId,
				"requires_payment_method",
			);

			const retry = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey,
			});
			const retryBody = await assertResponse<{
				orderIds: string[];
				clientSecret: string;
				paymentIntentId: string;
			}>(retry, 200);

			expect(retryBody.paymentIntentId).toBe(firstBody.paymentIntentId);
			expect(retryBody.orderIds).toEqual(firstBody.orderIds);

			const updateCalls = mockPayments._getOperationsOfType(
				"customer.updatePaymentIntent",
			);
			expect(updateCalls).toHaveLength(1);
			expect(updateCalls[0]?.params).toMatchObject({
				paymentIntentId: firstBody.paymentIntentId,
			});

			const piAfter = mockPayments._getPaymentIntent(firstBody.paymentIntentId);
			expect(piAfter?.status).toBe("requires_confirmation");
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

		it("replay with a different paymentMethodId → 422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", async () => {
			// Stripe-pattern guard: reusing the same idempotency key with a
			// different payload (here: a fresh paymentMethodId) is an SPA bug —
			// silently confirming the original cart on the wrong card is worse
			// than refusing.
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			const idempotencyKey = uniqueIdempotencyKey("payload-mismatch-pm");

			await assertResponse(
				await postClaim(buyer.api, {
					quoteId,
					paymentMethodId: buyer.paymentMethodId,
					idempotencyKey,
				}),
				200,
			);

			// Fresh payment method on the same buyer → different payload hash.
			const freshPm = await fixtures.users.createPaymentMethod(
				buyer.session.user.id,
			);

			const replay = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: freshPm.id,
				idempotencyKey,
			});

			const body = await assertResponse<{ code: string }>(replay, 422);
			expect(body.code).toBe("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
		});

		it("replay with a different quoteId → 422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", async () => {
			const sellerA = await setupSellerWithListing();
			const sellerB = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteA = await createQuoteFor(buyer.api, [sellerA.listing.id]);
			const quoteB = await createQuoteFor(buyer.api, [sellerB.listing.id]);
			const idempotencyKey = uniqueIdempotencyKey("payload-mismatch-quote");

			await assertResponse(
				await postClaim(buyer.api, {
					quoteId: quoteA,
					paymentMethodId: buyer.paymentMethodId,
					idempotencyKey,
				}),
				200,
			);

			const replay = await postClaim(buyer.api, {
				quoteId: quoteB,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey,
			});

			const body = await assertResponse<{ code: string }>(replay, 422);
			expect(body.code).toBe("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
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

		it("non-US ship-to at claim time → 422 SHIPPING_COUNTRY_NOT_SUPPORTED, no PI created", async () => {
			const seller = await setupSellerWithListing();
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);
			const mockPayments = getMockPayments();

			// Defense-in-depth: quote.ts already gates non-US, but the claim
			// handler must refuse if the address row referenced by the quote is
			// mutated to non-US between quote and claim. Simulate by flipping
			// the US address to a non-US country directly.
			await prisma.shippingAddress.update({
				where: { id: buyer.shippingAddressId },
				data: { country: "CA", state: "ON", postalCode: "M5H 1A1" },
			});

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("claim-intl"),
			});

			const body = await assertResponse<{ code: string }>(response, 422);
			expect(body.code).toBe("SHIPPING_COUNTRY_NOT_SUPPORTED");

			// No Stripe call, no Order rows.
			expect(
				mockPayments.customer.createCheckoutPaymentIntent,
			).not.toHaveBeenCalled();
			const orders = await prisma.order.findMany({
				where: { buyerId: buyer.session.user.id },
			});
			expect(orders).toHaveLength(0);
		});
	});

	describe("letter shipping (PWE / NL-253)", () => {
		// At claim time the per-seller bundle is classified onto a shipping
		// rail — letter (EasyPost FCML), letter-upgraded-to-parcel (Shippo
		// with a standard_card fallback), or default parcel (Shippo with the
		// listing's own dims). The decision is frozen on Order.shippingPresetKey
		// so PI-succeeded + label-purchase don't re-derive it.

		it("single letter listing produces an Order on the letter rail charged at the flat $1.49", async () => {
			const seller = await setupSellerWithListing({
				price: 10,
				itemType: "physical",
				shippingCostCents: 149,
			});
			await prisma.listing.update({
				where: { id: seller.listing.id },
				data: { shippingPresetKey: "raw_single_pwe" },
			});
			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [seller.listing.id]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("letter-single"),
			});

			const body = await assertResponse<{ orderIds: string[] }>(response, 200);
			const order = await prisma.order.findUniqueOrThrow({
				where: { id: body.orderIds[0] },
			});
			expect(order.shippingPresetKey).toBe("raw_single_pwe");
			expect(order.shippingCents).toBe(149);
		});

		it("six-card all-letter bundle auto-upgrades to a standard_card parcel at the fallback rate", async () => {
			// Letter shipping caps at 5 cards (USPS FCML weight tiers + bend
			// test). A 6th letter listing in the bundle pushes it over the
			// limit; checkout flips the rail to a default parcel preset
			// (`standard_card`) so the seller can ship in a bubble mailer
			// instead of an envelope. The buyer is charged the parcel
			// fallback rate, not 6× the letter rate.
			const seller = await setupSellerWithListing({
				price: 8,
				itemType: "physical",
				shippingCostCents: 149,
			});
			await prisma.listing.update({
				where: { id: seller.listing.id },
				data: { shippingPresetKey: "raw_single_pwe" },
			});
			const extraIds: string[] = [];
			for (let i = 0; i < 5; i++) {
				const extra = await createFixedPriceListingForSeller(
					seller.sellerProfileId,
					{ price: 8, itemType: "physical" },
				);
				await prisma.listing.update({
					where: { id: extra.id },
					data: {
						shippingPresetKey: "raw_single_pwe",
						shippingCostCents: 149,
					},
				});
				extraIds.push(extra.id);
			}

			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [
				seller.listing.id,
				...extraIds,
			]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("letter-upgrade"),
			});

			const body = await assertResponse<{ orderIds: string[] }>(response, 200);
			const order = await prisma.order.findUniqueOrThrow({
				where: { id: body.orderIds[0] },
				include: { lineItems: true },
			});
			expect(order.lineItems).toHaveLength(6);
			expect(order.shippingPresetKey).toBe("standard_card");
			expect(order.shippingCents).toBe(650);
		});

		it("mixed letter + parcel bundle stays on the parcel rail with bundle-max shipping", async () => {
			// Regression: a single non-letter listing in the bundle disables
			// the letter rail. Bundle ships as parcel using the existing
			// `max(item.shippingCents)` math — no upgrade needed because the
			// seller already priced for parcel on at least one item.
			const seller = await setupSellerWithListing({
				price: 10,
				itemType: "physical",
				shippingCostCents: 149,
			});
			await prisma.listing.update({
				where: { id: seller.listing.id },
				data: { shippingPresetKey: "raw_single_pwe" },
			});
			const parcelListing = await createFixedPriceListingForSeller(
				seller.sellerProfileId,
				{ price: 25, itemType: "physical" },
			);
			await prisma.listing.update({
				where: { id: parcelListing.id },
				data: {
					shippingPresetKey: "standard_card",
					shippingCostCents: 500,
				},
			});

			const buyer = await setupReadyBuyer();
			const quoteId = await createQuoteFor(buyer.api, [
				seller.listing.id,
				parcelListing.id,
			]);

			const response = await postClaim(buyer.api, {
				quoteId,
				paymentMethodId: buyer.paymentMethodId,
				idempotencyKey: uniqueIdempotencyKey("letter-mixed"),
			});

			const body = await assertResponse<{ orderIds: string[] }>(response, 200);
			const order = await prisma.order.findUniqueOrThrow({
				where: { id: body.orderIds[0] },
			});
			expect(order.shippingPresetKey).toBeNull();
			// max(149, 500) — parcel item dictates the bundle rate.
			expect(order.shippingCents).toBe(500);
		});
	});
});
