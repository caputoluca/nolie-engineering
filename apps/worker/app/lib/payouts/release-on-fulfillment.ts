import { PayoutStatus } from "@nolie/db";
import type { WorkerContextBase } from "../context.js";
import { reportError } from "../observability/sentry/report.js";

export type ReleaseOnFulfillmentResult = "released" | "raced" | "failed";

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
		},
		data: {
			payoutStatus: PayoutStatus.in_review,
			markedAsFulfilledAt: new Date(),
		},
	});

	if (updated.count === 0) {
		return { result: "raced" };
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
