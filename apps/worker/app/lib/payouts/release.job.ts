import {
	DisputeStatus,
	isPrismaRecordNotFoundError,
	PayoutStatus,
} from "@nolie/db";
import { PaymentErrorCode } from "@nolie/payments";
import { logger } from "../../logger.js";
import { RetryableError } from "../../retryable-error.js";
import { reportError, reportWarning } from "../observability/sentry/report.js";
import type { PayoutsContext } from "./context.js";
import {
	markPayoutAsFailed,
	reschedulePayoutForInsufficientFunds,
} from "./release-utils.js";
import type { PayoutJob } from "./types.js";

export async function release(job: PayoutJob<"release">, ctx: PayoutsContext) {
	const { earningId } = job.data;

	logger.info({ earningId }, "payout.release: starting");

	const earning = await ctx.prisma.earning.findUnique({
		where: {
			id: earningId,
		},
		select: {
			id: true,
			netAmount: true, // amount in cents, seller's share
			processingFee: true, // Stripe processing fee (nullable)
			listingId: true,
			insufficientFundsRetryAttempts: true,
			payoutStatus: true,
			stripeTransferId: true, // For validation
			createdAt: true, // For calculating age-based backoff
			listing: {
				select: {
					winnerId: true,
					winningBidId: true,
					paymentIntentId: true, // For retrying fee retrieval
					fulfillmentDispute: { select: { id: true, status: true } },
					paymentChargeId: true,
				},
			},
			sellerProfile: {
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
		earning.payoutStatus !== PayoutStatus.in_review &&
		earning.payoutStatus !== PayoutStatus.pending
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

	const fulfillmentDisputeStatus = earning.listing.fulfillmentDispute?.status;
	if (
		fulfillmentDisputeStatus === DisputeStatus.pending ||
		fulfillmentDisputeStatus === DisputeStatus.refunded
	) {
		logger.warn(
			{ earningId, dispute: earning.listing.fulfillmentDispute },
			"payout.release: fulfillment dispute exists; skipping",
		);
		return;
	}

	const connectAccountId = earning.sellerProfile.connectAccountId;
	if (!connectAccountId) {
		reportWarning("Seller has no connect account for payout", {
			operation: "release_payout",
			extra: { earningId, auctionId: earning.listingId },
		});
		logger.error(
			{ earningId },
			"payout.release: seller has no connect account; marking as failed",
		);
		await markPayoutAsFailed(ctx.prisma, { earningId });

		// Fire-and-forget: queue payoutFailed notification
		void ctx.queues.notifications
			.payoutFailed({
				auctionId: earning.listingId,
				userId: earning.sellerProfile.userId,
			})
			.catch((err) => {
				reportError(err, {
					operation: "queue_payout_failed_notification",
					extra: { earningId, auctionId: earning.listingId },
				});
				logger.warn(
					{ err, earningId, auctionId: earning.listingId },
					"payout.release: Failed to queue payoutFailed notification",
				);
			});

		return;
	}

	const auction = earning.listing;
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

	const buyerId = auction.winnerId;
	const bidId = auction.winningBidId;

	if (!buyerId || !bidId) {
		logger.error(
			{ earningId, auctionId: earning.listingId, buyerId, bidId },
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

	const amountInDollars = earning.netAmount / 100; // creator's share in dollars

	if (amountInDollars <= 0) {
		logger.error(
			{ earningId, auctionId: earning.listingId, amountInDollars },
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
			auctionId: earning.listingId,
			amountInDollars,
			connectAccountId,
			buyerId,
			bidId,
		},
		"payout.release: calling payments.seller.pay",
	);

	const result = await ctx.payments.seller.pay({
		amount: amountInDollars,
		sellerConnectAccountId: connectAccountId,
		auctionId: earning.listingId,
		buyerId,
		bidId,
		retryAttempt: earning.insufficientFundsRetryAttempts,
		sourceChargeId: earning.listing.paymentChargeId,
	});

	if (!result.success) {
		if (result.error === PaymentErrorCode.insufficient_funds) {
			reportWarning("Insufficient platform balance when paying out seller", {
				operation: "release_payout",
				extra: { earningId, amountInDollars },
			});
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

		reportWarning("Payout to seller failed", {
			operation: "release_payout",
			extra: {
				earningId,
				auctionId: earning.listingId,
				error: result.error,
				message: result.message,
			},
		});
		logger.error(
			{
				earningId,
				auctionId: earning.listingId,
				error: result.error,
				message: result.message,
			},
			"payout.release: payout failed",
		);

		await markPayoutAsFailed(ctx.prisma, { earningId });

		// Fire-and-forget: queue payoutFailed notification (likely bank account issue)
		void ctx.queues.notifications
			.payoutFailed({
				auctionId: earning.listingId,
				userId: earning.sellerProfile.userId,
			})
			.catch((err) => {
				reportError(err, {
					operation: "queue_payout_failed_notification",
					extra: { earningId, auctionId: earning.listingId },
				});
				logger.warn(
					{ err, earningId, auctionId: earning.listingId },
					"payout.release: Failed to queue payoutFailed notification",
				);
			});

		return;
	}

	// Success: mark as paid and persist transfer id
	logger.info(
		{
			earningId,
			auctionId: earning.listingId,
			transferId: result.transferId,
		},
		"payout.release: payout succeeded",
	);

	try {
		await ctx.prisma.earning.update({
			where: {
				id: earningId,
				payoutStatus: {
					in: [PayoutStatus.in_review, PayoutStatus.pending],
				},
				stripeTransferId: null,
			},
			data: {
				payoutStatus: PayoutStatus.pending,
				stripeTransferId: result.transferId,
				stripeDestinationPaymentId: result.destinationPaymentId,
			},
		});

		// Fire-and-forget: queue payoutProcessed notification to creator
		void ctx.queues.notifications
			.payoutProcessed({
				auctionId: earning.listingId,
				userId: earning.sellerProfile.userId,
			})
			.catch((err) => {
				reportError(err, {
					operation: "queue_payout_processed_notification",
					extra: { earningId, auctionId: earning.listingId },
				});
				logger.warn(
					{ err, earningId, auctionId: earning.listingId },
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
			"Failed to update earning, retrying...",
		);
		throw new RetryableError("Failed to update earning, retrying...");
	}
}
