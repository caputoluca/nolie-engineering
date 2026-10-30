import {
	finalizeCheckoutTx,
	MidPaymentRaceLossSignal,
	type OrderForFinalization,
	runCheckoutSideEffects,
} from "@nolie/checkout";
import {
	ListingStatus,
	OfferState,
	OrderOriginationType,
	PaymentStatus,
} from "@nolie/db";
import type { NoLieJob } from "@nolie/queues/types";
import type { webhooksStripeQueue } from "@nolie/queues/webhooks-stripe";
import { releaseHolds } from "@nolie/wallet";
import type Stripe from "stripe";
import { workerTx } from "../../../db/tx.js";
import {
	reportError,
	reportWarning,
	setReportingContext,
} from "../../observability/sentry/report.js";
import { fanOutCanceledSiblings } from "../../offers/cancel-fanout.js";
import type { WebhookContext } from "../context.js";
import { loadFinalizableOrdersForPI } from "./_helpers.js";

/**
 * Worker-side `payment_intent.succeeded` handler. Delegates the DB tx
 * body to `@nolie/checkout/finalizeCheckoutTx` (shared with the API's
 * $0 credit-only claim path) and the queue/notification fan-out to
 * `runCheckoutSideEffects`. Race-loss handling is webhook-specific and
 * stays here — the credit-only path can't physically race-lose.
 *
 * Idempotency: predicates inside `finalizeCheckoutTx` (`paymentStatus
 * = pending` on every UPDATE, `skipDuplicates` on bulk creates) make
 * re-fires a no-op, covering BullMQ retries and Stripe redeliveries.
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
	const paidAt = new Date();

	let finalizeResult: Awaited<ReturnType<typeof finalizeCheckoutTx>>;
	try {
		finalizeResult = await workerTx(ctx.prisma, (tx) =>
			finalizeCheckoutTx({
				tx,
				orders,
				chargeId,
				paidAt,
				onAnomalousFallback: ({ orderId }) => {
					reportError(
						new Error(
							"payment_intent.succeeded: ShippingLabel sized from fallback dims — non-letter listing reached payment with no package dims",
						),
						{
							operation: "pi_succeeded_label_fallback_dims",
							extra: { orderId, paymentIntentId },
						},
					);
				},
			}),
		);
	} catch (err) {
		if (err instanceof MidPaymentRaceLossSignal) {
			await handleMidThreeDsRaceLoss({
				ctx,
				event,
				paymentIntentId,
				orders,
				expectedListingCount: orders.flatMap((o) =>
					o.lineItems.map((l) => l.listingId),
				).length,
				flippedCount: err.flippedCount,
			});
			return;
		}
		throw err;
	}

	// Webhook redelivery — Stripe re-fires `payment_intent.succeeded` on its
	// own cadence. `finalizeCheckoutTx` detected the prior finalize and no-op'd.
	// Skip side effects so we don't double-fire notifications / engagement
	// events; the first call already enqueued them.
	if (finalizeResult.alreadyFinalized) {
		ctx.logger.info(
			{ eventId: event.id, paymentIntentId, orderIds },
			"payment_intent.succeeded: redelivery — prior finalize already completed; skipping side effects",
		);
		return;
	}

	ctx.logger.info(
		{ eventId: event.id, paymentIntentId, orderIds, chargeId },
		"payment_intent.succeeded: orders finalized",
	);

	runCheckoutSideEffects({
		orders,
		paymentIntentId,
		paidAt,
		queues: ctx.queues,
		logger: ctx.logger,
		reportError,
		analytics: ctx.analytics,
		marketing: ctx.marketing,
	});

	fanOutCanceledSiblings({
		realtime: ctx.realtime(),
		notificationsQueue: ctx.queues.notifications,
		siblings: finalizeResult.cancelledSiblings,
		state: finalizeResult.cancelledSiblingState,
		resolvedAt: finalizeResult.cancelledSiblingsResolvedAt,
		resolvedBy: null,
		context: "pi_succeeded",
	});
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
		// Mid-3DS race-loss: main tx rolled back so no captures ran, but
		// claim's Tx A wrote the holds. Release them back to available so
		// the buyer's wallet UI matches the Stripe refund landing on their
		// card. Unified release key (`${ac.id}:release`) replays cleanly
		// if a follow-on webhook tries again.
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
