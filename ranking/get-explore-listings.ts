/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 *
 * Left out of this folder:
 * - EXPLORE_RANKING_ENABLED_KEY, EXPLORE_FEED_SERVING_ENABLED_KEY,
 *   EXPLORE_RANK_EPOCH_KEY: the kill switch, the feed-path switch and the
 *   epoch counter the worker sets.
 * - loadSortedExploreListings: the buyer-chosen sorts (price, ending soon),
 *   which skip ranking.
 * Everything else is plumbing: filters, listing select and shape, database,
 *   cache, Sentry, logging.
 */

import type {
	CacheOf,
	ExploreSnapshot,
	ExploreSnapshotEntry,
} from "@nolie/cache";
import {
	applyDiversity,
	compareForSnapshot,
	DEFAULT_RANKING_CONFIG,
	EXPLORE_FEED_SERVING_ENABLED_KEY,
	EXPLORE_RANK_EPOCH_KEY,
	EXPLORE_RANKING_ENABLED_KEY,
	effectivePriceUSD,
} from "@nolie/core/explore";
import { type DbClient, ListingStatus, type Prisma } from "@nolie/db";
import {
	DEFAULT_EXPLORE_LIMIT,
	type ExploreForm,
	type ExploreListingSummary,
	type ExploreQueryType,
} from "@nolie/schemas/explore";
import { logger } from "../../logger.js";
import { queryListings } from "../listings/query.js";
import { reportError } from "../observability/sentry/report.js";
import { loadMaterializedExploreListings } from "./feed-serve.js";
import {
	type ExploreFilters,
	entryMatchesFilters,
	isRawFields,
	isSlabFields,
} from "./filters.js";
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
	/**
	 * Originating feed query id. Set by the ranked path so the emitted
	 * impression carries the SAME id the client echoes on a later action —
	 * the join key. Omitted by legacy/sort, where the emit falls back to the
	 * per-request id (those paths don't carry a stable cross-page id).
	 */
	queryId?: string;
}

interface PageSlice {
	listings: ExploreListingSummary[];
	nextCursor: string | null;
	impressions: ExploreImpression[];
}

export interface LoadExploreListingsResult extends PageSlice {
	/**
	 * The query id this page is attributed under — the value the route echoes
	 * back to the client, which then stamps it on every downstream action.
	 * The ranked path carries it across pages via the cursor so all pages of
	 * one scroll share it (otherwise page 2+ impressions and their actions
	 * land under different ids and never join). Legacy/sort use the request id.
	 */
	queryId: string;
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
 * pushdown via the existing `(sortPriority, rankScore DESC, id)` index — an
 * index range scan with heap fetches (the SELECT pulls non-indexed columns),
 * bounded by this limit rather than catalog size.
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
): Promise<PageSlice> {
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
): Promise<PageSlice> {
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
	/**
	 * Originating feed query id, minted on page 0 and carried forward on every
	 * page so all pages of one scroll share it. Optional only for backward
	 * compatibility: cursors minted before this shipped lack `q` and decode to
	 * `undefined`, falling back to the per-request id (the old behavior) for
	 * that one continuation — no crash, self-heals on the next fresh page 0.
	 */
	q?: string;
	/**
	 * Category filter the sublist was frozen under (NL-349). Absent on the
	 * "All" feed; carried forward so every page of a category scroll filters
	 * the same frozen list (and `o` indexes into that filtered sublist).
	 */
	c?: string;
	/**
	 * Price-band + item-type filters the sublist was frozen under (NL-383).
	 * Same carry-forward role as `c`: `o` indexes into the filtered sublist, so
	 * the bounds and form must travel with the cursor or page 2+ would re-slice
	 * a differently-sized list. Absent when the filter is off. `mn`/`mx` =
	 * min/max price, `fm` = item form ("slab" | "raw").
	 */
	mn?: number;
	mx?: number;
	fm?: ExploreForm;
}

function encodeCursor(c: ExploreCursor): string {
	return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): ExploreCursor | null {
	try {
		const c = JSON.parse(Buffer.from(raw, "base64url").toString());
		if (typeof c?.e === "number" && typeof c?.o === "number") {
			return {
				e: c.e,
				o: c.o,
				q: typeof c?.q === "string" ? c.q : undefined,
				c: typeof c?.c === "string" ? c.c : undefined,
				mn: typeof c?.mn === "number" ? c.mn : undefined,
				mx: typeof c?.mx === "number" ? c.mx : undefined,
				fm: c?.fm === "slab" || c?.fm === "raw" ? c.fm : undefined,
			};
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

/**
 * The ranked-candidate core shared by every "first N of explore" surface: the
 * candidate query (the covering index `sortPriority, rankScore DESC, id`), the
 * §12 `compareForSnapshot` re-order, and the global per-seller diversity cap.
 * Returns the FULL ordered id list (callers slice to their own depth) plus the
 * candidate count for logging.
 *
 * Extracted so the explore snapshot and the Klaviyo trending feed (NL-353) rank
 * from the IDENTICAL logic and cannot drift — the same "two surfaces MUST agree
 * byte-for-byte" invariant `compareForSnapshot` is documented under. A consumer
 * that needs a different *eligibility* set (e.g. the feed wants fixed-price only)
 * filters at hydration, not here, so the ordering stays shared.
 *
 * The feed is the diversity-spaced rankScore order — nothing recomposes it
 * after `applyDiversity`. The v4 slot policy (anchors / hourly rotation / fresh
 * slots / window-shopper eviction) was removed: against the v5 score its
 * engagement-gated anchor pool inverted the feed, pinning old high-engagement
 * cards above higher-scored fresh ones and reshuffling the same faces every
 * hour. The score now does the surfacing and recency provides the churn; the
 * per-seller sliding-window cap lives entirely in `applyDiversity`.
 */
export async function selectRankedCandidateIds(
	db: DbClient,
	candidateLimit: number,
): Promise<{
	orderedIds: string[];
	candidateCount: number;
	/**
	 * id → categoryId for the candidate set (NL-349). The snapshot build zips
	 * this onto the ordered ids so the category filter is an in-memory pass.
	 * The Klaviyo trending consumer ignores it (id-only), so it stays free.
	 */
	categoryById: Map<string, string | null>;
}> {
	const rows = await db.listing.findMany({
		where: buildExploreWhere(),
		select: {
			id: true,
			sellerProfileId: true,
			title: true,
			sortPriority: true,
			sortTimeMs: true,
			rankScore: true,
			categoryId: true,
		},
		orderBy: [{ sortPriority: "asc" }, { rankScore: "desc" }, { id: "asc" }],
		take: candidateLimit,
	});
	rows.sort(compareForSnapshot);
	const orderedIds = applyDiversity(rows, DEFAULT_RANKING_CONFIG);

	return {
		orderedIds,
		candidateCount: rows.length,
		categoryById: new Map(rows.map((r) => [r.id, r.categoryId ?? null])),
	};
}

interface SnapshotEntryMeta {
	priceUSD: number | null;
	isSlab: boolean;
	isRaw: boolean;
}

/**
 * Hydrates the price + item-type facets for the snapshot's top-`depth` ids
 * (NL-383). Kept OUT of `selectRankedCandidateIds` so the shared ranker (also
 * driving Klaviyo trending) never grows a facet dependency it doesn't use — one
 * bounded `IN` read over the ≤2000 frozen ids, run once per snapshot build
 * (≤60s cache TTL), is cheaper than the drift risk of touching the ranker.
 * Effective price reuses `effectivePriceUSD` (fixed price, or starting bid for
 * auctions) so the in-memory band filter agrees with the price sort.
 */
async function loadSnapshotEntryMeta(
	db: DbClient,
	ids: string[],
): Promise<Map<string, SnapshotEntryMeta>> {
	if (ids.length === 0) return new Map();
	const rows = await db.listing.findMany({
		where: { id: { in: ids } },
		select: {
			id: true,
			listingType: true,
			price: true,
			startingBid: true,
			grader: true,
			certNumber: true,
			condition: true,
		},
	});
	return new Map(
		rows.map((r) => [
			r.id,
			{
				priceUSD: effectivePriceUSD(r),
				isSlab: isSlabFields(r),
				isRaw: isRawFields(r),
			},
		]),
	);
}

async function buildSnapshotEntries(
	db: DbClient,
	rankEpoch: number,
): Promise<ExploreSnapshotEntry[]> {
	const start = Date.now();
	const { orderedIds, candidateCount, categoryById } =
		await selectRankedCandidateIds(db, EXPLORE_CANDIDATE_LIMIT);
	const slicedIds = orderedIds.slice(0, EXPLORE_SNAPSHOT_DEPTH);
	const metaById = await loadSnapshotEntryMeta(db, slicedIds);
	const entries = slicedIds.map((id) => {
		const meta = metaById.get(id);
		return {
			id,
			categoryId: categoryById.get(id) ?? null,
			priceUSD: meta?.priceUSD ?? null,
			isSlab: meta?.isSlab ?? false,
			isRaw: meta?.isRaw ?? false,
		};
	});

	const log: SnapshotBuildLog = {
		candidateCount,
		keptCount: entries.length,
		rankEpoch,
		buildMs: Date.now() - start,
	};
	logger.info(
		{ event: "explore_snapshot_build", ...log },
		"explore snapshot built",
	);
	return entries;
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
	queryId: string,
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
				queryId,
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
	requestQueryId: string,
): Promise<LoadExploreListingsResult> {
	const limit = query.limit ?? DEFAULT_EXPLORE_LIMIT;
	const parsed = query.cursor ? decodeCursor(query.cursor) : null;
	const offset = parsed?.o ?? 0;
	// Page 0 mints the feed query id (this request's id); every later page
	// recovers it from the cursor. So all pages of one scroll — and the actions
	// taken on them — attribute under one id and join cleanly.
	const queryId = parsed?.q ?? requestQueryId;
	// Category the sublist is frozen under: minted from the request on page 0,
	// recovered from the cursor on every later page so a category scroll keeps
	// filtering the same frozen list even if the request param drifts.
	const category = parsed?.c ?? query.category;
	// Price + item-type filters the sublist is frozen under (NL-383). Same
	// cursor-recovery as `category` so every page of a filtered scroll narrows
	// the same frozen list; `?? query` self-heals pre-NL-383 cursors.
	const filters: ExploreFilters = {
		minPrice: parsed?.mn ?? query.minPrice,
		maxPrice: parsed?.mx ?? query.maxPrice,
		form: parsed?.fm ?? query.form,
	};

	const loadSnapshot = (epoch: number) =>
		snapshotCache.get(`${epoch}`, {
			load: async () => ({ entries: await buildSnapshotEntries(db, epoch) }),
		});

	// Continuing a scroll whose epoch has since rolled: prefer the snapshot
	// the cursor was minted under so the frozen order stays stable. If it
	// expired, fall forward to the current epoch and skip ahead by the offset
	// (rare boundary dup — the documented industry tradeoff, §8).
	let effectiveEpoch = currentEpoch;
	let frozen: ExploreSnapshot | null = null;
	if (parsed && parsed.e !== currentEpoch) {
		const stable = await snapshotCache.get(`${parsed.e}`);
		if (stable) {
			frozen = stable;
			effectiveEpoch = parsed.e;
		}
	}
	const snap = frozen ?? (await loadSnapshot(currentEpoch));

	// Buyer-facing filters over one global snapshot, applied in memory before
	// the page slice so `offset` + rank positions stay exact (NL-349 category,
	// NL-383 price + item type). No-filter keeps the full frozen list. Untagged
	// rows (categoryId null) match no category and surface only in "All";
	// unpriced rows fail any active price bound.
	const entries = snap.entries.filter(
		(e) =>
			(category ? e.categoryId === category : true) &&
			entryMatchesFilters(e, filters),
	);

	const window = entries.slice(offset, offset + limit).map((e) => e.id);
	const { listings, impressions } = await hydrateWindow(
		db,
		window,
		offset,
		queryId,
	);
	const nextOffset = offset + limit;
	const nextCursor =
		nextOffset < entries.length
			? encodeCursor({
					e: effectiveEpoch,
					o: nextOffset,
					q: queryId,
					...(category ? { c: category } : {}),
					...(filters.minPrice != null ? { mn: filters.minPrice } : {}),
					...(filters.maxPrice != null ? { mx: filters.maxPrice } : {}),
					...(filters.form ? { fm: filters.form } : {}),
				})
			: null;

	return { listings, nextCursor, impressions, queryId };
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
	/**
	 * The request's per-request id (`request.queryId`). On page 0 it becomes
	 * the feed query id minted into the cursor; on later pages it's only a
	 * fallback (the cursor carries the real one). Legacy/sort use it directly.
	 */
	queryId: string;
	caches: {
		exploreListings: CacheOf<"exploreListings">;
		exploreSnapshot: CacheOf<"exploreSnapshot">;
	};
	redis: ExploreRedis;
	/**
	 * Per-request impression emit hook. Invoked once after the page slice is
	 * built, with one entry per returned listing. Callback owns the surface
	 * and rank epoch, the lib owns the rank position + (ranked path) query id.
	 * Skipped on legacy / kill-switch paths (no meaningful rank position).
	 */
	onImpressions?: (impressions: ExploreImpression[]) => void;
}

export async function getExploreListings(
	input: GetExploreListingsInput,
): Promise<LoadExploreListingsResult> {
	const { db, query, queryId, caches, redis, onImpressions } = input;

	// Sort modes bypass the ranking + caching system entirely. Opt-in feature,
	// low traffic; forking the snapshot cache per sort would blow memory. Its
	// impressions don't carry a cross-page query id (integer-offset cursor), so
	// they fall back to the request id at emit time — acceptable for an opt-in.
	if (query.sort && query.sort !== "featured") {
		const result = await loadSortedExploreListings(db, query);
		if (onImpressions && result.impressions.length > 0) {
			onImpressions(result.impressions);
		}
		return { ...result, queryId };
	}

	// Kill switch + rank epoch in one round trip, not two. Fail-safe (§10):
	// ranked serves ONLY on an explicit "1"; a missing key, "0", or a Redis
	// read error all fall back to legacy, so a fresh deploy, the pre-score
	// window, a failed backfill, or Redis being down can never serve a
	// half-ranked feed. The worker self-enables via SET NX after the first
	// successful refresh; humans only ever set "0" to disable.
	let enabledRaw: string | null | undefined;
	let epochRaw: string | null | undefined;
	// NL-384 serving-path flag, read in the SAME round trip — chooses between
	// the materialized `feed_entry` keyset path and the in-memory snapshot path
	// once ranking is enabled. Fail-safe to the snapshot path on anything but "1".
	let feedServingRaw: string | null | undefined;
	try {
		[enabledRaw, epochRaw, feedServingRaw] = await redis.mget(
			EXPLORE_RANKING_ENABLED_KEY,
			EXPLORE_RANK_EPOCH_KEY,
			EXPLORE_FEED_SERVING_ENABLED_KEY,
		);
	} catch {
		return {
			...(await legacyGetExploreListings(db, query, caches.exploreListings)),
			queryId,
		};
	}

	if (enabledRaw !== "1") {
		return {
			...(await legacyGetExploreListings(db, query, caches.exploreListings)),
			queryId,
		};
	}
	// Defensive degrade: the switch read above is fail-safe, but the ranked
	// path itself must never 500 /explore on an unforeseen data edge. A throw
	// here serves exactly today's feed and pages us, instead of breaking the
	// page until a human with prod-network Redis access can set "0" (§10).
	try {
		// NL-384 three-tier serve: when the serving flag is on, page the
		// materialized `feed_entry` table (SQL filter-then-rank, no cliff). On any
		// error fall THROUGH to the snapshot path below — which itself falls back
		// to legacy in the outer catch — so the new path can never harden a
		// regression into a 500.
		if (feedServingRaw === "1") {
			try {
				const result = await loadMaterializedExploreListings(
					db,
					query,
					parseEpoch(epochRaw),
					queryId,
				);
				// `null` ⇒ this epoch isn't materialized yet (the pre-first-tick
				// window, or a worker materialize outage). Fall through to the
				// snapshot path WITHOUT a Sentry error — it's an expected,
				// self-healing state, not a fault. A genuine throw is the fault and
				// is reported below.
				if (result) {
					if (onImpressions && result.impressions.length > 0) {
						onImpressions(result.impressions);
					}
					return result;
				}
			} catch (err) {
				reportError(err, { operation: "getExploreListings.feedEntry" });
				logger.error(
					{ err, event: "explore_feed_entry_fallback" },
					"feed_entry serving path threw; serving snapshot",
				);
			}
		}

		const result = await loadRankedExploreListings(
			db,
			query,
			caches.exploreSnapshot,
			parseEpoch(epochRaw),
			queryId,
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
		return {
			...(await legacyGetExploreListings(db, query, caches.exploreListings)),
			queryId,
		};
	}
}
