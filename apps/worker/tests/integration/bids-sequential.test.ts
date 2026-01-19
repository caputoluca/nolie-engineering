/**
 * Sequential bid processing tests.
 *
 * Tests behavior when multiple bids are in the inbox:
 * - Bids are processed in FIFO order
 * - First valid bid wins when amounts are equal
 * - Both bids can be accepted when amounts increase
 */

import { BidValidationCode } from "@nolie/schemas/auction/bid-validation";
import { describe, it } from "vitest";
import {
	assertBidAccepted,
	assertBidRejected,
	assertBidsPersistedCount,
	bidOnAuction,
	createBidder,
	createTestBidsContext,
	drainBids,
	setupAuction,
} from "../helpers/index.js";

describe("Sequential Bid Processing", () => {
	it("processes multiple bids in inbox order, first wins when amounts equal", async () => {
		// Arrange: Two bidders, both bidding $100
		const { auction } = await setupAuction({ startingBid: 100 });
		const bidder1 = await createBidder();
		const bidder2 = await createBidder();
		const { ctx, mocks } = createTestBidsContext();

		// Act: Push both bids to inbox, then drain once
		const requestId1 = await bidOnAuction({
			auctionId: auction.id,
			userId: bidder1.user.id,
			amount: 100,
		});
		const requestId2 = await bidOnAuction({
			auctionId: auction.id,
			userId: bidder2.user.id,
			amount: 100, // Same amount - will fail because bidder1 already set highest to 100
		});
		await drainBids(auction.id, ctx);

		// Assert: First bid accepted, second rejected
		assertBidAccepted(mocks, { requestId: requestId1 });
		assertBidRejected(mocks, {
			requestId: requestId2,
			reason: BidValidationCode.bid_too_low,
		});

		// Only first bid persisted
		assertBidsPersistedCount(mocks, 1);
	});

	it("processes multiple bids in order, both accepted when amounts increase", async () => {
		// Arrange
		const { auction } = await setupAuction({ startingBid: 100 });
		const bidder1 = await createBidder();
		const bidder2 = await createBidder();
		const { ctx, mocks } = createTestBidsContext();

		// Act: Push bids with increasing amounts
		const requestId1 = await bidOnAuction({
			auctionId: auction.id,
			userId: bidder1.user.id,
			amount: 100,
		});
		const requestId2 = await bidOnAuction({
			auctionId: auction.id,
			userId: bidder2.user.id,
			amount: 110, // Higher than bidder1
		});
		await drainBids(auction.id, ctx);

		// Assert: Both bids accepted
		assertBidAccepted(mocks, { requestId: requestId1 });
		assertBidAccepted(mocks, { requestId: requestId2 });

		// Both bids persisted
		assertBidsPersistedCount(mocks, 2);
	});
});
