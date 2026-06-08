"use client";

import type {
	ExploreListingsResponse,
	ExploreSort,
} from "@nolie/schemas/explore";
import type { CategoryKey } from "@nolie/schemas/listing/categories";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useExploreCategory } from "@/hooks/listings/use-category";
import { useListingsSort } from "@/hooks/listings/use-sort";
import { browser } from "@/lib/http/browser";
import { EXPLORE_LISTINGS_QUERY_KEY } from "./queries";

interface UseExploreListingsOptions {
	// SSR-fetched first page. Used only when the React Query cache is empty
	// for this sort/category key — on back-nav from a listing page, the
	// cache's existing multi-page state wins, which preserves scroll position.
	initialData?: ExploreListingsResponse;
	// Sort the SSR payload was fetched for. When the user switches sort via
	// the shallow router, initialData no longer applies and we must let
	// React Query fetch the new sort instead of seeding the new key with
	// stale rows.
	initialSort?: ExploreSort;
	// Category (NL-349) the SSR payload was fetched for — same matching role as
	// initialSort. Undefined = "All".
	initialCategory?: CategoryKey;
}

export function useExploreListings(options?: UseExploreListingsOptions) {
	const sort: ExploreSort = useListingsSort();
	const category = useExploreCategory();
	const seedInitialData =
		options?.initialData &&
		options.initialSort === sort &&
		options.initialCategory === category
			? options.initialData
			: undefined;
	const res = useInfiniteQuery({
		queryKey: [EXPLORE_LISTINGS_QUERY_KEY, sort, category],
		queryFn: async ({ pageParam }) => {
			const res = await browser.get<ExploreListingsResponse>("/explore", {
				params: { cursor: pageParam, sort, category },
				timeout: 7_000,
			});
			return res.data;
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		// Align with server rank_epoch rotation (10 min). Inside one epoch the
		// snapshot is frozen, so refetching just gives us the same data with a
		// fresh query_id — duplicates impressions and skews IPS propensities.
		staleTime: 10 * 60 * 1000,
		// A tab refocus is NOT a new exposure. Without this, useInfiniteQuery
		// refetches EVERY loaded page on focus → 24×N fresh impressions for an
		// N-page scroll (TanStack discussion #3576). The server-side worker's
		// event_id dedup only catches BullMQ retries — each client refetch
		// generates fresh event_ids server-side, so this guard has to live on
		// the client.
		refetchOnWindowFocus: false,
		// SSR-seeded for cold-load; don't invalidate the seed on client mount.
		refetchOnMount: false,
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

	// §19 referrer carry-back. All pages of one infinite-query session share
	// the same queryId/rankEpoch (the snapshot is frozen per epoch; new
	// pages are slices of the same ranked query). Read from page 0 so the
	// values stay stable across pagination and back-nav even if a future
	// page rolled into a new epoch — we always attribute to the originating
	// query the user first saw.
	const firstPage = res.data?.pages[0];

	return {
		listings,
		serverOffset,
		queryId: firstPage?.queryId,
		rankEpoch: firstPage?.rankEpoch,
		...res,
	};
}
