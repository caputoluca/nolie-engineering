import { type Prisma, prisma } from "@nolie/db";
import { PaymentErrorCode, payments } from "@nolie/payments";
import { EarningsPayoutStatus } from "@nolie/schemas/me/index";
import { logger } from "../logger.js";
import {
	markPayoutAsFailed,
	RetryablePayoutError,
	reschedulePayoutForInsufficientFunds,
} from "./release-utils.js";
import type { PayoutJob } from "./types.js";

const WHERE_CLAUSE = {
	payoutStatus: {
		in: [EarningsPayoutStatus.in_review, EarningsPayoutStatus.pending],
	},
	stripeTransferId: null,
} as const satisfies Prisma.CreatorEarningWhereInput;

export async function release(job: PayoutJob<"release">) {
	const { earningId } = job.data;

	logger.info({ earningId }, "payout.release: starting");

	const earning = await prisma.creatorEarning.findUnique({
		where: {
			id: earningId,
			...WHERE_CLAUSE,
		},
		select: {
			id: true,
			netAmount: true, // amount in cents, creator's share
			auctionId: true,
			payoutRetryAttempts: true,
			payoutStatus: true,
			auction: {
				select: {
					winnerId: true,
					winningBidId: true,
					fulfillmentDispute: { select: { id: true } },
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

	if (earning.auction.fulfillmentDispute !== null) {
		logger.warn(
			{ earningId },
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
		retryAttempt: earning.payoutRetryAttempts,
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
				currentAttempts: earning.payoutRetryAttempts,
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
				...WHERE_CLAUSE,
			},
			data: {
				payoutStatus: EarningsPayoutStatus.pending,
				stripeTransferId: result.transferId,
			},
		});
	} catch (err) {
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
