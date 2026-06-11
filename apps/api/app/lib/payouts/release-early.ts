import { PayoutStatus, type PrismaClient } from "@nolie/db";
import type { QueueOf } from "@nolie/queues";
import { logger } from "../../logger.js";
import { reportError } from "../observability/sentry/report.js";

interface ReleaseEarningEarlyInput {
	db: PrismaClient;
	payoutsQueue: QueueOf<"payout">;
	earningId: string;
	sellerProfileId: string;
}

export type ReleaseEarningEarlyResult = "released" | "skipped" | "failed";

/**
 * Release a seller's proceeds EARLY — at shipping-label purchase, before
 * delivery — for a `fastPayoutEligible` seller (NL-263). The payout-only
 * sibling of `confirmDelivery`: it advances the same payout clock and
 * enqueues the same `payout.release`, but fires NONE of the fulfillment
 * effects. Critically it does NOT stamp `markedAsFulfilledAt` — that's
 * the dispute-window anchor and must stay on actual delivery, stamped by
 * `markFulfilled` at the delivery webhook / deemed-delivered cron. See
 * docs/fast-payouts.md §1.
 *
 * Eligibility (`fastPayoutEligible` + `payoutsEnabled`) is decided by the
 * caller (`getSaleLabel`, which already has the seller profile loaded);
 * this is pure mechanism.
 *
 * **Single-fire / race safety.** The CAS guard pins the transition to
 * `requires_action + stripeTransferId=null + payoutHoldAt=null`. A held
 * earning, or one already advanced (e.g. the seller re-opening the label
 * after it released), fails the guard and returns `"skipped"` with no
 * enqueue — never a double-pay. `payoutReleasedEarlyAt` is set in the
 * same write, so it is a faithful "fronted before delivery" marker.
 *
 * **Best-effort at the call site.** The label purchase has already
 * committed by the time this runs — a payout-enqueue failure must never
 * fail the label. On enqueue failure we roll the earning back to
 * `requires_action` (so the normal delivery-time release still pays the
 * seller) and return `"failed"`; the caller swallows it.
 */
export async function releaseEarningEarly(
	input: ReleaseEarningEarlyInput,
): Promise<{ result: ReleaseEarningEarlyResult }> {
	const { db, payoutsQueue, earningId, sellerProfileId } = input;

	const advanced = await db.earning.updateMany({
		where: {
			id: earningId,
			sellerProfileId,
			payoutStatus: PayoutStatus.requires_action,
			stripeTransferId: null,
			payoutHoldAt: null,
		},
		data: {
			payoutStatus: PayoutStatus.in_review,
			payoutReleasedEarlyAt: new Date(),
		},
	});

	if (advanced.count === 0) {
		return { result: "skipped" };
	}

	try {
		await payoutsQueue.release({ earningId }, { delay: 0 });
		logger.info({ earningId }, "Released payout early at label purchase");
		return { result: "released" };
	} catch (scheduleError) {
		reportError(scheduleError, {
			operation: "fast_payout_early_release",
			extra: { earningId },
		});
		try {
			await db.earning.updateMany({
				where: { id: earningId, payoutStatus: PayoutStatus.in_review },
				data: {
					payoutStatus: PayoutStatus.requires_action,
					payoutReleasedEarlyAt: null,
				},
			});
		} catch (rollbackError) {
			reportError(rollbackError, {
				operation: "fast_payout_early_release_rollback",
				level: "error",
				extra: { earningId },
			});
		}
		return { result: "failed" };
	}
}
