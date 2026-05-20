"use client";

import type {
	ExploreListingsResponse,
	ExploreSort,
} from "@nolie/schemas/explore";
import { useInfiniteQuery } from "@tanstack/react-query";
import { browser } from "@/lib/http/browser";
import { EXPLORE_LISTINGS_QUERY_KEY } from "./queries";
import { useExploreSort } from "./use-explore-sort";

interface UseExploreListingsOptions {
	/**
	 * SSR-fetched first page. Used only when the React Query cache has no
	 * existing entry — so on back-nav from a listing/profile, the cached
	 * multi-page infinite-scroll state is preserved (and scroll restoration
	 * works) instead of being clobbered by a fresh single-page seed.
	 */
	initialData?: ExploreListingsResponse;
}

export function useExploreListings(options?: UseExploreListingsOptions) {
	const sort: ExploreSort = useExploreSort();
	const res = useInfiniteQuery({
		queryKey: [EXPLORE_LISTINGS_QUERY_KEY, sort],
		queryFn: async ({ pageParam }) => {
			const res = await browser.get<ExploreListingsResponse>("/explore", {
				params: { cursor: pageParam, sort },
				timeout: 7_000,
			});
			return res.data;
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		staleTime: 60 * 1000 * 2, // 2 minutes
		initialData: options?.initialData
			? {
					pages: [options.initialData],
					pageParams: [undefined as string | undefined],
				}
			: undefined,
		// Treat the SSR page as freshly fetched so we don't trigger an
		// immediate refetch on first mount.
		initialDataUpdatedAt: options?.initialData ? Date.now() : undefined,
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
