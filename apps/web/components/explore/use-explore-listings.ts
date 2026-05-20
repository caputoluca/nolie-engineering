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
	// SSR-fetched first page. Used only when the React Query cache is empty
	// for this sort key — on back-nav from a listing page, the cache's
	// existing multi-page state wins, which preserves scroll position.
	initialData?: ExploreListingsResponse;
	// Sort the SSR payload was fetched for. When the user switches sort via
	// the shallow router, initialData no longer applies and we must let
	// React Query fetch the new sort instead of seeding the new key with
	// stale rows.
	initialSort?: ExploreSort;
}

export function useExploreListings(options?: UseExploreListingsOptions) {
	const sort: ExploreSort = useExploreSort();
	const seedInitialData =
		options?.initialData && options.initialSort === sort
			? options.initialData
			: undefined;
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
		initialData: seedInitialData
			? {
					pages: [seedInitialData],
					pageParams: [undefined as string | undefined],
				}
			: undefined,
		// Treat the SSR page as freshly fetched so we don't trigger an
		// immediate refetch on first mount.
		initialDataUpdatedAt: seedInitialData ? Date.now() : undefined,
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
