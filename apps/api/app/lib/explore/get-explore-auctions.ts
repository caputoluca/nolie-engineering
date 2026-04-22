import type { CacheOf } from "@nolie/cache";
import { AuctionStatus, type DbClient, type Prisma } from "@nolie/db";
import {
	DEFAULT_EXPLORE_LIMIT,
	type ExploreAuctionOut,
	type ExploreAuctionsResponse,
	type ExploreQueryType,
} from "@nolie/schemas/explore";
import { queryAuctions } from "../auctions/query.js";
import { exploreAuctionSelect } from "./select.js";
import { toExploreAuctionOut } from "./transform.js";

interface LoadExploreAuctionsResult {
	auctions: ExploreAuctionOut[];
	nextCursor: string | null;
}

async function loadExploreAuctions(
	db: DbClient,
	query: ExploreQueryType,
): Promise<LoadExploreAuctionsResult> {
	const { filter, cursor, limit = DEFAULT_EXPLORE_LIMIT } = query;
	const where: Prisma.ListingWhereInput = {
		// exclude auctions without thumbnails (e.g. load test artifacts)
		listingAssets: { some: {} },
		hidden: false,
	};
	if (filter === "live") {
		where.status = AuctionStatus.active;
	} else if (filter === "ended") {
		// failed means all payments failed
		where.status = { in: [AuctionStatus.closed, AuctionStatus.failed] };
	} else {
		where.status = {
			in: [
				AuctionStatus.active,
				AuctionStatus.scheduled,
				AuctionStatus.closed,
				AuctionStatus.failed, // failed means all payments failed
				AuctionStatus.pending,
			],
		};
	}

	const auctions = await queryAuctions(db, {
		where,
		select: exploreAuctionSelect,
		...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		take: limit + 1,
		orderBy: [{ sortPriority: "asc" }, { sortTimeMs: "asc" }, { id: "asc" }],
	});

	return {
		auctions: auctions.slice(0, limit).map(toExploreAuctionOut),
		nextCursor: getNextCursor(auctions, limit),
	};
}

function getNextCursor(auctions: { id: string }[], limit: number | undefined) {
	const effectiveLimit = limit ?? DEFAULT_EXPLORE_LIMIT;
	if (auctions.length > effectiveLimit) {
		return auctions[effectiveLimit - 1]?.id || null;
	}
	return null;
}

export async function getExploreAuctions(
	db: DbClient,
	query: ExploreQueryType,
	exploreAuctionsCache: CacheOf<"exploreAuctions">,
): Promise<Omit<ExploreAuctionsResponse, "serverNow">> {
	const { filter = "all", limit, cursor } = query;

	if (limit === DEFAULT_EXPLORE_LIMIT && !cursor) {
		return exploreAuctionsCache.get(filter, {
			load: () => loadExploreAuctions(db, { filter }),
		});
	}

	return loadExploreAuctions(db, { filter, limit, cursor });
}
