import type { CacheOf } from "@nolie/cache";
import {
	applyDiversity,
	compareForSnapshot,
	DEFAULT_RANKING_CONFIG,
	EXPLORE_RANK_EPOCH_KEY,
	EXPLORE_RANKING_ENABLED_KEY,
} from "@nolie/core/explore";
import { type DbClient, ListingStatus, type Prisma } from "@nolie/db";
import {
	DEFAULT_EXPLORE_LIMIT,
	type ExploreListingSummary,
	type ExploreQueryType,
} from "@nolie/schemas/explore";
import { logger } from "../../logger.js";
import { queryListings } from "../listings/query.js";
import { reportError } from "../observability/sentry/report.js";
import { exploreListingSelect } from "./select.js";
import { loadSortedExploreListings } from "./sort.js";
import { toExploreListingSummary } from "./transform.js";

/**
 * One impression row per listing returned to the request — `rankPosition` is
 * 1-indexed against the snapshot (`offset + i + 1` so page 2 starts at 13,
 * not 1). Emitted by the dispatcher via the optional `onImpressions` callback
 * on `GetExploreListingsInput`. Legacy / kill-switch path skips impressions
 * entirely (no meaningful rank position for an id-cursor sort).
 */
export interface ExploreImpression {
	listingId: string;
	sellerId: string;
	rankPosition: number;
}

interface LoadExploreListingsResult {
	listings: ExploreListingSummary[];
	nextCursor: string | null;
	impressions: ExploreImpression[];
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
 * eligible set is far smaller, so this is effectively "all of it". Applied
 * as a post-sort slice over the diversity-capped, JS-sorted candidate set.
 */
const EXPLORE_SNAPSHOT_DEPTH = 2000;

/**
 * Upper bound on the candidate set the snapshot is built from. SQL-LIMIT
 * pushdown via the existing `(sortPriority, rankScore DESC, id)` covering
 * index — index-only scan, sub-linear with catalog size.
 *
 * Sized comfortably above `EXPLORE_SNAPSHOT_DEPTH` so the per-seller
 * diversity demotion (rows pushed to a tail, not dropped — see
 * `applyDiversity`) has headroom before the snapshot runs short: a single
 * seller owning >60% of the candidate set still leaves enough diverse rows
 * to fill the 2000-row snapshot.
 *
 * The SQL ordering is a candidate filter, not the final order. The JS-side
 * `compareForSnapshot` re-orders the bounded set because ACTIVE_AUCTION rows
 * sort by `sortTimeMs` (ending soonest), which Prisma's `orderBy` can't
 * express conditionally on `sortPriority`. Holds as long as the count of
 * simultaneous live auctions stays below this limit (well under 1k even at
 * the 50k-catalog projection).
 */
const EXPLORE_CANDIDATE_LIMIT = 5000;

/**
 * The eligible-rows filter for /explore. Single source of truth shared by the
 * ranked snapshot build, the legacy fallback path, and the sort-mode path so
 * they never drift on visibility.
 *
 * The browse grid surfaces only ACTIVE inventory — listings a buyer could
 * actually act on. Sold / auction-closed are intentionally excluded; they
 * live in the dedicated "Recently sold" carousel instead. Keeping them out
 * of the grid removes the duplicate-card problem (same listing in both the
 * carousel and the grid) and keeps browse focused on "what can I buy now."
 *
 * Included statuses:
 *   - active     — live (buyable / biddable)
 *   - scheduled  — upcoming auctions
 *   - pending    — mid-creation (NoLie quirk; explore surfaces these)
 *   - reserved   — mid-checkout BIN, still showable until paid (10-min hold)
 *   - failed     — BIN payment failed, listing returns to available
 */
export function buildExploreWhere(): Prisma.ListingWhereInput {
	return {
		// exclude listings without thumbnails (e.g. load test artifacts)
		listingAssets: { some: {} },
		hidden: false,
		status: {
			in: [
				ListingStatus.active,
				ListingStatus.scheduled,
				ListingStatus.pending,
				ListingStatus.reserved,
				ListingStatus.failed,
			],
		},
	};
}

// ---------------------------------------------------------------------------
// Legacy path (kill-switch fallback) — kept fully intact: legacy
// orderBy [sortPriority, sortTimeMs, id] + id-cursor + exploreListingsCache.
// ---------------------------------------------------------------------------

type LegacyExploreQuery = Pick<ExploreQueryType, "cursor" | "limit">;

async function loadExploreListings(
	db: DbClient,
	query: LegacyExploreQuery,
): Promise<LoadExploreListingsResult> {
	const { cursor, limit = DEFAULT_EXPLORE_LIMIT } = query;

	const listings = await queryListings(db, {
		where: buildExploreWhere(),
		select: exploreListingSelect,
		...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		take: limit + 1,
		orderBy: [{ sortPriority: "asc" }, { sortTimeMs: "asc" }, { id: "asc" }],
	});

	return {
		// Legacy/kill-switch path has no ranker, so rankPosition is the slot
		// index in the id-cursor sort. 1-indexed.
		listings: listings
			.slice(0, limit)
			.map((record, i) => toExploreListingSummary(record, i + 1)),
		nextCursor: getLegacyNextCursor(listings, limit),
		// Legacy / kill-switch path: id-cursor sort has no meaningful rank
		// position to record. Impressions are skipped entirely; the dispatcher
		// will pass an empty array to the callback (effectively no emission).
		impressions: [],
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
	const { limit, cursor } = query;

	if (limit === DEFAULT_EXPLORE_LIMIT && !cursor) {
		// Cache schema predates impressions and intentionally doesn't carry them
		// — legacy path skips impression emission entirely (id-cursor sort, no
		// meaningful rank position). Strip on store, re-add empty on read.
		const cached = await exploreListingsCache.get("default", {
			load: async () => {
				const { listings, nextCursor } = await loadExploreListings(db, {});
				return { listings, nextCursor };
			},
		});
		return { ...cached, impressions: [] };
	}

	return loadExploreListings(db, { limit, cursor });
}

// ---------------------------------------------------------------------------
// Ranked path — frozen-snapshot pagination + diversity (NL-284 §8/§9/§12).
// ---------------------------------------------------------------------------

interface ExploreCursor {
	/** rankEpoch the snapshot was minted under. */
	e: number;
	/** offset into the frozen ID array. */
	o: number;
}

function encodeCursor(c: ExploreCursor): string {
	return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): ExploreCursor | null {
	try {
		const c = JSON.parse(Buffer.from(raw, "base64url").toString());
		if (typeof c?.e === "number" && typeof c?.o === "number") {
			return { e: c.e, o: c.o };
		}
	} catch {
		// Malformed/foreign cursor (e.g. a legacy id-cursor after a kill-switch
		// flip) ⇒ treat as a fresh first page rather than 500.
	}
	return null;
}

interface SnapshotBuildLog {
	candidateCount: number;
	keptCount: number;
	rankEpoch: number;
	buildMs: number;
}

async function buildSnapshotIds(
	db: DbClient,
	rankEpoch: number,
): Promise<string[]> {
	const start = Date.now();
	const rows = await db.listing.findMany({
		where: buildExploreWhere(),
		select: {
			id: true,
			sellerProfileId: true,
			title: true,
			sortPriority: true,
			sortTimeMs: true,
			rankScore: true,
		},
		orderBy: [{ sortPriority: "asc" }, { rankScore: "desc" }, { id: "asc" }],
		take: EXPLORE_CANDIDATE_LIMIT,
	});

	rows.sort(compareForSnapshot);
	const ordered = applyDiversity(rows, DEFAULT_RANKING_CONFIG);
	const ids = ordered.slice(0, EXPLORE_SNAPSHOT_DEPTH);

	const log: SnapshotBuildLog = {
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

interface HydratedWindow {
	listings: ExploreListingSummary[];
	impressions: ExploreImpression[];
}

/**
 * Hydrate a sliced ID window into ordered summaries (`IN` loses order) and
 * the parallel impression envelopes. `rankPosition` is the position the user
 * actually saw (post-drop): if a listing was hidden/deleted between snapshot
 * build and hydrate it drops from the page entirely and the next surviving
 * row inherits its slot. IPS-correct — an action joins back to the slot the
 * user clicked.
 */
async function hydrateWindow(
	db: DbClient,
	window: string[],
	offset: number,
): Promise<HydratedWindow> {
	if (window.length === 0) return { listings: [], impressions: [] };
	const records = await queryListings(db, {
		where: { id: { in: window } },
		select: exploreListingSelect,
		take: window.length,
	});
	const byId = new Map(records.map((r) => [r.id, r]));
	const listings: ExploreListingSummary[] = [];
	const impressions: ExploreImpression[] = [];
	let position = offset;
	for (const id of window) {
		const record = byId.get(id);
		if (record) {
			position += 1;
			listings.push(toExploreListingSummary(record, position));
			impressions.push({
				listingId: record.id,
				sellerId: record.sellerProfileId,
				rankPosition: position,
			});
		}
	}
	return { listings, impressions };
}

async function loadRankedExploreListings(
	db: DbClient,
	query: ExploreQueryType,
	snapshotCache: CacheOf<"exploreSnapshot">,
	currentEpoch: number,
): Promise<LoadExploreListingsResult> {
	const limit = query.limit ?? DEFAULT_EXPLORE_LIMIT;
	const parsed = query.cursor ? decodeCursor(query.cursor) : null;
	const offset = parsed?.o ?? 0;

	const loadSnapshot = (epoch: number) =>
		snapshotCache.get(`${epoch}`, {
			load: async () => ({ ids: await buildSnapshotIds(db, epoch) }),
		});

	// Continuing a scroll whose epoch has since rolled: prefer the snapshot
	// the cursor was minted under so the frozen order stays stable. If it
	// expired, fall forward to the current epoch and skip ahead by the offset
	// (rare boundary dup — the documented industry tradeoff, §8).
	let effectiveEpoch = currentEpoch;
	let frozen: { ids: string[] } | null = null;
	if (parsed && parsed.e !== currentEpoch) {
		const stable = await snapshotCache.get(`${parsed.e}`);
		if (stable) {
			frozen = stable;
			effectiveEpoch = parsed.e;
		}
	}
	const snap = frozen ?? (await loadSnapshot(currentEpoch));

	const window = snap.ids.slice(offset, offset + limit);
	const { listings, impressions } = await hydrateWindow(db, window, offset);
	const nextOffset = offset + limit;
	const nextCursor =
		nextOffset < snap.ids.length
			? encodeCursor({ e: effectiveEpoch, o: nextOffset })
			: null;

	return { listings, nextCursor, impressions };
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
	/**
	 * Per-request impression emit hook. Invoked once after the page slice is
	 * built, with one entry per returned listing. Callback owns the surface
	 * and rank epoch, the lib owns the rank position. Skipped on legacy /
	 * kill-switch / sort-mode paths (no meaningful rank position to record).
	 */
	onImpressions?: (impressions: ExploreImpression[]) => void;
}

export async function getExploreListings(
	input: GetExploreListingsInput,
): Promise<LoadExploreListingsResult> {
	const { db, query, caches, redis, onImpressions } = input;

	// Sort modes bypass the ranking + caching system entirely. Opt-in feature,
	// low traffic; forking the snapshot cache per sort would blow memory.
	if (query.sort && query.sort !== "featured") {
		const result = await loadSortedExploreListings(db, query);
		if (onImpressions && result.impressions.length > 0) {
			onImpressions(result.impressions);
		}
		return result;
	}

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
	// Defensive degrade: the switch read above is fail-safe, but the ranked
	// path itself must never 500 /explore on an unforeseen data edge. A throw
	// here serves exactly today's feed and pages us, instead of breaking the
	// page until a human with prod-network Redis access can set "0" (§10).
	try {
		const result = await loadRankedExploreListings(
			db,
			query,
			caches.exploreSnapshot,
			parseEpoch(epochRaw),
		);
		if (onImpressions && result.impressions.length > 0) {
			onImpressions(result.impressions);
		}
		return result;
	} catch (err) {
		reportError(err, { operation: "getExploreListings.ranked" });
		logger.error(
			{ err, event: "explore_ranked_fallback" },
			"ranked explore path threw; serving legacy",
		);
		return legacyGetExploreListings(db, query, caches.exploreListings);
	}
}
