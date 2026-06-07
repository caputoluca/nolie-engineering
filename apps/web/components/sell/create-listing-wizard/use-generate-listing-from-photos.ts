"use client";

import type { GenerateListingFromPhotoResponse } from "@nolie/schemas/ai/listing-extraction";
import { useQuery } from "@tanstack/react-query";
import { browser } from "@/lib/http/browser";

interface UseGenerateListingFromPhotosArgs {
	imageKeys: string[];
	/**
	 * Wizard-session id (NL-349). Sent with every generation so the server can
	 * group a seller's re-rolls in the generation log. Deliberately NOT part of
	 * the query key — it's stable for the wizard's lifetime, and a re-roll
	 * (hero swap) should reuse it, not invalidate the cache.
	 */
	sessionId?: string;
}

/**
 * Query wrapper around POST /listings/generate. The cache key tracks ONLY
 * the hero image (`imageKeys[0]`) — additional photos (back of the card,
 * angles, etc.) don't trigger a new generation, since they rarely add facts
 * to the title/description and silently overwriting the user's accepted
 * copy is the bigger annoyance. Replacing the hero (delete + re-upload, or
 * a future drag-to-reorder) refetches.
 */
export function useGenerateListingFromPhotos({
	imageKeys,
	sessionId,
}: UseGenerateListingFromPhotosArgs) {
	const signature = imageKeys[0] ?? "";

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
				{ imageKeys, ...(sessionId && { sessionId }) },
				{ signal },
			);
			return res.data;
		},
	});
}
