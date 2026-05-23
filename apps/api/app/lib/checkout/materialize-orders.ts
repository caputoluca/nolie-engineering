import {
	generateDisplayId,
	type SellerVacationPeriod,
	snapshotSellerVacation,
} from "@nolie/core/orders";
import { OrderOriginationType, PaymentStatus, type Prisma } from "@nolie/db";
import { errors } from "@nolie/errors/http";
import { calculateNetAmount } from "@nolie/payments/utils";
import type { FulfillmentMethodType } from "@nolie/schemas/fulfillment";
import { setReportingContext } from "../observability/sentry/report.js";
import type { CheckoutListingTotals } from "./compute-totals.js";
import type { CheckoutListing } from "./listings.js";

export interface ShipToSnapshot {
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	state: string;
	postalCode: string;
	country: string;
	phone: string | null;
}

export interface ShipFromSnapshot {
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	state: string;
	postalCode: string;
	country: string;
	phone: string | null;
}

export interface PickupSnapshot {
	pickupLocationId: string;
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	state: string;
	postalCode: string;
	country: string;
	instructions: string | null;
	latitude: number | null;
	longitude: number | null;
}

export interface MaterializationGroup {
	/** Pre-generated Order.id (also `reservedByOrderId` on the listings). */
	orderId: string;
	sellerProfileId: string;
	fulfillmentMode: FulfillmentMethodType;
	listings: CheckoutListing[];
	/** NL-253: rail decision resolved by `computeCheckoutTotals` for this group.
	 *  Letter preset key → letter rail; parcel preset key (set on auto-upgrade)
	 *  → parcel rail with that preset's dims at label time; null → default. */
	shippingPresetKey: string | null;
	/** Bundle carrier service (max-cost line's service); null on letter rail. */
	shippingServiceKey: string | null;
	/** Bundle signature flag (OR'd across line items); false on letter rail. */
	signatureRequired: boolean;
}

interface MaterializeInput {
	tx: Prisma.TransactionClient;
	buyerId: string;
	buyerEmailSnapshot: string;
	idempotencyKey: string;
	/** SHA-256 of the canonical claim payload — Stripe-style replay-with-different-payload guard. */
	idempotencyPayloadHash: string;
	groups: MaterializationGroup[];
	totalsByListingId: Map<string, CheckoutListingTotals>;
	/** Required for any group with `fulfillmentMode = shipping`; null if all groups are pickup. */
	shipTo: ShipToSnapshot | null;
	shipFromBySellerProfile: Map<string, ShipFromSnapshot>;
	/** PickupLocation snapshot keyed by pickupLocationId; required for any pickup group. */
	pickupSnapshotByLocationId: Map<string, PickupSnapshot>;
	/** Card brand/last4 snapshot from the buyer's PaymentMethod row at claim time. */
	paymentMethodBrand: string | null;
	paymentMethodLast4: string | null;
	/** Active vacation period for any seller that was on vacation when the
	 *  buyer claimed. Sellers not on vacation are absent — the snapshot
	 *  helper handles `null` and writes null fields for those orders. */
	vacationBySellerProfileId: Map<string, SellerVacationPeriod>;
}

/**
 * Bulk-creates one Order per fulfillment group plus all nested OrderLineItems.
 *
 * `paymentIntentId` is left null at this stage — claim.ts fills it in via a
 * follow-up `updateMany` after the Stripe PaymentIntent is created (Brandur's
 * "atomic phase before foreign state mutation" pattern). Each Order starts in
 * `paymentStatus: pending`; the webhook handler flips it to succeeded/failed.
 *
 * Snapshot invariants enforced here:
 *   - shipping orders: shipTo* + shipFrom* populated, pickup snapshot null
 *   - pickup orders: shipTo* + shipFrom* null, pickup snapshot populated
 *
 * Two round trips total: Order.createMany + OrderLineItem.createMany. Caller
 * MUST run inside a `$transaction`.
 */
export async function materializeOrders(input: MaterializeInput): Promise<{
	orderIds: string[];
}> {
	type OrderRow = Prisma.OrderCreateManyInput;
	type OrderLineItemRow = Prisma.OrderLineItemCreateManyInput;
	const orderRows: OrderRow[] = [];
	const lineItemRows: OrderLineItemRow[] = [];

	for (const group of input.groups) {
		const isShipping = group.fulfillmentMode === "shipping";

		if (isShipping && !input.shipTo) {
			setReportingContext({
				operation: "checkout_materialize_missing_ship_to",
				extra: {
					orderId: group.orderId,
					sellerProfileId: group.sellerProfileId,
				},
			});
			throw errors.internal("Materialization invariant violation", {
				code: "MATERIALIZE_MISSING_SHIP_TO",
			});
		}

		const shipFrom = isShipping
			? input.shipFromBySellerProfile.get(group.sellerProfileId)
			: null;
		if (isShipping && !shipFrom) {
			setReportingContext({
				operation: "checkout_materialize_missing_ship_from",
				extra: {
					orderId: group.orderId,
					sellerProfileId: group.sellerProfileId,
				},
			});
			throw errors.internal("Materialization invariant violation", {
				code: "MATERIALIZE_MISSING_SHIP_FROM",
			});
		}

		// Pickup snapshot — pickup groups must reference a known location, AND
		// every listing in the group must point to that same location (the
		// grouping function guarantees this).
		let pickup: PickupSnapshot | null = null;
		if (!isShipping) {
			const referenced = group.listings[0]?.pickupLocationId;
			if (!referenced) {
				setReportingContext({
					operation: "checkout_materialize_pickup_missing_location_id",
					extra: {
						orderId: group.orderId,
						sellerProfileId: group.sellerProfileId,
					},
				});
				throw errors.internal("Materialization invariant violation", {
					code: "MATERIALIZE_PICKUP_MISSING_LOCATION_ID",
				});
			}
			const snapshot = input.pickupSnapshotByLocationId.get(referenced);
			if (!snapshot) {
				setReportingContext({
					operation: "checkout_materialize_pickup_snapshot_missing",
					extra: {
						orderId: group.orderId,
						sellerProfileId: group.sellerProfileId,
						pickupLocationId: referenced,
					},
				});
				throw errors.internal("Materialization invariant violation", {
					code: "MATERIALIZE_PICKUP_SNAPSHOT_MISSING",
				});
			}
			pickup = snapshot;
		}

		let subtotalCents = 0;
		let taxCents = 0;
		let shippingCents = 0;
		let totalCents = 0;
		let applicationFeeCents = 0;
		let processingFeeCents = 0;

		for (const listing of group.listings) {
			const totals = input.totalsByListingId.get(listing.id);
			if (!totals) {
				setReportingContext({
					operation: "checkout_materialize_missing_totals",
					extra: {
						listingId: listing.id,
						sellerProfileId: group.sellerProfileId,
					},
				});
				throw errors.internal("Materialization invariant violation", {
					code: "MATERIALIZE_MISSING_TOTALS",
				});
			}

			const { netAmount: lineSellerEarning } = calculateNetAmount({
				grossAmount: totals.priceCents,
				platformFee: totals.applicationFeeCents,
				processingFee: totals.processingFeeCents,
			});

			subtotalCents += totals.priceCents;
			taxCents += totals.taxCents;
			shippingCents += totals.shippingCents;
			totalCents += totals.totalCents;
			applicationFeeCents += totals.applicationFeeCents;
			processingFeeCents += totals.processingFeeCents;

			lineItemRows.push({
				orderId: group.orderId,
				listingId: listing.id,
				listingTitleSnapshot: listing.title,
				listingPhotoUrlSnapshot: listing.heroAssetKey,
				sellerProfileId: group.sellerProfileId,
				sellerHandleSnapshot: listing.sellerHandle ?? "",
				priceCents: totals.priceCents,
				taxCents: totals.taxCents,
				applicationFeeCents: totals.applicationFeeCents,
				processingFeeCents: totals.processingFeeCents,
				sellerEarningCents: lineSellerEarning,
				// §19 — forward the cart-item's referrer triad (null on the
				// direct-quote path that bypasses cart). Settle worker reads
				// these to stamp the `purchase_completed` event envelope.
				referrerQueryId: listing.referrerQueryId,
				referrerRankPosition: listing.referrerRankPosition,
				referrerSurface: listing.referrerSurface,
			});
		}

		const vacationSnapshot = snapshotSellerVacation(
			input.vacationBySellerProfileId.get(group.sellerProfileId) ?? null,
		);

		orderRows.push({
			id: group.orderId,
			displayId: generateDisplayId(),
			buyerId: input.buyerId,
			buyerEmailSnapshot: input.buyerEmailSnapshot,
			sellerProfileId: group.sellerProfileId,
			...vacationSnapshot,
			originationType: OrderOriginationType.checkout,
			originationRef: null,
			paymentIntentId: null,
			paymentStatus: PaymentStatus.pending,
			paymentMethodBrand: input.paymentMethodBrand,
			paymentMethodLast4: input.paymentMethodLast4,
			idempotencyKey: input.idempotencyKey,
			idempotencyPayloadHash: input.idempotencyPayloadHash,
			fulfillmentMode: group.fulfillmentMode,
			shippingPresetKey: group.shippingPresetKey,
			shippingServiceKey: group.shippingServiceKey,
			signatureRequired: group.signatureRequired,
			subtotalCents,
			shippingCents,
			taxCents,
			applicationFeeCents,
			processingFeeCents,
			totalCents,
			...(isShipping && input.shipTo && shipFrom
				? {
						shipToName: input.shipTo.name,
						shipToLine1: input.shipTo.line1,
						shipToLine2: input.shipTo.line2,
						shipToCity: input.shipTo.city,
						shipToState: input.shipTo.state,
						shipToPostalCode: input.shipTo.postalCode,
						shipToCountry: input.shipTo.country,
						shipToPhone: input.shipTo.phone,
						shipFromName: shipFrom.name,
						shipFromLine1: shipFrom.line1,
						shipFromLine2: shipFrom.line2,
						shipFromCity: shipFrom.city,
						shipFromState: shipFrom.state,
						shipFromPostalCode: shipFrom.postalCode,
						shipFromCountry: shipFrom.country,
						shipFromPhone: shipFrom.phone,
					}
				: {}),
			...(pickup
				? {
						pickupLocationId: pickup.pickupLocationId,
						pickupLocationName: pickup.name,
						pickupLine1: pickup.line1,
						pickupLine2: pickup.line2,
						pickupCity: pickup.city,
						pickupState: pickup.state,
						pickupPostalCode: pickup.postalCode,
						pickupCountry: pickup.country,
						pickupInstructions: pickup.instructions,
						pickupLatitude: pickup.latitude,
						pickupLongitude: pickup.longitude,
					}
				: {}),
		});
	}

	await input.tx.order.createMany({ data: orderRows });
	await input.tx.orderLineItem.createMany({ data: lineItemRows });

	return { orderIds: orderRows.map((o) => o.id as string) };
}
