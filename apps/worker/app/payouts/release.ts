import { prisma } from "@mazal/db";
import { payments } from "@mazal/payments";
import { EarningsPayoutStatus } from "@mazal/schemas/me/index";
import { logger } from "@/logger.js";
import { markPayoutAsFailed, RetryablePayoutError } from "./release-utils.js";
import type { PayoutJob } from "./types.js";

export async function release(job: PayoutJob<"release">) {
	const { earningId } = job.data;

	logger.info({ earningId }, "payout.release: starting");

	const earning = await prisma.creatorEarning.findUnique({
		where: {
			id: earningId,
			payoutStatus: EarningsPayoutStatus.in_review,
			stripeTransferId: null,
		},
		select: {
			id: true,
			netAmount: true, // amount in cents, creator's share
			auctionId: true,
			auction: {
				select: {
					winnerId: true,
					winningBidId: true,
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
	});

	if (!result.success) {
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
				payoutStatus: EarningsPayoutStatus.in_review,
				stripeTransferId: null,
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
