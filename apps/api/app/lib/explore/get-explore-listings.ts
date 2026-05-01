import type { CacheOf } from "@nolie/cache";
import { type DbClient, ListingStatus, type Prisma } from "@nolie/db";
import {
	DEFAULT_EXPLORE_LIMIT,
	type ExploreListingSummary,
	type ExploreQueryType,
} from "@nolie/schemas/explore";
import { queryListings } from "../listings/query.js";
import { exploreListingSelect } from "./select.js";
import { toExploreListingSummary } from "./transform.js";

interface LoadExploreListingsResult {
	listings: ExploreListingSummary[];
	nextCursor: string | null;
}

async function loadExploreListings(
	db: DbClient,
	query: ExploreQueryType,
): Promise<LoadExploreListingsResult> {
	const { filter, cursor, limit = DEFAULT_EXPLORE_LIMIT } = query;
	const where: Prisma.ListingWhereInput = {
		// exclude listings without thumbnails (e.g. load test artifacts)
		listingAssets: { some: {} },
		hidden: false,
	};
	if (filter === "live") {
		where.status = ListingStatus.active;
	} else if (filter === "ended") {
		// failed means all payments failed
		where.status = { in: [ListingStatus.closed, ListingStatus.failed] };
	} else {
		where.status = {
			in: [
				ListingStatus.active,
				ListingStatus.scheduled,
				ListingStatus.closed,
				ListingStatus.failed, // failed means all payments failed
				ListingStatus.pending,
				ListingStatus.sold,
				ListingStatus.reserved,
			],
		};
	}

	const listings = await queryListings(db, {
		where,
		select: exploreListingSelect,
		...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		take: limit + 1,
		orderBy: [{ sortPriority: "asc" }, { sortTimeMs: "asc" }, { id: "asc" }],
	});

	return {
		listings: listings.slice(0, limit).map(toExploreListingSummary),
		nextCursor: getNextCursor(listings, limit),
	};
}

function getNextCursor(listings: { id: string }[], limit: number | undefined) {
	const effectiveLimit = limit ?? DEFAULT_EXPLORE_LIMIT;
	if (listings.length > effectiveLimit) {
		return listings[effectiveLimit - 1]?.id || null;
	}
	return null;
}

export async function getExploreListings(
	db: DbClient,
	query: ExploreQueryType,
	exploreListingsCache: CacheOf<"exploreListings">,
): Promise<LoadExploreListingsResult> {
	const { filter = "all", limit, cursor } = query;

	if (limit === DEFAULT_EXPLORE_LIMIT && !cursor) {
		return exploreListingsCache.get(filter, {
			load: () => loadExploreListings(db, { filter }),
		});
	}

	return loadExploreListings(db, { filter, limit, cursor });
}
