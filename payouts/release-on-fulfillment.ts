/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 * Left out: DISPUTE_WINDOW_DAYS_AFTER_FULFILLMENT, the days after delivery a buyer
 * can still dispute. The release delay comes from getPayoutReleaseDelayMs in
 * payouts.ts, passed in by the caller. Everything else is plumbing: types,
 * database, error reporting.
 */

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
 * payout moment has arrived for this order".
 *
 * **Payout-only (NL-263).** This advances the *payout* clock and nothing
 * else. The *fulfillment* clock — `markedAsFulfilledAt` (the dispute
 * window anchor), buyer comms, and `referrals.qualify` — is now stamped
 * separately at the actual delivery anchor via `markFulfilled`. The two
 * used to be welded into this one CAS; fast payout releases the payout
 * early (at label purchase, before delivery), so a fast-paid earning
 * reaches delivery already `in_review` and this CAS no-ops (`"raced"`).
 * Keeping `markedAsFulfilledAt` here would mean the dispute clock never
 * started on exactly the fast-paid orders. See docs/fast-payouts.md §2.
 *
 * **Race safety.** The `WHERE` guard pins the transition to
 * `requires_action + stripeTransferId=null`. A concurrent caller (e.g.
 * the parcel webhook firing while the letter reconciler is mid-tick on
 * the same order, or two reconciler ticks back-to-back, or the
 * fast-payout early-release having already advanced it) gets
 * `result: "raced"` with no side effects.
 *
 * **Hold.** An admin/manual payout hold (`Earning.payoutHoldAt`) also
 * fails the guard; the caller gets `result: "held"` (distinct from
 * `raced` so telemetry is honest and the parcel webhook skips its
 * buyer notifications). `release.job` re-checks the live hold and is
 * the authoritative gate — this just avoids needless enqueue churn.
 *
 * **Dispute interaction.** A pending or refunded `FulfillmentDispute`
 * does NOT block the payout enqueue: the release.job is per-line aware
 * and decides what to actually pay at execution time. Caller-side
 * gating only duplicates the worker's gate and risks drift.
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

/**
 * Stamp the *fulfillment* clock for an order — the delivery-anchored
 * counterpart to `releaseEarningOnFulfillment`'s payout clock (NL-263).
 * Idempotent and single-fire via the `markedAsFulfilledAt IS NULL` latch
 * (the column self-guards — no dependency on payout state), so it's safe
 * to call from every real/deemed delivery anchor (parcel `delivered`
 * webhook, the `promoteStaleOrders` deemed-delivered cron for both
 * rails); the first writer wins and the rest no-op.
 *
 * On the stamping write (and only then) it kicks off `referrals.qualify`,
 * delayed by the dispute window so a referral can't qualify on an order
 * that's still inside its dispute period. Fire-and-forget: a queue blip
 * must not unwind the fulfillment stamp — the qualify job is idempotent
 * and re-fires are harmless.
 *
 * Callers gate this themselves (e.g. skip on a `held` payout) — it makes
 * no payout-state decisions of its own.
 */
export async function markFulfilled(
	ctx: Ctx,
	input: { earningId: string; orderId: string },
): Promise<{ stamped: boolean }> {
	const { earningId, orderId } = input;

	const updated = await ctx.prisma.earning.updateMany({
		where: { id: earningId, markedAsFulfilledAt: null },
		data: { markedAsFulfilledAt: new Date() },
	});

	if (updated.count === 0) {
		return { stamped: false };
	}

	// NL-270: single referral hook, fired once at the genuine fulfillment
	// moment (not per-rail) so letter, parcel, and the deemed-delivered
	// cron all qualify referrals the same way.
	void ctx.queues.referrals
		.qualify({ orderId }, { delay: REFERRAL_QUALIFY_DELAY_MS })
		.catch((err: unknown) => {
			reportError(err, {
				operation: "queue_referral_qualification",
				level: "warning",
				extra: { orderId, earningId },
			});
		});

	return { stamped: true };
}
