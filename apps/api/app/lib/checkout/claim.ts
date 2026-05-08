import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@nolie/db";
import { errors, HttpError } from "@nolie/errors/http";
import { joinName } from "@nolie/lib/name";
import { PaymentErrorCode, type PaymentsClient } from "@nolie/payments";
import { isStripeRateLimitError } from "@nolie/payments/utils";
import type {
	CheckoutClaimSuccess,
	CheckoutLineTotals,
} from "@nolie/schemas/checkout/claim";
import { CheckoutClaimErrorCode } from "@nolie/schemas/checkout/claim";
import type { FulfillmentMethodType } from "@nolie/schemas/fulfillment";
import { COUNTRY_CODE_US } from "../../constants/country.js";
import { logger } from "../../logger.js";
import { apiTx } from "../db/tx.js";
import { setReportingContext } from "../observability/sentry/report.js";
import { BUNDLE_SHIPPING_FORMULA } from "./bundle-shipping.js";
import {
	buildAndValidateGroups,
	type CheckoutListingTotals,
	type ComputedCheckoutTotals,
	type ComputedFulfillmentGroup,
	computeCheckoutTotals,
} from "./compute-totals.js";
import {
	computeIdempotencyPayloadHash,
	validateIdempotencyKeyFormat,
} from "./idempotency.js";
import { type CheckoutListing, loadCheckoutListings } from "./listings.js";
import {
	type MaterializationGroup,
	materializeOrders,
	type PickupSnapshot,
	type ShipFromSnapshot,
	type ShipToSnapshot,
} from "./materialize-orders.js";
import { reserveListings } from "./reserve.js";

/** Claim-before-charge hold — see flat-pricing-bin-checkout.md "Reservation TTL". */
const RESERVATION_TTL_MS = 10 * 60 * 1000;

interface ClaimInput {
	db: PrismaClient;
	payments: PaymentsClient;
	buyerId: string;
	body: {
		quoteId: string;
		paymentMethodId: string;
		idempotencyKey: string;
	};
}

/**
 * Brandur-pattern claim: atomic local writes first, foreign API call second.
 *
 *   Tx A      consume quote, reserve listings, bulk-create Orders (paymentIntentId=null)
 *   Stripe    create PaymentIntent (idempotency-keyed on body.idempotencyKey)
 *   Tx B      updateMany Orders to set paymentIntentId
 *
 * Abandonment safety net is the periodic checkout reservation reconciler
 * (apps/worker/app/checkout/reconciler.ts) — it scans `Listing.reservedUntil`
 * and cancels stuck PIs, which fires `payment_intent.canceled` for the
 * existing webhook to handle. No per-claim BullMQ job needed.
 *
 * Stripe's idempotency key turns retries into the recovery mechanism — no
 * explicit compensating cancel needed. If the process crashes between Tx A
 * and Tx B, a buyer retry replays through `replayIfExists` which detects
 * the null-PI Orders and resumes from the Stripe call onward.
 */
export async function claimCheckout(
	input: ClaimInput,
): Promise<CheckoutClaimSuccess> {
	const { db, payments, buyerId, body } = input;

	// 0) Validate idempotency key format up-front. Cheap synchronous check —
	//    rejects low-entropy / malformed keys before they hit any DB or Stripe
	//    work. Stripe / Square / AWS / IETF-draft pattern.
	validateIdempotencyKeyFormat(body.idempotencyKey);

	// 0b) Compute the canonical payload hash once. Used twice:
	//      - on replay: compare to the stored hash; mismatch → 422
	//      - on fresh insert: persisted on Order so future replays can compare
	const payloadHash = computeIdempotencyPayloadHash({
		quoteId: body.quoteId,
		paymentMethodId: body.paymentMethodId,
	});

	// 1) Idempotency replay — same buyer + same key returns the same Order set
	//    and the same PI clientSecret. Handles two replay scenarios:
	//      a) Orders + paymentIntentId set → just return clientSecret.
	//      b) Orders + paymentIntentId null → previous attempt died between Tx A
	//         and Tx B; resume from the Stripe call.
	const replay = await replayIfExists({
		db,
		payments,
		buyerId,
		body,
		incomingPayloadHash: payloadHash,
	});
	if (replay) return replay;

	// 2) Pre-flight reads (no tx — fast lookups, run in parallel).
	const quote = ensureQuoteUsable(
		await db.checkoutQuote.findUnique({
			where: { id: body.quoteId },
			include: { lines: true },
		}),
		buyerId,
	);

	const listingIds = quote.lines.map((l) => l.listingId);

	// Buyer fulfillment choices come from the persisted quote lines — at claim
	// time we trust the snapshot. Fulfillment changes require a fresh quote;
	// the claim body never overrides.
	const buyerChoiceByListing = new Map<string, FulfillmentMethodType>(
		quote.lines.map((l) => [l.listingId, asResolvedMethod(l.fulfillmentMode)]),
	);

	const [listings, buyer] = await Promise.all([
		loadCheckoutListings(db, listingIds),
		db.user.findUnique({
			where: { id: buyerId },
			select: {
				email: true,
				phone: true,
				taxExemptStatus: true,
				billing: {
					select: {
						customerId: true,
						paymentMethods: {
							where: { id: body.paymentMethodId },
							select: {
								id: true,
								stripePaymentMethodId: true,
								brand: true,
								last4: true,
							},
							take: 1,
						},
					},
				},
				shippingAddresses: quote.shippingAddressId
					? {
							where: { id: quote.shippingAddressId },
							select: {
								id: true,
								fullName: true,
								line1: true,
								line2: true,
								city: true,
								state: true,
								postalCode: true,
								country: true,
							},
							take: 1,
						}
					: false,
			},
		}),
	]);

	const customerId = buyer?.billing?.customerId;
	if (!buyer || !customerId) {
		throw errors.badRequest(
			"Buyer is missing a Stripe customer. Set up payment first.",
			{ code: "BUYER_MISSING_WALLET" },
		);
	}
	const paymentMethod = buyer.billing?.paymentMethods[0];
	if (!paymentMethod) {
		throw errors.badRequest("Payment method not found for this buyer", {
			code: "PAYMENT_METHOD_NOT_FOUND",
		});
	}

	const shipAddress =
		quote.shippingAddressId && buyer.shippingAddresses
			? (buyer.shippingAddresses[0] ?? null)
			: null;
	if (quote.shippingAddressId && !shipAddress) {
		throw errors.badRequest("Shipping address not found for this buyer", {
			code: "SHIPPING_ADDRESS_NOT_FOUND",
		});
	}

	// 3) Self-purchase guard — never allow buyer to claim their own listing.
	for (const l of listings) {
		if (l.sellerUserId === buyerId) {
			throw errors.forbidden("Cannot purchase your own listing", {
				code: CheckoutClaimErrorCode.self_purchase,
			});
		}
	}

	// 3b) Country gate (defense-in-depth) — quote.ts surfaces a non-blocking
	// flag so the FE disables Place Order; claim refuses to materialize an
	// Order with a non-US ship-to. Only checked when there's a ship line: a
	// 100%-pickup quote requires no buyer ship address.
	const hasShipLine = Array.from(buyerChoiceByListing.values()).some(
		(m) => m === "shipping",
	);
	if (
		hasShipLine &&
		shipAddress &&
		shipAddress.country.toUpperCase() !== COUNTRY_CODE_US
	) {
		throw new HttpError(
			"Shipping is only available within the United States",
			CheckoutClaimErrorCode.shipping_country_not_supported,
			{ statusCode: 422 },
		);
	}

	// 4) Pickup snapshots — full address fields needed for both Order pickup
	//    snapshot AND tax-address fallback when there's no ship-to.
	const pickupSnapshotByLocationId = await loadPickupSnapshots(db, listings);

	// 5) Resolve the tax address. Mirror quote-time logic: if any ship line, use
	//    buyer ship-to; else first pickup location.
	const taxAddress = resolveClaimTaxAddress({
		listings,
		buyerChoiceByListing,
		shipAddress,
		pickupSnapshotByLocationId,
	});
	if (!taxAddress) {
		throw errors.badRequest(
			"Cannot resolve a tax address for this checkout (no ship-to and no pickup location available)",
			{ code: "TAX_ADDRESS_UNRESOLVED" },
		);
	}

	// 6) Recompute fresh totals + drift check. Group + validate upfront so
	//    a stale fulfillment choice (listing's mode/pickup-location changed
	//    after the quote) fails fast with 422.
	const { items: groupableItems, groups: validatedGroups } =
		buildAndValidateGroups(listings, buyerChoiceByListing);
	const fresh = await computeCheckoutTotals({
		listings,
		items: groupableItems,
		groups: validatedGroups,
		taxAddress,
		taxExempt: buyer.taxExemptStatus === "approved",
		payments,
	});

	const drift = computeDrift(quote.lines, fresh.perListing);
	if (drift) {
		const newQuote = await db.checkoutQuote.create({
			data: {
				buyerId,
				shippingAddressId: shipAddress?.id ?? null,
				totalCents: fresh.totalCents,
				taxCalculationId: fresh.taxCalculationId,
				cartHash: quote.cartHash,
				expiresAt: quote.expiresAt,
				lines: {
					createMany: {
						data: fresh.perListing.map((p) => ({
							listingId: p.listingId,
							fulfillmentMode: p.fulfillmentMode,
							priceCents: p.priceCents,
							taxCents: p.taxCents,
							shippingCents: p.shippingCents,
							totalCents: p.totalCents,
						})),
					},
				},
			},
			select: { id: true },
		});
		throw new HttpError(
			"Prices changed since quote",
			CheckoutClaimErrorCode.price_changed,
			{
				statusCode: 409,
				data: {
					newQuoteId: newQuote.id,
					oldTotalCents: quote.totalCents,
					newTotalCents: fresh.totalCents,
					diffByListing: drift,
				},
			},
		);
	}

	// 7) Build materialization groups — one Order per fulfillment group.
	const listingsById = new Map(listings.map((l) => [l.id, l]));
	const materializationGroups: MaterializationGroup[] = fresh.groups.map(
		(g) => ({
			orderId: randomUUID(),
			sellerProfileId: g.sellerProfileId,
			fulfillmentMode: g.fulfillmentMode,
			listings: g.listingIds
				.map((id) => listingsById.get(id))
				.filter((l): l is CheckoutListing => l !== undefined),
		}),
	);

	const sellerProfileIdsWithShipGroup = new Set(
		fresh.groups
			.filter((g) => g.fulfillmentMode === "shipping")
			.map((g) => g.sellerProfileId),
	);
	const shipFromBySellerProfile = await loadShipFromBySellerProfile(
		db,
		Array.from(sellerProfileIdsWithShipGroup),
	);

	const shipTo: ShipToSnapshot | null = shipAddress
		? {
				name: shipAddress.fullName,
				line1: shipAddress.line1,
				line2: shipAddress.line2,
				city: shipAddress.city,
				state: shipAddress.state,
				postalCode: shipAddress.postalCode,
				country: shipAddress.country,
				phone: buyer.phone,
			}
		: null;

	const totalsByListingId = new Map(
		fresh.perListing.map((t) => [t.listingId, t]),
	);
	const consumedMarkerOrderId = materializationGroups[0]?.orderId;
	if (!consumedMarkerOrderId) {
		throw errors.internal("No fulfillment groups in claim", {
			code: "NO_FULFILLMENT_GROUPS",
		});
	}
	const reservedUntil = new Date(Date.now() + RESERVATION_TTL_MS);

	// 8) Tx A — atomic DB writes only. Fast (no external calls).
	const { orderIds } = await apiTx(db, async (tx) => {
		const consumed = await tx.checkoutQuote.updateMany({
			where: {
				id: quote.id,
				buyerId,
				consumedByOrderId: null,
				expiresAt: { gt: new Date() },
			},
			data: { consumedByOrderId: consumedMarkerOrderId },
		});
		if (consumed.count === 0) {
			const refresh = await tx.checkoutQuote.findUnique({
				where: { id: quote.id },
				select: { expiresAt: true },
			});
			if (refresh && refresh.expiresAt < new Date()) {
				throw new HttpError(
					"Quote expired",
					CheckoutClaimErrorCode.quote_expired,
					{ statusCode: 410 },
				);
			}
			throw new HttpError(
				"Quote is no longer valid",
				CheckoutClaimErrorCode.invalid_quote,
				{ statusCode: 422 },
			);
		}

		const { unavailableListingIds } = await reserveListings(tx, {
			groups: materializationGroups.map((g) => ({
				orderId: g.orderId,
				listingIds: g.listings.map((l) => l.id),
			})),
			reservedUntil,
		});
		if (unavailableListingIds.length > 0) {
			throw new HttpError(
				"Some listings became unavailable",
				CheckoutClaimErrorCode.unavailable_listings,
				{
					statusCode: 409,
					data: { unavailableListingIds },
				},
			);
		}

		const materialized = await materializeOrders({
			tx,
			buyerId,
			buyerEmailSnapshot: buyer.email,
			idempotencyKey: body.idempotencyKey,
			idempotencyPayloadHash: payloadHash,
			groups: materializationGroups,
			totalsByListingId,
			shipTo,
			shipFromBySellerProfile,
			pickupSnapshotByLocationId,
			paymentMethodBrand: paymentMethod.brand,
			paymentMethodLast4: paymentMethod.last4,
		});

		// Cart hand-off: once Orders exist, the claimed listings are committed
		// purchases — drop them from the buyer's cart so they don't render as
		// "unavailable" rows. Replay path returns earlier so this is one-shot.
		await tx.cartItem.deleteMany({
			where: { buyerId, listingId: { in: listingIds } },
		});

		return materialized;
	});

	// 9) Stripe call (no tx). Idempotency-keyed on body.idempotencyKey — buyer
	//    retries land on the same PI. Abandonment is handled by the periodic
	//    checkout reservation reconciler (apps/worker/app/checkout/reconciler.ts),
	//    not a per-claim BullMQ job — see Saleor / stripe-magento2 prior art.
	const sellerProfileIds = uniqueSellerProfileIds(fresh.groups);
	const piResult = await payments.customer.createCheckoutPaymentIntent({
		idempotencyKey: body.idempotencyKey,
		buyerId,
		customerId,
		paymentMethodId: paymentMethod.stripePaymentMethodId,
		amountCents: fresh.totalCents,
		taxCalculationId: fresh.taxCalculationId ?? undefined,
		metadata: buildPaymentIntentMetadata({
			fresh,
			buyerId,
			sellerProfileIds,
			orderIds,
			quoteId: quote.id,
			idempotencyKey: body.idempotencyKey,
		}),
	});
	if (!piResult.success) {
		if (piResult.error === PaymentErrorCode.rate_limit_exceeded) {
			throw errors.tooManyRequests(
				"We are experiencing high demand. Please try again in a moment.",
				{ code: "STRIPE_RATE_LIMIT_EXCEEDED" },
			);
		}
		setReportingContext({
			operation: "checkout_pi_create_failed",
			extra: {
				buyerId,
				quoteId: quote.id,
				orderIds,
				stripeError: piResult.error,
				stripeErrorCode: piResult.stripeErrorCode,
			},
		});
		// Orders sit at paymentIntentId=null; buyer retry resumes via the replay
		// path. The reservation reconciler is the longer-term cleanup.
		throw errors.internal("PaymentIntent creation failed", {
			code: "PI_CREATION_FAILED",
		});
	}

	// 10) Tx B — link the PI to the Orders. Bounded WHERE clause guards against
	//     a concurrent retry already linking them.
	await db.order.updateMany({
		where: {
			id: { in: orderIds },
			buyerId,
			idempotencyKey: body.idempotencyKey,
			paymentIntentId: null,
		},
		data: { paymentIntentId: piResult.paymentIntentId },
	});

	logger.info(
		{
			buyerId,
			quoteId: quote.id,
			paymentIntentId: piResult.paymentIntentId,
			orderIds,
		},
		"checkout.claim: success",
	);

	return {
		clientSecret: piResult.clientSecret,
		paymentIntentId: piResult.paymentIntentId,
		orderIds,
	};
}

interface PersistedQuoteLine {
	listingId: string;
	/** DB enum carries `shipping | pickup | pickup_optional`; only the first two are valid here. */
	fulfillmentMode: string;
	priceCents: number;
	taxCents: number;
	shippingCents: number;
	totalCents: number;
}

interface PersistedQuote {
	id: string;
	buyerId: string;
	consumedByOrderId: string | null;
	expiresAt: Date;
	shippingAddressId: string | null;
	cartHash: string | null;
	totalCents: number;
	lines: PersistedQuoteLine[];
}

function ensureQuoteUsable(
	quote: PersistedQuote | null,
	buyerId: string,
): PersistedQuote {
	if (!quote || quote.buyerId !== buyerId) {
		// Don't disclose the existence of someone else's quote — same code path.
		throw new HttpError(
			"Quote not found",
			CheckoutClaimErrorCode.invalid_quote,
			{ statusCode: 422 },
		);
	}
	if (quote.consumedByOrderId) {
		throw new HttpError(
			"Quote was already used",
			CheckoutClaimErrorCode.invalid_quote,
			{ statusCode: 422 },
		);
	}
	if (quote.expiresAt < new Date()) {
		throw new HttpError("Quote expired", CheckoutClaimErrorCode.quote_expired, {
			statusCode: 410,
		});
	}
	return quote;
}

async function replayIfExists({
	db,
	payments,
	buyerId,
	body,
	incomingPayloadHash,
}: {
	db: PrismaClient;
	payments: PaymentsClient;
	buyerId: string;
	body: ClaimInput["body"];
	incomingPayloadHash: string;
}): Promise<CheckoutClaimSuccess | null> {
	const siblings = await db.order.findMany({
		where: { buyerId, idempotencyKey: body.idempotencyKey },
		select: {
			id: true,
			paymentIntentId: true,
			subtotalCents: true,
			shippingCents: true,
			taxCents: true,
			applicationFeeCents: true,
			totalCents: true,
			sellerProfileId: true,
			idempotencyPayloadHash: true,
		},
	});
	if (siblings.length === 0) return null;

	// Stripe-style replay-with-different-payload guard. Same buyer + same key
	// landing here with a different (quoteId, paymentMethodId) means the SPA
	// reused a stale key — refuse, don't silently confirm the wrong payment.
	const storedHash = siblings.find(
		(s) => s.idempotencyPayloadHash !== null,
	)?.idempotencyPayloadHash;
	if (storedHash && storedHash !== incomingPayloadHash) {
		throw new HttpError(
			"Idempotency key reused with a different payload",
			"IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
			{ statusCode: 422 },
		);
	}

	const orderIds = siblings.map((s) => s.id);
	const linkedPI = siblings.find((s) => s.paymentIntentId);

	// Replay path A — PI was already linked. Just refetch the clientSecret.
	if (linkedPI?.paymentIntentId) {
		let pi: Awaited<ReturnType<typeof payments.customer.retrievePaymentIntent>>;
		try {
			pi = await payments.customer.retrievePaymentIntent(
				linkedPI.paymentIntentId,
			);
		} catch (err) {
			if (isStripeRateLimitError(err)) {
				throw errors.tooManyRequests(
					"We are experiencing high demand. Please try again in a moment.",
					{ code: "STRIPE_RATE_LIMIT_EXCEEDED" },
				);
			}
			throw err;
		}
		if (pi.status === "canceled" || pi.status === "succeeded") {
			throw new HttpError(
				"Original PaymentIntent is no longer in flight",
				"REPLAY_PI_TERMINAL",
				{ statusCode: 410, data: { paymentIntentStatus: pi.status } },
			);
		}
		if (!pi.clientSecret) {
			setReportingContext({
				operation: "checkout_replay_pi_no_client_secret",
				extra: { buyerId, paymentIntentId: linkedPI.paymentIntentId },
			});
			throw errors.internal("Replay PaymentIntent missing client_secret", {
				code: "REPLAY_PI_NO_CLIENT_SECRET",
			});
		}
		return {
			clientSecret: pi.clientSecret,
			paymentIntentId: pi.id,
			orderIds,
		};
	}

	// Replay path B — Orders exist but no PI was linked yet. Previous attempt
	// died between Tx A and Tx B (or the Stripe call itself never landed).
	// Resume by re-calling Stripe with the same idempotency key — Stripe
	// returns the same PI it created last time, or creates a fresh one.
	return resumeWithoutLinkedPI({ db, payments, buyerId, body, siblings });
}

async function resumeWithoutLinkedPI({
	db,
	payments,
	buyerId,
	body,
	siblings,
}: {
	db: PrismaClient;
	payments: PaymentsClient;
	buyerId: string;
	body: ClaimInput["body"];
	siblings: {
		id: string;
		subtotalCents: number;
		shippingCents: number;
		taxCents: number;
		applicationFeeCents: number;
		totalCents: number;
		sellerProfileId: string;
	}[];
}): Promise<CheckoutClaimSuccess> {
	const buyer = await db.user.findUnique({
		where: { id: buyerId },
		select: {
			billing: {
				select: {
					customerId: true,
					paymentMethods: {
						where: { id: body.paymentMethodId },
						select: { stripePaymentMethodId: true },
						take: 1,
					},
				},
			},
		},
	});
	const customerId = buyer?.billing?.customerId;
	const stripePaymentMethodId =
		buyer?.billing?.paymentMethods[0]?.stripePaymentMethodId;
	if (!customerId || !stripePaymentMethodId) {
		throw errors.badRequest(
			"Buyer wallet or payment method missing during replay",
			{ code: "REPLAY_BUYER_WALLET_MISSING" },
		);
	}

	const orderIds = siblings.map((s) => s.id);
	const sellerProfileIds = Array.from(
		new Set(siblings.map((s) => s.sellerProfileId)),
	);
	const quote = await db.checkoutQuote.findFirst({
		where: { consumedByOrderId: { in: orderIds }, buyerId },
		select: { id: true, taxCalculationId: true },
	});

	const aggregate = siblings.reduce(
		(acc, s) => ({
			subtotalCents: acc.subtotalCents + s.subtotalCents,
			shippingCents: acc.shippingCents + s.shippingCents,
			taxCents: acc.taxCents + s.taxCents,
			applicationFeeCents: acc.applicationFeeCents + s.applicationFeeCents,
			totalCents: acc.totalCents + s.totalCents,
		}),
		{
			subtotalCents: 0,
			shippingCents: 0,
			taxCents: 0,
			applicationFeeCents: 0,
			totalCents: 0,
		},
	);

	const piResult = await payments.customer.createCheckoutPaymentIntent({
		idempotencyKey: body.idempotencyKey,
		buyerId,
		customerId,
		paymentMethodId: stripePaymentMethodId,
		amountCents: aggregate.totalCents,
		taxCalculationId: quote?.taxCalculationId ?? undefined,
		metadata: {
			subtotalCents: aggregate.subtotalCents,
			shippingCents: aggregate.shippingCents,
			taxCents: aggregate.taxCents,
			applicationFeeCents: aggregate.applicationFeeCents,
			totalCents: aggregate.totalCents,
			buyerId,
			sellerProfileIds: sellerProfileIds.join(","),
			orderIds: orderIds.join(","),
			quoteId: quote?.id ?? "",
			idempotencyKey: body.idempotencyKey,
			bundleShippingFormula: BUNDLE_SHIPPING_FORMULA,
		},
	});
	if (!piResult.success) {
		if (piResult.error === PaymentErrorCode.rate_limit_exceeded) {
			throw errors.tooManyRequests(
				"We are experiencing high demand. Please try again in a moment.",
				{ code: "STRIPE_RATE_LIMIT_EXCEEDED" },
			);
		}
		setReportingContext({
			operation: "checkout_replay_pi_create_failed",
			extra: { buyerId, orderIds, stripeError: piResult.error },
		});
		throw errors.internal("Replay PaymentIntent creation failed", {
			code: "REPLAY_PI_CREATION_FAILED",
		});
	}

	await db.order.updateMany({
		where: {
			id: { in: orderIds },
			buyerId,
			idempotencyKey: body.idempotencyKey,
			paymentIntentId: null,
		},
		data: { paymentIntentId: piResult.paymentIntentId },
	});

	logger.info(
		{
			buyerId,
			orderIds,
			paymentIntentId: piResult.paymentIntentId,
		},
		"checkout.claim: replay resumed (PI linked)",
	);

	return {
		clientSecret: piResult.clientSecret,
		paymentIntentId: piResult.paymentIntentId,
		orderIds,
	};
}

async function loadShipFromBySellerProfile(
	db: PrismaClient,
	sellerProfileIds: string[],
): Promise<Map<string, ShipFromSnapshot>> {
	if (sellerProfileIds.length === 0) return new Map();
	const sellers = await db.sellerProfile.findMany({
		where: { id: { in: sellerProfileIds } },
		select: {
			id: true,
			user: {
				select: {
					phone: true,
					firstName: true,
					lastName: true,
					handle: true,
				},
			},
			shippingFromAddress: {
				select: {
					fullName: true,
					line1: true,
					line2: true,
					city: true,
					state: true,
					postalCode: true,
					country: true,
				},
			},
		},
	});

	const map = new Map<string, ShipFromSnapshot>();
	for (const seller of sellers) {
		const addr = seller.shippingFromAddress;
		if (!addr) {
			throw errors.badRequest(
				"Seller has no ship-from address; cannot fulfill BIN",
				{
					code: "SELLER_MISSING_SHIP_FROM",
					data: { sellerProfileId: seller.id },
				},
			);
		}
		map.set(seller.id, {
			name:
				addr.fullName ??
				seller.user.handle ??
				joinName(seller.user.firstName, seller.user.lastName),
			line1: addr.line1,
			line2: addr.line2,
			city: addr.city,
			state: addr.state,
			postalCode: addr.postalCode,
			country: addr.country,
			phone: seller.user.phone,
		});
	}
	return map;
}

async function loadPickupSnapshots(
	db: PrismaClient,
	listings: CheckoutListing[],
): Promise<Map<string, PickupSnapshot>> {
	const ids = Array.from(
		new Set(
			listings
				.map((l) => l.pickupLocationId)
				.filter((id): id is string => id !== null),
		),
	);
	if (ids.length === 0) return new Map();
	const rows = await db.pickupLocation.findMany({
		where: { id: { in: ids } },
		select: {
			id: true,
			name: true,
			line1: true,
			line2: true,
			city: true,
			state: true,
			postalCode: true,
			country: true,
			instructions: true,
			latitude: true,
			longitude: true,
		},
	});
	return new Map(
		rows.map((r) => [
			r.id,
			{
				pickupLocationId: r.id,
				name: r.name,
				line1: r.line1,
				line2: r.line2,
				city: r.city,
				state: r.state,
				postalCode: r.postalCode,
				country: r.country,
				instructions: r.instructions,
				latitude: r.latitude,
				longitude: r.longitude,
			},
		]),
	);
}

interface TaxAddress {
	line1: string;
	line2: string | null;
	city: string;
	state: string;
	postalCode: string;
	country: string;
}

function resolveClaimTaxAddress(input: {
	listings: CheckoutListing[];
	buyerChoiceByListing: Map<string, FulfillmentMethodType>;
	shipAddress: {
		line1: string;
		line2: string | null;
		city: string;
		state: string;
		postalCode: string;
		country: string;
	} | null;
	pickupSnapshotByLocationId: Map<string, PickupSnapshot>;
}): TaxAddress | null {
	const hasShipLine = input.listings.some(
		(l) => input.buyerChoiceByListing.get(l.id) === "shipping",
	);
	if (hasShipLine) {
		return input.shipAddress;
	}
	for (const l of input.listings) {
		if (input.buyerChoiceByListing.get(l.id) !== "pickup") continue;
		if (!l.pickupLocationId) continue;
		const snap = input.pickupSnapshotByLocationId.get(l.pickupLocationId);
		if (!snap) continue;
		return {
			line1: snap.line1,
			line2: snap.line2,
			city: snap.city,
			state: snap.state,
			postalCode: snap.postalCode,
			country: snap.country,
		};
	}
	return null;
}

function asResolvedMethod(mode: string): FulfillmentMethodType {
	if (mode === "shipping" || mode === "pickup") return mode;
	// Quote-time validation forbids `pickup_optional` on a CheckoutQuoteLine.
	// If it lands here, it's a writer-side bug.
	throw errors.internal(`Unresolved fulfillment mode on quote line: ${mode}`, {
		code: "QUOTE_LINE_UNRESOLVED_MODE",
	});
}

function uniqueSellerProfileIds(groups: ComputedFulfillmentGroup[]): string[] {
	return Array.from(new Set(groups.map((g) => g.sellerProfileId)));
}

function buildPaymentIntentMetadata(input: {
	fresh: ComputedCheckoutTotals;
	buyerId: string;
	sellerProfileIds: string[];
	orderIds: string[];
	quoteId: string;
	idempotencyKey: string;
}): Record<string, string | number | boolean> {
	return {
		subtotalCents: input.fresh.subtotalCents,
		shippingCents: input.fresh.shippingTotalCents,
		taxCents: input.fresh.taxTotalCents,
		applicationFeeCents: input.fresh.applicationFeeTotalCents,
		totalCents: input.fresh.totalCents,
		buyerId: input.buyerId,
		sellerProfileIds: input.sellerProfileIds.join(","),
		orderIds: input.orderIds.join(","),
		quoteId: input.quoteId,
		idempotencyKey: input.idempotencyKey,
		bundleShippingFormula: BUNDLE_SHIPPING_FORMULA,
	};
}

interface DriftRow {
	listingId: string;
	oldTotals: CheckoutLineTotals;
	newTotals: CheckoutLineTotals;
}

function computeDrift(
	quoteLines: PersistedQuoteLine[],
	freshPerListing: CheckoutListingTotals[],
): DriftRow[] | null {
	const priorByListing = new Map(quoteLines.map((l) => [l.listingId, l]));
	const drifted: DriftRow[] = [];
	for (const fresh of freshPerListing) {
		const prior = priorByListing.get(fresh.listingId);
		if (!prior) continue;
		if (prior.totalCents !== fresh.totalCents) {
			drifted.push({
				listingId: fresh.listingId,
				oldTotals: {
					priceCents: prior.priceCents,
					taxCents: prior.taxCents,
					shippingCents: prior.shippingCents,
					totalCents: prior.totalCents,
				},
				newTotals: {
					priceCents: fresh.priceCents,
					taxCents: fresh.taxCents,
					shippingCents: fresh.shippingCents,
					totalCents: fresh.totalCents,
				},
			});
		}
	}
	return drifted.length > 0 ? drifted : null;
}

export type { CheckoutListing, ComputedCheckoutTotals };
