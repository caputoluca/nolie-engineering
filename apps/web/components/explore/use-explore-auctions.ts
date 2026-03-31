"use client";

import type { ExploreAuctionsResponse } from "@nolie/schemas/explore";
import { useInfiniteQuery } from "@tanstack/react-query";
import { browser } from "@/lib/http/browser";
import { defaultInfiniteRetry } from "@/lib/http/retry";
import { EXPLORE_AUCTIONS_QUERY_KEY } from "./queries";
import { useExploreFilter } from "./use-explore-filter";

export function useExploreAuctions() {
	const { filter } = useExploreFilter();
	const res = useInfiniteQuery({
		queryKey: [EXPLORE_AUCTIONS_QUERY_KEY, filter],
		queryFn: async ({ pageParam }) => {
			const res = await browser.get<ExploreAuctionsResponse>("/explore", {
				params: { filter, cursor: pageParam },
				timeout: 7_000,
			});
			return res.data;
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		staleTime: 60 * 1000 * 2, // 2 minutes

		retry: defaultInfiniteRetry,
	});

	// Clock drift = serverNow - dataUpdatedAt. Both values are frozen at fetch time,
	// so their difference stays correct even when served from React Query cache.
	const serverNow = res.data?.pages[0]?.serverNow;
	const serverOffset = serverNow
		? new Date(serverNow).getTime() - res.dataUpdatedAt
		: 0;

	return {
		auctions: res.data?.pages.flatMap((p) => p.auctions) ?? [],
		serverOffset,
		...res,
	};
}
