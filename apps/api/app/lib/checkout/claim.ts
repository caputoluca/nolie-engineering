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
import { logger } from "../../logger.js";
import { apiTx } from "../db/tx.js";
import { setReportingContext } from "../observability/sentry/report.js";
import {
	type CheckoutListingTotals,
	type ComputedCheckoutTotals,
	computeCheckoutTotals,
} from "./compute-totals.js";
import { type CheckoutListing, loadCheckoutListings } from "./listings.js";
import { materializeOrders } from "./materialize-orders.js";
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

	// 1) Idempotency replay — same buyer + same key returns the same Order set
	//    and the same PI clientSecret. Handles two replay scenarios:
	//      a) Orders + paymentIntentId set → just return clientSecret.
	//      b) Orders + paymentIntentId null → previous attempt died between Tx A
	//         and Tx B; resume from the Stripe call.
	const replay = await replayIfExists({ db, payments, buyerId, body });
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

	const [listings, buyer, shipFromBySellerProfile] = await Promise.all([
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
							select: { id: true, stripePaymentMethodId: true },
							take: 1,
						},
					},
				},
				shippingAddresses: {
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
				},
			},
		}),
		// SellerProfile shipFrom lives on a different table — separate query, but
		// runs in parallel with the others so latency stays additive at 1 round-trip.
		loadShipFromBySellerProfile(db, listingIds),
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
	const address = buyer.shippingAddresses[0];
	if (!address) {
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

	const sellerProfileIds = Array.from(
		new Set(listings.map((l) => l.sellerProfileId)),
	);

	// 4) Recompute fresh totals + drift check.
	const fresh = await computeCheckoutTotals({
		listings,
		address,
		taxExempt: buyer.taxExemptStatus === "approved",
		payments,
	});

	const drift = computeDrift(quote.lines, fresh.perListing);
	if (drift) {
		const newQuote = await db.checkoutQuote.create({
			data: {
				buyerId,
				shippingAddressId: address.id,
				totalCents: fresh.totalCents,
				taxCalculationId: fresh.taxCalculationId,
				expiresAt: quote.expiresAt,
				lines: {
					createMany: {
						data: fresh.perListing.map((p) => ({
							listingId: p.listingId,
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

	// 5) Pre-generate Order IDs — one per seller group. Order.id doubles as
	//    `reservedByOrderId` so the webhook can defend against mid-3DS races.
	const orderIdBySellerProfile = new Map<string, string>(
		sellerProfileIds.map((id) => [id, randomUUID()]),
	);
	// `consumedByOrderId` is a "claimed" flag, not a real FK. All N Orders share
	// the same PI; pick any of the generated IDs as the marker.
	const [consumedMarkerOrderId] = orderIdBySellerProfile.values();
	if (!consumedMarkerOrderId) {
		throw errors.internal("No seller groups in listings", {
			code: "NO_SELLER_GROUPS",
		});
	}

	const reservedUntil = new Date(Date.now() + RESERVATION_TTL_MS);

	// 6) Tx A — atomic DB writes only. Fast (no external calls).
	const totalsByListingId = new Map(
		fresh.perListing.map((t) => [t.listingId, t]),
	);
	const shipTo = {
		name: address.fullName,
		line1: address.line1,
		line2: address.line2,
		city: address.city,
		state: address.state,
		postalCode: address.postalCode,
		country: address.country,
		phone: buyer.phone,
	};

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
			listings: listings.map((l) => ({
				id: l.id,
				sellerProfileId: l.sellerProfileId,
			})),
			orderIdBySellerProfile,
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

		return materializeOrders({
			tx,
			buyerId,
			buyerEmailSnapshot: buyer.email,
			idempotencyKey: body.idempotencyKey,
			listings,
			totalsByListingId,
			shipTo,
			shipFromBySellerProfile,
			orderIdBySellerProfile,
		});
	});

	// 7) Stripe call (no tx). Idempotency-keyed on body.idempotencyKey — buyer
	//    retries land on the same PI. Abandonment is handled by the periodic
	//    checkout reservation reconciler (apps/worker/app/checkout/reconciler.ts),
	//    not a per-claim BullMQ job — see Saleor / stripe-magento2 prior art.
	const piResult = await payments.customer.createCheckoutPaymentIntent({
		idempotencyKey: body.idempotencyKey,
		buyerId,
		customerId,
		paymentMethodId: paymentMethod.stripePaymentMethodId,
		amountCents: fresh.totalCents,
		taxCalculationId: fresh.taxCalculationId ?? undefined,
		metadata: {
			quoteId: quote.id,
			sellerProfileCount: sellerProfileIds.length,
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

	// 9) Tx B — link the PI to the Orders. Bounded WHERE clause guards against
	//    a concurrent retry already linking them.
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
	shippingAddressId: string;
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
}: {
	db: PrismaClient;
	payments: PaymentsClient;
	buyerId: string;
	body: ClaimInput["body"];
}): Promise<CheckoutClaimSuccess | null> {
	const siblings = await db.order.findMany({
		where: { buyerId, idempotencyKey: body.idempotencyKey },
		select: { id: true, paymentIntentId: true, totalCents: true },
	});
	if (siblings.length === 0) return null;

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
	siblings: { id: string; totalCents: number }[];
}): Promise<CheckoutClaimSuccess> {
	// We need the buyer's customer + the chosen payment method (re-validated
	// against the current paymentMethodId from this attempt's body).
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

	// taxCalculationId comes from the original quote — find it via the
	// reverse `consumedByOrderId IN orderIds` lookup.
	const orderIds = siblings.map((s) => s.id);
	const quote = await db.checkoutQuote.findFirst({
		where: { consumedByOrderId: { in: orderIds }, buyerId },
		select: { id: true, taxCalculationId: true },
	});

	const totalCents = siblings.reduce((sum, s) => sum + s.totalCents, 0);

	const piResult = await payments.customer.createCheckoutPaymentIntent({
		idempotencyKey: body.idempotencyKey,
		buyerId,
		customerId,
		paymentMethodId: stripePaymentMethodId,
		amountCents: totalCents,
		taxCalculationId: quote?.taxCalculationId ?? undefined,
		metadata: {
			quoteId: quote?.id ?? "",
			sellerProfileCount: orderIds.length,
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

interface ShipFromSnapshot {
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	state: string;
	postalCode: string;
	country: string;
	phone: string | null;
}

async function loadShipFromBySellerProfile(
	db: PrismaClient,
	listingIds: string[],
): Promise<Map<string, ShipFromSnapshot>> {
	const sellers = await db.sellerProfile.findMany({
		where: { listings: { some: { id: { in: listingIds } } } },
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
