/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 *
 * Left out of this folder:
 * - priceFilterSql, formFilterSql: the buyer's price band and raw-or-graded
 *   filter, as SQL.
 * Everything else is plumbing: listing select and shape, database.
 */

import { type DbClient, Prisma } from "@nolie/db";
import {
	DEFAULT_EXPLORE_LIMIT,
	type ExploreForm,
	type ExploreListingSummary,
	type ExploreQueryType,
} from "@nolie/schemas/explore";
import { queryListings } from "../listings/query.js";
import {
	type ExploreFilters,
	formFilterSql,
	priceFilterSql,
} from "./filters.js";
import type {
	ExploreImpression,
	LoadExploreListingsResult,
} from "./get-explore-listings.js";
import { exploreListingSelect } from "./select.js";
import { toExploreListingSummary } from "./transform.js";

// ---------------------------------------------------------------------------
// Materialized-feed serving path (NL-384) — keyset over `feed_entry` with
// SQL filter-then-rank. Replaces the in-memory snapshot path's filter-then-
// truncate (the cliff): filters live in the WHERE, evaluated before LIMIT, so
// a selective filter can never under-return matches ranked past the old top-K.
// ---------------------------------------------------------------------------

/**
 * Keyset cursor for the materialized path. Deliberately carries NO `o` (the
 * snapshot path's integer offset) so the two cursor shapes are mutually
 * exclusive on decode: a snapshot cursor reaching this path lacks `p`/`s` and
 * decodes to null (→ fresh page), and a materialized cursor reaching the
 * snapshot path lacks `o` and decodes to null there too. A mid-scroll flag
 * flip in either direction self-heals to page 0 instead of 500-ing.
 */
interface FeedCursor {
	/** rankEpoch the scroll is pinned to (the `feed_entry.epoch` it pages). */
	e: number;
	/**
	 * Last `feed_entry.position` served. The keyset bound: the next page is
	 * `position > p`. `position` is unique within `(surface, epoch)` (it's in
	 * the PK), so a bare `>` is exact — no companion id tiebreaker needed.
	 */
	p: number;
	/**
	 * Running count of rows actually SERVED so far across the scroll (survivors
	 * of hydration, not raw feed rows). `rankPosition = s + survivingIndex`, so
	 * it stays the as-seen filtered slot (NL-352 IPS join key) — never the
	 * global `feed_entry.position`. Decoupled from `p` on purpose: `p` advances
	 * by raw feed position, `s` only by rows that survived the hydrate.
	 */
	s: number;
	/** Originating feed query id — minted on page 0, carried so every page (and
	 *  the actions taken on it) attribute under one id (NL-352). */
	q?: string;
	/** Category filter the scroll is pinned under (NL-349). */
	c?: string;
	/** Price-band + item-type filters the scroll is pinned under (NL-383). */
	mn?: number;
	mx?: number;
	fm?: ExploreForm;
}

function encodeCursor(c: FeedCursor): string {
	return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): FeedCursor | null {
	try {
		const c = JSON.parse(Buffer.from(raw, "base64url").toString());
		if (
			typeof c?.e === "number" &&
			typeof c?.p === "number" &&
			typeof c?.s === "number"
		) {
			return {
				e: c.e,
				p: c.p,
				s: c.s,
				q: typeof c?.q === "string" ? c.q : undefined,
				c: typeof c?.c === "string" ? c.c : undefined,
				mn: typeof c?.mn === "number" ? c.mn : undefined,
				mx: typeof c?.mx === "number" ? c.mx : undefined,
				fm: c?.fm === "slab" || c?.fm === "raw" ? c.fm : undefined,
			};
		}
	} catch {
		// Malformed / foreign cursor (e.g. a snapshot cursor after a flag flip)
		// ⇒ treat as a fresh first page rather than 500.
	}
	return null;
}

interface FeedRow {
	id: string;
	position: number;
}

/**
 * Serve one /explore page from the worker-materialized `feed_entry` order.
 *
 * One keyset SQL read joins `feed_entry → auction` and applies EVERY filter in
 * the WHERE (visibility from `buildExploreWhere`, plus the NL-349 category and
 * NL-383 price/form facets) before the LIMIT, then hydrates the page through
 * the shared `exploreListingSelect`. The `surface = … AND epoch = … AND
 * position > … ORDER BY position` predicate matches the `feed_entry` PK
 * `(surface, epoch, position)` → a range scan; the join is a nested loop on the
 * `auction` PK.
 *
 * The cursor pins the epoch, so a mid-scroll epoch roll leaves this reader on
 * the epoch they started (the worker's retain-one sweep keeps `epoch - 1`
 * resident). A scroll that outlives the retain window finds its epoch swept and
 * ends gracefully (empty page, null cursor) — far beyond any real session at a
 * ≤10-min roll cadence.
 *
 * Returns `null` to signal "this epoch isn't materialized — fall back" when a
 * FRESH page finds no `feed_entry` rows for the epoch at all. Serving auto-
 * enables after the worker's first good tick (it can't be flipped manually —
 * prod Redis is private), so the API must self-protect: if a later tick stops
 * materializing while the flag stays on, a `null` here routes the dispatcher to
 * the snapshot path instead of serving an empty /explore. An honest empty
 * filtered result (epoch IS materialized, the filter just matched nothing) is a
 * real empty page, NOT a `null`. Continuation pages never return `null` — an
 * empty continuation is the end of the scroll, and falling back mid-scroll
 * would restart at the snapshot's offset 0 and re-serve the whole feed.
 */
export async function loadMaterializedExploreListings(
	db: DbClient,
	query: ExploreQueryType,
	currentEpoch: number,
	requestQueryId: string,
): Promise<LoadExploreListingsResult | null> {
	const limit = query.limit ?? DEFAULT_EXPLORE_LIMIT;
	const parsed = query.cursor ? decodeCursor(query.cursor) : null;

	// Fresh page pins the current epoch (the worker materializes BEFORE rolling
	// the epoch key, so the current epoch is always fully written). `position`
	// is 0-based dense, so `> -1` starts from the top.
	const epoch = parsed?.e ?? currentEpoch;
	const cursorPos = parsed?.p ?? -1;
	const servedCount = parsed?.s ?? 0;
	// Page 0 mints the feed query id; later pages recover it from the cursor so
	// all pages of one scroll — and their actions — join under one id (NL-352).
	const queryId = parsed?.q ?? requestQueryId;
	// Filters pinned from the cursor on continuation pages, seeded from the
	// request on page 0 (`?? query` also self-heals a pre-filter cursor).
	const category = parsed?.c ?? query.category;
	const filters: ExploreFilters = {
		minPrice: parsed?.mn ?? query.minPrice,
		maxPrice: parsed?.mx ?? query.maxPrice,
		form: parsed?.fm ?? query.form,
	};

	const categoryFilter = category
		? Prisma.sql`AND a."categoryId" = ${category}`
		: Prisma.empty;
	const priceFilter = priceFilterSql(filters);
	const formFilter = formFilterSql(filters);

	// Visibility predicate mirrors `buildExploreWhere()` (hidden=false, eligible
	// status set, at least one asset) expressed as raw SQL — same fragments the
	// price-sort path uses. The `feed_entry` JOIN is the only structural
	// difference from that query.
	const rows = await db.$queryRaw<FeedRow[]>`
		SELECT fe."listingId" AS "id", fe."position" AS "position"
		FROM "feed_entry" fe
		JOIN "auction" a ON a."id" = fe."listingId"
		WHERE fe."surface" = 'explore'
			AND fe."epoch" = ${epoch}
			AND a."hidden" = false
			AND a."status"::text IN ('active', 'scheduled', 'pending', 'reserved', 'failed')
			AND EXISTS (SELECT 1 FROM "auction_asset" aa WHERE aa."auctionId" = a."id")
			${categoryFilter}
			${priceFilter}
			${formFilter}
			AND fe."position" > ${cursorPos}
		ORDER BY fe."position" ASC
		LIMIT ${limit + 1}
	`;

	const hasMore = rows.length > limit;
	const pageRows = rows.slice(0, limit);

	if (pageRows.length === 0) {
		// A continuation page that runs dry is the end of the scroll (or a swept
		// epoch) — terminate gracefully, never fall back mid-scroll.
		if (parsed) {
			return { listings: [], nextCursor: null, impressions: [], queryId };
		}
		// Fresh page with no rows: distinguish an unmaterialized epoch (→ null,
		// caller falls back to the snapshot path) from a filter that legitimately
		// matched nothing (→ honest empty page). The existence probe is a single
		// indexed LIMIT 1, run only in this rare zero-result case.
		const present = await db.$queryRaw<{ ok: number }[]>`
			SELECT 1 AS ok FROM "feed_entry"
			WHERE "surface" = 'explore' AND "epoch" = ${epoch}
			LIMIT 1
		`;
		if (present.length === 0) return null;
		return { listings: [], nextCursor: null, impressions: [], queryId };
	}

	const records = await queryListings(db, {
		where: { id: { in: pageRows.map((r) => r.id) } },
		select: exploreListingSelect,
		take: pageRows.length,
	});
	const byId = new Map(records.map((r) => [r.id, r]));

	// `rankPosition` runs off `servedCount`, advancing ONLY for rows that
	// survive hydration — a row deleted in the gap between the feed read and the
	// hydrate read drops from the page and the next surviving row inherits its
	// slot, exactly like the snapshot path's `hydrateWindow`. The keyset
	// position (`p`) advances independently by raw feed position.
	const listings: ExploreListingSummary[] = [];
	const impressions: ExploreImpression[] = [];
	let served = servedCount;
	for (const row of pageRows) {
		const record = byId.get(row.id);
		if (!record) continue;
		served += 1;
		listings.push(toExploreListingSummary(record, served));
		impressions.push({
			listingId: record.id,
			sellerId: record.sellerProfileId,
			rankPosition: served,
			queryId,
		});
	}

	// Keyset continues after the LAST feed row on this page (not the last
	// survivor) so a hydrate drop never re-serves the next row. `s` carries the
	// survivor count forward for the next page's `rankPosition`.
	const lastPos = pageRows[pageRows.length - 1]?.position ?? cursorPos;
	const nextCursor = hasMore
		? encodeCursor({
				e: epoch,
				p: lastPos,
				s: served,
				q: queryId,
				...(category ? { c: category } : {}),
				...(filters.minPrice != null ? { mn: filters.minPrice } : {}),
				...(filters.maxPrice != null ? { mx: filters.maxPrice } : {}),
				...(filters.form ? { fm: filters.form } : {}),
			})
		: null;

	return { listings, nextCursor, impressions, queryId };
}
