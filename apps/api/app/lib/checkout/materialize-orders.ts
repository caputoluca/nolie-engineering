import { generateDisplayId } from "@nolie/core/orders";
import { OrderOriginationType, PaymentStatus, type Prisma } from "@nolie/db";
import { errors } from "@nolie/errors/http";
import {
	calculateNetAmount,
	calculatePlatformFee,
} from "@nolie/payments/utils";
import { setReportingContext } from "../observability/sentry/report.js";
import type { CheckoutListingTotals } from "./compute-totals.js";
import type { CheckoutListing } from "./listings.js";

interface ShipToSnapshot {
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	state: string;
	postalCode: string;
	country: string;
	phone: string | null;
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

interface MaterializeInput {
	tx: Prisma.TransactionClient;
	buyerId: string;
	buyerEmailSnapshot: string;
	idempotencyKey: string;
	listings: CheckoutListing[];
	totalsByListingId: Map<string, CheckoutListingTotals>;
	shipTo: ShipToSnapshot;
	shipFromBySellerProfile: Map<string, ShipFromSnapshot>;
	/** sellerProfileId → pre-generated Order.id (also used as `reservedByOrderId`). */
	orderIdBySellerProfile: Map<string, string>;
}

/**
 * Bulk-creates one Order per seller group plus all nested OrderLineItems.
 * `paymentIntentId` is left null at this stage — claim.ts fills it in via a
 * follow-up `updateMany` after the Stripe PaymentIntent is created (Brandur's
 * "atomic phase before foreign state mutation" pattern). Each Order starts in
 * `paymentStatus: pending`; the webhook handler flips it to succeeded/failed.
 *
 * Two round trips total: Order.createMany + OrderLineItem.createMany. Caller
 * MUST run inside a `$transaction`.
 */
export async function materializeOrders(input: MaterializeInput): Promise<{
	orderIds: string[];
}> {
	const groupsBySeller = new Map<string, CheckoutListing[]>();
	for (const l of input.listings) {
		const existing = groupsBySeller.get(l.sellerProfileId);
		if (existing) {
			existing.push(l);
		} else {
			groupsBySeller.set(l.sellerProfileId, [l]);
		}
	}

	type OrderRow = Prisma.OrderCreateManyInput;
	type OrderLineItemRow = Prisma.OrderLineItemCreateManyInput;
	const orderRows: OrderRow[] = [];
	const lineItemRows: OrderLineItemRow[] = [];

	for (const [sellerProfileId, groupListings] of groupsBySeller) {
		const orderId = input.orderIdBySellerProfile.get(sellerProfileId);
		if (!orderId) {
			setReportingContext({
				operation: "checkout_materialize_missing_order_id",
				extra: { sellerProfileId },
			});
			throw errors.internal("Materialization invariant violation", {
				code: "MATERIALIZE_MISSING_ORDER_ID",
			});
		}

		const shipFrom = input.shipFromBySellerProfile.get(sellerProfileId);
		if (!shipFrom) {
			setReportingContext({
				operation: "checkout_materialize_missing_ship_from",
				extra: { sellerProfileId },
			});
			throw errors.internal("Materialization invariant violation", {
				code: "MATERIALIZE_MISSING_SHIP_FROM",
			});
		}

		let subtotalCents = 0;
		let taxCents = 0;
		let shippingCents = 0;
		let totalCents = 0;
		let applicationFeeCents = 0;

		for (const listing of groupListings) {
			const totals = input.totalsByListingId.get(listing.id);
			if (!totals) {
				setReportingContext({
					operation: "checkout_materialize_missing_totals",
					extra: { listingId: listing.id, sellerProfileId },
				});
				throw errors.internal("Materialization invariant violation", {
					code: "MATERIALIZE_MISSING_TOTALS",
				});
			}

			const linePlatformFee = calculatePlatformFee({
				amountInCents: totals.priceCents,
				feeRate: listing.platformFeeRate,
			});
			const { netAmount: lineSellerEarning } = calculateNetAmount({
				grossAmount: totals.priceCents,
				platformFee: linePlatformFee,
			});

			subtotalCents += totals.priceCents;
			taxCents += totals.taxCents;
			shippingCents += totals.shippingCents;
			totalCents += totals.totalCents;
			applicationFeeCents += linePlatformFee;

			lineItemRows.push({
				orderId,
				listingId: listing.id,
				listingTitleSnapshot: listing.title,
				listingPhotoUrlSnapshot: listing.heroAssetKey,
				sellerProfileId,
				sellerHandleSnapshot: listing.sellerHandle ?? "",
				priceCents: totals.priceCents,
				taxCents: totals.taxCents,
				applicationFeeCents: linePlatformFee,
				sellerEarningCents: lineSellerEarning,
			});
		}

		orderRows.push({
			id: orderId,
			displayId: generateDisplayId(),
			buyerId: input.buyerId,
			buyerEmailSnapshot: input.buyerEmailSnapshot,
			sellerProfileId,
			originationType: OrderOriginationType.checkout,
			originationRef: null,
			paymentIntentId: null,
			paymentStatus: PaymentStatus.pending,
			idempotencyKey: input.idempotencyKey,
			subtotalCents,
			shippingCents,
			taxCents,
			applicationFeeCents,
			totalCents,
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
		});
	}

	await input.tx.order.createMany({ data: orderRows });
	await input.tx.orderLineItem.createMany({ data: lineItemRows });

	return { orderIds: orderRows.map((o) => o.id as string) };
}
