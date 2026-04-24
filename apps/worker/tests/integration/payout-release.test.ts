/**
 * Payout release tests.
 *
 * Tests the release job which handles paying sellers after delivery:
 * - Happy path: seller gets paid
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
	// TEST 1: Happy path - seller gets paid
	// =========================================================================
	it("pays seller and records transfer on successful payout", async () => {
		// Arrange: Create settled auction with earning ready for payout
		const { earning, seller } = await createPendingPayout();
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
			auctionId: earning.listingId,
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
		const { earning } = await createPendingPayout({
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
			auctionId: earning.listingId,
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
	// TEST 7: Payment fails (transfer error) - marks as failed
	// =========================================================================
	it("marks payout as failed when Stripe transfer fails", async () => {
		// Arrange: Create earning ready for payout
		const { earning } = await createPendingPayout();
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

		// Assert: Seller notified of failure
		assertNotificationQueued(mocks, "payoutFailed", {
			auctionId: earning.listingId,
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

	// Optionally add a dispute (populates both legacy listingId and new
	// orderLineItemId FKs to match recordWinner's dispute-write contract).
	if (dispute) {
		await prisma.fulfillmentDispute.create({
			data: {
				listingId: auction.id,
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
