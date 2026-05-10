import { addBusinessDays } from "@nolie/core/business-days";
import { DAYS_PASSED_BEFORE_FULFILLMENT_DISPUTE_WINDOW } from "@nolie/core/disputes";
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
				data: {
					paymentStatus: PaymentStatus.succeeded,
					paymentChargeId: chargeId,
					fulfillmentStatus: OrderStatus.awaiting_shipment,
				},
			});

			const buyerIdForCart = orders[0]?.buyerId;
			if (buyerIdForCart) {
				await tx.cartItem.deleteMany({
					where: {
						buyerId: buyerIdForCart,
						listingId: { in: listingIds },
					},
				});
			}

			const flipped = await tx.listing.updateMany({
				where: {
					reservedByOrderId: { in: orderIds },
					status: ListingStatus.reserved,
				},
				data: {
					status: ListingStatus.sold,
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

				const dims = computeBundleDims(order.lineItems);
				if (!dims) {
					ctx.logger.warn(
						{ orderId: order.id, paymentIntentId },
						"payment_intent.succeeded: skipping ShippingLabel create — line items missing package dims (un-backfilled?)",
					);
					continue;
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
