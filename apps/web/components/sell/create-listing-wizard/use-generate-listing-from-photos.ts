"use client";

import type { GenerateListingFromPhotoResponse } from "@nolie/schemas/ai/listing-extraction";
import { useQuery } from "@tanstack/react-query";
import { browser } from "@/lib/http/browser";
import { keySignature } from "./images";

interface UseGenerateListingFromPhotosArgs {
	imageKeys: string[];
}

/**
 * Query wrapper around POST /listings/generate. The keyed inputs (sorted S3
 * keys) make a stable cache signature, so removing then re-adding the same
 * photo serves the cached result without a refetch. Manual rerun is
 * `query.refetch()` — that bypasses the cache and forces a fresh extraction.
 */
export function useGenerateListingFromPhotos({
	imageKeys,
}: UseGenerateListingFromPhotosArgs) {
	const signature = keySignature(imageKeys);

	return useQuery<GenerateListingFromPhotoResponse, Error>({
		queryKey: ["listing-ai", signature],
		enabled: imageKeys.length > 0,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 30 * 60 * 1000,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnMount: false,
		refetchOnReconnect: false,
		queryFn: async ({ signal }) => {
			const res = await browser.post<GenerateListingFromPhotoResponse>(
				"/listings/generate",
				{ imageKeys },
				{ signal },
			);
			return res.data;
		},
	});
}
