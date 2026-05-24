import { randomUUID } from "node:crypto";
import { getSortFieldsForTransition } from "@nolie/core/auctions";
import { addBusinessDays } from "@nolie/core/business-days";
import { DAYS_PASSED_BEFORE_FULFILLMENT_DISPUTE_WINDOW } from "@nolie/core/disputes";
import {
	EngagementEventName,
	EngagementSystemSessionId,
} from "@nolie/core/engagement/catalog";
import { generatePickupCode } from "@nolie/core/orders";
import {
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
import type { NoLieJob } from "@nolie/queues/types";
import type { webhooksStripeQueue } from "@nolie/queues/webhooks-stripe";
import {
	getLetterPreset,
	getPreset,
	LETTER_PLACEHOLDER_PARCEL_DIMS,
	LETTER_SERVICE_CODE,
} from "@nolie/shipping/presets";
import { captureHolds, releaseHolds } from "@nolie/wallet";
import type Stripe from "stripe";
import { workerTx } from "../../../db/tx.js";
import {
	reportError,
	reportWarning,
	setReportingContext,
} from "../../observability/sentry/report.js";
import { fanOutCanceledSiblings } from "../../offers/cancel-fanout.js";
import type { WebhookContext } from "../context.js";
import {
	computeBundleDims,
	loadFinalizableOrdersForPI,
	type OrderForFinalization,
} from "./_helpers.js";

/**
 * Worker-side `payment_intent.succeeded` handler. Mirrors
 * `apps/api/app/lib/stripe/payment-intents.ts handlePaymentIntentSucceeded`
 * 1:1 — same DB tx, same fan-out, same race-loss path.
 *
 * Idempotency: the `paymentStatus = pending` predicate on the Order
 * UPDATE makes a re-fire a no-op, which covers BullMQ retries and
 * Stripe redeliveries past the 4-day jobId dedupe window.
 */
export async function paymentIntentSucceeded(
	job: NoLieJob<typeof webhooksStripeQueue, "paymentIntentSucceeded">,
	ctx: WebhookContext,
): Promise<void> {
	const event = job.data as unknown as Stripe.Event;
	const pi = event.data.object as Stripe.PaymentIntent;
	const paymentIntentId = pi.id;
	const chargeId =
		typeof pi.latest_charge === "string"
			? pi.latest_charge
			: (pi.latest_charge?.id ?? null);

	const orders = await loadFinalizableOrdersForPI(ctx.prisma, paymentIntentId);
	if (orders.length === 0) {
		ctx.logger.info(
			{ eventId: event.id, paymentIntentId },
			"payment_intent.succeeded: no finalizable orders found for this PI; skipping (likely auction-won or pre-checkout PI)",
		);
		return;
	}

	const orderIds = orders.map((o) => o.id);
	const listingIds = orders.flatMap((o) => o.lineItems.map((l) => l.listingId));
	const acceptedOfferIds = orders
		.map((o) => o.acceptedOfferId)
		.filter((id): id is string => id !== null);

	let cancelledSiblings: Offer[] = [];
	let cancelledSiblingState: OfferState = OfferState.canceled_by_bin;
	const cancelledSiblingsResolvedAt = new Date();

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

	try {
		await workerTx(ctx.prisma, async (tx) => {
			const paidAt = new Date();
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

			if (shippingOrderIds.length > 0) {
				await tx.order.updateMany({
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
			}

			// Pickup orders need a unique 6-digit handoff code per row, so we
			// can't do a single updateMany — loop with updateMany-per-id to
			// keep the paymentStatus=pending idempotency predicate.
			for (const order of pickupOrders) {
				await tx.order.updateMany({
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
			}

			const buyerIdForCart = orders[0]?.buyerId;
			if (buyerIdForCart) {
				await tx.cartItem.deleteMany({
					where: {
						buyerId: buyerIdForCart,
						listingId: { in: listingIds },
					},
				});
			}

			// All listings in this batch share the same soldAt, and the BIN→sold
			// sort fields depend only on soldAt, so compute once and reuse.
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
				throw new MidThreeDsRaceLossSignal(flipped.count);
			}

			const isOfferOrigin = orders.some(
				(o) => o.originationType === OrderOriginationType.offer_accepted,
			);
			cancelledSiblings = await tx.offer.findMany({
				where: {
					listingId: { in: listingIds },
					state: OfferState.pending,
					...(acceptedOfferIds.length > 0
						? { id: { notIn: acceptedOfferIds } }
						: {}),
				},
			});
			cancelledSiblingState = isOfferOrigin
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

			await tx.earning.createMany({
				data: earningRows,
				skipDuplicates: true,
			});

			// NL-183: per-line ledger alongside each Earning. Read back the
			// just-created Earnings (we can't pre-generate IDs cleanly
			// because skipDuplicates is keyed on `orderId @unique`; on a
			// webhook redelivery the existing Earning's id is the
			// authoritative one). Then createMany the EarningLines —
			// skipDuplicates on the `orderLineItemId @unique` index makes
			// redeliveries no-op on already-created lines.
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

			// NL-253: build all ShippingLabel rows up front, then one
			// createMany. Decision lives on Order.shippingPresetKey
			// (resolved by checkout/claim):
			//  - letter preset key  → EasyPost FCML; placeholder dims; on-wire
			//                         weight computed at label-purchase time
			//                         from line-item count via
			//                         `letterWeightOzForCardCount`.
			//  - parcel preset key  → Shippo, dims looked up from PACKAGE_PRESETS
			//                         (this is the auto-upgrade path; the listings
			//                         themselves carry no parcel dims because they
			//                         were created as letter listings).
			//  - null               → Shippo, dims from `computeBundleDims` on
			//                         per-listing parcel dims (default parcel rail).
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
						weightLbs: new Prisma.Decimal(
							LETTER_PLACEHOLDER_PARCEL_DIMS.weightLbs,
						),
						lengthIn: new Prisma.Decimal(
							LETTER_PLACEHOLDER_PARCEL_DIMS.lengthIn,
						),
						widthIn: new Prisma.Decimal(LETTER_PLACEHOLDER_PARCEL_DIMS.widthIn),
						heightIn: new Prisma.Decimal(
							LETTER_PLACEHOLDER_PARCEL_DIMS.heightIn,
						),
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

				// `computeBundleDims` always returns a usable box now — a
				// dims-less line falls back to the standard_card upgrade size
				// rather than stranding the (already-charged) order. A
				// letter-tagged line in a mixed bundle hitting the fallback
				// is by design and stays silent; `anomalousFallback` flags
				// only a non-letter listing with no dims (un-backfilled
				// parcel listing, or a future path that didn't freeze the
				// rail) — a real problem worth a Sentry signal.
				const { dims, anomalousFallback } = computeBundleDims(order.lineItems);
				if (anomalousFallback) {
					reportError(
						new Error(
							"payment_intent.succeeded: ShippingLabel sized from fallback dims — non-letter listing reached payment with no package dims",
						),
						{
							operation: "pi_succeeded_label_fallback_dims",
							extra: { orderId: order.id, paymentIntentId },
						},
					);
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

			// Capture any wallet credit held for this checkout. AppliedCredit
			// rows landed in claim's Tx A; capture batches them into one
			// wallet CAS + one createManyAndReturn. Per-row backfill of
			// `captureEntryId` + `capturedCents` is N updates inside the same
			// tx — N is small (one per Order with credit) and the previous
			// captureMany-by-key SQL would be heavier than the loop saves.
			const appliedCredits = await tx.appliedCredit.findMany({
				where: { orderId: { in: orderIds }, captureEntryId: null },
				select: { id: true, holdEntryId: true, appliedCents: true },
			});
			const captureSpecs = appliedCredits.filter(
				(ac): ac is typeof ac & { holdEntryId: string } =>
					ac.holdEntryId !== null,
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
		});
	} catch (err) {
		if (err instanceof MidThreeDsRaceLossSignal) {
			await handleMidThreeDsRaceLoss({
				ctx,
				event,
				paymentIntentId,
				orders,
				expectedListingCount: listingIds.length,
				flippedCount: err.flippedCount,
			});
			return;
		}
		throw err;
	}

	ctx.logger.info(
		{
			eventId: event.id,
			paymentIntentId,
			orderIds,
			chargeId,
		},
		"payment_intent.succeeded: orders finalized",
	);

	// purchase_completed engagement events (NL-310 §5.1). One event per line
	// item per order — token-popularity attribution needs per-listing rows.
	// `session_id` is the synthetic settle sentinel since there's no user
	// session in the worker. Single bulk enqueue → one Redis pipeline for the
	// whole multi-seller bundle instead of N round trips. Fire-and-forget;
	// never block the settle path.
	const purchaseOccurredAt = new Date().toISOString();
	const purchaseEventItems = orders.flatMap((order) =>
		order.lineItems.map((li) => ({
			data: {
				eventId: randomUUID(),
				eventName: EngagementEventName.purchaseCompleted,
				eventVersion: 1,
				occurredAt: purchaseOccurredAt,
				sessionId: EngagementSystemSessionId.settle,
				userId: order.buyerId,
				anonymousId: null,
				listingId: li.listingId,
				sellerId: order.sellerProfileId,
				orderId: order.id,
				surface: null,
				queryId: null,
				rankPosition: null,
				rankEpoch: null,
				// §19 — copied from OrderLineItem (which was copied from
				// CartItem at materialization). Null when the order came
				// from a non-cart path (direct quote / offer accept) OR
				// when the buyer added to cart before referrer wiring shipped.
				referrerSurface: li.referrerSurface,
				referrerQueryId: li.referrerQueryId,
				referrerRankPosition: li.referrerRankPosition,
				client: null,
				appVersion: null,
				userAgent: null,
				ipCountry: null,
				payload: { amount_cents: li.priceCents },
			},
		})),
	);
	if (purchaseEventItems.length > 0) {
		void ctx.queues.engagementEvents.write
			.bulk(purchaseEventItems)
			.catch((err) => {
				reportError(err, {
					operation: "engagement_event_emit_purchase_completed",
					extra: { orderIds, batchSize: purchaseEventItems.length },
				});
			});
	}

	fanOutCanceledSiblings({
		realtime: ctx.realtime(),
		notificationsQueue: ctx.queues.notifications,
		siblings: cancelledSiblings,
		state: cancelledSiblingState,
		resolvedAt: cancelledSiblingsResolvedAt,
		resolvedBy: null,
		context: "pi_succeeded",
	});

	const buyerId = orders[0]?.buyerId;
	if (buyerId) {
		void ctx.queues.notifications
			.orderConfirmed({ paymentIntentId, buyerId })
			.catch((err) => {
				reportError(err, {
					operation: "checkout_succeeded_queue_order_confirmed",
					extra: { paymentIntentId, buyerId },
				});
				ctx.logger.error(
					{ err, paymentIntentId, buyerId },
					"payment_intent.succeeded: failed to queue orderConfirmed notification (non-blocking)",
				);
			});
	}

	const shippingOrderItems = orders
		.filter((o) => o.fulfillmentMode === FulfillmentMode.shipping)
		.map((order) => ({
			data: {
				orderId: order.id,
				userId: order.sellerUserId,
			},
			orderId: order.id,
		}));

	if (shippingOrderItems.length > 0) {
		void ctx.queues.notifications.deliveryNeeded
			.bulk(shippingOrderItems.map(({ data }) => ({ data })))
			.catch((err) => {
				const failedOrderIds = shippingOrderItems.map((i) => i.orderId);
				reportError(err, {
					operation: "checkout_succeeded_queue_delivery_needed",
					extra: { orderIds: failedOrderIds, paymentIntentId },
				});
				ctx.logger.error(
					{ err, orderIds: failedOrderIds, paymentIntentId },
					"payment_intent.succeeded: failed to queue deliveryNeeded notifications (non-blocking)",
				);
			});

		// shipping reminder ~1h before the dispute window opens.
		const reminderDelay = Math.max(
			0,
			addBusinessDays(
				new Date(),
				DAYS_PASSED_BEFORE_FULFILLMENT_DISPUTE_WINDOW,
			).getTime() -
				Date.now() -
				60 * 60 * 1000,
		);
		void ctx.queues.notifications.deliveryReminder
			.bulk(
				shippingOrderItems.map(({ data }) => ({
					data,
					opts: { delay: reminderDelay },
				})),
			)
			.catch((err) => {
				const failedOrderIds = shippingOrderItems.map((i) => i.orderId);
				reportError(err, {
					operation: "checkout_succeeded_queue_delivery_reminder",
					extra: { orderIds: failedOrderIds, paymentIntentId },
				});
				ctx.logger.error(
					{ err, orderIds: failedOrderIds, paymentIntentId },
					"payment_intent.succeeded: failed to queue deliveryReminder notifications (non-blocking)",
				);
			});
	}
}

class MidThreeDsRaceLossSignal extends Error {
	constructor(public readonly flippedCount: number) {
		super("BIN mid-3DS race-loss detected");
		this.name = "MidThreeDsRaceLossSignal";
	}
}

async function handleMidThreeDsRaceLoss({
	ctx,
	event,
	paymentIntentId,
	orders,
	expectedListingCount,
	flippedCount,
}: {
	ctx: WebhookContext;
	event: Stripe.Event;
	paymentIntentId: string;
	orders: OrderForFinalization[];
	expectedListingCount: number;
	flippedCount: number;
}): Promise<void> {
	const orderIds = orders.map((o) => o.id);
	const primaryOrder = orders[0];
	if (!primaryOrder) return;

	const expectedListingIds = orders.flatMap((o) =>
		o.lineItems.map((l) => l.listingId),
	);
	const mismatches = await ctx.prisma.listing.findMany({
		where: {
			id: { in: expectedListingIds },
			OR: [
				{ reservedByOrderId: null },
				{ reservedByOrderId: { notIn: orderIds } },
				{ status: { not: ListingStatus.reserved } },
			],
		},
		select: { id: true, reservedByOrderId: true, status: true },
	});

	reportWarning("BIN mid-3DS race-loss detected; refunding buyer", {
		operation: "checkout_mid_3ds_race_loss",
		extra: {
			eventId: event.id,
			paymentIntentId,
			orderIds,
			expectedListingCount,
			flippedCount,
			mismatches: mismatches.map((m) => ({
				listingId: m.id,
				actualReservedByOrderId: m.reservedByOrderId,
				actualStatus: m.status,
			})),
		},
	});

	try {
		const refund = await ctx.payments.customer.refund({
			paymentIntentId,
			orderId: primaryOrder.id,
			customerId: primaryOrder.buyerId,
		});
		ctx.logger.info(
			{
				eventId: event.id,
				paymentIntentId,
				orderIds,
				refundId: refund.refundId,
			},
			"payment_intent.succeeded: mid-3DS race-loss refund issued",
		);
	} catch (err) {
		setReportingContext({
			operation: "checkout_mid_3ds_refund_failed",
			extra: { eventId: event.id, paymentIntentId, orderIds },
		});
		ctx.logger.error(
			{ err, eventId: event.id, paymentIntentId, orderIds },
			"payment_intent.succeeded: mid-3DS refund failed — manual intervention required",
		);
		throw err;
	}

	const offerIdsToVoid = orders
		.map((o) => o.acceptedOfferId)
		.filter((id): id is string => id !== null);
	await workerTx(ctx.prisma, async (tx) => {
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
			data: { paymentStatus: PaymentStatus.voided },
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
		// Mid-3DS race-loss: the main tx rolled back so no captures ran, but
		// claim's Tx A wrote the holds. Release them back to available so the
		// buyer's wallet shows the refund in real time alongside the Stripe
		// refund landing on their card.
		const heldCredits = await tx.appliedCredit.findMany({
			where: {
				orderId: { in: orderIds },
				holdEntryId: { not: null },
				captureEntryId: null,
			},
			select: { id: true, holdEntryId: true },
		});
		const releaseSpecs = heldCredits.filter(
			(ac): ac is typeof ac & { holdEntryId: string } =>
				ac.holdEntryId !== null,
		);
		if (releaseSpecs.length > 0) {
			// Unified release key across race-loss, PI-canceled, and PI-failed.
			// A hold settles exactly once via release OR capture; if a follow-on
			// webhook fires after another path already released, the batch
			// idempotency check returns the existing entries as a replay no-op
			// instead of tripping the "already settled" guard.
			await releaseHolds({
				db: tx,
				holds: releaseSpecs.map((ac) => ({
					holdEntryId: ac.holdEntryId,
					idempotencyKey: `${ac.id}:release`,
				})),
			});
		}
	});

	ctx.logger.warn(
		{
			eventId: event.id,
			paymentIntentId,
			buyerId: primaryOrder.buyerId,
			orderIds,
		},
		"payment_intent.succeeded: apology email STUB — real template ships in PR 4",
	);
}
