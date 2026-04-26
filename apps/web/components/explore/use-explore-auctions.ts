"use client";

import type { ExploreListingsResponse } from "@nolie/schemas/explore";
import { useInfiniteQuery } from "@tanstack/react-query";
import { browser } from "@/lib/http/browser";
import { EXPLORE_AUCTIONS_QUERY_KEY } from "./queries";
import { useExploreFilter } from "./use-explore-filter";

export function useExploreAuctions() {
	const { filter } = useExploreFilter();
	const res = useInfiniteQuery({
		queryKey: [EXPLORE_AUCTIONS_QUERY_KEY, filter],
		queryFn: async ({ pageParam }) => {
			const res = await browser.get<ExploreListingsResponse>("/explore", {
				params: { filter, cursor: pageParam },
				timeout: 7_000,
			});
			return res.data;
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		staleTime: 60 * 1000 * 2, // 2 minutes
	});

	// Clock drift = serverNow - dataUpdatedAt. Both values are frozen at fetch time,
	// so their difference stays correct even when served from React Query cache.
	const serverNow = res.data?.pages[0]?.serverNow;
	const serverOffset = serverNow
		? new Date(serverNow).getTime() - res.dataUpdatedAt
		: 0;

	// TODO(bin-ui): drop the auction-only filter once the explore feed renders
	// fixed-price listings (Phase 7 / PR 2 — when AuctionCard learns about BIN
	// or a sibling FixedPriceCard ships). Until then, the polymorphic feed
	// gets narrowed here so the auction-only UI keeps compiling.
	const auctions =
		res.data?.pages
			.flatMap((p) => p.listings)
			.filter((listing) => listing.listingType === "auction") ?? [];

	return {
		auctions,
		serverOffset,
		...res,
	};
}
