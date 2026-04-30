"use client";

import type { ExploreListingsResponse } from "@nolie/schemas/explore";
import { useInfiniteQuery } from "@tanstack/react-query";
import { browser } from "@/lib/http/browser";
import { EXPLORE_LISTINGS_QUERY_KEY } from "./queries";

export function useExploreListings() {
	const res = useInfiniteQuery({
		queryKey: [EXPLORE_LISTINGS_QUERY_KEY],
		queryFn: async ({ pageParam }) => {
			const res = await browser.get<ExploreListingsResponse>("/explore", {
				params: { cursor: pageParam },
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

	const listings = res.data?.pages.flatMap((p) => p.listings) ?? [];

	return {
		listings,
		serverOffset,
		...res,
	};
}
