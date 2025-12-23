import { DisputeStatus, isPrismaRecordNotFoundError, prisma } from "@nolie/db";
import { PaymentErrorCode, payments } from "@nolie/payments";
import { EarningsPayoutStatus } from "@nolie/schemas/me/index";
import { logger } from "../../logger.js";
import {
	markPayoutAsFailed,
	RetryablePayoutError,
	reschedulePayoutForInsufficientFunds,
	reschedulePayoutForMissingProcessingFee,
} from "./release-utils.js";
import type { PayoutJob } from "./types.js";

export async function release(job: PayoutJob<"release">) {
	const { earningId } = job.data;

	logger.info({ earningId }, "payout.release: starting");

	const earning = await prisma.creatorEarning.findUnique({
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
		logger.error(
			{ earningId },
			"payout.release: creator has no connect account; marking as failed",
		);
		await markPayoutAsFailed(prisma, { earningId });
		return;
	}

	const auction = earning.auction;
	if (!auction) {
		logger.error(
			{ earningId },
			"payout.release: earning has no auction; failing",
		);
		await markPayoutAsFailed(prisma, { earningId });
		return;
	}

	const fanId = auction.winnerId;
	const bidId = auction.winningBidId;

	if (!fanId || !bidId) {
		logger.error(
			{ earningId, auctionId: earning.auctionId, fanId, bidId },
			"payout.release: auction missing winner or winningBidId; failing",
		);
		await markPayoutAsFailed(prisma, { earningId });
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

		await reschedulePayoutForMissingProcessingFee(prisma, payments, {
			earningId,
			currentAttempts: earning.processingFeeRetryAttempts,
			createdAt: earning.createdAt,
			paymentIntentId: earning.auction.paymentIntentId,
		});
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
		await markPayoutAsFailed(prisma, { earningId });
		return;
	}

	const amountInDollars = earning.netAmount / 100; // creator's share in dollars

	if (amountInDollars <= 0) {
		logger.error(
			{ earningId, auctionId: earning.auctionId, amountInDollars },
			"payout.release: amount is less than or equal to 0; failing",
		);
		await markPayoutAsFailed(prisma, { earningId });
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

	const result = await payments.creator.pay({
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
			await reschedulePayoutForInsufficientFunds(prisma, payments, {
				amountInDollars,
				earningId,
				currentAttempts: earning.insufficientFundsRetryAttempts,
				currentPayoutStatus: earning.payoutStatus,
			});
			return;
		}

		logger.error(
			{
				earningId,
				auctionId: earning.auctionId,
				error: result.error,
				message: result.message,
			},
			"payout.release: payout failed",
		);

		await markPayoutAsFailed(prisma, { earningId });

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
		await prisma.creatorEarning.update({
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
		throw new RetryablePayoutError(
			"Failed to update creator earning, retrying...",
		);
	}
}
