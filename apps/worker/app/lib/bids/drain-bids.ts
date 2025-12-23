import { type BidInboxItem, inbox } from "@nolie/inbox";
import { logger } from "../../logger.js";
import type { BidJob } from "./types.js";

const MAX_ROUNDS = 25;
const MAX_ITEMS_PER_ROUND = 500;

// TODO: there might be a tiny race condition here if a new bid is added after the dirty flag is cleared but before the items are drained
// we could use a lock, but then that would cause retry storms
// figure this out
function startTimer(): bigint {
	return process.hrtime.bigint();
}

function elapsedMs(start: bigint): number {
	const elapsedNs = process.hrtime.bigint() - start;
	return Number(elapsedNs) / 1_000_000;
}

export function drainBidsInbox(
	process: (item: BidInboxItem) => Promise<void>,
): (job: BidJob) => Promise<void> {
	return async (job: BidJob) => {
		const auctionId = job.data.auctionId;
		const jobStart = startTimer();
		let rounds = 0;
		let totalDrained = 0;

		logger.info({ auctionId, jobId: job.id }, "bids.drain: start");

		while (rounds < MAX_ROUNDS) {
			const dirty = await inbox.bids.isDirty(auctionId);
			if (!dirty) break;

			rounds++;

			// Clear dirty BEFORE draining to close exit gap
			await inbox.bids.clearDirty(auctionId);

			let drained = 0;
			const roundStart = startTimer();

			while (drained < MAX_ITEMS_PER_ROUND) {
				const item = await inbox.bids.pop(auctionId);
				if (!item) break;

				drained++;
				totalDrained++;

				try {
					await process(item);
				} catch (err) {
					logger.error(
						{ auctionId, item, err, round: rounds, drained },
						"bids.drain: item failed",
					);
					throw err;
				}
			}

			const roundMs = elapsedMs(roundStart);
			logger.debug(
				{
					auctionId,
					round: rounds,
					drained,
					roundMs: Math.round(roundMs * 100) / 100,
				},
				"bids.drain: round complete",
			);
		}

		const totalMs = elapsedMs(jobStart);
		logger.info(
			{
				auctionId,
				jobId: job.id,
				rounds,
				totalDrained,
				totalMs: Math.round(totalMs * 100) / 100,
				reason: rounds >= MAX_ROUNDS ? "max_rounds" : "no_dirty",
			},
			"bids.drain: exit",
		);
	};
}
