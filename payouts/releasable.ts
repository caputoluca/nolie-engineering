/**
 * Per-line releasability for seller payouts (NL-183).
 *
 * The release job, the confirm-delivery flip, and pickup auto-complete
 * all used to bail when ANY OrderLineItem on the Order had a
 * FulfillmentDispute. That made sense for single-line auction Orders
 * but is far too aggressive once cart bundles ship multi-line Orders:
 * one disputed card in a 5-card cart shouldn't trap payout for the
 * other 4.
 *
 * This helper centralises the per-line decision: a line is releasable
 * when no dispute is open against it, minus any net already refunded.
 * Callers sum the releasable lines into a single Stripe Transfer.
 *
 * Pure: takes a typed shape the caller has already loaded, returns the
 * subset + total. No Prisma import — keeps @nolie/core dep-light.
 */

/**
 * Mirrors the DisputeStatus enum in packages/db (Prisma schema). Kept
 * as a string-literal union here so this module stays dep-light.
 * Values produced by the Prisma client are assignable to this type.
 *
 *  - `pending`          — open dispute, blocks payout for this line
 *  - `seller_review`    — P4.1: seller-first — waiting on the seller's Gate-2
 *                         response; blocks payout exactly like `pending` until
 *                         it resolves or escalates. A new status defaults to
 *                         *releasable* in the fall-through below, so it MUST be
 *                         listed here or payout leaks mid-review.
 *  - `awaiting_return`  — NL-355: resolved for buyer but the refund is
 *                         gated on the item shipping back; blocks payout
 *                         exactly like `pending` until the return is
 *                         delivered (then it flips to `refunded`)
 *  - `refunded`         — buyer was refunded, no payout for this line
 *  - `released`         — admin chose `pay_seller`; line is releasable
 *  - `absorbed`         — admin chose `platform_absorb`; buyer refunded AND
 *                         seller paid (platform takes the loss); releasable
 */
export type ReleasableDisputeStatus =
	| "pending"
	| "seller_review"
	| "awaiting_return"
	| "refunded"
	| "released"
	| "absorbed";

/**
 * Minimum shape the helper needs per EarningLine. Callers load this
 * via Prisma with the matching include shape.
 *
 * `paidAt` is what makes partial release safe: once a line is paid
 * (paidAt IS NOT NULL), the helper excludes it from future releases.
 * Re-firing the release job after a dispute resolves pays only the
 * lines that haven't shipped yet.
 */
export interface ReleasableLineInput {
	id: string;
	netCents: number;
	refundedNetCents: number;
	/**
	 * Of `refundedNetCents`, how much the platform absorbed (refunds issued
	 * with `platformAbsorbs=true`). Added back into release math so the
	 * seller is paid in full on absorbed slices while `refundedNetCents`
	 * remains the audit-honest "net refunded to buyer" tally.
	 */
	platformAbsorbedNetCents: number;
	paidAt: Date | null;
	orderLineItem: {
		fulfillmentDispute: { status: ReleasableDisputeStatus } | null;
	};
}

export interface ReleasableLineResult {
	earningLineId: string;
	orderLineItemId?: never; // intentionally not surfaced — caller already has it
	cents: number;
}

export interface GetReleasableLinesResult {
	/** Line IDs + per-line releasable cents (sum into Stripe Transfer). */
	lines: Array<{ earningLineId: string; cents: number }>;
	/** Sum of `lines[].cents`. The amount to transfer this run. */
	totalCents: number;
	/** True when no line is releasable this run. */
	allBlocked: boolean;
	/**
	 * True when ≥1 line is held back by a `pending` dispute. Caller may
	 * still release the rest; the Earning stays in pending state until
	 * the held line resolves and the resolver re-queues this job.
	 */
	hasPendingDisputes: boolean;
	/**
	 * True when ≥1 unpaid line had a `refunded` dispute and was
	 * excluded. Caller may still release the rest.
	 */
	hasRefundedLines: boolean;
	/**
	 * True when ≥1 unpaid line is held back by an `awaiting_return` dispute
	 * (NL-355: buyer won, refund gated on the return). Caller may still
	 * release the rest; the held line ships once the return is delivered and
	 * the dispute flips to `refunded`/`absorbed`.
	 */
	hasAwaitingReturn: boolean;
}

/**
 * Compute the releasable subset of an Earning's lines for a payout run.
 *
 * A line is releasable this run when:
 *   • It hasn't been paid yet (paidAt IS NULL).
 *   • Its FulfillmentDispute (if any) is not in `pending`, `seller_review`,
 *     `awaiting_return`, or `refunded` state — undisputed, or resolved as
 *     `released` / `absorbed` (both unblock payout).
 *   • Its remaining net
 *     (netCents − refundedNetCents + platformAbsorbedNetCents) is positive.
 *     The absorbed-net term adds back slices the platform ate (buyer was
 *     refunded but seller is being made whole) so they stay payable.
 *
 * Already-paid lines are skipped silently — re-firing the job after a
 * dispute resolves pays only the lines that still need money.
 *
 * Empty input → `{ lines: [], totalCents: 0, allBlocked: true,
 * hasPendingDisputes: false, hasRefundedLines: false,
 * hasAwaitingReturn: false }`.
 */
export function getReleasableLines(earning: {
	lines: readonly ReleasableLineInput[];
}): GetReleasableLinesResult {
	const releasable: Array<{ earningLineId: string; cents: number }> = [];
	let totalCents = 0;
	let hasPendingDisputes = false;
	let hasRefundedLines = false;
	let hasAwaitingReturn = false;

	for (const line of earning.lines) {
		// Already paid in a prior release run — skip silently.
		if (line.paidAt !== null) continue;

		const disputeStatus = line.orderLineItem.fulfillmentDispute?.status;

		// `seller_review` is a pending-like hold (P4.1): the seller hasn't
		// answered yet, so the line's payout stays blocked and the Earning stays
		// pending, same as an open `pending` dispute.
		if (disputeStatus === "pending" || disputeStatus === "seller_review") {
			hasPendingDisputes = true;
			continue;
		}
		if (disputeStatus === "awaiting_return") {
			hasAwaitingReturn = true;
			continue;
		}
		if (disputeStatus === "refunded") {
			hasRefundedLines = true;
			continue;
		}

		const remaining =
			line.netCents - line.refundedNetCents + line.platformAbsorbedNetCents;
		if (remaining <= 0) continue;

		releasable.push({ earningLineId: line.id, cents: remaining });
		totalCents += remaining;
	}

	return {
		lines: releasable,
		totalCents,
		allBlocked: releasable.length === 0,
		hasPendingDisputes,
		hasRefundedLines,
		hasAwaitingReturn,
	};
}
