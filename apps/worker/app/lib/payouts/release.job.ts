import { getReleasableLines } from "@nolie/core/payouts";
import {
	isPrismaRecordNotFoundError,
	PayoutStatus,
	type Prisma,
} from "@nolie/db";
import { PaymentErrorCode } from "@nolie/payments";
import { logger } from "../../logger.js";
import { RetryableError } from "../../retryable-error.js";
import { reportError, reportWarning } from "../observability/sentry/report.js";
import type { PayoutsContext } from "./context.js";
import {
	markPayoutAsFailed,
	reschedulePayoutForInsufficientFunds,
} from "./release-utils.js";
import type { PayoutJob } from "./types.js";

/**
 * Payout release (NL-183 / Pattern B).
 *
 * For each Earning, releases the seller's net via a Stripe Transfer.
 * Per-line aware: lines with pending or refunded disputes are held
 * back, clean lines ship now. When a dispute resolves (chat 3), the
 * resolver re-queues this job and the held line ships in its own
 * Transfer.
 *
 * Each Stripe Transfer corresponds to one PayoutTransfer row, which
 * is what `payout.paid` webhooks key off. The row is pre-allocated
 * (its cuid is the Stripe idempotency key) before calling Stripe.
 *
 * Deploy-window orphan shim: if an Earning was created by an old
 * worker pod that didn't populate EarningLine, lines.length is 0.
 * We fall back to the legacy single-Transfer path AND insert a
 * PayoutTransfer row so the new webhook handler can still reconcile.
 */
export async function release(job: PayoutJob<"release">, ctx: PayoutsContext) {
	const { earningId } = job.data;

	logger.info({ earningId }, "payout.release: starting");

	const earning = await ctx.prisma.earning.findUnique({
		where: { id: earningId },
		select: {
			id: true,
			netAmount: true,
			orderId: true,
			sellerProfileId: true,
			insufficientFundsRetryAttempts: true,
			payoutStatus: true,
			createdAt: true,
			// Legacy single-Transfer fields — kept nullable in the expand
			// step; written on the FIRST transfer for old-webhook back-compat,
			// then ignored on subsequent partials.
			stripeTransferId: true,
			order: {
				select: {
					id: true,
					buyerId: true,
					paymentIntentId: true,
					paymentChargeId: true,
					// Shim: orphan Earnings (no EarningLines) fall back to a
					// per-Order any-line-disputed check.
					lineItems: {
						select: {
							fulfillmentDispute: { select: { status: true } },
						},
					},
				},
			},
			lines: {
				select: {
					id: true,
					netCents: true,
					refundedNetCents: true,
					platformAbsorbedNetCents: true,
					paidAt: true,
					orderLineItem: {
						select: {
							fulfillmentDispute: { select: { status: true } },
						},
					},
				},
			},
			sellerProfile: {
				select: {
					userId: true,
					connectAccountId: true,
				},
			},
		},
	});

	if (!earning) {
		logger.error({ earningId }, "payout.release: earning not found; skipping");
		return;
	}

	const orderIdForNotification = earning.order?.id ?? null;

	// Terminal-state gate. Held-back states (requires_action) and failed
	// states block release. `succeeded` is NOT blocked: an old webhook
	// handler can prematurely flip an Earning to succeeded after the
	// first partial transfer's payout clears; we still need to be able
	// to release the held lines once they unblock.
	if (
		earning.payoutStatus === PayoutStatus.failed ||
		earning.payoutStatus === PayoutStatus.refunded ||
		earning.payoutStatus === PayoutStatus.requires_action
	) {
		logger.info(
			{
				earningId,
				reason: "earning_terminal_state",
				payoutStatus: earning.payoutStatus,
			},
			"payout.release.skipped",
		);
		return;
	}

	const connectAccountId = earning.sellerProfile.connectAccountId;
	if (!connectAccountId) {
		reportWarning("Seller has no connect account for payout", {
			operation: "release_payout",
			extra: { earningId, orderId: earning.orderId },
		});
		logger.error(
			{ earningId },
			"payout.release: seller has no connect account; marking as failed",
		);
		await markPayoutAsFailed(ctx.prisma, { earningId });

		if (orderIdForNotification) {
			void ctx.queues.notifications
				.payoutFailed({
					orderId: orderIdForNotification,
					userId: earning.sellerProfile.userId,
				})
				.catch((err) => {
					reportError(err, {
						operation: "queue_payout_failed_notification",
						extra: { earningId, orderId: earning.orderId },
					});
					logger.warn(
						{ err, earningId, orderId: earning.orderId },
						"payout.release: Failed to queue payoutFailed notification",
					);
				});
		}
		return;
	}

	if (!earning.order) {
		logger.error(
			{ earningId },
			"payout.release: earning has no order; failing",
		);
		await markPayoutAsFailed(ctx.prisma, { earningId });
		reportWarning("Order not found in payout release job", {
			operation: "release_payout",
			extra: { earningId },
		});
		return;
	}

	const buyerId = earning.order.buyerId;
	if (!buyerId) {
		logger.error(
			{ earningId, orderId: earning.order.id },
			"payout.release: order missing buyerId; failing",
		);
		reportWarning("Order missing buyerId in payout release job", {
			operation: "release_payout",
			extra: { earningId },
		});
		await markPayoutAsFailed(ctx.prisma, { earningId });
		return;
	}

	// ────────────────────────────────────────────────────────────
	// Decide the release plan: per-line (normal) vs orphan shim
	// ────────────────────────────────────────────────────────────
	const isOrphan = earning.lines.length === 0;

	let amountCents: number;
	let earningLineIdsToMark: string[];

	if (isOrphan) {
		// Deploy-window orphan: Earning created by an old worker pod
		// pre-rollout that didn't populate EarningLine rows. Use the
		// legacy any-line-disputed check + transfer the full netAmount.
		// A post-deploy re-backfill (or chat 3) heals the EarningLine
		// rows; this path stops being hit once the re-backfill runs.
		reportWarning("payout.release: orphan Earning (no EarningLine)", {
			operation: "release_payout",
			extra: { earningId, orderId: earning.orderId },
		});
		logger.warn(
			{ earningId },
			"payout.release: orphan Earning — falling back to legacy single-Transfer path",
		);

		// Legacy gate: skip if ANY line has a pending/refunded dispute.
		// Same conservatism as pre-NL-183.
		const legacyBlocked = earning.order.lineItems.some((li) => {
			const s = li.fulfillmentDispute?.status;
			return s === "pending" || s === "refunded";
		});
		if (legacyBlocked) {
			logger.info(
				{ earningId, reason: "orphan_legacy_disputed" },
				"payout.release.skipped",
			);
			return;
		}

		// Idempotency: if Earning already has stripeTransferId set, an
		// old worker pod already paid this Earning. No-op.
		if (earning.stripeTransferId !== null) {
			logger.info(
				{
					earningId,
					reason: "orphan_already_paid",
					stripeTransferId: earning.stripeTransferId,
				},
				"payout.release.skipped",
			);
			return;
		}

		amountCents = earning.netAmount;
		earningLineIdsToMark = []; // no lines to mark
	} else {
		// Normal per-line path
		const releasable = getReleasableLines({ lines: earning.lines });
		if (releasable.allBlocked) {
			// Categorise the skip for telemetry — one log line, one reason.
			const reason = releasable.hasPendingDisputes
				? "held_by_pending_dispute"
				: releasable.hasRefundedLines
					? "held_by_refunded_dispute"
					: "all_lines_paid";
			logger.info(
				{
					earningId,
					reason,
					lineCount: earning.lines.length,
				},
				"payout.release.skipped",
			);
			return;
		}
		amountCents = releasable.totalCents;
		earningLineIdsToMark = releasable.lines.map((l) => l.earningLineId);
	}

	const amountInDollars = amountCents / 100;

	if (amountInDollars <= 0) {
		logger.error(
			{ earningId, orderId: earning.orderId, amountInDollars },
			"payout.release: amount is less than or equal to 0; failing",
		);
		reportWarning("Net amount is <= 0 in payout release job", {
			level: "error",
			operation: "release_payout",
			extra: { earningId },
		});
		await markPayoutAsFailed(ctx.prisma, { earningId });
		return;
	}

	// Pre-allocate the PayoutTransfer row. Its id is the Stripe
	// idempotency key — one row = one Transfer. Inserted BEFORE the
	// Stripe call so that if we crash mid-flight, the row exists for
	// audit and the Stripe idempotency replay returns the same Transfer.
	const payoutTransfer = await ctx.prisma.payoutTransfer.create({
		data: {
			sellerProfileId: earning.sellerProfileId,
			amountCents,
			status: "pending",
		},
		select: { id: true },
	});

	logger.info(
		{
			earningId,
			orderId: earning.order.id,
			amountInDollars,
			connectAccountId,
			buyerId,
			payoutTransferId: payoutTransfer.id,
			lineCount: earningLineIdsToMark.length,
			orphan: isOrphan,
		},
		"payout.release: calling payments.seller.pay",
	);

	const result = await ctx.payments.seller.pay({
		amount: amountInDollars,
		sellerConnectAccountId: connectAccountId,
		orderId: earning.order.id,
		buyerId,
		sourceChargeId: earning.order.paymentChargeId,
		payoutTransferId: payoutTransfer.id,
	});

	if (!result.success) {
		// Failed Transfer — mark the pre-allocated PayoutTransfer row as
		// failed. A future retry creates a NEW PayoutTransfer row with a
		// fresh id (and therefore a fresh Stripe idempotency key).
		await ctx.prisma.payoutTransfer
			.update({
				where: { id: payoutTransfer.id },
				data: { status: "failed", failedAt: new Date() },
			})
			.catch((err) => {
				logger.error(
					{ err, earningId, payoutTransferId: payoutTransfer.id },
					"payout.release: failed to mark PayoutTransfer as failed",
				);
			});

		if (result.error === PaymentErrorCode.insufficient_funds) {
			reportWarning("Insufficient platform balance when paying out seller", {
				operation: "release_payout",
				extra: { earningId, amountInDollars },
			});
			logger.warn(
				{ earningId, amountInDollars },
				"payout.release: insufficient funds; starting reschedule flow",
			);
			await reschedulePayoutForInsufficientFunds(
				ctx.prisma,
				ctx.payments,
				ctx.queues,
				{
					amountInDollars,
					earningId,
					currentAttempts: earning.insufficientFundsRetryAttempts,
					currentPayoutStatus: earning.payoutStatus,
				},
			);
			return;
		}

		reportWarning("Payout to seller failed", {
			operation: "release_payout",
			extra: {
				earningId,
				orderId: earning.orderId,
				error: result.error,
				message: result.message,
			},
		});
		logger.error(
			{
				earningId,
				orderId: earning.orderId,
				error: result.error,
				message: result.message,
			},
			"payout.release: payout failed",
		);

		await markPayoutAsFailed(ctx.prisma, { earningId });

		if (orderIdForNotification) {
			void ctx.queues.notifications
				.payoutFailed({
					orderId: orderIdForNotification,
					userId: earning.sellerProfile.userId,
				})
				.catch((err) => {
					reportError(err, {
						operation: "queue_payout_failed_notification",
						extra: { earningId, orderId: earning.orderId },
					});
					logger.warn(
						{ err, earningId, orderId: earning.orderId },
						"payout.release: Failed to queue payoutFailed notification",
					);
				});
		}
		return;
	}

	logger.info(
		{
			earningId,
			orderId: earning.orderId,
			transferId: result.transferId,
			payoutTransferId: payoutTransfer.id,
		},
		"payout.release: payout succeeded",
	);

	const now = new Date();

	try {
		await ctx.prisma.$transaction(async (tx) => {
			// 1. Update the PayoutTransfer row with the Stripe IDs. Status
			//    stays `pending` — flips to `succeeded` when payout.paid
			//    webhook lands.
			await tx.payoutTransfer.update({
				where: { id: payoutTransfer.id },
				data: {
					stripeTransferId: result.transferId,
					stripeDestinationPaymentId: result.destinationPaymentId,
				},
			});

			// 2. Mark the released EarningLines as paid + link to the transfer.
			if (earningLineIdsToMark.length > 0) {
				await tx.earningLine.updateMany({
					where: { id: { in: earningLineIdsToMark }, paidAt: null },
					data: { paidAt: now, payoutTransferId: payoutTransfer.id },
				});
			}

			// 3. Update Earning aggregate. Dual-write the legacy single-
			//    Transfer fields ON THE FIRST TRANSFER ONLY so the old
			//    webhook handler (still running on some pods during the
			//    deploy window) can find this Earning. Subsequent partial
			//    transfers are tracked only via PayoutTransfer.
			const earningUpdate: Prisma.EarningUpdateInput = {
				payoutStatus: PayoutStatus.pending,
			};
			if (earning.stripeTransferId === null) {
				earningUpdate.stripeTransferId = result.transferId;
				earningUpdate.stripeDestinationPaymentId = result.destinationPaymentId;
			}
			await tx.earning.update({
				where: {
					id: earningId,
					payoutStatus: {
						in: [
							PayoutStatus.in_review,
							PayoutStatus.pending,
							PayoutStatus.succeeded,
						],
					},
				},
				data: earningUpdate,
			});
		});

		if (orderIdForNotification) {
			void ctx.queues.notifications
				.payoutProcessed({
					orderId: orderIdForNotification,
					userId: earning.sellerProfile.userId,
				})
				.catch((err) => {
					reportError(err, {
						operation: "queue_payout_processed_notification",
						extra: { earningId, orderId: earning.orderId },
					});
					logger.warn(
						{ err, earningId, orderId: earning.orderId },
						"payout.release: Failed to queue payoutProcessed notification",
					);
				});
		}
	} catch (err) {
		if (isPrismaRecordNotFoundError(err)) {
			logger.warn(
				{ earningId, transferId: result.transferId },
				"payout.release: earning status changed during payout; skipping update",
			);
			return;
		}
		logger.error(
			{ earningId, transferId: result.transferId, err },
			"Failed to update earning + lines + transfer, retrying...",
		);
		throw new RetryableError(
			"Failed to update earning + lines + transfer, retrying...",
		);
	}
}
