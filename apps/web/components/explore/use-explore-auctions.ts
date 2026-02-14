"use client";

import type { ExploreAuctionsResponse } from "@nolie/schemas/explore";
import { useInfiniteQuery } from "@tanstack/react-query";
import { browser } from "@/lib/http/browser";
import { EXPLORE_AUCTIONS_QUERY_KEY } from "./queries";
import { useExploreFilter } from "./use-explore-filter";

export function useExploreAuctions() {
	const { filter } = useExploreFilter();
	const res = useInfiniteQuery({
		queryKey: [EXPLORE_AUCTIONS_QUERY_KEY, filter],
		queryFn: async ({ pageParam }) => {
			const res = await browser.get<ExploreAuctionsResponse>("/explore", {
				params: { filter, cursor: pageParam },
			});
			return res.data;
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		staleTime: 60 * 1000 * 2, // 2 minutes
		retry: 2,
	});

	return { auctions: res.data?.pages.flatMap((p) => p.auctions) ?? [], ...res };
}
