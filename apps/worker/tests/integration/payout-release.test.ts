/**
 * Payout release tests.
 *
 * Tests the release job which handles paying sellers after delivery:
 * - Happy path: seller gets paid
 * - Idempotency: already paid → no-op
 * - Dispute blocking: pending/resolved_fan disputes block payout
 * - Failure handling: missing connect account
 * - NL-183 per-line partial release: clean lines pay now, disputed lines later
 * - NL-183 structured skip reasons: every skip emits a categorised `reason`
 */

import { randomUUID } from "node:crypto";
import {
	DisputeIssueType,
	DisputeStatus,
	PayoutStatus,
	prisma,
} from "@nolie/db";
import { AuctionStatus } from "@nolie/schemas/auction/status";
import { fixtures } from "@nolie/testing";
import { describe, expect, it } from "vitest";
import { release } from "../../app/lib/payouts/release.job.js";
import {
	createTestPayoutsContext,
	type TestMocksWithPayments,
} from "../helpers/context.js";
import { createMockJob } from "../helpers/index.js";

describe("Payout Release", () => {
	// =========================================================================
	// TEST 1: Happy path - seller gets paid
	// =========================================================================
	it("pays seller and records transfer on successful payout", async () => {
		// Arrange: Create settled auction with earning ready for payout
		const { auction, earning, order, seller } = await createPendingPayout();
		const { ctx, mocks } = createTestPayoutsContext();

		// Act: Run release job
		const job = createMockJob({ earningId: earning.id });
		await release(job, ctx);

		// Assert: Seller was paid
		assertSellerPaid(mocks, {
			sellerConnectAccountId: seller.connectAccountId as string,
			amount: earning.netAmount / 100, // Convert cents to dollars
		});

		// Assert: Earning record updated with transfer ID
		const updatedEarning = await prisma.earning.findUnique({
			where: { id: earning.id },
		});
		expect(updatedEarning?.stripeTransferId).toBeTruthy();
		expect(updatedEarning?.stripeDestinationPaymentId).toBeTruthy();

		// Assert: Success notification queued
		assertNotificationQueued(mocks, "payoutProcessed", {
			orderId: order.id,
		});
	});

	// =========================================================================
	// TEST 2: Idempotency - already paid
	// =========================================================================
	it("skips payout when earning already has stripeTransferId (idempotent)", async () => {
		// Arrange: Create earning that was already paid
		const { earning } = await createPendingPayout({
			stripeTransferId: "tr_already_paid",
		});
		const { ctx, mocks } = createTestPayoutsContext();

		// Act: Run release job
		const job = createMockJob({ earningId: earning.id });
		await release(job, ctx);

		// Assert: No payment attempted
		const payOps = mocks.payments._getOperationsOfType("seller.pay");
		expect(payOps).toHaveLength(0);

		// Assert: Transfer ID unchanged
		const unchangedEarning = await prisma.earning.findUnique({
			where: { id: earning.id },
		});
		expect(unchangedEarning?.stripeTransferId).toBe("tr_already_paid");
	});

	// =========================================================================
	// TEST 3: Dispute blocking - pending dispute
	// =========================================================================
	it("skips payout when dispute is pending", async () => {
		// Arrange: Create earning with pending dispute
		const { earning } = await createPendingPayout({
			dispute: "pending",
		});
		const { ctx, mocks } = createTestPayoutsContext();

		// Act: Run release job
		const job = createMockJob({ earningId: earning.id });
		await release(job, ctx);

		// Assert: No payment attempted (dispute blocks payout)
		const payOps = mocks.payments._getOperationsOfType("seller.pay");
		expect(payOps).toHaveLength(0);

		// Assert: Earning unchanged
		const unchangedEarning = await prisma.earning.findUnique({
			where: { id: earning.id },
		});
		expect(unchangedEarning?.stripeTransferId).toBeNull();
	});

	// =========================================================================
	// TEST 4: Dispute blocking - resolved in buyer's favor
	// =========================================================================
	it("skips payout when dispute resolved in buyer's favor", async () => {
		// Arrange: Create earning with dispute resolved for buyer
		const { earning } = await createPendingPayout({
			dispute: "resolved_fan",
		});
		const { ctx, mocks } = createTestPayoutsContext();

		// Act: Run release job
		const job = createMockJob({ earningId: earning.id });
		await release(job, ctx);

		// Assert: No payment attempted (buyer was refunded, seller shouldn't be paid)
		const payOps = mocks.payments._getOperationsOfType("seller.pay");
		expect(payOps).toHaveLength(0);

		// Assert: Earning unchanged
		const unchangedEarning = await prisma.earning.findUnique({
			where: { id: earning.id },
		});
		expect(unchangedEarning?.stripeTransferId).toBeNull();
	});

	// =========================================================================
	// TEST 5: Failure - seller missing connect account
	// =========================================================================
	it("marks payout as failed when seller has no connect account", async () => {
		// Arrange: Create earning where seller never set up Stripe Connect
		const { earning, order } = await createPendingPayout({
			hasConnectAccount: false,
		});
		const { ctx, mocks } = createTestPayoutsContext();

		// Act: Run release job
		const job = createMockJob({ earningId: earning.id });
		await release(job, ctx);

		// Assert: No payment attempted (can't pay without connect account)
		const payOps = mocks.payments._getOperationsOfType("seller.pay");
		expect(payOps).toHaveLength(0);

		// Assert: Earning marked as failed
		const failedEarning = await prisma.earning.findUnique({
			where: { id: earning.id },
		});
		expect(failedEarning?.payoutStatus).toBe(PayoutStatus.failed);

		// Assert: Seller notified of failure
		assertNotificationQueued(mocks, "payoutFailed", {
			orderId: order.id,
		});
	});

	// =========================================================================
	// TEST 6: Insufficient funds - reschedules payout
	// =========================================================================
	it("reschedules payout when platform has insufficient funds", async () => {
		// Arrange: Create earning ready for payout
		const { earning } = await createPendingPayout();
		const { ctx, mocks } = createTestPayoutsContext();

		// Mock: Payment fails due to insufficient funds in platform balance
		mocks.payments.seller.pay.mockResolvedValueOnce({
			success: false,
			error: "insufficient_funds",
			message: "Insufficient funds in Stripe balance",
		});

		// Act: Run release job
		const job = createMockJob({ earningId: earning.id });
		await release(job, ctx);

		// Assert: Payment was attempted (using .mock.calls since we overrode the mock)
		expect(mocks.payments.seller.pay.mock.calls).toHaveLength(1);

		// Assert: Payout rescheduled (not marked as failed)
		const rescheduledEarning = await prisma.earning.findUnique({
			where: { id: earning.id },
		});
		expect(rescheduledEarning?.payoutStatus).not.toBe(PayoutStatus.failed);
		expect(rescheduledEarning?.insufficientFundsRetryAttempts).toBe(1);

		// Assert: Payout rescheduled for later retry
		const rescheduleOps = mocks.queues._getOperationsByJob(
			"payout",
			"rescheduleRelease",
		);
		expect(rescheduleOps.length).toBeGreaterThan(0);
	});

	// =========================================================================
	// NL-183: a failed transfer must release its line claim, otherwise
	// the lines stay pinned to a dead PayoutTransfer and the rescheduled
	// retry can never re-claim them — a silently stuck payout.
	// =========================================================================
	it("unclaims lines on a failed transfer so the retry re-pays (no stuck payout)", async () => {
		const { earning, seller } = await createPendingPayout();
		const { ctx, mocks } = createTestPayoutsContext();

		mocks.payments.seller.pay.mockResolvedValueOnce({
			success: false,
			error: "insufficient_funds",
			message: "Insufficient funds in Stripe balance",
		});

		await release(createMockJob({ earningId: earning.id }), ctx);

		// Failed transfer recorded, but its claim is released so the
		// lines are payable again.
		const failed = await prisma.payoutTransfer.findFirstOrThrow({
			where: { sellerProfileId: seller.id },
		});
		expect(failed.status).toBe("failed");
		const afterFail = await prisma.earningLine.findMany({
			where: { earningId: earning.id },
		});
		expect(afterFail.every((l) => l.payoutTransferId === null)).toBe(true);
		expect(afterFail.every((l) => l.paidAt === null)).toBe(true);

		// Retry (mock back to its default success) re-claims into a NEW
		// transfer and pays the seller in full.
		await release(createMockJob({ earningId: earning.id }), ctx);

		assertSellerPaid(mocks, {
			sellerConnectAccountId: seller.connectAccountId as string,
			amount: earning.netAmount / 100,
		});
		const succeeded = await prisma.payoutTransfer.findMany({
			where: { sellerProfileId: seller.id, stripeTransferId: { not: null } },
		});
		expect(succeeded).toHaveLength(1);
		expect(succeeded[0]?.id).not.toBe(failed.id);
		const paid = await prisma.earningLine.findMany({
			where: { earningId: earning.id },
		});
		expect(paid.every((l) => l.paidAt !== null)).toBe(true);
		expect(paid.every((l) => l.payoutTransferId === succeeded[0]?.id)).toBe(
			true,
		);
	});

	// =========================================================================
	// TEST 7: Payment fails (transfer error) - marks as failed
	// =========================================================================
	it("marks payout as failed when Stripe transfer fails", async () => {
		// Arrange: Create earning ready for payout
		const { earning, order } = await createPendingPayout();
		const { ctx, mocks } = createTestPayoutsContext();

		// Mock: Payment fails due to transfer error (e.g., invalid bank account)
		mocks.payments.seller.pay.mockResolvedValueOnce({
			success: false,
			error: "transfer_failed",
			message: "The bank account could not be verified",
		});

		// Act: Run release job
		const job = createMockJob({ earningId: earning.id });
		await release(job, ctx);

		// Assert: Payment was attempted (using .mock.calls since we overrode the mock)
		expect(mocks.payments.seller.pay.mock.calls).toHaveLength(1);

		// Assert: Earning marked as failed (not rescheduled)
		const failedEarning = await prisma.earning.findUnique({
			where: { id: earning.id },
		});
		expect(failedEarning?.payoutStatus).toBe(PayoutStatus.failed);

		// NL-183: the pre-allocated PayoutTransfer row is marked failed too,
		// so the next retry creates a NEW row (and therefore a new Stripe
		// idempotency key) rather than re-hitting the cached failure.
		const transfer = await prisma.payoutTransfer.findFirstOrThrow({
			where: { sellerProfileId: earning.sellerProfileId },
		});
		expect(transfer.status).toBe("failed");
		expect(transfer.failedAt).not.toBeNull();

		// Assert: Seller notified of failure
		assertNotificationQueued(mocks, "payoutFailed", {
			orderId: order.id,
		});
	});

	// =========================================================================
	// NL-183: Per-line partial release across multi-line cart Earnings
	// =========================================================================
	describe("per-line partial release (NL-183)", () => {
		it("pays only the clean lines when one line in a cart is disputed", async () => {
			const { earning, lineA, lineB } = await createTwoLineEarning({
				disputeOn: "B",
				disputeStatus: DisputeStatus.pending,
			});
			const { ctx, mocks } = createTestPayoutsContext();

			await release(createMockJob({ earningId: earning.id }), ctx);

			// One Stripe transfer for line A's net only.
			const payOps = mocks.payments._getOperationsOfType("seller.pay");
			expect(payOps).toHaveLength(1);
			expect(payOps[0]?.params).toMatchObject({
				amount: lineA.netCents / 100,
			});

			const [updatedA, updatedB] = await Promise.all([
				prisma.earningLine.findUniqueOrThrow({ where: { id: lineA.id } }),
				prisma.earningLine.findUniqueOrThrow({ where: { id: lineB.id } }),
			]);
			expect(updatedA.paidAt).not.toBeNull();
			expect(updatedA.payoutTransferId).not.toBeNull();
			expect(updatedB.paidAt).toBeNull();
			expect(updatedB.payoutTransferId).toBeNull();

			const transfers = await prisma.payoutTransfer.findMany({
				where: { sellerProfileId: earning.sellerProfileId },
			});
			expect(transfers).toHaveLength(1);
			expect(transfers[0]).toMatchObject({
				amountCents: lineA.netCents,
				status: "pending",
				stripeTransferId: expect.any(String),
				stripeDestinationPaymentId: expect.any(String),
			});
		});

		it("releases the held line on a second job fire after dispute resolves", async () => {
			const { earning, lineA, lineB, dispute } = await createTwoLineEarning({
				disputeOn: "B",
				disputeStatus: DisputeStatus.pending,
			});
			const { ctx, mocks } = createTestPayoutsContext();

			await release(createMockJob({ earningId: earning.id }), ctx);
			expect(mocks.payments._getOperationsOfType("seller.pay")).toHaveLength(1);

			// Simulate chat 3 resolver: flip dispute to released, re-queue.
			if (!dispute) throw new Error("test setup: dispute missing");
			await prisma.fulfillmentDispute.update({
				where: { id: dispute.id },
				data: { status: DisputeStatus.released, resolvedAt: new Date() },
			});

			await release(createMockJob({ earningId: earning.id }), ctx);

			const payOps = mocks.payments._getOperationsOfType("seller.pay");
			expect(payOps).toHaveLength(2);
			expect(payOps[1]?.params).toMatchObject({
				amount: lineB.netCents / 100,
			});

			const [updatedA, updatedB] = await Promise.all([
				prisma.earningLine.findUniqueOrThrow({ where: { id: lineA.id } }),
				prisma.earningLine.findUniqueOrThrow({ where: { id: lineB.id } }),
			]);
			expect(updatedA.paidAt).not.toBeNull();
			expect(updatedB.paidAt).not.toBeNull();
			expect(updatedA.payoutTransferId).not.toBe(updatedB.payoutTransferId);

			const transfers = await prisma.payoutTransfer.findMany({
				where: { sellerProfileId: earning.sellerProfileId },
				orderBy: { createdAt: "asc" },
			});
			expect(transfers).toHaveLength(2);
			expect(transfers[0]?.amountCents).toBe(lineA.netCents);
			expect(transfers[1]?.amountCents).toBe(lineB.netCents);
		});

		it("pays seller in full when a line's dispute resolves as platform_absorb", async () => {
			// Production shape after admin chose PLATFORM_ABSORB:
			//   • createRefund ran with platformAbsorbs=true → bumped both
			//     EarningLine.refundedNetCents AND .platformAbsorbedNetCents
			//   • Dispute flipped to DisputeStatus.absorbed
			//   • Release re-queued
			// The release math (netCents − refundedNetCents + platformAbsorbedNetCents)
			// must net out to the full netCents so the seller is paid in full
			// even though the buyer was refunded.
			const { earning, orderLineItem, order, seller, winner } =
				await createPendingPayout();
			const { ctx, mocks } = createTestPayoutsContext();

			const line = await prisma.earningLine.findUniqueOrThrow({
				where: { orderLineItemId: orderLineItem.id },
			});

			await prisma.earningLine.update({
				where: { id: line.id },
				data: {
					refundedNetCents: line.netCents,
					platformAbsorbedNetCents: line.netCents,
				},
			});
			await prisma.fulfillmentDispute.create({
				data: {
					orderLineItemId: orderLineItem.id,
					userId: winner.id,
					issueType: DisputeIssueType.not_received,
					status: DisputeStatus.absorbed,
					resolvedAt: new Date(),
				},
			});

			await release(createMockJob({ earningId: earning.id }), ctx);

			// Seller paid the full net — absorbed credit cancelled the refund debit.
			assertSellerPaid(mocks, {
				sellerConnectAccountId: seller.connectAccountId as string,
				amount: earning.netAmount / 100,
			});

			const transfers = await prisma.payoutTransfer.findMany({
				where: { sellerProfileId: earning.sellerProfileId },
			});
			expect(transfers).toHaveLength(1);
			expect(transfers[0]?.amountCents).toBe(earning.netAmount);

			const updatedLine = await prisma.earningLine.findUniqueOrThrow({
				where: { id: line.id },
			});
			expect(updatedLine.paidAt).not.toBeNull();
			expect(updatedLine.payoutTransferId).toBe(transfers[0]?.id);
			// Counters remain — they're the audit record, not a release latch.
			expect(updatedLine.refundedNetCents).toBe(line.netCents);
			expect(updatedLine.platformAbsorbedNetCents).toBe(line.netCents);

			assertNotificationQueued(mocks, "payoutProcessed", {
				orderId: order.id,
			});
		});

		it("Earning.netAmount equals sum(EarningLine.netCents)", async () => {
			const { earning, lineA, lineB } = await createTwoLineEarning({});

			expect(lineA.netCents + lineB.netCents).toBe(earning.netAmount);

			const sum = await prisma.earningLine.aggregate({
				where: { earningId: earning.id },
				_sum: { netCents: true },
			});
			expect(sum._sum.netCents).toBe(earning.netAmount);
		});

		it("does not transfer when all lines are held by pending disputes", async () => {
			const { earning } = await createTwoLineEarning({
				disputeOn: "both",
				disputeStatus: DisputeStatus.pending,
			});
			const { ctx, mocks } = createTestPayoutsContext();

			await release(createMockJob({ earningId: earning.id }), ctx);

			expect(mocks.payments._getOperationsOfType("seller.pay")).toHaveLength(0);
			expect(
				await prisma.payoutTransfer.count({
					where: { sellerProfileId: earning.sellerProfileId },
				}),
			).toBe(0);
		});
	});

	// =========================================================================
	// NL-183: Structured skip reasons. Every no-op release emits a
	// categorised `payout.release.skipped` event. These tests pin the
	// observable contract: when the job decides not to transfer, neither
	// Stripe nor the PayoutTransfer table is touched.
	// =========================================================================
	describe("skip reasons (NL-183)", () => {
		it("skips when earning is in a terminal failed state", async () => {
			const { earning } = await createPendingPayout({
				payoutStatus: PayoutStatus.failed,
			});
			const { ctx, mocks } = createTestPayoutsContext();

			await release(createMockJob({ earningId: earning.id }), ctx);

			expect(mocks.payments._getOperationsOfType("seller.pay")).toHaveLength(0);
		});

		it("skips when earning is in requires_action (not yet released)", async () => {
			const { earning } = await createPendingPayout({
				payoutStatus: PayoutStatus.requires_action,
			});
			const { ctx, mocks } = createTestPayoutsContext();

			await release(createMockJob({ earningId: earning.id }), ctx);

			expect(mocks.payments._getOperationsOfType("seller.pay")).toHaveLength(0);
		});

		it("skips when the only line has a refunded dispute", async () => {
			const { earning } = await createPendingPayout({
				dispute: "resolved_fan", // → DisputeStatus.refunded
			});
			const { ctx, mocks } = createTestPayoutsContext();

			await release(createMockJob({ earningId: earning.id }), ctx);

			expect(mocks.payments._getOperationsOfType("seller.pay")).toHaveLength(0);
			expect(
				await prisma.payoutTransfer.count({
					where: { sellerProfileId: earning.sellerProfileId },
				}),
			).toBe(0);
		});

		it("skips when every line is already paid (idempotency)", async () => {
			const { earning } = await createPendingPayout({});
			const transfer = await prisma.payoutTransfer.create({
				data: {
					sellerProfileId: earning.sellerProfileId,
					stripeTransferId: `tr_test_${randomUUID()}`,
					amountCents: earning.netAmount,
					status: "succeeded",
					paidAt: new Date(),
				},
			});
			await prisma.earningLine.updateMany({
				where: { earningId: earning.id },
				data: { paidAt: new Date(), payoutTransferId: transfer.id },
			});

			const { ctx, mocks } = createTestPayoutsContext();
			await release(createMockJob({ earningId: earning.id }), ctx);

			expect(mocks.payments._getOperationsOfType("seller.pay")).toHaveLength(0);
			expect(
				await prisma.payoutTransfer.count({
					where: { sellerProfileId: earning.sellerProfileId },
				}),
			).toBe(1);
		});

		it("orphan shim: skips when legacy Earning was already paid (no EarningLines)", async () => {
			// Old worker pod left an Earning with stripeTransferId set but no
			// EarningLine rows. New worker's orphan shim should no-op.
			const { earning } = await createPendingPayout({});
			await prisma.earningLine.deleteMany({
				where: { earningId: earning.id },
			});
			await prisma.earning.update({
				where: { id: earning.id },
				data: { stripeTransferId: `tr_legacy_${randomUUID()}` },
			});

			const { ctx, mocks } = createTestPayoutsContext();
			await release(createMockJob({ earningId: earning.id }), ctx);

			expect(mocks.payments._getOperationsOfType("seller.pay")).toHaveLength(0);
		});
	});

	// =========================================================================
	// NL-183: Concurrent execution race. Two release jobs picking up the same
	// earningId (cross-pod, or same pod with concurrency > 1) must NOT both
	// call Stripe — that would create two transfers with two different
	// idempotency keys and double-pay the seller. The partial unique index on
	// PayoutTransfer(earningId) WHERE status='pending' AND stripeTransferId
	// IS NULL is the mutex: the loser's INSERT fails with P2002 and exits
	// with a structured skip log.
	// =========================================================================
	describe("concurrent execution race (NL-183)", () => {
		it("serializes parallel release() calls for the same earning into exactly one Stripe transfer", async () => {
			// Arrange: a single earning ready for payout. Note that the test
			// harness's mock recorders (payments, queues) are module-level
			// singletons reset between tests — both contexts here share the
			// same underlying recorder, so we assert on either one.
			const { earning, seller } = await createPendingPayout();
			const ctxA = createTestPayoutsContext();
			const ctxB = createTestPayoutsContext();

			// Act: two workers fire concurrently against the same earningId.
			await Promise.all([
				release(createMockJob({ earningId: earning.id }), ctxA.ctx),
				release(createMockJob({ earningId: earning.id }), ctxB.ctx),
			]);

			// Assert: exactly one Stripe transfer call (the loser caught
			// P2002 and exited cleanly without reaching Stripe).
			expect(
				ctxA.mocks.payments._getOperationsOfType("seller.pay"),
			).toHaveLength(1);

			// Assert: exactly one PayoutTransfer row exists for this earning.
			const transfers = await prisma.payoutTransfer.findMany({
				where: { sellerProfileId: seller.id },
			});
			expect(transfers).toHaveLength(1);
			expect(transfers[0]?.earningId).toBe(earning.id);
			expect(transfers[0]?.stripeTransferId).toBeTruthy();

			// Assert: every line is paid, linked to that single transfer.
			const lines = await prisma.earningLine.findMany({
				where: { earningId: earning.id },
			});
			expect(lines.length).toBeGreaterThan(0);
			expect(lines.every((l) => l.paidAt !== null)).toBe(true);
			expect(lines.every((l) => l.payoutTransferId === transfers[0]?.id)).toBe(
				true,
			);

			// Assert: exactly one payoutProcessed notification queued — the
			// loser didn't fire one since it didn't transfer.
			expect(
				ctxA.mocks.queues._getOperationsByJob(
					"notifications",
					"payoutProcessed",
				),
			).toHaveLength(1);
		});

		it("allows a second transfer for the same earning after the first completes (Pattern B partial release)", async () => {
			// The partial unique index condition is `stripeTransferId IS NULL`,
			// so once the first transfer's Stripe response is recorded, its row
			// exits the index — freeing the slot for a subsequent release
			// after a dispute resolves. This pins that Pattern B isn't broken.
			//
			// Arrange: multi-line earning, line B disputed-pending. First
			// release pays only line A.
			const { earning, lineB } = await createTwoLineEarning({
				disputeOn: "B",
				disputeStatus: DisputeStatus.pending,
			});

			const ctx = createTestPayoutsContext();
			await release(createMockJob({ earningId: earning.id }), ctx.ctx);

			// Assert: one transfer for line A, race-window slot now FREE
			// (stripeTransferId set in the success tx).
			expect(
				ctx.mocks.payments._getOperationsOfType("seller.pay"),
			).toHaveLength(1);
			const firstTransfers = await prisma.payoutTransfer.findMany({
				where: { earningId: earning.id },
			});
			expect(firstTransfers).toHaveLength(1);
			expect(firstTransfers[0]?.stripeTransferId).toBeTruthy();

			// Resolve line B's dispute as released → unblocks its payout.
			await prisma.fulfillmentDispute.update({
				where: { orderLineItemId: lineB.orderLineItemId },
				data: { status: DisputeStatus.released },
			});

			// Act: second release fires. (Module-level mock recorder is shared,
			// so we re-use the same ctx — fresh ctx wouldn't reset it anyway.)
			await release(createMockJob({ earningId: earning.id }), ctx.ctx);

			// Assert: second transfer happened. Total Stripe calls is now 2
			// (one per release fire), proving the unique index didn't block
			// the second transfer once the first's slot freed.
			expect(
				ctx.mocks.payments._getOperationsOfType("seller.pay"),
			).toHaveLength(2);
			const allTransfers = await prisma.payoutTransfer.findMany({
				where: { earningId: earning.id },
				orderBy: { createdAt: "asc" },
			});
			expect(allTransfers).toHaveLength(2);
			expect(allTransfers[0]?.id).not.toBe(allTransfers[1]?.id);
			expect(allTransfers[1]?.earningId).toBe(earning.id);
			expect(allTransfers[1]?.stripeTransferId).toBeTruthy();

			// Assert: both lines are now marked paid, each to its own transfer.
			const lines = await prisma.earningLine.findMany({
				where: { earningId: earning.id },
			});
			expect(lines.every((l) => l.paidAt !== null)).toBe(true);
			const distinctTransferIds = new Set(lines.map((l) => l.payoutTransferId));
			expect(distinctTransferIds.size).toBe(2);
		});

		it("does not double-pay when a second release fires after the first fully completes (post-success window)", async () => {
			// The partial unique index frees the instant the winner writes
			// stripeTransferId — a late sibling that read the earning as
			// unpaid could previously slip past it into a second Stripe
			// transfer. The EarningLine claim is the real mutex now: the
			// second release finds zero unclaimed lines and no-ops.
			const { earning, seller } = await createPendingPayout();
			const { ctx, mocks } = createTestPayoutsContext();

			await release(createMockJob({ earningId: earning.id }), ctx);
			expect(mocks.payments._getOperationsOfType("seller.pay")).toHaveLength(1);

			await release(createMockJob({ earningId: earning.id }), ctx);

			expect(mocks.payments._getOperationsOfType("seller.pay")).toHaveLength(1);
			const transfers = await prisma.payoutTransfer.findMany({
				where: { sellerProfileId: seller.id },
			});
			expect(transfers).toHaveLength(1);
			const lines = await prisma.earningLine.findMany({
				where: { earningId: earning.id },
			});
			expect(lines.length).toBeGreaterThan(0);
			expect(lines.every((l) => l.payoutTransferId === transfers[0]?.id)).toBe(
				true,
			);
			expect(lines.every((l) => l.paidAt !== null)).toBe(true);
		});

		it("does not pay when the lines are already claimed by another transfer, even with the in-flight index free", async () => {
			// The actual double-pay bug: the partial unique index frees the
			// instant a sibling writes stripeTransferId, so a release still
			// holding a pre-claim snapshot would sail past it into a SECOND
			// Stripe transfer. Reproduce that precise window — a concurrent
			// sibling has claimed every line (Phase 1 committed) and its
			// PayoutTransfer has already exited the in-flight index (Stripe
			// responded), but this release's snapshot predates the paidAt
			// stamp so it still reaches Phase 1. The EarningLine claim, not
			// the freed index, has to stop it. Pre-fix, this double-paid:
			// the sequential post-success test above passes on the buggy
			// code too because its second release re-reads paid lines and
			// bails early; only a stale-claim state exercises the mutex.
			const { earning, seller } = await createPendingPayout();
			const { ctx, mocks } = createTestPayoutsContext();

			// Sibling transfer: succeeded (so out of the partial in-flight
			// index — the old code's only mutex is now free), owning all of
			// this earning's lines, paidAt not yet stamped.
			const siblingTransfer = await prisma.payoutTransfer.create({
				data: {
					sellerProfileId: seller.id,
					earningId: earning.id,
					amountCents: earning.netAmount,
					status: "succeeded",
					stripeTransferId: `tr_sibling_${randomUUID()}`,
					stripeDestinationPaymentId: `py_sibling_${randomUUID()}`,
					paidAt: new Date(),
				},
			});
			await prisma.earningLine.updateMany({
				where: { earningId: earning.id },
				data: { payoutTransferId: siblingTransfer.id },
			});

			await release(createMockJob({ earningId: earning.id }), ctx);

			// No Stripe call — the claim matched zero unowned lines.
			expect(mocks.payments._getOperationsOfType("seller.pay")).toHaveLength(0);

			// The pre-allocated row rolled back with the lost claim: the
			// sibling's transfer is the only one that survives.
			const transfers = await prisma.payoutTransfer.findMany({
				where: { sellerProfileId: seller.id },
			});
			expect(transfers).toHaveLength(1);
			expect(transfers[0]?.id).toBe(siblingTransfer.id);

			// Lines untouched: still the sibling's, still unpaid.
			const lines = await prisma.earningLine.findMany({
				where: { earningId: earning.id },
			});
			expect(lines.length).toBeGreaterThan(0);
			expect(
				lines.every((l) => l.payoutTransferId === siblingTransfer.id),
			).toBe(true);
			expect(lines.every((l) => l.paidAt === null)).toBe(true);

			// Nothing was paid, so no success notification fired.
			expect(
				mocks.queues._getOperationsByJob("notifications", "payoutProcessed"),
			).toHaveLength(0);
		});
	});
});

// ============================================================================
// Test Helpers
// ============================================================================

type CreatePendingPayoutOptions = {
	/** Override payout status (default: in_review) */
	payoutStatus?: PayoutStatus;
	/** Set to simulate already-paid state */
	stripeTransferId?: string | null;
	/** Whether seller has connect account (default: true) */
	hasConnectAccount?: boolean;
	/** Add a dispute with this status */
	dispute?: "pending" | "resolved_fan" | "resolved_creator" | null;
};

/**
 * Creates state as if an auction has been settled and marked as delivered.
 * Mimics the output of: settle job → markAsDelivered
 *
 * Returns everything needed to test payout release:
 * - Seller with connect account
 * - Auction with winner
 * - Earning ready for payout
 */
async function createPendingPayout(options: CreatePendingPayoutOptions = {}) {
	const {
		payoutStatus = PayoutStatus.in_review,
		stripeTransferId = null,
		hasConnectAccount = true,
		dispute = null,
	} = options;

	// Create winner (buyer) with billing info
	const winner = await fixtures.users.create();
	await fixtures.users.createPaymentMethod(winner.id);

	// Create seller with connect account
	const sellerUser = await fixtures.users.create();
	const seller = await prisma.sellerProfile.create({
		data: {
			userId: sellerUser.id,
			connectAccountId: hasConnectAccount ? `acct_test_${Date.now()}` : null,
		},
	});

	// Create auction (closed, with winner)
	const auction = await fixtures.auctions.createForSeller(seller.id, {
		status: AuctionStatus.closed,
	});

	// Seed settled-auction state via the fixture (creates Order + OLI + Earning
	// in the shape production's recordWinner produces).
	const {
		order,
		orderLineItem,
		earning: settledEarning,
		bid,
	} = await fixtures.orders.createSettled({
		listingId: auction.id,
		buyerUserId: winner.id,
	});

	// Mark fulfilled + apply the test's payout-state overrides on top.
	const earning = await prisma.earning.update({
		where: { id: settledEarning.id },
		data: {
			payoutStatus,
			stripeTransferId,
			markedAsFulfilledAt: new Date(),
		},
	});

	// NL-183: when simulating "already paid" via stripeTransferId, also
	// create a matching PayoutTransfer row and mark the EarningLine as
	// paid. Production state always has these aligned (release.job writes
	// all three atomically). Without this, the new per-line path would
	// treat the lines as unpaid and re-fire the payout.
	if (stripeTransferId) {
		const payoutTransfer = await prisma.payoutTransfer.create({
			data: {
				sellerProfileId: seller.id,
				stripeTransferId,
				stripeDestinationPaymentId: `py_test_${randomUUID()}`,
				amountCents: settledEarning.netAmount,
				status: "succeeded",
				paidAt: new Date(),
			},
		});
		await prisma.earningLine.updateMany({
			where: { earningId: earning.id, paidAt: null },
			data: {
				paidAt: new Date(),
				payoutTransferId: payoutTransfer.id,
			},
		});
	}

	if (dispute) {
		await prisma.fulfillmentDispute.create({
			data: {
				orderLineItemId: orderLineItem.id,
				userId: winner.id,
				bidId: bid.id,
				issueType: "not_received",
				status:
					dispute === "pending"
						? DisputeStatus.pending
						: dispute === "resolved_fan"
							? DisputeStatus.refunded
							: DisputeStatus.released,
			},
		});
	}

	return {
		auction,
		seller: { ...seller, user: sellerUser },
		order,
		orderLineItem,
		earning,
		winner,
		bid,
	};
}

interface CreateTwoLineEarningOpts {
	disputeOn?: "A" | "B" | "both" | null;
	disputeStatus?: DisputeStatus;
}

/**
 * Multi-line cart Earning fixture (NL-183).
 *
 * Composes two `createSettled` calls for the same buyer + seller, then
 * collapses them onto a single Order — same end state as a multi-line
 * cart checkout, without dragging the whole `payment-intent-succeeded`
 * flow into release.job tests.
 *
 * Direct DB inserts here are intentional. The PI-succeeded path that
 * really creates multi-line orders in production is exercised in
 * `webhook-payment-intent-succeeded.test.ts`.
 */
async function createTwoLineEarning(opts: CreateTwoLineEarningOpts) {
	const { disputeOn = null, disputeStatus = DisputeStatus.pending } = opts;

	const winner = await fixtures.users.create();
	await fixtures.users.createPaymentMethod(winner.id);

	const sellerUser = await fixtures.users.create();
	const seller = await prisma.sellerProfile.create({
		data: {
			userId: sellerUser.id,
			connectAccountId: `acct_test_${randomUUID()}`,
		},
	});

	const listingA = await fixtures.auctions.createForSeller(seller.id, {
		status: AuctionStatus.closed,
	});
	const listingB = await fixtures.auctions.createForSeller(seller.id, {
		status: AuctionStatus.closed,
	});

	const settledA = await fixtures.orders.createSettled({
		listingId: listingA.id,
		buyerUserId: winner.id,
		amountCents: 10_000,
		platformFeeCents: 2_000,
		payoutStatus: PayoutStatus.in_review,
	});
	const settledB = await fixtures.orders.createSettled({
		listingId: listingB.id,
		buyerUserId: winner.id,
		amountCents: 5_000,
		platformFeeCents: 1_000,
		payoutStatus: PayoutStatus.in_review,
	});

	// Collapse Order B onto Order A's Earning. Move B's OrderLineItem +
	// EarningLine over; bump aggregates on Order A + Earning A; delete the
	// now-empty Order B and its detached Earning.
	await prisma.orderLineItem.update({
		where: { id: settledB.orderLineItem.id },
		data: { orderId: settledA.order.id },
	});
	await prisma.earningLine.update({
		where: { orderLineItemId: settledB.orderLineItem.id },
		data: { earningId: settledA.earning.id },
	});

	const newSubtotal =
		settledA.order.subtotalCents + settledB.order.subtotalCents;
	const newAppFee =
		settledA.order.applicationFeeCents + settledB.order.applicationFeeCents;
	const newTotal = settledA.order.totalCents + settledB.order.totalCents;
	const newNet = settledA.earning.netAmount + settledB.earning.netAmount;

	await prisma.order.update({
		where: { id: settledA.order.id },
		data: {
			subtotalCents: newSubtotal,
			applicationFeeCents: newAppFee,
			totalCents: newTotal,
		},
	});
	const earning = await prisma.earning.update({
		where: { id: settledA.earning.id },
		data: {
			grossAmount: newSubtotal,
			platformFee: newAppFee,
			netAmount: newNet,
			markedAsFulfilledAt: new Date(),
		},
	});

	await prisma.shippingLabel.deleteMany({
		where: { orderId: settledB.order.id },
	});
	await prisma.earning.delete({ where: { id: settledB.earning.id } });
	await prisma.order.delete({ where: { id: settledB.order.id } });

	const lineA = await prisma.earningLine.findUniqueOrThrow({
		where: { orderLineItemId: settledA.orderLineItem.id },
	});
	const lineB = await prisma.earningLine.findUniqueOrThrow({
		where: { orderLineItemId: settledB.orderLineItem.id },
	});

	let dispute: { id: string } | null = null;
	if (disputeOn === "A" || disputeOn === "both") {
		dispute = await prisma.fulfillmentDispute.create({
			data: {
				orderLineItemId: settledA.orderLineItem.id,
				userId: winner.id,
				issueType: DisputeIssueType.not_received,
				status: disputeStatus,
			},
			select: { id: true },
		});
	}
	if (disputeOn === "B" || disputeOn === "both") {
		dispute = await prisma.fulfillmentDispute.create({
			data: {
				orderLineItemId: settledB.orderLineItem.id,
				userId: winner.id,
				issueType: DisputeIssueType.not_received,
				status: disputeStatus,
			},
			select: { id: true },
		});
	}

	return { earning, lineA, lineB, dispute };
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Assert seller was paid via Stripe transfer.
 */
function assertSellerPaid(
	mocks: TestMocksWithPayments,
	expected: { sellerConnectAccountId: string; amount: number },
) {
	const payOps = mocks.payments._getOperationsOfType("seller.pay");
	expect(
		payOps.length,
		"Expected at least one seller.pay call",
	).toBeGreaterThan(0);

	const match = payOps.find(
		(op) =>
			(op.params as { sellerConnectAccountId: string })
				.sellerConnectAccountId === expected.sellerConnectAccountId &&
			(op.params as { amount: number }).amount === expected.amount,
	);
	expect(
		match,
		`Expected seller.pay with connectAccountId=${expected.sellerConnectAccountId}, amount=${expected.amount}`,
	).toBeDefined();
}

type PayoutNotificationType = "payoutProcessed" | "payoutFailed";

/**
 * Assert a payout notification was queued.
 */
function assertNotificationQueued(
	mocks: TestMocksWithPayments,
	type: PayoutNotificationType,
	expected: { orderId: string },
) {
	const ops = mocks.queues._getOperationsByJob<{ orderId: string }>(
		"notifications",
		type,
	);

	expect(
		ops.length,
		`Expected "${type}" notification to be queued`,
	).toBeGreaterThan(0);

	const match = ops.find((op) => op.data.orderId === expected.orderId);
	expect(
		match,
		`Expected "${type}" notification for orderId=${expected.orderId}`,
	).toBeDefined();
}
