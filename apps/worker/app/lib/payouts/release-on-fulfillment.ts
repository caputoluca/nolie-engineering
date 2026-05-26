import { DISPUTE_WINDOW_DAYS_AFTER_FULFILLMENT } from "@nolie/core/disputes";
import { PayoutStatus } from "@nolie/db";
import type { WorkerContextBase } from "../context.js";
import { reportError } from "../observability/sentry/report.js";

const REFERRAL_QUALIFY_DELAY_MS =
	DISPUTE_WINDOW_DAYS_AFTER_FULFILLMENT * 24 * 60 * 60 * 1000;

export type ReleaseOnFulfillmentResult =
	| "released"
	| "raced"
	| "held"
	| "failed";

interface Input {
	earningId: string;
	sellerProfileId: string;
	orderId: string;
	/** Delay applied to the payout.release job. Omit for immediate. */
	delayMs?: number;
	/** Sentry tag + log breadcrumb for the calling rail (parcel webhook,
	 * letter reconciler, etc.). Used in error reports + rollback report. */
	operation: string;
}

type Ctx = Pick<WorkerContextBase, "prisma" | "queues">;

/**
 * Transition an Earning from `requires_action` to `in_review` and
 * schedule its payout release. Shared core for the parcel `delivered`
 * webhook and the letter-mail clock-based reconciler — anywhere "the
 * fulfillment moment has arrived for this order".
 *
 * **Race safety.** The `WHERE` guard pins the transition to
 * `requires_action + stripeTransferId=null`. A concurrent caller (e.g.
 * the parcel webhook firing while the letter reconciler is mid-tick on
 * the same order, or two reconciler ticks back-to-back) that already
 * advanced this earning gets `result: "raced"` with no side effects.
 *
 * **Hold.** An admin/manual payout hold (`Earning.payoutHoldAt`) also
 * fails the guard; the caller gets `result: "held"` (distinct from
 * `raced` so telemetry is honest and the parcel webhook skips its
 * buyer notifications). `release.job` re-checks the live hold and is
 * the authoritative gate — this just avoids needless enqueue churn.
 *
 * **Dispute interaction.** A pending or refunded `FulfillmentDispute`
 * does NOT block the earning transition — `markedAsFulfilledAt`
 * reflects "we believe fulfillment landed", which is true even if the
 * buyer is disputing it. Per NL-183, the dispute also does NOT block
 * the payout enqueue: the release.job is per-line aware and decides
 * what to actually pay at execution time. Caller-side gating only
 * duplicates the worker's gate and risks drift.
 *
 * **Rollback.** If the `payout.release` enqueue throws, the earning is
 * rolled back to `requires_action` so a follow-up tick / webhook
 * redelivery can retry. Callers that want BullMQ retry on failure
 * should re-throw on `result: "failed"`.
 *
 * Notifications, listing-id breadcrumbs, and rail-specific logging
 * stay at the callsite — they vary too much to fit cleanly here.
 */
export async function releaseEarningOnFulfillment(
	ctx: Ctx,
	input: Input,
): Promise<{ result: ReleaseOnFulfillmentResult }> {
	const { earningId, sellerProfileId, orderId, delayMs, operation } = input;

	const updated = await ctx.prisma.earning.updateMany({
		where: {
			id: earningId,
			sellerProfileId,
			payoutStatus: PayoutStatus.requires_action,
			stripeTransferId: null,
			// Admin/manual hold short-circuit. A held earning fails this
			// guard, so it never leaves `requires_action` and no
			// `payout.release` is enqueued. `count === 0` is then
			// disambiguated below into `held` vs a genuine `raced`.
			payoutHoldAt: null,
		},
		data: {
			payoutStatus: PayoutStatus.in_review,
			markedAsFulfilledAt: new Date(),
		},
	});

	if (updated.count === 0) {
		// Either a genuine race (already advanced past `requires_action`)
		// or a deliberate hold. One cheap cold-path read tells them apart
		// so callers don't mislabel an operator hold as a race (and the
		// parcel webhook doesn't fire false delivery/review notifications
		// for a parked payout).
		const earning = await ctx.prisma.earning.findUnique({
			where: { id: earningId },
			select: { payoutHoldAt: true },
		});
		return { result: earning?.payoutHoldAt ? "held" : "raced" };
	}

	try {
		await ctx.queues.payout.release(
			{ earningId },
			delayMs != null ? { delay: delayMs } : undefined,
		);
		// NL-270: kick off the referral qualify pipeline. Single hook here
		// rather than per-rail so letter, parcel, pickup, and manual
		// confirm all benefit. Fire-and-forget: a queue blip must never
		// roll back the earning transition — the qualify job is
		// idempotent and the next dispute-resolution re-fire of this
		// helper would re-enqueue anyway. Held earnings never reach this
		// branch (they short-circuit above with result=`held`), which is
		// correct — a parked payout means a parked referral too.
		void ctx.queues.referrals
			.qualify({ orderId }, { delay: REFERRAL_QUALIFY_DELAY_MS })
			.catch((err: unknown) => {
				reportError(err, {
					operation: "queue_referral_qualification",
					level: "warning",
					extra: { orderId, earningId },
				});
			});
		return { result: "released" };
	} catch (scheduleError) {
		reportError(scheduleError, {
			operation,
			extra: { earningId, orderId },
		});
		try {
			await ctx.prisma.earning.updateMany({
				where: { id: earningId, payoutStatus: PayoutStatus.in_review },
				data: {
					payoutStatus: PayoutStatus.requires_action,
					markedAsFulfilledAt: null,
				},
			});
		} catch (rollbackError) {
			reportError(rollbackError, {
				operation: `${operation}_rollback`,
				level: "error",
				extra: { earningId, orderId },
			});
		}
		return { result: "failed" };
	}
}
