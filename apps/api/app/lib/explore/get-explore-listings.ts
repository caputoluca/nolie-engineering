import type { CacheOf } from "@nolie/cache";
import { type DbClient, ListingStatus, type Prisma } from "@nolie/db";
import {
	DEFAULT_EXPLORE_LIMIT,
	type ExploreListingSummary,
	type ExploreQueryType,
} from "@nolie/schemas/explore";
import { queryListings } from "../listings/query.js";
import {
	publicListingsWhere,
	SOLD_VISIBILITY_DAYS,
} from "../listings/statuses.js";
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
		// "ended" = recently-ended listings. Auction-won (closed +
		// winningAmount) obey the SOLD_VISIBILITY_DAYS cutoff; auction-failed
		// (closed without winningAmount) and payment-failed listings have no
		// time gate since they aren't "sold" in any commerce sense.
		const cutoff = new Date(
			Date.now() - SOLD_VISIBILITY_DAYS * 24 * 60 * 60 * 1000,
		);
		where.OR = [
			{ status: ListingStatus.failed },
			{ status: ListingStatus.closed, winningAmount: null },
			{
				status: ListingStatus.closed,
				winningAmount: { not: null },
				soldAt: { gte: cutoff },
			},
		];
	} else {
		// `all` filter: visible statuses + sold/auction-won within the cutoff.
		// Explore historically also surfaces `pending` (mid-creation listings)
		// which the seller-profile path does not — preserve that here without
		// pushing it into the shared helper.
		const base = publicListingsWhere();
		where.OR = [...(base.OR ?? []), { status: ListingStatus.pending }];
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
