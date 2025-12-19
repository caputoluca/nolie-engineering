import type { BidInboxItem } from "@nolie/inbox";
import {
	acquireIdempotency,
	markIdempotencyProcessed,
	releaseIdempotency,
} from "@nolie/redis/idempotency";
import { logger } from "../logger.js";

const TTL_SECONDS = 3600;

export function withBidIdempotency<T>(
	handler: (item: BidInboxItem) => Promise<T>,
): (item: BidInboxItem) => Promise<T | undefined> {
	return async (item: BidInboxItem) => {
		const requestId = item.requestId;
		const idempotencyKey = `bid:${requestId}`;

		const result = await acquireIdempotency(idempotencyKey, TTL_SECONDS);

		if (!result.acquired) {
			// Already processing or processed → skip safely
			logger.info(
				{ requestId },
				"bids.withIdempotency: Already processing or processed, skipping",
			);
			return;
		}

		try {
			const output = await handler(item);

			// Mark success (do NOT delete)
			await markIdempotencyProcessed(idempotencyKey, TTL_SECONDS);

			return output;
		} catch (error) {
			await releaseIdempotency(idempotencyKey);
			throw error; // let BullMQ retry the job
		}
	};
}
