import { getSortFieldsForTransition } from "@nolie/core/auctions";
import { generatePickupCode } from "@nolie/core/orders";
import {
	type DbClient,
	FulfillmentMode,
	ListingStatus,
	type Offer,
	OfferState,
	OrderOriginationType,
	OrderStatus,
	PaymentStatus,
	PayoutStatus,
	Prisma,
} from "@nolie/db";
import {
	getLetterPreset,
	getPreset,
	LETTER_PLACEHOLDER_PARCEL_DIMS,
	LETTER_RIDEALONG_WEIGHT_LBS,
	LETTER_SERVICE_CODE,
	LETTER_UPGRADE_PARCEL_PRESET_KEY,
	PACKAGE_PRESETS,
} from "@nolie/shipping/presets";
import { captureHolds, releaseHolds } from "@nolie/wallet";

/**
 * Listing-side packaging dims used by the bundle-dim fallback. Letter-
 * tagged listings intentionally carry no parcel dims so a real letter
 * line in a mixed bundle can be told apart from a parcel listing that
 * forgot to set them.
 */
export interface ListingPackageDims {
	shippingPresetKey: string | null;
	packageWeightLbs: Prisma.Decimal | null;
	packageLengthIn: Prisma.Decimal | null;
	packageWidthIn: Prisma.Decimal | null;
	packageHeightIn: Prisma.Decimal | null;
	shippingLabel: {
		weightLbs: Prisma.Decimal;
		lengthIn: Prisma.Decimal;
		widthIn: Prisma.Decimal;
		heightIn: Prisma.Decimal;
	} | null;
}

export interface OrderForFinalization {
	id: string;
	buyerId: string;
	/** Buyer's CURRENT email/name (the User relation, not `buyerEmailSnapshot`) —
	 *  the Klaviyo identity spine must track the live email, not the immutable
	 *  receipt snapshot, or the order_completed event fragments onto a stale
	 *  profile. */
	buyerEmail: string;
	buyerFirstName: string | null;
	buyerLastName: string | null;
	sellerProfileId: string;
	sellerUserId: string;
	/** Seller's CURRENT email/name (the User relation) — the Klaviyo identity
	 *  spine for the seller-side `sale_completed` event (NL-353), same live-email
	 *  rationale as the buyer fields above. */
	sellerEmail: string;
	sellerFirstName: string | null;
	sellerLastName: string | null;
	originationType: OrderOriginationType;
	acceptedOfferId: string | null;
	fulfillmentMode: FulfillmentMode;
	subtotalCents: number;
	shippingCents: number;
	totalCents: number;
	applicationFeeCents: number;
	processingFeeCents: number;
	taxCents: number;
	shippingPresetKey: string | null;
	/** Checkout-group key — all orders sharing the same claim carry the same
	 *  value. Threaded through to `orderConfirmed` so the handler can fan
	 *  out to siblings without an anchor lookup. Null on legacy auction-won
	 *  rows (which never enter this pipeline). */
	idempotencyKey: string | null;
	lineItems: {
		id: string;
		listingId: string;
		priceCents: number;
		applicationFeeCents: number;
		processingFeeCents: number;
		sellerEarningCents: number;
		listing: ListingPackageDims;
		referrerQueryId: string | null;
		referrerRankPosition: number | null;
		referrerSurface: string | null;
	}[];
}

export interface BundleDims {
	weightLbs: Prisma.Decimal;
	lengthIn: Prisma.Decimal;
	widthIn: Prisma.Decimal;
	heightIn: Prisma.Decimal;
}

const UPGRADE_PRESET = PACKAGE_PRESETS[LETTER_UPGRADE_PARCEL_PRESET_KEY];

const FALLBACK_LINE_DIMS: BundleDims = {
	weightLbs: new Prisma.Decimal(UPGRADE_PRESET.weightLbs),
	lengthIn: new Prisma.Decimal(UPGRADE_PRESET.lengthIn),
	widthIn: new Prisma.Decimal(UPGRADE_PRESET.widthIn),
	heightIn: new Prisma.Decimal(UPGRADE_PRESET.heightIn),
};

/**
 * Bundle-level package dims for a multi-item Order. Weight sums; LWH take
 * the per-line max. A line without listing parcel dims falls back to its
 * legacy ShippingLabel row, then to a fallback box. The fallback is
 * *expected* for letter-tagged lines in a default-parcel bundle (normal
 * mixed checkout): such a line rides inside the bundle's real parcel, so it
 * contributes the upgrade box's LWH (for the max) but only ~1 oz of weight
 * (`LETTER_RIDEALONG_WEIGHT_LBS`), not a whole `padded_mailer`. Only a
 * *non-letter* listing reaching the fallback is flagged for Sentry — that's
 * the unexpected case, and it keeps the full upgrade box as a safe over-estimate.
 */
export function computeBundleDims(
	lineItems: { listing: ListingPackageDims }[],
): { dims: BundleDims; anomalousFallback: boolean } {
	let anomalousFallback = false;
	const dimsPerLine = lineItems.map((li) => {
		const l = li.listing;
		if (
			l.packageWeightLbs &&
			l.packageLengthIn &&
			l.packageWidthIn &&
			l.packageHeightIn
		) {
			return {
				weightLbs: l.packageWeightLbs,
				lengthIn: l.packageLengthIn,
				widthIn: l.packageWidthIn,
				heightIn: l.packageHeightIn,
			};
		}
		if (l.shippingLabel) return l.shippingLabel;
		const isLetterTagged =
			l.shippingPresetKey != null &&
			getLetterPreset(l.shippingPresetKey) != null;
		if (!isLetterTagged) {
			// A non-letter listing with no parcel dims and no legacy label
			// shouldn't happen — over-estimate at the full upgrade box and
			// flag it (Sentry via onAnomalousFallback at the call site).
			anomalousFallback = true;
			return FALLBACK_LINE_DIMS;
		}
		// A letter-tagged line is a raw single riding inside the bundle's
		// real parcel — always present here, since an all-letter bundle is
		// routed to a non-null preset upstream and never reaches this fn.
		// Keep the upgrade box for the LWH max, but add only the card's
		// ~1 oz, not a whole padded_mailer (8 oz). The latter over-stated
		// bundle weight and bought a costlier label than the real shipment.
		return {
			...FALLBACK_LINE_DIMS,
			weightLbs: new Prisma.Decimal(LETTER_RIDEALONG_WEIGHT_LBS),
		};
	});

	const sumWeight = dimsPerLine.reduce(
		(acc, d) => acc.add(d.weightLbs),
		new Prisma.Decimal(0),
	);
	const maxBy = (key: "lengthIn" | "widthIn" | "heightIn") =>
		dimsPerLine.reduce(
			(max, d) => (d[key].greaterThan(max) ? d[key] : max),
			new Prisma.Decimal(0),
		);
	return {
		dims: {
			weightLbs: sumWeight,
			lengthIn: maxBy("lengthIn"),
			widthIn: maxBy("widthIn"),
			heightIn: maxBy("heightIn"),
		},
		anomalousFallback,
	};
}

/**
 * Shared select shape for any finalize-the-order query — keeps the two
 * loaders + any inline future call in lockstep so a column added here
 * propagates everywhere `OrderForFinalization` is consumed.
 */
const ORDER_FOR_FINALIZATION_SELECT = {
	id: true,
	buyerId: true,
	buyer: { select: { email: true, firstName: true, lastName: true } },
	sellerProfileId: true,
	sellerProfile: {
		select: {
			userId: true,
			user: { select: { email: true, firstName: true, lastName: true } },
		},
	},
	originationType: true,
	originationRef: true,
	fulfillmentMode: true,
	subtotalCents: true,
	shippingCents: true,
	totalCents: true,
	applicationFeeCents: true,
	processingFeeCents: true,
	taxCents: true,
	shippingPresetKey: true,
	idempotencyKey: true,
	lineItems: {
		select: {
			id: true,
			listingId: true,
			priceCents: true,
			applicationFeeCents: true,
			processingFeeCents: true,
			sellerEarningCents: true,
			referrerQueryId: true,
			referrerRankPosition: true,
			referrerSurface: true,
			listing: {
				select: {
					shippingPresetKey: true,
					packageWeightLbs: true,
					packageLengthIn: true,
					packageWidthIn: true,
					packageHeightIn: true,
					shippingLabel: {
						select: {
							weightLbs: true,
							lengthIn: true,
							widthIn: true,
							heightIn: true,
						},
					},
				},
			},
		},
	},
} satisfies Prisma.OrderSelect;

type OrderForFinalizationRow = Prisma.OrderGetPayload<{
	select: typeof ORDER_FOR_FINALIZATION_SELECT;
}>;

function toOrderForFinalization(
	r: OrderForFinalizationRow,
): OrderForFinalization {
	return {
		id: r.id,
		buyerId: r.buyerId,
		buyerEmail: r.buyer.email,
		buyerFirstName: r.buyer.firstName,
		buyerLastName: r.buyer.lastName,
		sellerProfileId: r.sellerProfileId,
		sellerUserId: r.sellerProfile.userId,
		sellerEmail: r.sellerProfile.user.email,
		sellerFirstName: r.sellerProfile.user.firstName,
		sellerLastName: r.sellerProfile.user.lastName,
		originationType: r.originationType,
		acceptedOfferId:
			r.originationType === OrderOriginationType.offer_accepted
				? r.originationRef
				: null,
		fulfillmentMode: r.fulfillmentMode,
		subtotalCents: r.subtotalCents,
		shippingCents: r.shippingCents,
		totalCents: r.totalCents,
		applicationFeeCents: r.applicationFeeCents,
		processingFeeCents: r.processingFeeCents,
		taxCents: r.taxCents,
		shippingPresetKey: r.shippingPresetKey,
		idempotencyKey: r.idempotencyKey,
		lineItems: r.lineItems,
	};
}

/**
 * Loader keyed on PaymentIntent ID — webhook path. Filtered to BIN /
 * offer-accept origins (auction-won + non-checkout PIs share the table
 * and must not be picked up here).
 */
export async function loadFinalizableOrdersForPI(
	db: DbClient,
	paymentIntentId: string,
): Promise<OrderForFinalization[]> {
	const rows = await db.order.findMany({
		where: {
			paymentIntentId,
			originationType: {
				in: [
					OrderOriginationType.checkout,
					OrderOriginationType.offer_accepted,
				],
			},
		},
		select: ORDER_FOR_FINALIZATION_SELECT,
	});
	return rows.map(toOrderForFinalization);
}

/**
 * Loader keyed on order IDs — credit-only ($0) claim path. Claim has
 * the IDs in hand after `materializeOrders`; this fetches the full
 * select shape so `finalizeCheckoutTx` can run inside the same tx.
 * Same origination filter as the PI loader.
 */
export async function loadFinalizableOrdersByIds(
	db: DbClient,
	orderIds: string[],
): Promise<OrderForFinalization[]> {
	if (orderIds.length === 0) return [];
	const rows = await db.order.findMany({
		where: {
			id: { in: orderIds },
			originationType: {
				in: [
					OrderOriginationType.checkout,
					OrderOriginationType.offer_accepted,
				],
			},
		},
		select: ORDER_FOR_FINALIZATION_SELECT,
	});
	return rows.map(toOrderForFinalization);
}

/**
 * Signal thrown by `finalizeCheckoutTx` when fewer listings flipped than
 * expected — a different PI raced past the reservation. Worker catches
 * this on PI.succeeded to issue a Stripe refund + void orders. The
 * credit-only path lets it propagate as a 500 (the race can't physically
 * happen for $0 orders since there's no 3DS gap).
 */
export class MidPaymentRaceLossSignal extends Error {
	constructor(public readonly flippedCount: number) {
		super("checkout finalize race-loss detected");
		this.name = "MidPaymentRaceLossSignal";
	}
}

export interface FinalizeCheckoutTxInput {
	tx: Prisma.TransactionClient;
	orders: OrderForFinalization[];
	/** Null for credit-only checkouts ($0 charge — no Stripe PI). */
	chargeId: string | null;
	paidAt: Date;
	/** Hook for non-letter dim-fallback signals — worker reports to Sentry. */
	onAnomalousFallback?: (input: { orderId: string }) => void;
}

export interface FinalizeCheckoutTxResult {
	cancelledSiblings: Offer[];
	cancelledSiblingState: OfferState;
	cancelledSiblingsResolvedAt: Date;
	/** Listing IDs touched — used by side-effects (cart cleanup etc. are inside tx). */
	listingIds: string[];
	/** Buyer ID — every order in a checkout shares one. */
	buyerId: string | null;
	/**
	 * True when this run was a no-op because a prior `finalizeCheckoutTx`
	 * already finalized this set of orders — i.e. webhook redelivery (Stripe
	 * retries `payment_intent.succeeded` on its own cadence). Caller should
	 * skip side effects to avoid double-firing notifications / engagement
	 * events. Distinguishes the redelivery case from a real mid-3DS race-loss
	 * (where orders were still pending but listings were stolen by a different
	 * PI — that still throws `MidPaymentRaceLossSignal`).
	 */
	alreadyFinalized?: boolean;
}

/**
 * Run the post-payment finalization tx body. Shared between the worker's
 * `payment_intent.succeeded` handler and the API's $0 credit-only claim
 * path. Behavior is identical except `chargeId` is null in the credit-
 * only case.
 *
 * Idempotency: every UPDATE has a `paymentStatus = pending` predicate so
 * BullMQ retries and webhook redeliveries are no-ops. `skipDuplicates`
 * on the bulk creates covers the same.
 *
 * Throws `MidPaymentRaceLossSignal` when the listings.updateMany flipped
 * fewer rows than expected — caller decides how to recover.
 */
export async function finalizeCheckoutTx(
	input: FinalizeCheckoutTxInput,
): Promise<FinalizeCheckoutTxResult> {
	const { tx, orders, chargeId, paidAt } = input;
	const orderIds = orders.map((o) => o.id);
	const listingIds = orders.flatMap((o) => o.lineItems.map((l) => l.listingId));
	const acceptedOfferIds = orders
		.map((o) => o.acceptedOfferId)
		.filter((id): id is string => id !== null);

	const eligibleOriginationTypes = [
		OrderOriginationType.checkout,
		OrderOriginationType.offer_accepted,
	];
	const shippingOrderIds = orders
		.filter((o) => o.fulfillmentMode === FulfillmentMode.shipping)
		.map((o) => o.id);
	const pickupOrders = orders.filter(
		(o) => o.fulfillmentMode === FulfillmentMode.pickup,
	);

	// Track how many of our orders flipped from `pending → succeeded`. Used
	// below to distinguish a redelivery (zero flipped) from a real race-loss
	// (some flipped, but listings didn't).
	let totalOrdersFlipped = 0;

	if (shippingOrderIds.length > 0) {
		const result = await tx.order.updateMany({
			where: {
				id: { in: shippingOrderIds },
				originationType: { in: eligibleOriginationTypes },
				paymentStatus: PaymentStatus.pending,
			},
			data: {
				paymentStatus: PaymentStatus.succeeded,
				paymentChargeId: chargeId,
				paidAt,
				fulfillmentStatus: OrderStatus.awaiting_shipment,
			},
		});
		totalOrdersFlipped += result.count;
	}

	// Pickup orders need a unique 6-digit handoff code per row — can't fold
	// into a single updateMany.
	for (const order of pickupOrders) {
		const result = await tx.order.updateMany({
			where: {
				id: order.id,
				originationType: { in: eligibleOriginationTypes },
				paymentStatus: PaymentStatus.pending,
			},
			data: {
				paymentStatus: PaymentStatus.succeeded,
				paymentChargeId: chargeId,
				paidAt,
				fulfillmentStatus: OrderStatus.awaiting_pickup,
				pickupCode: generatePickupCode(),
			},
		});
		totalOrdersFlipped += result.count;
	}

	// Redelivery short-circuit: every Order is already past `pending`, so a
	// prior `finalizeCheckoutTx` did the work. Return early before the listing
	// flip / earning creates / capture so we don't (a) trip the race-loss
	// check below by finding no `reserved` listings — which previously caused
	// a phantom Stripe refund on every Stripe webhook redelivery — or (b) try
	// to re-INSERT rows (ShippingLabel.createMany has no `skipDuplicates`).
	if (totalOrdersFlipped === 0) {
		return {
			cancelledSiblings: [],
			cancelledSiblingState: OfferState.canceled_by_bin,
			cancelledSiblingsResolvedAt: new Date(),
			listingIds,
			buyerId: orders[0]?.buyerId ?? null,
			alreadyFinalized: true,
		};
	}

	const buyerId = orders[0]?.buyerId ?? null;
	if (buyerId) {
		await tx.cartItem.deleteMany({
			where: { buyerId, listingId: { in: listingIds } },
		});
	}

	const soldAt = new Date();
	const sortFields = getSortFieldsForTransition(ListingStatus.sold, {
		listingType: "fixed_price",
		createdAt: soldAt,
		soldAt,
	});
	const flipped = await tx.listing.updateMany({
		where: {
			reservedByOrderId: { in: orderIds },
			status: ListingStatus.reserved,
		},
		data: {
			status: ListingStatus.sold,
			soldAt,
			sortPriority: sortFields.sortPriority,
			sortTime: sortFields.sortTime,
			sortTimeMs: sortFields.sortTimeMs,
			reservedUntil: null,
			reservedByOrderId: null,
		},
	});
	if (flipped.count !== listingIds.length) {
		throw new MidPaymentRaceLossSignal(flipped.count);
	}

	const isOfferOrigin = orders.some(
		(o) => o.originationType === OrderOriginationType.offer_accepted,
	);
	const cancelledSiblingsResolvedAt = new Date();
	const cancelledSiblings = await tx.offer.findMany({
		where: {
			listingId: { in: listingIds },
			state: OfferState.pending,
			...(acceptedOfferIds.length > 0
				? { id: { notIn: acceptedOfferIds } }
				: {}),
		},
	});
	const cancelledSiblingState: OfferState = isOfferOrigin
		? OfferState.canceled_by_sibling_acceptance
		: OfferState.canceled_by_bin;
	if (cancelledSiblings.length > 0) {
		await tx.offer.updateMany({
			where: { id: { in: cancelledSiblings.map((s) => s.id) } },
			data: {
				state: cancelledSiblingState,
				resolvedAt: cancelledSiblingsResolvedAt,
			},
		});
	}

	const earningRows = orders.map((order) => ({
		orderId: order.id,
		sellerProfileId: order.sellerProfileId,
		grossAmount: order.subtotalCents,
		platformFee: order.applicationFeeCents,
		chargedProcessingFee: order.processingFeeCents,
		netAmount: order.lineItems.reduce(
			(sum, l) => sum + l.sellerEarningCents,
			0,
		),
		taxAmount: order.taxCents,
		buyerPremiumAmount: 0,
		payoutStatus: PayoutStatus.requires_action,
	}));
	await tx.earning.createMany({ data: earningRows, skipDuplicates: true });

	// Earning IDs aren't pre-generated cleanly because skipDuplicates is
	// keyed on orderId @unique; on redelivery the prior Earning's id is
	// authoritative. Read back, then createMany the lines.
	const createdEarnings = await tx.earning.findMany({
		where: { orderId: { in: orderIds } },
		select: { id: true, orderId: true },
	});
	const earningIdByOrderId = new Map(
		createdEarnings.map((e) => [e.orderId, e.id]),
	);
	const earningLineRows = orders.flatMap((order) => {
		const earningId = earningIdByOrderId.get(order.id);
		if (!earningId) return [];
		return order.lineItems.map((li) => ({
			earningId,
			orderLineItemId: li.id,
			grossCents: li.priceCents,
			platformFeeCents: li.applicationFeeCents,
			processingFeeCents: li.processingFeeCents,
			netCents: li.sellerEarningCents,
		}));
	});
	if (earningLineRows.length > 0) {
		await tx.earningLine.createMany({
			data: earningLineRows,
			skipDuplicates: true,
		});
	}

	// ShippingLabel rows for shipping-mode orders. Rail decision frozen on
	// Order.shippingPresetKey at checkout/claim.
	const labelRows: Prisma.ShippingLabelCreateManyInput[] = [];
	for (const order of orders) {
		if (order.fulfillmentMode !== FulfillmentMode.shipping) continue;

		const presetKey = order.shippingPresetKey;
		const letterPreset =
			presetKey != null ? getLetterPreset(presetKey) : undefined;
		const parcelPreset =
			presetKey != null && letterPreset == null
				? getPreset(presetKey)
				: undefined;

		if (letterPreset) {
			labelRows.push({
				orderId: order.id,
				provider: "easypost",
				serviceCode: LETTER_SERVICE_CODE,
				weightLbs: new Prisma.Decimal(LETTER_PLACEHOLDER_PARCEL_DIMS.weightLbs),
				lengthIn: new Prisma.Decimal(LETTER_PLACEHOLDER_PARCEL_DIMS.lengthIn),
				widthIn: new Prisma.Decimal(LETTER_PLACEHOLDER_PARCEL_DIMS.widthIn),
				heightIn: new Prisma.Decimal(LETTER_PLACEHOLDER_PARCEL_DIMS.heightIn),
			});
			continue;
		}

		if (parcelPreset) {
			labelRows.push({
				orderId: order.id,
				weightLbs: new Prisma.Decimal(parcelPreset.weightLbs),
				lengthIn: new Prisma.Decimal(parcelPreset.lengthIn),
				widthIn: new Prisma.Decimal(parcelPreset.widthIn),
				heightIn: new Prisma.Decimal(parcelPreset.heightIn),
			});
			continue;
		}

		const { dims, anomalousFallback } = computeBundleDims(order.lineItems);
		if (anomalousFallback) {
			input.onAnomalousFallback?.({ orderId: order.id });
		}
		labelRows.push({
			orderId: order.id,
			weightLbs: dims.weightLbs,
			lengthIn: dims.lengthIn,
			widthIn: dims.widthIn,
			heightIn: dims.heightIn,
		});
	}
	if (labelRows.length > 0) {
		await tx.shippingLabel.createMany({ data: labelRows });
	}

	// Capture any wallet credit held for this checkout. AppliedCredit rows
	// landed in claim's Tx A; capture batches them into one wallet CAS +
	// one createManyAndReturn. Per-row backfill of captureEntryId and
	// capturedCents is N updates inside the same tx — N is small.
	const appliedCredits = await tx.appliedCredit.findMany({
		where: { orderId: { in: orderIds }, captureEntryId: null },
		select: { id: true, holdEntryId: true, appliedCents: true },
	});
	const captureSpecs = appliedCredits.filter(
		(ac): ac is typeof ac & { holdEntryId: string } => ac.holdEntryId !== null,
	);
	if (captureSpecs.length > 0) {
		const captureEntries = await captureHolds({
			db: tx,
			holds: captureSpecs.map((ac) => ({
				holdEntryId: ac.holdEntryId,
				idempotencyKey: `${ac.id}:capture`,
			})),
		});
		for (let i = 0; i < captureSpecs.length; i++) {
			const spec = captureSpecs[i];
			const entry = captureEntries[i];
			if (!spec || !entry) {
				throw new Error("capture/applied-credit ordering mismatch");
			}
			await tx.appliedCredit.update({
				where: { id: spec.id },
				data: {
					capturedCents: spec.appliedCents,
					captureEntryId: entry.id,
				},
			});
		}
	}

	return {
		cancelledSiblings,
		cancelledSiblingState,
		cancelledSiblingsResolvedAt,
		listingIds,
		buyerId,
	};
}

export interface ReleaseOrdersTxInput {
	tx: Prisma.TransactionClient;
	orders: Pick<
		OrderForFinalization,
		"id" | "originationType" | "acceptedOfferId"
	>[];
	/** `voided` = abandoned (PI canceled / superseded); `failed` = declined. */
	terminalStatus: Extract<PaymentStatus, "failed" | "voided">;
}

/**
 * Terminal-release tx body, shared by the worker's `payment_intent.canceled` /
 * `.payment_failed` handlers and the API checkout-claim resume guard (which
 * supersedes a buyer's own abandoned in-flight order before re-reserving —
 * NL-378). Flips the orders to `terminalStatus`, voids their line items (frees
 * the listing's 1-of-1 slot), releases reserved listings back to `active`,
 * voids any linked offer, and releases held wallet credit.
 *
 * Idempotent under retries / concurrent paths:
 *   - order flip is guarded `WHERE paymentStatus = pending`
 *   - listing release is scoped `WHERE reservedByOrderId IN (orderIds) AND
 *     status = reserved`, so a *fresh* re-reservation by a new order (the
 *     resume guard's next step) is never clobbered by a late webhook
 *   - credit release dedupes on the unified `${ac.id}:release` key
 */
export async function releaseOrdersTx(
	input: ReleaseOrdersTxInput,
): Promise<void> {
	const { tx, orders, terminalStatus } = input;
	const orderIds = orders.map((o) => o.id);
	const offerIdsToVoid = orders
		.map((o) => o.acceptedOfferId)
		.filter((id): id is string => id !== null);

	await tx.order.updateMany({
		where: {
			id: { in: orderIds },
			originationType: {
				in: [
					OrderOriginationType.checkout,
					OrderOriginationType.offer_accepted,
				],
			},
			paymentStatus: PaymentStatus.pending,
		},
		data: { paymentStatus: terminalStatus },
	});
	await tx.orderLineItem.updateMany({
		where: { orderId: { in: orderIds }, voidedAt: null },
		data: { voidedAt: new Date() },
	});
	await tx.listing.updateMany({
		where: {
			reservedByOrderId: { in: orderIds },
			status: ListingStatus.reserved,
		},
		data: {
			status: ListingStatus.active,
			reservedUntil: null,
			reservedByOrderId: null,
		},
	});
	if (offerIdsToVoid.length > 0) {
		await tx.offer.updateMany({
			where: {
				id: { in: offerIdsToVoid },
				state: {
					in: [OfferState.accepted, OfferState.accepted_payment_pending],
				},
			},
			data: {
				state: OfferState.canceled_payment_failed,
				resolvedAt: new Date(),
			},
		});
	}
	const heldCredits = await tx.appliedCredit.findMany({
		where: {
			orderId: { in: orderIds },
			holdEntryId: { not: null },
			captureEntryId: null,
		},
		select: { id: true, holdEntryId: true },
	});
	const releaseSpecs = heldCredits.filter(
		(ac): ac is typeof ac & { holdEntryId: string } => ac.holdEntryId !== null,
	);
	if (releaseSpecs.length > 0) {
		await releaseHolds({
			db: tx,
			holds: releaseSpecs.map((ac) => ({
				holdEntryId: ac.holdEntryId,
				idempotencyKey: `${ac.id}:release`,
			})),
		});
	}
}
