/**
 * Payout release tests.
 *
 * Tests the release job which handles paying creators after delivery:
 * - Happy path: creator gets paid
 * - Idempotency: already paid → no-op
 * - Dispute blocking: pending/resolved_fan disputes block payout
 * - Failure handling: missing connect account
 */

import { DisputeStatus, PayoutStatus, Prisma, prisma } from "@nolie/db";
import { AuctionStatus, PaymentStatus } from "@nolie/schemas/auction/status";
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
	// TEST 1: Happy path - creator gets paid
	// =========================================================================
	it("pays creator and records transfer on successful payout", async () => {
		// Arrange: Create settled auction with earning ready for payout
		const { earning, creator } = await createPendingPayout();
		const { ctx, mocks } = createTestPayoutsContext();

		// Act: Run release job
		const job = createMockJob({ earningId: earning.id });
		await release(job, ctx);

		// Assert: Creator was paid
		assertCreatorPaid(mocks, {
			creatorConnectAccountId: creator.connectAccountId as string,
			amount: earning.netAmount / 100, // Convert cents to dollars
		});

		// Assert: Earning record updated with transfer ID
		const updatedEarning = await prisma.creatorEarning.findUnique({
			where: { id: earning.id },
		});
		expect(updatedEarning?.stripeTransferId).toBeTruthy();
		expect(updatedEarning?.stripeDestinationPaymentId).toBeTruthy();

		// Assert: Success notification queued
		assertNotificationQueued(mocks, "payoutProcessed", {
			auctionId: earning.auctionId,
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
		const payOps = mocks.payments._getOperationsOfType("creator.pay");
		expect(payOps).toHaveLength(0);

		// Assert: Transfer ID unchanged
		const unchangedEarning = await prisma.creatorEarning.findUnique({
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
		const payOps = mocks.payments._getOperationsOfType("creator.pay");
		expect(payOps).toHaveLength(0);

		// Assert: Earning unchanged
		const unchangedEarning = await prisma.creatorEarning.findUnique({
			where: { id: earning.id },
		});
		expect(unchangedEarning?.stripeTransferId).toBeNull();
	});

	// =========================================================================
	// TEST 4: Dispute blocking - resolved in fan's favor
	// =========================================================================
	it("skips payout when dispute resolved in fan's favor", async () => {
		// Arrange: Create earning with dispute resolved for fan
		const { earning } = await createPendingPayout({
			dispute: "resolved_fan",
		});
		const { ctx, mocks } = createTestPayoutsContext();

		// Act: Run release job
		const job = createMockJob({ earningId: earning.id });
		await release(job, ctx);

		// Assert: No payment attempted (fan was refunded, creator shouldn't be paid)
		const payOps = mocks.payments._getOperationsOfType("creator.pay");
		expect(payOps).toHaveLength(0);

		// Assert: Earning unchanged
		const unchangedEarning = await prisma.creatorEarning.findUnique({
			where: { id: earning.id },
		});
		expect(unchangedEarning?.stripeTransferId).toBeNull();
	});

	// =========================================================================
	// TEST 5: Failure - creator missing connect account
	// =========================================================================
	it("marks payout as failed when creator has no connect account", async () => {
		// Arrange: Create earning where creator never set up Stripe Connect
		const { earning } = await createPendingPayout({
			hasConnectAccount: false,
		});
		const { ctx, mocks } = createTestPayoutsContext();

		// Act: Run release job
		const job = createMockJob({ earningId: earning.id });
		await release(job, ctx);

		// Assert: No payment attempted (can't pay without connect account)
		const payOps = mocks.payments._getOperationsOfType("creator.pay");
		expect(payOps).toHaveLength(0);

		// Assert: Earning marked as failed
		const failedEarning = await prisma.creatorEarning.findUnique({
			where: { id: earning.id },
		});
		expect(failedEarning?.payoutStatus).toBe(PayoutStatus.failed);

		// Assert: Creator notified of failure
		assertNotificationQueued(mocks, "payoutFailed", {
			auctionId: earning.auctionId,
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
		mocks.payments.creator.pay.mockResolvedValueOnce({
			success: false,
			error: "insufficient_funds",
			message: "Insufficient funds in Stripe balance",
		});

		// Act: Run release job
		const job = createMockJob({ earningId: earning.id });
		await release(job, ctx);

		// Assert: Payment was attempted (using .mock.calls since we overrode the mock)
		expect(mocks.payments.creator.pay.mock.calls).toHaveLength(1);

		// Assert: Payout rescheduled (not marked as failed)
		const rescheduledEarning = await prisma.creatorEarning.findUnique({
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
	// TEST 7: Payment fails (transfer error) - marks as failed
	// =========================================================================
	it("marks payout as failed when Stripe transfer fails", async () => {
		// Arrange: Create earning ready for payout
		const { earning } = await createPendingPayout();
		const { ctx, mocks } = createTestPayoutsContext();

		// Mock: Payment fails due to transfer error (e.g., invalid bank account)
		mocks.payments.creator.pay.mockResolvedValueOnce({
			success: false,
			error: "transfer_failed",
			message: "The bank account could not be verified",
		});

		// Act: Run release job
		const job = createMockJob({ earningId: earning.id });
		await release(job, ctx);

		// Assert: Payment was attempted (using .mock.calls since we overrode the mock)
		expect(mocks.payments.creator.pay.mock.calls).toHaveLength(1);

		// Assert: Earning marked as failed (not rescheduled)
		const failedEarning = await prisma.creatorEarning.findUnique({
			where: { id: earning.id },
		});
		expect(failedEarning?.payoutStatus).toBe(PayoutStatus.failed);

		// Assert: Creator notified of failure
		assertNotificationQueued(mocks, "payoutFailed", {
			auctionId: earning.auctionId,
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
	/** Whether creator has connect account (default: true) */
	hasConnectAccount?: boolean;
	/** Add a dispute with this status */
	dispute?: "pending" | "resolved_fan" | "resolved_creator" | null;
};

/**
 * Creates state as if an auction has been settled and marked as delivered.
 * Mimics the output of: settle job → markAsDelivered
 *
 * Returns everything needed to test payout release:
 * - Creator with connect account
 * - Auction with winner
 * - CreatorEarning ready for payout
 */
async function createPendingPayout(options: CreatePendingPayoutOptions = {}) {
	const {
		payoutStatus = PayoutStatus.in_review,
		stripeTransferId = null,
		hasConnectAccount = true,
		dispute = null,
	} = options;

	// Create winner (fan) with billing info
	const winner = await fixtures.users.create();
	await fixtures.users.createPaymentMethod(winner.id);

	// Create creator with connect account
	const creatorUser = await fixtures.users.create({ role: "creator" });
	const creator = await prisma.creator.create({
		data: {
			userId: creatorUser.id,
			connectAccountId: hasConnectAccount ? `acct_test_${Date.now()}` : null,
		},
	});

	// Create auction (closed, with winner)
	const auction = await fixtures.auctions.createForCreator(creator.id, {
		status: AuctionStatus.closed,
	});

	// Create winning bid
	const bid = await prisma.bid.create({
		data: {
			id: `bid_test_${Date.now()}`,
			auctionId: auction.id,
			userId: winner.id,
			amount: new Prisma.Decimal(100),
		},
	});

	// Update auction with winner
	await prisma.auction.update({
		where: { id: auction.id },
		data: {
			winnerId: winner.id,
			winningBidId: bid.id,
			winningAmount: new Prisma.Decimal(100),
			paymentIntentId: `pi_test_${Date.now()}`,
			paymentStatus: PaymentStatus.succeeded,
		},
	});

	// Create CreatorEarning (this is what settle creates)
	const earning = await prisma.creatorEarning.create({
		data: {
			auctionId: auction.id,
			creatorId: creator.id,
			grossAmount: 10000, // $100 in cents
			platformFee: 2000, // 20% fee
			netAmount: 8000, // $80 creator payout
			payoutStatus,
			stripeTransferId,
			markedAsFulfilledAt: new Date(), // Marked as delivered
		},
	});

	// Optionally add a dispute
	if (dispute) {
		await prisma.fulfillmentDispute.create({
			data: {
				auctionId: auction.id,
				userId: winner.id,
				bidId: bid.id,
				issueType: "not_received",
				status:
					dispute === "pending"
						? DisputeStatus.pending
						: dispute === "resolved_fan"
							? DisputeStatus.resolved_fan
							: DisputeStatus.resolved_creator,
			},
		});
	}

	return {
		auction,
		creator: { ...creator, user: creatorUser },
		earning,
		winner,
		bid,
	};
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Assert creator was paid via Stripe transfer.
 */
function assertCreatorPaid(
	mocks: TestMocksWithPayments,
	expected: { creatorConnectAccountId: string; amount: number },
) {
	const payOps = mocks.payments._getOperationsOfType("creator.pay");
	expect(
		payOps.length,
		"Expected at least one creator.pay call",
	).toBeGreaterThan(0);

	const match = payOps.find(
		(op) =>
			(op.params as { creatorConnectAccountId: string })
				.creatorConnectAccountId === expected.creatorConnectAccountId &&
			(op.params as { amount: number }).amount === expected.amount,
	);
	expect(
		match,
		`Expected creator.pay with connectAccountId=${expected.creatorConnectAccountId}, amount=${expected.amount}`,
	).toBeDefined();
}

type PayoutNotificationType = "payoutProcessed" | "payoutFailed";

/**
 * Assert a payout notification was queued.
 */
function assertNotificationQueued(
	mocks: TestMocksWithPayments,
	type: PayoutNotificationType,
	expected: { auctionId: string },
) {
	const ops = mocks.queues._getOperationsByJob<{ auctionId: string }>(
		"notifications",
		type,
	);

	expect(
		ops.length,
		`Expected "${type}" notification to be queued`,
	).toBeGreaterThan(0);

	const match = ops.find((op) => op.data.auctionId === expected.auctionId);
	expect(
		match,
		`Expected "${type}" notification for auctionId=${expected.auctionId}`,
	).toBeDefined();
}
