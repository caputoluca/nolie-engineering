import type { CacheOf } from "@nolie/cache";
import { SortPriority } from "@nolie/core/auctions";
import {
	applyDiversity,
	DEFAULT_RANKING_CONFIG,
	type DiversityCandidate,
	EXPLORE_RANK_EPOCH_KEY,
	EXPLORE_RANKING_ENABLED_KEY,
} from "@nolie/core/explore";
import { type DbClient, ListingStatus, type Prisma } from "@nolie/db";
import {
	DEFAULT_EXPLORE_LIMIT,
	ExploreFilterSchema,
	type ExploreListingSummary,
	type ExploreQueryType,
} from "@nolie/schemas/explore";
import { logger } from "../../logger.js";
import { queryListings } from "../listings/query.js";
import {
	getSoldVisibilityCutoff,
	publicListingsOrClauses,
} from "../listings/statuses.js";
import { exploreListingSelect } from "./select.js";
import { toExploreListingSummary } from "./transform.js";

interface LoadExploreListingsResult {
	listings: ExploreListingSummary[];
	nextCursor: string | null;
}

/**
 * Structural Redis surface — just the one multi-get this module issues.
 * Kept minimal (not `typeof redis`) so the lib stays decoupled from
 * `@nolie/redis` and is trivially fake-able in tests.
 */
interface ExploreRedis {
	mget(...keys: string[]): Promise<(string | null)[]>;
}

/**
 * How deep the frozen snapshot goes. Scale-prep — at current volume the
 * eligible set is far smaller, so this is effectively "all of it". The
 * SQL-LIMIT pushdown of this bound is the documented scale escape hatch
 * (docs/explore-ranking.md §8/§9 [DEFER]); applied here as a post-sort slice.
 */
const EXPLORE_SNAPSHOT_DEPTH = 2000;

type ExploreFilter = ExploreQueryType["filter"];

/**
 * The eligible-rows filter for one /explore tab. Single source of truth shared
 * by the ranked snapshot build and the legacy fallback path so the two never
 * drift on visibility.
 */
function buildExploreWhere(filter: ExploreFilter): Prisma.ListingWhereInput {
	const where: Prisma.ListingWhereInput = {
		// exclude listings without thumbnails (e.g. load test artifacts)
		listingAssets: { some: {} },
		hidden: false,
	};
	if (filter === "live") {
		where.status = ListingStatus.active;
	} else if (filter === "ended") {
		// "ended" = recently-ended listings. Auction-won (closed +
		// winningAmount) obey the cutoff via soldAt; auction-closed without a
		// winner obeys the cutoff via endAt (UI labels these "Sold on endAt"
		// too). Payment-failed listings have no time gate.
		const cutoff = getSoldVisibilityCutoff();
		where.OR = [
			{ status: ListingStatus.failed },
			{
				status: ListingStatus.closed,
				winningAmount: { not: null },
				soldAt: { gte: cutoff },
			},
			{
				status: ListingStatus.closed,
				winningAmount: null,
				endAt: { gte: cutoff },
			},
		];
	} else {
		// `all` filter: public listings + sold/auction-won within the cutoff.
		// Explore historically also surfaces `pending` (mid-creation listings)
		// which the seller-profile path does not — append it here without
		// pushing the quirk into the shared helper.
		where.OR = [
			...publicListingsOrClauses(),
			{ status: ListingStatus.pending },
		];
	}
	return where;
}

// ---------------------------------------------------------------------------
// Legacy path (kill-switch fallback) — kept fully intact: legacy
// orderBy [sortPriority, sortTimeMs, id] + id-cursor + exploreListingsCache.
// ---------------------------------------------------------------------------

async function loadExploreListings(
	db: DbClient,
	query: ExploreQueryType,
): Promise<LoadExploreListingsResult> {
	const { filter = "all", cursor, limit = DEFAULT_EXPLORE_LIMIT } = query;
	const where = buildExploreWhere(filter);

	const listings = await queryListings(db, {
		where,
		select: exploreListingSelect,
		...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		take: limit + 1,
		orderBy: [{ sortPriority: "asc" }, { sortTimeMs: "asc" }, { id: "asc" }],
	});

	return {
		listings: listings.slice(0, limit).map(toExploreListingSummary),
		nextCursor: getLegacyNextCursor(listings, limit),
	};
}

function getLegacyNextCursor(
	listings: { id: string }[],
	limit: number | undefined,
) {
	const effectiveLimit = limit ?? DEFAULT_EXPLORE_LIMIT;
	if (listings.length > effectiveLimit) {
		return listings[effectiveLimit - 1]?.id || null;
	}
	return null;
}

async function legacyGetExploreListings(
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

// ---------------------------------------------------------------------------
// Ranked path — frozen-snapshot pagination + diversity (NL-284 §8/§9/§12).
// ---------------------------------------------------------------------------

interface ExploreCursor {
	/** rankEpoch the snapshot was minted under. */
	e: number;
	/** filter tab. */
	f: ExploreFilter;
	/** offset into the frozen ID array. */
	o: number;
}

function encodeCursor(c: ExploreCursor): string {
	return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): ExploreCursor | null {
	try {
		const c = JSON.parse(Buffer.from(raw, "base64url").toString());
		const f = ExploreFilterSchema.safeParse(c?.f);
		if (typeof c?.e === "number" && typeof c?.o === "number" && f.success) {
			return { e: c.e, f: f.data, o: c.o };
		}
	} catch {
		// Malformed/foreign cursor (e.g. a legacy id-cursor after a kill-switch
		// flip) ⇒ treat as a fresh first page rather than 500.
	}
	return null;
}

type SnapshotCandidate = DiversityCandidate & {
	sortPriority: number;
	sortTimeMs: bigint;
	rankScore: number;
};

/**
 * §12 ordering: live auctions (ACTIVE_AUCTION bucket) stay ending-soonest on
 * `sortTimeMs` so a near-closing auction can't be buried; every other bucket
 * orders by stored `rankScore` desc. `sortPriority` is always primary.
 */
function compareForSnapshot(
	a: SnapshotCandidate,
	b: SnapshotCandidate,
): number {
	if (a.sortPriority !== b.sortPriority) {
		return a.sortPriority - b.sortPriority;
	}
	if (a.sortPriority === SortPriority.ACTIVE_AUCTION) {
		if (a.sortTimeMs !== b.sortTimeMs) {
			return a.sortTimeMs < b.sortTimeMs ? -1 : 1;
		}
	} else if (a.rankScore !== b.rankScore) {
		return b.rankScore - a.rankScore;
	}
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface SnapshotBuildLog {
	filter: ExploreFilter;
	candidateCount: number;
	keptCount: number;
	rankEpoch: number;
	buildMs: number;
}

async function buildSnapshotIds(
	db: DbClient,
	filter: ExploreFilter,
	rankEpoch: number,
): Promise<string[]> {
	const start = Date.now();
	const rows = await db.listing.findMany({
		where: buildExploreWhere(filter),
		select: {
			id: true,
			sellerProfileId: true,
			title: true,
			sortPriority: true,
			sortTimeMs: true,
			rankScore: true,
		},
	});

	rows.sort(compareForSnapshot);
	const ordered = applyDiversity(rows, DEFAULT_RANKING_CONFIG);
	const ids = ordered.slice(0, EXPLORE_SNAPSHOT_DEPTH);

	const log: SnapshotBuildLog = {
		filter,
		candidateCount: rows.length,
		keptCount: ids.length,
		rankEpoch,
		buildMs: Date.now() - start,
	};
	logger.info(
		{ event: "explore_snapshot_build", ...log },
		"explore snapshot built",
	);
	return ids;
}

/** Hydrate a sliced ID window into ordered summaries (`IN` loses order). */
async function hydrateWindow(
	db: DbClient,
	window: string[],
): Promise<ExploreListingSummary[]> {
	if (window.length === 0) return [];
	const records = await queryListings(db, {
		where: { id: { in: window } },
		select: exploreListingSelect,
		take: window.length,
	});
	const byId = new Map(records.map((r) => [r.id, r]));
	const out: ExploreListingSummary[] = [];
	for (const id of window) {
		const record = byId.get(id);
		// A row hidden/deleted between snapshot build and hydrate just drops
		// from this page — accepted, documented tradeoff (don't backfill).
		if (record) out.push(toExploreListingSummary(record));
	}
	return out;
}

async function loadRankedExploreListings(
	db: DbClient,
	query: ExploreQueryType,
	snapshotCache: CacheOf<"exploreSnapshot">,
	currentEpoch: number,
): Promise<LoadExploreListingsResult> {
	const limit = query.limit ?? DEFAULT_EXPLORE_LIMIT;
	const parsed = query.cursor ? decodeCursor(query.cursor) : null;
	const filter: ExploreFilter = parsed?.f ?? query.filter ?? "all";
	const offset = parsed?.o ?? 0;

	const loadSnapshot = (epoch: number) =>
		snapshotCache.get(`${filter}:${epoch}`, {
			load: async () => ({ ids: await buildSnapshotIds(db, filter, epoch) }),
		});

	// Continuing a scroll whose epoch has since rolled: prefer the snapshot
	// the cursor was minted under so the frozen order stays stable. If it
	// expired, fall forward to the current epoch and skip ahead by the offset
	// (rare boundary dup — the documented industry tradeoff, §8).
	let effectiveEpoch = currentEpoch;
	let frozen: { ids: string[] } | null = null;
	if (parsed && parsed.e !== currentEpoch) {
		const stable = await snapshotCache.get(`${filter}:${parsed.e}`);
		if (stable) {
			frozen = stable;
			effectiveEpoch = parsed.e;
		}
	}
	const snap = frozen ?? (await loadSnapshot(currentEpoch));

	const window = snap.ids.slice(offset, offset + limit);
	const listings = await hydrateWindow(db, window);
	const nextOffset = offset + limit;
	const nextCursor =
		nextOffset < snap.ids.length
			? encodeCursor({ e: effectiveEpoch, f: filter, o: nextOffset })
			: null;

	return { listings, nextCursor };
}

// ---------------------------------------------------------------------------
// Dispatcher + kill switch.
// ---------------------------------------------------------------------------

function parseEpoch(raw: string | null | undefined): number {
	const parsed = raw == null ? 0 : Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

interface GetExploreListingsInput {
	db: DbClient;
	query: ExploreQueryType;
	caches: {
		exploreListings: CacheOf<"exploreListings">;
		exploreSnapshot: CacheOf<"exploreSnapshot">;
	};
	redis: ExploreRedis;
}

export async function getExploreListings(
	input: GetExploreListingsInput,
): Promise<LoadExploreListingsResult> {
	const { db, query, caches, redis } = input;

	// Kill switch + rank epoch in one round trip, not two. Fail-safe (§10):
	// ranked serves ONLY on an explicit "1"; a missing key, "0", or a Redis
	// read error all fall back to legacy, so a fresh deploy, the pre-score
	// window, a failed backfill, or Redis being down can never serve a
	// half-ranked feed. The worker self-enables via SET NX after the first
	// successful refresh; humans only ever set "0" to disable.
	let enabledRaw: string | null | undefined;
	let epochRaw: string | null | undefined;
	try {
		[enabledRaw, epochRaw] = await redis.mget(
			EXPLORE_RANKING_ENABLED_KEY,
			EXPLORE_RANK_EPOCH_KEY,
		);
	} catch {
		return legacyGetExploreListings(db, query, caches.exploreListings);
	}

	if (enabledRaw !== "1") {
		return legacyGetExploreListings(db, query, caches.exploreListings);
	}
	return loadRankedExploreListings(
		db,
		query,
		caches.exploreSnapshot,
		parseEpoch(epochRaw),
	);
}
