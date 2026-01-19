/**
 * Sequential bid processing tests.
 *
 * Tests behavior when multiple bids are in the inbox:
 * - Bids are processed in FIFO order
 * - First valid bid wins when amounts are equal
 * - Both bids can be accepted when amounts increase
 */

import { BidValidationCode } from "@nolie/schemas/auction/bid-validation";
import { describe, expect, it } from "vitest";
import {
	assertBidsPersistedCount,
	bidOnAuction,
	createBidder,
	createTestBidsContext,
	drainBids,
	getAllBidResults,
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
		await bidOnAuction({
			auctionId: auction.id,
			userId: bidder1.user.id,
			amount: 100,
		});
		await bidOnAuction({
			auctionId: auction.id,
			userId: bidder2.user.id,
			amount: 100, // Same amount - will fail because bidder1 already set highest to 100
		});
		await drainBids(auction.id, ctx);

		// Assert: Both bids processed, first accepted, second rejected
		const results = getAllBidResults(mocks);
		expect(results).toHaveLength(2);

		// First bid accepted
		const firstResult = results.find(
			(r) => (r.data as { userId: string }).userId === bidder1.user.id,
		);
		expect(firstResult?.data).toMatchObject({
			success: true,
			userId: bidder1.user.id,
		});

		// Second bid rejected (bid_too_low - needs to exceed $100)
		const secondResult = results.find(
			(r) => (r.data as { userId: string }).userId === bidder2.user.id,
		);
		expect(secondResult?.data).toMatchObject({
			success: false,
			reason: BidValidationCode.bid_too_low,
		});

		// Only first bid persisted
		assertBidsPersistedCount(mocks, 1);

		// Final state: bidder1 is highest
		const state = await ctx.cache.auctionState.get(auction.id);
		expect(state?.currentHighestBidAmount).toBe(100);
		expect(state?.highestBidUserId).toBe(bidder1.user.id);
	});

	it("processes multiple bids in order, both accepted when amounts increase", async () => {
		// Arrange
		const { auction } = await setupAuction({ startingBid: 100 });
		const bidder1 = await createBidder();
		const bidder2 = await createBidder();
		const { ctx, mocks } = createTestBidsContext();

		// Act: Push bids with increasing amounts
		await bidOnAuction({
			auctionId: auction.id,
			userId: bidder1.user.id,
			amount: 100,
		});
		await bidOnAuction({
			auctionId: auction.id,
			userId: bidder2.user.id,
			amount: 110, // Higher than bidder1
		});
		await drainBids(auction.id, ctx);

		// Assert: Both bids accepted
		const results = getAllBidResults(mocks);
		expect(results).toHaveLength(2);

		const result1 = results.find(
			(r) => (r.data as { userId: string }).userId === bidder1.user.id,
		);
		const result2 = results.find(
			(r) => (r.data as { userId: string }).userId === bidder2.user.id,
		);

		expect(result1?.data).toMatchObject({ success: true });
		expect(result2?.data).toMatchObject({ success: true });

		// Both bids persisted
		assertBidsPersistedCount(mocks, 2);

		// Final state: bidder2 is highest
		const state = await ctx.cache.auctionState.get(auction.id);
		expect(state?.currentHighestBidAmount).toBe(110);
		expect(state?.highestBidUserId).toBe(bidder2.user.id);
	});
});
