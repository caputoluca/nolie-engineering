import { DisputeStatus, isPrismaRecordNotFoundError } from "@nolie/db";
import { PaymentErrorCode } from "@nolie/payments";
import { EarningsPayoutStatus } from "@nolie/schemas/me/index";
import { logger } from "../../logger.js";
import { RetryableError } from "../../retryable-error.js";
import { reportError, reportWarning } from "../observability/sentry/report.js";
import type { PayoutsContext } from "./context.js";
import {
	markPayoutAsFailed,
	reschedulePayoutForInsufficientFunds,
	reschedulePayoutForMissingProcessingFee,
} from "./release-utils.js";
import type { PayoutJob } from "./types.js";

export async function release(job: PayoutJob<"release">, ctx: PayoutsContext) {
	const { earningId } = job.data;

	logger.info({ earningId }, "payout.release: starting");

	const earning = await ctx.prisma.creatorEarning.findUnique({
		where: {
			id: earningId,
		},
		select: {
			id: true,
			netAmount: true, // amount in cents, creator's share
			processingFee: true, // Stripe processing fee (nullable)
			auctionId: true,
			insufficientFundsRetryAttempts: true,
			processingFeeRetryAttempts: true,
			payoutStatus: true,
			stripeTransferId: true, // For validation
			createdAt: true, // For calculating age-based backoff
			auction: {
				select: {
					winnerId: true,
					winningBidId: true,
					paymentIntentId: true, // For retrying fee retrieval
					fulfillmentDispute: { select: { id: true, status: true } },
				},
			},
			creator: {
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

	// Validate payout status - must be in_review or pending
	if (
		earning.payoutStatus !== EarningsPayoutStatus.in_review &&
		earning.payoutStatus !== EarningsPayoutStatus.pending
	) {
		logger.warn(
			{
				earningId,
				payoutStatus: earning.payoutStatus,
			},
			"payout.release: earning not in valid payout status; skipping",
		);
		return;
	}

	// Validate stripeTransferId is null (payout not yet initiated)
	if (earning.stripeTransferId !== null) {
		logger.warn(
			{
				earningId,
				stripeTransferId: earning.stripeTransferId,
			},
			"payout.release: earning already has stripeTransferId; skipping",
		);
		return;
	}

	const fulfillmentDisputeStatus = earning.auction.fulfillmentDispute?.status;
	if (
		fulfillmentDisputeStatus === DisputeStatus.pending ||
		fulfillmentDisputeStatus === DisputeStatus.resolved_fan
	) {
		logger.warn(
			{ earningId, dispute: earning.auction.fulfillmentDispute },
			"payout.release: fulfillment dispute exists; skipping",
		);
		return;
	}

	const connectAccountId = earning.creator.connectAccountId;
	if (!connectAccountId) {
		reportWarning("Creator has no connect account for payout", {
			operation: "release_payout",
			extra: { earningId, auctionId: earning.auctionId },
		});
		logger.error(
			{ earningId },
			"payout.release: creator has no connect account; marking as failed",
		);
		await markPayoutAsFailed(ctx.prisma, { earningId });

		// Fire-and-forget: queue payoutFailed notification
		void ctx.queues.notifications
			.payoutFailed({
				auctionId: earning.auctionId,
				userId: earning.creator.userId,
			})
			.catch((err) => {
				reportError(err, {
					operation: "queue_payout_failed_notification",
					extra: { earningId, auctionId: earning.auctionId },
				});
				logger.warn(
					{ err, earningId, auctionId: earning.auctionId },
					"payout.release: Failed to queue payoutFailed notification",
				);
			});

		return;
	}

	const auction = earning.auction;
	if (!auction) {
		logger.error(
			{ earningId },
			"payout.release: earning has no auction; failing",
		);
		await markPayoutAsFailed(ctx.prisma, { earningId });

		reportWarning("Auction not found in payout release job", {
			operation: "release_payout",
			extra: { earningId },
		});

		return;
	}

	const fanId = auction.winnerId;
	const bidId = auction.winningBidId;

	if (!fanId || !bidId) {
		logger.error(
			{ earningId, auctionId: earning.auctionId, fanId, bidId },
			"payout.release: auction missing winner or winningBidId; failing",
		);
		reportWarning(
			"Auction missing winner or winningBidId in payout release job",
			{
				operation: "release_payout",
				extra: { earningId },
			},
		);
		await markPayoutAsFailed(ctx.prisma, { earningId });

		return;
	}

	// Check if processingFee is null - if so, reschedule with time-aware backoff
	if (earning.processingFee === null) {
		logger.warn(
			{
				earningId,
				auctionId: earning.auctionId,
				paymentIntentId: earning.auction.paymentIntentId,
				ageHours: (Date.now() - earning.createdAt.getTime()) / (60 * 60 * 1000),
			},
			"payout.release: processingFee is null; rescheduling with time-aware backoff",
		);

		await reschedulePayoutForMissingProcessingFee(
			ctx.prisma,
			ctx.payments,
			ctx.queues,
			{
				earningId,
				auctionId: earning.auctionId,
				currentAttempts: earning.processingFeeRetryAttempts,
				createdAt: earning.createdAt,
				paymentIntentId: earning.auction.paymentIntentId,
			},
		);
		return;
	}

	// Check if netAmount is null (shouldn't happen if processingFee is set, but defensive check)
	if (earning.netAmount === null) {
		logger.error(
			{
				earningId,
				auctionId: earning.auctionId,
				processingFee: earning.processingFee,
			},
			"payout.release: netAmount is null but processingFee is set; this should not happen",
		);
		reportWarning(
			"Net amount is null but processingFee is set in payout release job",
			{
				level: "fatal",
				operation: "release_payout",
				extra: { earningId },
				tags: { critical: "true" },
			},
		);
		await markPayoutAsFailed(ctx.prisma, { earningId });

		return;
	}

	const amountInDollars = earning.netAmount / 100; // creator's share in dollars

	if (amountInDollars <= 0) {
		logger.error(
			{ earningId, auctionId: earning.auctionId, amountInDollars },
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

	logger.info(
		{
			earningId,
			auctionId: earning.auctionId,
			amountInDollars,
			connectAccountId,
			fanId,
			bidId,
		},
		"payout.release: calling payments.creator.pay",
	);

	const result = await ctx.payments.creator.pay({
		amount: amountInDollars,
		creatorConnectAccountId: connectAccountId,
		auctionId: earning.auctionId,
		fanId,
		bidId,
		retryAttempt: earning.insufficientFundsRetryAttempts,
	});

	if (!result.success) {
		if (result.error === PaymentErrorCode.insufficient_funds) {
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

		reportWarning("Payout to creator failed", {
			operation: "release_payout",
			extra: {
				earningId,
				auctionId: earning.auctionId,
				error: result.error,
				message: result.message,
			},
		});
		logger.error(
			{
				earningId,
				auctionId: earning.auctionId,
				error: result.error,
				message: result.message,
			},
			"payout.release: payout failed",
		);

		await markPayoutAsFailed(ctx.prisma, { earningId });

		// Fire-and-forget: queue payoutFailed notification (likely bank account issue)
		void ctx.queues.notifications
			.payoutFailed({
				auctionId: earning.auctionId,
				userId: earning.creator.userId,
			})
			.catch((err) => {
				reportError(err, {
					operation: "queue_payout_failed_notification",
					extra: { earningId, auctionId: earning.auctionId },
				});
				logger.warn(
					{ err, earningId, auctionId: earning.auctionId },
					"payout.release: Failed to queue payoutFailed notification",
				);
			});

		return;
	}

	// Success: mark as paid and persist transfer id
	logger.info(
		{
			earningId,
			auctionId: earning.auctionId,
			transferId: result.transferId,
		},
		"payout.release: payout succeeded",
	);

	try {
		await ctx.prisma.creatorEarning.update({
			where: {
				id: earningId,
				payoutStatus: {
					in: [EarningsPayoutStatus.in_review, EarningsPayoutStatus.pending],
				},
				stripeTransferId: null,
			},
			data: {
				payoutStatus: EarningsPayoutStatus.pending,
				stripeTransferId: result.transferId,
			},
		});

		// Fire-and-forget: queue payoutProcessed notification to creator
		void ctx.queues.notifications
			.payoutProcessed({
				auctionId: earning.auctionId,
				userId: earning.creator.userId,
			})
			.catch((err) => {
				reportError(err, {
					operation: "queue_payout_processed_notification",
					extra: { earningId, auctionId: earning.auctionId },
				});
				logger.warn(
					{ err, earningId, auctionId: earning.auctionId },
					"payout.release: Failed to queue payoutProcessed notification",
				);
			});
	} catch (err) {
		if (isPrismaRecordNotFoundError(err)) {
			logger.warn(
				{
					earningId,
					transferId: result.transferId,
				},
				"payout.release: earning status or transferId changed during payout; skipping update",
			);
			// Don't throw - transfer succeeded, status was just updated by another process
			return;
		}
		logger.error(
			{
				earningId,
				transferId: result.transferId,
				err,
			},
			"Failed to update creator earning, retrying...",
		);
		throw new RetryableError("Failed to update creator earning, retrying...");
	}
}
