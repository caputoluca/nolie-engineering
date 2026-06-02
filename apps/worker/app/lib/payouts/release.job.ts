import { getReleasableLines } from "@nolie/core/payouts";
import {
	isPrismaRecordNotFoundError,
	isPrismaUniqueError,
	PayoutStatus,
	type Prisma,
} from "@nolie/db";
import { PaymentErrorCode } from "@nolie/payments";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { RetryableError } from "../../retryable-error.js";
import { reportError, reportWarning } from "../observability/sentry/report.js";
import type { PayoutsContext } from "./context.js";
import {
	abandonFeeNettedTransfer,
	applyFeeNetting,
	finalizeFullyNettedTransfer,
} from "./fee-netting.js";
import {
	markPayoutAsFailed,
	reschedulePayoutForInsufficientFunds,
} from "./release-utils.js";
import type { PayoutJob } from "./types.js";

/**
 * Phase-1 rollback signal: the EarningLine claim matched zero rows, so
 * a concurrent — or already-completed — sibling release owns these
 * lines. Thrown inside the claim transaction to roll the pre-allocated
 * PayoutTransfer row back rather than leaving an orphan `pending` row
 * parked in the partial unique index (which would wedge every future
 * release for this earning).
 */
class ClaimLost extends Error {}

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
 *
 * Concurrency safety (race against double-pay): the EarningLine rows
 * are the mutex. Phase 1 (one tx) creates the PayoutTransfer row and
 * claims its lines — `UPDATE earning_line SET payoutTransferId WHERE
 * paidAt IS NULL AND payoutTransferId IS NULL`. The row lock on those
 * lines serializes concurrent releases for the same earning: the
 * loser blocks, re-evaluates after the winner commits, claims zero,
 * and skips with `claim_lost` (its PayoutTransfer INSERT rolls back
 * with the aborted tx). The Stripe call (Phase 2) happens AFTER this
 * commits — never under the lock. The partial unique index on
 * PayoutTransfer(earningId) is kept as a DB-level backstop for the
 * pure simultaneous-INSERT case (P2002 → `inflight_lock_held`) but is
 * no longer load-bearing. Phase 3 marks the claimed lines paidAt.
 * Industry pattern: Brandur/Stripe atomic-phase + durable claim, the
 * claim record as the mutex.
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
			payoutHoldAt: true,
			payoutHoldReason: true,
			createdAt: true,
			// Legacy single-Transfer fields — kept nullable in the expand
			// step; written on the FIRST transfer for old-webhook back-compat,
			// then ignored on subsequent partials.
			stripeTransferId: true,
			order: {
				select: {
					id: true,
					displayId: true,
					buyerId: true,
					paymentIntentId: true,
					paymentChargeId: true,
					// Needed to derive the card-charged amount (total − credit)
					// so we don't pin a transfer to a charge that can't fund it.
					totalCents: true,
					appliedCredits: { select: { appliedCents: true } },
					// NL-319: defensive gate against paths that still enqueue
					// `payout.release` on a cancelled order (the dispute
					// resolver — its always-queue contract — and any late
					// webhook). `cancelOrder` itself deliberately does NOT
					// enqueue release, but other paths can.
					cancelledAt: true,
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
					user: { select: { handle: true } },
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

	// Admin/manual payout hold. The single authoritative gate: every
	// release rail (letter clock, parcel `delivered` webhook, pickup
	// auto-complete, confirm-delivery, admin manual) funnels through
	// this job before any Stripe Transfer, so checking the hold here —
	// against the live row, not a stale candidate-query snapshot —
	// closes every path including an already-`in_review` earning with a
	// delayed release in flight. A hold is a resumable park, NOT a
	// failure: do not `markPayoutAsFailed`. Clearing `payoutHoldAt` and
	// re-enqueuing `payout.release` pays out normally. Deliberate
	// operator action, so it's a skip log (not Sentry) like the gates
	// above.
	if (earning.payoutHoldAt) {
		logger.info(
			{
				earningId,
				orderId: earning.orderId,
				reason: "payout_on_hold",
				payoutHoldAt: earning.payoutHoldAt,
				payoutHoldReason: earning.payoutHoldReason,
			},
			"payout.release.skipped",
		);
		return;
	}

	// NL-319: cancelled orders never release payout. Defensive gate — most
	// paths that cancel an order also short-circuit release (cancelOrder
	// itself does not enqueue release), but `resolveAdminDispute` with
	// `refund_buyer` cancels the order AND queues release (NL-183
	// always-queue contract); a late webhook arriving after a cancel is the
	// other case. `Earning.payoutStatus` stays in its prior state — the
	// gate is a skip, not a status transition. Mirrors how `payoutHoldAt`
	// doesn't transition payoutStatus either.
	if (earning.order?.cancelledAt) {
		logger.info(
			{
				earningId,
				orderId: earning.orderId,
				reason: "order_cancelled",
				cancelledAt: earning.order.cancelledAt,
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
	// NL-231: cancellation-fee cents netted out of this run's gross inside the
	// claim tx (Rung 1 of the collection waterfall). Stays 0 on the orphan-shim
	// path — netting only runs on the normal per-line claim. The Stripe transfer
	// is for `amountCents − feeNettedCents`; `amountCents` stays GROSS on the row.
	let feeNettedCents = 0;
	// earningLineId → releasable cents this run. Empty for the orphan
	// shim (no EarningLine rows). Drives both the transfer size and the
	// post-claim amount re-derivation (a crashed or concurrent sibling
	// run may already hold part of the releasable set).
	const releasableCentsByLine = new Map<string, number>();

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
		// Orphan shim: no EarningLine rows — releasableCentsByLine stays empty.
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
		for (const l of releasable.lines) {
			releasableCentsByLine.set(l.earningLineId, l.cents);
		}
	}

	if (amountCents <= 0) {
		logger.error(
			{ earningId, orderId: earning.orderId, amountCents },
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

	// ────────────────────────────────────────────────────────────
	// Phase 1 — claim (one tx, no Stripe). See the function header
	// for the mutex argument. The PayoutTransfer INSERT shares the
	// claim's transaction so a lost claim rolls the row back rather
	// than leaving an orphan `pending` row in the partial index.
	// ────────────────────────────────────────────────────────────
	let payoutTransferId: string;

	if (isOrphan) {
		// Orphan shim has no EarningLine rows to claim; the partial
		// unique index on PayoutTransfer(earningId) stays its mutex
		// (rare legacy deploy-window path; self-heals on re-backfill).
		try {
			const pt = await ctx.prisma.payoutTransfer.create({
				data: {
					sellerProfileId: earning.sellerProfileId,
					earningId,
					amountCents,
					status: "pending",
				},
				select: { id: true },
			});
			payoutTransferId = pt.id;
		} catch (err) {
			if (isPrismaUniqueError(err)) {
				logger.info(
					{ earningId, reason: "inflight_lock_held" },
					"payout.release.skipped",
				);
				return;
			}
			throw err;
		}
	} else {
		const releasableLineIds = [...releasableCentsByLine.keys()];
		try {
			const claim = await ctx.prisma.$transaction(async (tx) => {
				const pt = await tx.payoutTransfer.create({
					data: {
						sellerProfileId: earning.sellerProfileId,
						earningId,
						amountCents,
						status: "pending",
					},
					select: { id: true },
				});

				// The mutex. The row lock on these lines + the
				// `payoutTransferId IS NULL` predicate means a
				// concurrent release for the same lines blocks, then
				// matches zero rows once we commit.
				const claimed = await tx.earningLine.updateMany({
					where: {
						id: { in: releasableLineIds },
						paidAt: null,
						payoutTransferId: null,
					},
					data: { payoutTransferId: pt.id },
				});

				if (claimed.count === 0) {
					throw new ClaimLost();
				}

				// Re-derive the amount from exactly the lines we won —
				// a crashed/concurrent sibling may hold part of the set.
				let claimedCents = amountCents;
				if (claimed.count !== releasableLineIds.length) {
					const claimedLines = await tx.earningLine.findMany({
						where: { payoutTransferId: pt.id },
						select: { id: true },
					});
					claimedCents = claimedLines.reduce(
						(sum, l) => sum + (releasableCentsByLine.get(l.id) ?? 0),
						0,
					);
					await tx.payoutTransfer.update({
						where: { id: pt.id },
						data: { amountCents: claimedCents },
					});
				}

				// NL-231: net the seller's outstanding cancellation-fee debits
				// against this claimed gross, INSIDE the claim tx so the
				// application rows + debit draw-downs roll back atomically with a
				// lost claim (the retry then re-nets against the fresh transfer).
				const nettedCents = await applyFeeNetting(tx, {
					sellerProfileId: earning.sellerProfileId,
					payoutTransferId: pt.id,
					grossCents: claimedCents,
					earningId,
				});

				return {
					payoutTransferId: pt.id,
					amountCents: claimedCents,
					feeNettedCents: nettedCents,
				};
			});
			payoutTransferId = claim.payoutTransferId;
			amountCents = claim.amountCents;
			feeNettedCents = claim.feeNettedCents;
		} catch (err) {
			if (err instanceof ClaimLost) {
				logger.info(
					{ earningId, reason: "claim_lost" },
					"payout.release.skipped",
				);
				return;
			}
			if (isPrismaUniqueError(err)) {
				// Partial-index backstop fired on the pure
				// simultaneous-INSERT race — sibling is mid-release.
				logger.info(
					{ earningId, reason: "inflight_lock_held" },
					"payout.release.skipped",
				);
				return;
			}
			throw err;
		}
	}

	// NL-231: the seller receives gross minus whatever fee debt netted out of
	// this run. `amountCents` stays GROSS on the PayoutTransfer (preserves the
	// NL-183 invariant `amountCents == Σ claimed line releasable cents`);
	// `feeNettedCents` records the deduction. The Stripe transfer is the net.
	const netToTransferCents = amountCents - feeNettedCents;

	if (netToTransferCents < 0) {
		// Invariant violation: `applyFeeNetting` caps feeNettedCents at the claimed
		// gross, so net is provably >= 0. A negative here means that cap was broken
		// upstream — surface it loudly instead of letting it masquerade as a Stripe
		// `transfer_failed` below. Treat as fully-netted (transfer nothing).
		reportError(new Error("payout.release: netToTransferCents is negative"), {
			operation: "payout_release_negative_net",
			extra: { earningId, amountCents, feeNettedCents, payoutTransferId },
		});
	}

	if (netToTransferCents <= 0) {
		// Fully netted: the fee consumed the entire payout. Nothing to transfer,
		// and `payments.seller.pay` rejects amount <= 0, so skip Stripe and
		// finalize directly. This is a SUCCESS (the earnings landed against the
		// seller's fee debt; the debit(s) settled in the claim tx) — distinct
		// from the `amountCents <= 0` ERROR gate above (genuine no-money).
		logger.info(
			{
				earningId,
				orderId: earning.order.id,
				grossCents: amountCents,
				feeNettedCents,
				payoutTransferId,
			},
			"payout.release.fully_netted",
		);
		await finalizeFullyNettedPayout(ctx, { earningId, payoutTransferId });
		return;
	}

	const amountInDollars = netToTransferCents / 100;

	// Stripe pins a transfer with `source_transaction` to its charge, and the sum
	// of transfers against one charge can never exceed the charge amount
	// (docs.stripe.com/connect/separate-charges-and-transfers). When the buyer
	// paid partly from wallet credit, the card charge is only
	// `totalCents − creditApplied` — smaller than the seller's net — and the
	// credit-covered portion sits in our platform balance, not the charge. Pin to
	// that undersized charge and Stripe rejects the over-amount. So we attach the
	// source charge only when it can provably fund the WHOLE earning's payout
	// (`netAmount`, not just this run's slice — partial releases share one charge
	// and must not overshoot it in aggregate). Otherwise we transfer straight from
	// the platform balance, exactly like the full-credit case where there's no
	// charge to pin to at all. Keeping the source charge wherever it fits
	// preserves its benefit: the transfer succeeds against unsettled charge funds
	// instead of failing on a thin available balance.
	const appliedCreditCents = earning.order.appliedCredits.reduce(
		(sum, c) => sum + c.appliedCents,
		0,
	);
	const cardChargedCents = earning.order.totalCents - appliedCreditCents;
	const sourceChargeId =
		earning.order.paymentChargeId !== null &&
		earning.netAmount <= cardChargedCents
			? earning.order.paymentChargeId
			: null;

	logger.info(
		{
			earningId,
			orderId: earning.order.id,
			amountInDollars,
			grossInDollars: amountCents / 100,
			feeNettedCents,
			connectAccountId,
			buyerId,
			payoutTransferId,
			orphan: isOrphan,
			sourcePinned: sourceChargeId !== null,
			cardChargedCents,
			appliedCreditCents,
		},
		"payout.release: calling payments.seller.pay",
	);

	const result = await ctx.payments.seller.pay({
		amount: amountInDollars,
		sellerConnectAccountId: connectAccountId,
		orderId: earning.order.id,
		buyerId,
		sourceChargeId,
		payoutTransferId,
	});

	if (!result.success) {
		// Record the Stripe failure in its OWN commit, BEFORE the abandon tx
		// below. This is the crash-recovery discriminator (NL-231): if the
		// worker dies mid-abandon, the sweep sees `stripeFailedAt` set and knows
		// the transfer is safe to reverse + unclaim — versus a crash that loses
		// the outcome entirely, which it can't safely auto-reverse (the money
		// may have moved). Best-effort: if this write itself fails, the abandon
		// below still runs; only a double failure falls back to manual review.
		await ctx.prisma.payoutTransfer
			.update({
				where: { id: payoutTransferId },
				data: { stripeFailedAt: new Date() },
			})
			.catch((err) => {
				logger.error(
					{ err, earningId, payoutTransferId },
					"payout.release: failed to record stripeFailedAt before abandon",
				);
			});

		// Abandon the transfer atomically: a `pending → failed` CAS, then reverse
		// its fee netting and release its line claim — all or nothing. A future
		// retry then claims the lines into a NEW PayoutTransfer with a fresh id
		// (and so a fresh Stripe idempotency key). The CAS is the mutex against the
		// reconcile sweep: if `pay()` stalled past the abandoned-transfer cutoff,
		// the sweep can be abandoning this very transfer concurrently, and two
		// unguarded reversals would lost-update the debit's `nettedCents` negative.
		// `abandonFeeNettedTransfer` lets exactly one of them win (the loser
		// no-ops). If the whole tx fails, the transfer stays `pending` with
		// `stripeFailedAt` set and the sweep recovers it.
		try {
			await ctx.prisma.$transaction((tx) =>
				abandonFeeNettedTransfer(tx, payoutTransferId, {
					unclaimLines: !isOrphan,
				}),
			);
		} catch (err) {
			reportError(err, {
				operation: "release_payout_abandon_transfer",
				extra: { earningId, payoutTransferId },
			});
			logger.error(
				{ err, earningId, payoutTransferId },
				"payout.release: failed to abandon transfer (reverse netting + unclaim); sweep will recover",
			);
		}

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

		await markPayoutAsFailed(ctx.prisma, { earningId });

		// Only email the seller when the failure is genuinely theirs to fix: the
		// destination connected account can't receive funds (payouts disabled /
		// pending verification / invalid account → `invalid_stripe_account`). For
		// platform-side or unattributable failures (our balance/config, the
		// source_transaction over-amount, a Stripe error we can't pin on them) we
		// must NOT tell the seller "fix your payout details" — it isn't their
		// fault. Those alert the team via Slack to triage + retry from admin.
		// (`insufficient_funds` returned earlier via the reschedule flow.)
		const sellerAtFault =
			result.error === PaymentErrorCode.invalid_stripe_account;

		reportWarning(
			sellerAtFault
				? "Seller payout failed — connected account can't receive funds"
				: "Seller payout failed (platform-side)",
			{
				operation: "release_payout",
				extra: {
					earningId,
					orderId: earning.orderId,
					error: result.error,
					message: result.message,
					sellerAtFault,
				},
			},
		);
		logger.error(
			{
				earningId,
				orderId: earning.orderId,
				error: result.error,
				message: result.message,
				sellerAtFault,
			},
			"payout.release: payout failed",
		);

		if (sellerAtFault) {
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
		} else {
			void ctx.slack
				.notifyPayoutTransferFailed({
					orderId: earning.order.id,
					displayId: earning.order.displayId,
					earningId,
					sellerHandle: earning.sellerProfile.user.handle,
					amountCents: netToTransferCents,
					errorCode: result.error,
					message: result.message ?? null,
					adminLink: `${config.frontend_url}/admin/orders/${earning.order.id}`,
				})
				.catch((err) => {
					reportError(err, {
						operation: "slack_payout_transfer_failed",
						extra: { earningId, orderId: earning.orderId },
					});
					logger.error(
						{ err, earningId, orderId: earning.orderId },
						"payout.release: failed to post payout-failed Slack alert",
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
			payoutTransferId,
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
				where: { id: payoutTransferId },
				data: {
					stripeTransferId: result.transferId,
					stripeDestinationPaymentId: result.destinationPaymentId,
				},
			});

			// 2. Flip the lines this transfer claimed in Phase 1 to paid.
			//    payoutTransferId was set under the claim mutex already;
			//    here we only stamp paidAt. Orphan shim has no lines.
			if (!isOrphan) {
				await tx.earningLine.updateMany({
					where: { payoutTransferId, paidAt: null },
					data: { paidAt: now },
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

/**
 * Finalize an exact-zero ("fully netted") payout — the fee consumed the whole
 * run, so no Stripe transfer was made. Wraps `finalizeFullyNettedTransfer` in a
 * tx with release.job's error semantics. A transient failure throws
 * RetryableError; the BullMQ retry re-fires this job but finds the lines already
 * claimed (claim_lost), so the crash-recovery sweep — which resumes this same
 * idempotent finalize for an exact-zero transfer (`feeNettedCents == amountCents`)
 * — is the durable backstop. A concurrent status change surfaces as
 * RecordNotFound and is a clean skip.
 */
async function finalizeFullyNettedPayout(
	ctx: PayoutsContext,
	{
		earningId,
		payoutTransferId,
	}: { earningId: string; payoutTransferId: string },
): Promise<void> {
	try {
		await ctx.prisma.$transaction((tx) =>
			finalizeFullyNettedTransfer(tx, {
				earningId,
				payoutTransferId,
				now: new Date(),
			}),
		);
	} catch (err) {
		if (isPrismaRecordNotFoundError(err)) {
			logger.warn(
				{ earningId, payoutTransferId },
				"payout.release: earning status changed during fully-netted finalize; skipping",
			);
			return;
		}
		logger.error(
			{ earningId, payoutTransferId, err },
			"payout.release: failed to finalize fully-netted payout, retrying...",
		);
		throw new RetryableError(
			"Failed to finalize fully-netted payout, retrying...",
		);
	}
}
