import { DAY_MS, SOLD_VISIBILITY_DAYS } from "@nolie/core/constants/listings";
import { EngagementEventName } from "@nolie/core/engagement/catalog";
import {
	computeDemandMultiplier,
	computePriceMult,
	computeRankBaseScore,
	computeRankScore,
	DEFAULT_RANKING_CONFIG,
	EXPLORE_RANK_EPOCH_KEY,
	EXPLORE_RANKING_ENABLED_KEY,
	type MatchedToken,
	matchTokens,
	RANK_BASE_VERSION,
	TOKEN_BOOST_MIN,
	TOKEN_BOOST_VERSION,
	TOKEN_DICTIONARY,
} from "@nolie/core/explore";
import {
	computeReviewAvgShrunk,
	computeSellerTrust,
	normalizeRating,
} from "@nolie/core/seller-trust";
import { ListingStatus, Prisma } from "@nolie/db";
import type { WorkerContextBase } from "../context.js";
import { reportWarning } from "../observability/sentry/report.js";

const UPDATE_CHUNK = 500;

// View-demand aggregation window (explore-ranking-v3 PR2, §5.2). A flat 30d
// count, NOT time-decayed — demand here is "how many distinct people looked at
// / saved / carted this listing in the last month", and we want a month-old
// view to count the same as a day-old one (the recency term in the scorer is
// the sole owner of freshness). Mirrors preview-demand-ranking.ts.
const DEMAND_WINDOW_DAYS = 30;

// Intent weighting for the engagement composite (validated on the June 2026
// prod export, signed off by the founder — preview-demand-ranking.ts):
//   engagement = distinctViewers + SAVE_VIEWS·saveCount + CART_VIEWS·cartEvents
// A save / cart is worth far more than a view because it's a high-intent,
// position-resistant signal (a buyer doesn't bookmark something they clicked
// off the top of the feed). Tunable post-deploy via ENABLE_*_SIGNAL kill
// switches + these weights.
const SAVE_VIEWS = 15;
const CART_VIEWS = 25;

// Subject-pooling pseudo-count: a listing trusts its OWN engagement once it
// has ≫ POOL_M; below that it's pulled toward its subject's (character/set)
// mean engagement, so a fresh listing of a popular character inherits that
// character's demand. `w = e / (e + POOL_M)`.
const POOL_M = 30;

// Subject token kinds that drive demand pooling. Characters + sets only —
// rarity is deliberately excluded (a "psa_10" pool would lump unrelated cards).
const SUBJECT_KINDS = new Set(["character", "set"]);

// Bot filter (audit-engagement-attribution.sql BLOCK 7): an anonymous_id that
// viewed more than this many DISTINCT listings in the window is a scraper, not
// a shopper. Its `listing_viewed` events are excluded from the distinct-viewer
// count so a crawler can't manufacture demand.
const BOT_BREADTH_THRESHOLD = 150;

// Cross above this in any single refresh tick and we warn — by then the
// tokenize-on-fly cost is in the danger zone and the §6.2 "denorm titleTokens
// onto Listing" trigger is in play (see refresh.job comment block below for
// the trigger list). 200ms is "act now"; 100ms would give earlier lead time
// but produces noisier alarms at our current ~10ms baseline.
const TOKENIZE_WARN_THRESHOLD_MS = 200;

// Statuses that are explore-visible regardless of age (publicListingsOrClauses
// + pending). OR'd with "written within the sold-visibility cutoff" this is a
// provable superset of every explore-visible row, while old terminal rows
// (closed/sold/cancelled with no recent write) fall out — so the scan stays
// bounded on a forever-growing table. soldAt/endAt >= cutoff ⟹ updatedAt >=
// that ⟹ any explore-visible terminal row is still in this set.
const ALWAYS_RANKABLE_STATUSES = [
	ListingStatus.active,
	ListingStatus.scheduled,
	ListingStatus.pending,
	ListingStatus.failed,
	ListingStatus.reserved,
] as const;

// The explore-served status set (identical to `buildExploreWhere`'s statuses in
// apps/api). Demand is min-max normalized over ONLY these rows: the rankable
// scan also drags in recently-updated terminal rows (sold/closed/cancelled via
// the cutoff) that never serve on /explore, and a sold listing is exactly the
// high-demand case — including it would stretch the range and compress every
// served listing toward neutral (explore-ranking-v3 PR2).
const SERVED_STATUSES = new Set<string>(ALWAYS_RANKABLE_STATUSES);

interface SellerTrustInputRow {
	sellerProfileId: string;
	reviewCount: number;
	reviewAverage: number | null;
	globalAverageRating: number | null;
	hasFirstEdition: boolean;
}

interface SellerTrustResult {
	/** sellerProfileId → composed `sellerTrust` in [0,1], for the listing pass. */
	trustMap: Map<string, number>;
	/** Number of `seller_profile` rows the bulk UPDATE actually wrote. */
	sellersTrustUpdated: number;
}

/**
 * Recompute seller-trust state for every seller, in one read + one bulk
 * write (NL-310 commit #6 — docs §7.1, §7.2). Returns the per-listing
 * `sellerTrust` map the scoring pass needs AND persists the underlying
 * `reviewCount` + `reviewAvgShrunk` columns so the values stay queryable
 * from elsewhere (and survive worker restarts before the next tick).
 *
 * One CTE-shaped read gathers all inputs in a single query:
 *   - LEFT JOIN per-seller `Review` aggregate (count + raw avg) so
 *     zero-review sellers still get a row — they should converge on the
 *     live global mean, not the migration-default 0.5.
 *   - Scalar subquery for the global `AVG(rating)` (broadcast across rows
 *     at zero per-row cost; Postgres executes the subquery once).
 *   - `EXISTS` against `seller_program_membership` with the same active-
 *     window predicate as the `first_edition` CTE in
 *     `users/profile-data.ts` — keeps badge resolution consistent between
 *     the profile page and the ranker.
 *
 * Both `reviewAvgShrunk` and the composed `sellerTrust` are computed in
 * memory from the same row, so the trust map and the seller_profile
 * updates can't drift, and we never re-read what we just wrote (the
 * previous "two helpers in sequence" shape did exactly that).
 *
 * Idempotent: re-derives from current `Review` totals every tick — no
 * incremental running sums to drift on review edits/deletes. The
 * `IS DISTINCT FROM` write guard keeps writes negligible when nothing
 * actually moved.
 *
 * Industry pattern note: no write-time hook on `Review` create/update.
 * `reviewAvgShrunk` is read exclusively by this worker — a write hook
 * would write a value the next tick overwrites within ≤10 min, paying
 * extra DB calls per review for zero observable freshness. Yelp / Etsy
 * ship ranking aggregates through batch pipelines for the same reason;
 * Rails `counter_cache` is for user-facing live counts, not this case.
 */
async function refreshSellerTrust(
	ctx: WorkerContextBase,
): Promise<SellerTrustResult> {
	const { prisma } = ctx;

	const rows = await prisma.$queryRaw<SellerTrustInputRow[]>`
		WITH global_review AS (
			SELECT AVG("rating")::float AS "avg" FROM "review"
		),
		per_seller_review AS (
			SELECT "sellerProfileId",
			       COUNT(*)::int        AS "count",
			       AVG("rating")::float AS "average"
			FROM "review"
			GROUP BY "sellerProfileId"
		)
		SELECT sp."id"                              AS "sellerProfileId",
		       COALESCE(psr."count", 0)::int        AS "reviewCount",
		       psr."average"                        AS "reviewAverage",
		       (SELECT "avg" FROM global_review)    AS "globalAverageRating",
		       EXISTS(
		         SELECT 1
		         FROM "seller_program_membership" m
		         WHERE m."sellerProfileId" = sp."id"
		           AND m."program"::text = 'first_edition'
		           AND m."revokedAt" IS NULL
		           AND (m."expiresAt" IS NULL OR m."expiresAt" > now())
		       )                                    AS "hasFirstEdition"
		FROM "seller_profile" sp
		LEFT JOIN per_seller_review psr
		       ON psr."sellerProfileId" = sp."id"
	`;

	if (rows.length === 0) {
		return { trustMap: new Map(), sellersTrustUpdated: 0 };
	}

	// All rows carry the same `globalAverageRating` (scalar subquery
	// broadcast); read it once and normalize via the @nolie/core helper that
	// also owns the cold-start fallback.
	const globalMeanRating = normalizeRating(
		rows[0]?.globalAverageRating ?? null,
	);

	const trustMap = new Map<string, number>();
	const updates: { id: string; count: number; shrunk: number }[] = [];

	for (const r of rows) {
		const reviewAvgShrunk = computeReviewAvgShrunk({
			reviewCount: r.reviewCount,
			reviewAverage: r.reviewAverage,
			globalMeanRating,
		});
		trustMap.set(
			r.sellerProfileId,
			computeSellerTrust({
				reviewAvgShrunk,
				hasFirstEditionBadge: r.hasFirstEdition,
			}),
		);
		updates.push({
			id: r.sellerProfileId,
			count: r.reviewCount,
			shrunk: reviewAvgShrunk,
		});
	}

	let sellersTrustUpdated = 0;
	for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
		const chunk = updates.slice(i, i + UPDATE_CHUNK);
		const values = Prisma.join(
			chunk.map(
				(u) =>
					Prisma.sql`(${u.id}, ${u.count}::int, ${u.shrunk}::double precision)`,
			),
		);
		sellersTrustUpdated += await prisma.$executeRaw`
			UPDATE "seller_profile" AS sp
			SET "reviewCount" = v.review_count,
				"reviewAvgShrunk" = v.review_avg_shrunk
			FROM (VALUES ${values}) AS v(id, review_count, review_avg_shrunk)
			WHERE sp.id = v.id
				AND (sp."reviewCount" IS DISTINCT FROM v.review_count
					OR sp."reviewAvgShrunk" IS DISTINCT FROM v.review_avg_shrunk)
		`;
	}

	return { trustMap, sellersTrustUpdated };
}

interface RankableListing {
	id: string;
	title: string;
	description: string | null;
	createdAt: Date;
	sellerProfileId: string;
	rankBaseScore: number;
	rankBaseVersion: number;
	/** Fixed-price asking price (Decimal(10,2) dollars). Null for auctions
	 * or unpriced fixed-price listings. */
	price: Prisma.Decimal | null;
	/** Auction starting bid (Decimal(10,2) dollars — same column shape as
	 * `price`, despite the historical "bid" naming). Null for fixed-price
	 * listings. */
	startingBid: Prisma.Decimal | null;
	listingType: string;
	/** Denormalized save count, maintained inline by the API on save/unsave
	 * (NL-239). Worker reads only — unlike `addToCartCount`, which the
	 * worker is the sole writer of. */
	saveCount: number;
	/** Denormalized hero-image dimensions, written by the `image-quality` score
	 * job (explore-ranking-v3 PR1). Null until the hero is scored or on a probe
	 * failure — the resolution demerit fails open to 0 on null. */
	heroWidth: number | null;
	heroHeight: number | null;
	/** Listing status. The scan pulls in recently-updated terminal rows
	 * (sold/closed via the cutoff) that never serve on /explore; `status` lets
	 * demand normalization restrict its min-max range to the served set
	 * (`SERVED_STATUSES`) so those rows can't stretch it (v3 PR2). */
	status: string;
}

/**
 * Effective dollar price for ranking purposes. Fixed-price uses `price`;
 * auctions use `startingBid`. Both columns are `Decimal(10, 2)` dollars
 * (despite "Bid" naming, `startingBid` is NOT cents). Returns null when
 * neither is set — those listings get a neutral priceMult.
 *
 * Auctions use the starting bid as a stand-in for "asking price" because
 * the live winning amount isn't known at refresh time and would lag as
 * bids accrue anyway. ~96% of listings on `/explore` are fixed-price (per
 * the doc), so the auction approximation is a minor edge.
 */
function effectivePriceUSD(l: {
	listingType: string;
	price: Prisma.Decimal | null;
	startingBid: Prisma.Decimal | null;
}): number | null {
	const raw =
		l.listingType === "fixed_price"
			? l.price
			: l.listingType === "auction"
				? l.startingBid
				: null;
	if (raw === null) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Median of a numeric array. Assumes the caller has already filtered out
 * non-finite / non-positive values. Sorts in place to avoid an allocation
 * — caller passes a one-shot copy each time.
 */
function median(values: number[]): number {
	values.sort((a, b) => a - b);
	const n = values.length;
	const mid = Math.floor(n / 2);
	if (n % 2 === 1) return values[mid] as number;
	return ((values[mid - 1] as number) + (values[mid] as number)) / 2;
}

/**
 * Minimum number of priced listings in a token bucket before we trust the
 * median enough to use it as a sigmoid reference. Below this we fall back
 * to the overall catalog median — keeps a 2-listing token from anchoring
 * the sigmoid on whatever those two sellers happened to price at.
 */
const PRICE_MEDIAN_MIN_BUCKET = 3;

interface DemandResult {
	/** listingId → matched dictionary tokens. Tokenized once here and reused
	 * by the scoring pass — never tokenize the same title twice per tick. */
	matchedByListing: Map<string, MatchedToken[]>;
	/** listingId → min-max-normalized view-demand in [0,1]. Empty when the
	 * `ENABLE_TOKEN_BOOST` kill switch is off; the scoring pass then reads 0
	 * (neutral multiplier) for every listing. */
	normalizedDemandByListing: Map<string, number>;
	/** `${tokenKind}:${tokenValue}` → median price (USD) across listings
	 * matching this token. Tokens with fewer than `PRICE_MEDIAN_MIN_BUCKET`
	 * priced listings are absent — caller falls back to `overallMedianPrice`. */
	medianPriceByKey: Map<string, number>;
	/** Catalog-wide median price (USD) — the fallback when a listing's
	 * matched tokens don't have enough listings to anchor their own median.
	 * Null when no listing in the scan has a price. */
	overallMedianPrice: number | null;
	/** Max raw engagement (pre-normalization) across the scan — logged for
	 * observability. 0 when demand is disabled or no signal landed. */
	engagementMax: number;
	/** Wall time of the `matchTokens` loop over every rankable listing.
	 * Alarmed against `TOKENIZE_WARN_THRESHOLD_MS` — the §6.2
	 * denorm-titleTokens escape hatch's only invisible trigger. */
	tokenizeMs: number;
}

interface DemandEventRow {
	listingId: string;
	/** Bot-filtered count of DISTINCT anonymous viewers in the window. */
	viewers: number;
	/** Count of `cart_added` EVENTS in the window (not net live cart size). */
	carts: number;
}

function tokenKey(kind: string, value: string): string {
	return `${kind}:${value}`;
}

/**
 * Bounded scan over rankable listings (§7 step 1): live-ish statuses
 * unconditionally, plus any row written within the sold-visibility cutoff.
 * Provable superset of every explore-visible row; old terminal rows drop out
 * so the scan stays sub-ms on a forever-growing catalog. Extracted from the
 * v1 inline call so commit #8 can launch this in parallel with seller-trust
 * + cart-add reads (`Promise.all` in `refresh`).
 */
async function loadRankableListings(
	ctx: WorkerContextBase,
	cutoff: Date,
): Promise<RankableListing[]> {
	return ctx.prisma.listing.findMany({
		where: {
			hidden: false,
			OR: [
				{ status: { in: [...ALWAYS_RANKABLE_STATUSES] } },
				{ updatedAt: { gte: cutoff } },
			],
		},
		select: {
			id: true,
			title: true,
			description: true,
			createdAt: true,
			sellerProfileId: true,
			rankBaseScore: true,
			rankBaseVersion: true,
			price: true,
			startingBid: true,
			listingType: true,
			saveCount: true,
			heroWidth: true,
			heroHeight: true,
			status: true,
		},
	});
}

/**
 * Live cart-add count per listing (NL-310 commit #8 — docs §9 step 3).
 * Single GROUP BY over the live `CartItem` table. "Current members, not
 * historical count" — distinct from the 30d `cart_added` EVENT count that
 * `aggregateDemand` consumes for the demand signal. This live-members count is
 * the (small) cart term folded into the base score.
 *
 * Sole-writer pattern (mirrors `reviewAvgShrunk` per docs §7.1): the
 * refresh worker is the only writer of `Listing.addToCartCount`. A
 * counter_cache-style live increment on cart add/remove would write a
 * value this worker overwrites within ≤10 min — extra DB calls per cart
 * op for zero observable freshness (downstream `rankScore` is only as
 * fresh as the refresh tick anyway).
 *
 * Returned unfiltered (every listing in any cart) so this can run in
 * parallel with `loadRankableListings` — at our scale the wasted bytes
 * are negligible versus serializing the two queries.
 *
 * Kill switch: `ENABLE_CART_ADD_SIGNAL=false` returns an empty map; the
 * scoring pass reads `addToCartCount = 0` uniformly.
 */
async function loadCartAddCounts(
	ctx: WorkerContextBase,
): Promise<Map<string, number>> {
	if (process.env.ENABLE_CART_ADD_SIGNAL === "false") return new Map();
	const rows = await ctx.prisma.cartItem.groupBy({
		by: ["listingId"],
		_count: { _all: true },
	});
	const out = new Map<string, number>();
	for (const r of rows) out.set(r.listingId, r._count._all);
	return out;
}

interface DemandSignalFlags {
	/** When false, the cart-event term drops out of `engagement`. */
	cartAddSignalEnabled: boolean;
	/** When false, the save term drops out of `engagement`. */
	saveSignalEnabled: boolean;
}

/**
 * Per-listing VIEW-DEMAND signal for the scoring pass (explore-ranking-v3 PR2,
 * §5.2). Replaces the inverted Empirical-Bayes token-CVR aggregation. Mirrors
 * `apps/worker/scripts/preview-demand-ranking.ts` — its math was validated on
 * the June 2026 prod export and signed off by the founder.
 *
 * Per rankable listing:
 *   engagement = distinctViewers30d + SAVE_VIEWS·saveCount + CART_VIEWS·cartEvents30d
 * where `distinctViewers30d` is the bot-filtered COUNT(DISTINCT anonymous_id)
 * of `listing_viewed` events (a scraper — anon_id viewing > BOT_BREADTH_THRESHOLD
 * distinct listings — is excluded), `saveCount` is the listing's denormalized
 * NET save count, and `cartEvents30d` is the COUNT of `cart_added` events (not
 * net live cart size). Purchases are deliberately NOT in the signal (0% of
 * purchases attribute to the feed slot today — audit BLOCK 4/5).
 *
 * Then pooled toward the listing's subject (character/set) demand so a fresh
 * listing of a popular character inherits that character's demand:
 *   prior  = max(subjectAvg over the listing's matched character/set tokens),
 *            or the global mean engagement if it matches no character/set token
 *   w      = engagement / (engagement + POOL_M)
 *   pooled = w·engagement + (1-w)·prior
 *   demand = log1p(pooled)
 * Finally min-max-normalized over the full rankable scan → [0,1].
 *
 * The price-median aggregation (priceMult input) runs unconditionally — it is
 * independent of the demand signal and the scorer's `computePriceMult` has its
 * own `ENABLE_PRICE_MULT` kill switch.
 *
 * Kill switch: `ENABLE_TOKEN_BOOST=false` skips the demand SQL + math entirely
 * and returns an empty `normalizedDemandByListing` (scoring pass reads 0 →
 * neutral 1.0× multiplier). We still tokenize + compute price medians so the
 * kill-switch path keeps priceMult and the base score intact.
 */
async function aggregateDemand(
	ctx: WorkerContextBase,
	scan: ReadonlyArray<RankableListing>,
	flags: DemandSignalFlags,
): Promise<DemandResult> {
	const tokStart = Date.now();
	const matchedByListing = new Map<string, MatchedToken[]>();
	for (const r of scan) {
		matchedByListing.set(r.id, matchTokens(r.title, TOKEN_DICTIONARY));
	}
	const tokenizeMs = Date.now() - tokStart;

	// Price aggregation (NL-310 commit #8.5 — docs §10). Independent of the
	// demand signal; runs on every tick so priceMult survives the demand kill
	// switch. Single pass pools the listing's effective price into every
	// matched-token bucket; medians per bucket drive the per-listing priceMult
	// sigmoid in the scoring loop. Untokenized listings still feed the overall
	// median fallback.
	const pricesByKey = new Map<string, number[]>();
	const allPrices: number[] = [];
	for (const r of scan) {
		const priceUSD = effectivePriceUSD(r);
		if (priceUSD === null) continue;
		allPrices.push(priceUSD);
		const matches = matchedByListing.get(r.id);
		if (!matches || matches.length === 0) continue;
		for (const m of matches) {
			const k = tokenKey(m.tokenKind, m.tokenValue);
			let arr = pricesByKey.get(k);
			if (!arr) {
				arr = [];
				pricesByKey.set(k, arr);
			}
			arr.push(priceUSD);
		}
	}
	const overallMedianPrice = allPrices.length > 0 ? median(allPrices) : null;
	const medianPriceByKey = new Map<string, number>();
	for (const [k, prices] of pricesByKey) {
		if (prices.length >= PRICE_MEDIAN_MIN_BUCKET) {
			medianPriceByKey.set(k, median(prices));
		}
	}

	const normalizedDemandByListing = new Map<string, number>();
	if (process.env.ENABLE_TOKEN_BOOST === "false" || scan.length === 0) {
		return {
			matchedByListing,
			normalizedDemandByListing,
			medianPriceByKey,
			overallMedianPrice,
			engagementMax: 0,
			tokenizeMs,
		};
	}

	// Per-listing bot-filtered distinct viewers + cart-add event count, scoped
	// to the scan IDs over the 30d window. The `scrapers` CTE flags any
	// anonymous_id that viewed > BOT_BREADTH_THRESHOLD distinct listings and
	// excludes its views from the distinct-viewer count (audit SQL BLOCK 7).
	// anonymous_id NOT NULL on the view leg keeps server/null actors out.
	const idsSql = Prisma.join(scan.map((r) => Prisma.sql`${r.id}`));
	const demandRows = await ctx.prisma.$queryRaw<DemandEventRow[]>`
		WITH scoped AS (
			SELECT listing_id, event_name, anonymous_id
			FROM engagement_event
			WHERE occurred_at >= now() - (${DEMAND_WINDOW_DAYS}::int * INTERVAL '1 day')
			  AND listing_id IN (${idsSql})
			  AND event_name IN (
			    ${EngagementEventName.listingViewed},
			    ${EngagementEventName.cartAdded}
			  )
		),
		scrapers AS (
			SELECT anonymous_id
			FROM scoped
			WHERE event_name = ${EngagementEventName.listingViewed}
			  AND anonymous_id IS NOT NULL
			GROUP BY anonymous_id
			HAVING COUNT(DISTINCT listing_id) > ${BOT_BREADTH_THRESHOLD}::int
		),
		viewers AS (
			SELECT listing_id, COUNT(DISTINCT anonymous_id)::int AS "viewers"
			FROM scoped
			WHERE event_name = ${EngagementEventName.listingViewed}
			  AND anonymous_id IS NOT NULL
			  AND anonymous_id NOT IN (SELECT anonymous_id FROM scrapers)
			GROUP BY listing_id
		),
		carts AS (
			SELECT listing_id, COUNT(*)::int AS "carts"
			FROM scoped
			WHERE event_name = ${EngagementEventName.cartAdded}
			GROUP BY listing_id
		)
		SELECT
			COALESCE(v.listing_id, c.listing_id) AS "listingId",
			COALESCE(v."viewers", 0)             AS "viewers",
			COALESCE(c."carts", 0)               AS "carts"
		FROM viewers v
		FULL OUTER JOIN carts c ON c.listing_id = v.listing_id
	`;

	const viewersByListing = new Map<string, number>();
	const cartsByListing = new Map<string, number>();
	for (const row of demandRows) {
		viewersByListing.set(row.listingId, row.viewers);
		cartsByListing.set(row.listingId, row.carts);
	}

	// engagement = viewers + SAVE_VIEWS·saveCount + CART_VIEWS·cartEvents.
	// Kill switches drop the save / cart term respectively (mirror the base
	// score's per-signal switches).
	const engagementByListing = new Map<string, number>();
	let engagementMax = 0;
	for (const r of scan) {
		const viewers = viewersByListing.get(r.id) ?? 0;
		const saves = flags.saveSignalEnabled ? r.saveCount : 0;
		const carts = flags.cartAddSignalEnabled
			? (cartsByListing.get(r.id) ?? 0)
			: 0;
		const engagement = viewers + SAVE_VIEWS * saves + CART_VIEWS * carts;
		engagementByListing.set(r.id, engagement);
		if (engagement > engagementMax) engagementMax = engagement;
	}

	// Subject (character/set) average engagement. A listing pools toward the
	// MAX subject average across its matched character/set tokens; pooling
	// lets a fresh listing of a hot character inherit that character's demand.
	const subjectVals = new Map<string, number[]>();
	for (const [listingId, matches] of matchedByListing) {
		const engagement = engagementByListing.get(listingId) ?? 0;
		for (const m of matches) {
			if (!SUBJECT_KINDS.has(m.tokenKind)) continue;
			const k = tokenKey(m.tokenKind, m.tokenValue);
			let arr = subjectVals.get(k);
			if (!arr) {
				arr = [];
				subjectVals.set(k, arr);
			}
			arr.push(engagement);
		}
	}
	const subjectAvg = new Map<string, number>();
	for (const [k, vals] of subjectVals) {
		subjectAvg.set(k, vals.reduce((s, x) => s + x, 0) / vals.length);
	}
	// scan.length > 0 is guaranteed: the function returns early on an empty scan.
	const globalAvg =
		scan.reduce((s, r) => s + (engagementByListing.get(r.id) ?? 0), 0) /
		scan.length;

	// Pooled demand = log1p(w·engagement + (1-w)·prior), then min-max-normalize
	// across the scan. `prior` is the max matched subject average, or the global
	// mean when the listing matches no character/set token.
	const demandLogByListing = new Map<string, number>();
	for (const r of scan) {
		const engagement = engagementByListing.get(r.id) ?? 0;
		const matches = matchedByListing.get(r.id) ?? [];
		let prior = -1;
		for (const m of matches) {
			if (!SUBJECT_KINDS.has(m.tokenKind)) continue;
			const mu = subjectAvg.get(tokenKey(m.tokenKind, m.tokenValue));
			if (mu !== undefined && mu > prior) prior = mu;
		}
		if (prior < 0) prior = globalAvg;
		const w = engagement / (engagement + POOL_M);
		demandLogByListing.set(r.id, Math.log1p(w * engagement + (1 - w) * prior));
	}

	// Min-max normalize over the EXPLORE-SERVED rows only (`SERVED_STATUSES`).
	// Pooling above intentionally spans the full scan (matches the preview), but
	// the normalization range must exclude terminal cutoff rows (sold/closed) —
	// otherwise a single recently-sold high-demand listing stretches dMax and
	// compresses every served listing's multiplier toward 1.0 (appraiser, v3 PR2).
	let dMin = Number.POSITIVE_INFINITY;
	let dMax = Number.NEGATIVE_INFINITY;
	for (const r of scan) {
		if (!SERVED_STATUSES.has(r.status)) continue;
		const v = demandLogByListing.get(r.id);
		if (v === undefined) continue;
		if (v < dMin) dMin = v;
		if (v > dMax) dMax = v;
	}
	const span = dMax > dMin ? dMax - dMin : 0;
	for (const [id, v] of demandLogByListing) {
		const n = span > 0 ? (v - dMin) / span : 0;
		// Clamp: terminal rows excluded from the range above can fall outside
		// [0,1]; they don't serve, but keep the stored value well-formed.
		normalizedDemandByListing.set(id, n < 0 ? 0 : n > 1 ? 1 : n);
	}

	return {
		matchedByListing,
		normalizedDemandByListing,
		medianPriceByKey,
		overallMedianPrice,
		engagementMax,
		tokenizeMs,
	};
}

/**
 * /explore default-feed ranking refresh (NL-284 docs/explore-ranking.md §7;
 * NL-310 v2 commit #6 extends with sellerTrust; explore-ranking-v3 PR2 swaps
 * the token-CVR multiplier for a view-demand one). Sole writer of the
 * time-decaying `rankScore`, `Listing.addToCartCount`, `Listing.tokenBoost`
 * (which now carries the view-demand multiplier, not CVR), and
 * `SellerProfile.reviewAvgShrunk`. Pure scoring formula lives in
 * `@nolie/core/explore` — no SQL/TS duplication.
 *
 * DB shape per tick (v3 PR2): 4 reads + 2 sets of bulk writes + 2 Redis ops.
 * Three of the four reads (`seller_profile` CTE, listing scan, cart_item
 * GROUP BY) are mutually independent — kicked off in parallel via
 * `Promise.all`. The fourth (the `engagement_event` demand aggregation in
 * `aggregateDemand`) depends on the listing-scan IDs and follows. The
 * `token_popularity` write is GONE — that table was analytics-only, never
 * read at serve time; the demand signal lives in memory for the tick and is
 * stored per-listing in the reused `tokenBoost` column. The listing/seller
 * writes are guarded by `IS DISTINCT FROM`; `rankScore` advances every
 * scheduled run because `now` advances — intended, the 10-minute cadence (not
 * byte-stable idempotency) keeps writes negligible. Same-instant BullMQ retry
 * is a true no-op, so retries are safe.
 *
 * `titleTokens` denorm column intentionally NOT added (docs §4.1 vs §6.2
 * contradiction resolved against §4.1 per the May 2026 research pass).
 * Tokenization runs once per tick inside `aggregateDemand` and the resulting
 * map is reused by the scoring pass — ~10ms at current catalog size. Triggers
 * to revisit and denorm (any one):
 *   (a) `tokenizeMs > TOKENIZE_WARN_THRESHOLD_MS` for a sustained stretch
 *       — Sentry warning below fires per tick when crossed (deduped by
 *       message fingerprint, so it lands as one alert);
 *   (b) a second reader needs matched tokens (faceting, similar-listings,
 *       admin token-coverage dashboard);
 *   (c) ranking moves out of the 10-min batch loop into real-time scoring;
 *   (d) structured set/character/rarity fields ship — skip `titleTokens`
 *       entirely and go straight to structured columns (TCGPlayer pattern).
 *
 * Scale escape hatch (§7 [DEFER], trigger-gated): the recency UPDATE can
 * move fully server-side (`SET rankScore = rankBaseScore + :wR * power(0.5,
 * extract(epoch from (now()-"createdAt"))/3600/:halfLife)`), zero rows in
 * app memory. NOT done now — the SQL pushdown can't recompute the base
 * inputs (sellerTrust / addToCartCount) or the per-listing demand multiplier
 * without making the SQL formula a fragile mirror of the pure scorer. The
 * cutoff-bounded scan keeps this sub-ms until that trigger fires.
 */
export async function refresh(ctx: WorkerContextBase): Promise<void> {
	const { prisma, redis, logger } = ctx;
	const start = Date.now();
	const cutoff = new Date(Date.now() - SOLD_VISIBILITY_DAYS * DAY_MS);

	// Three independent reads in parallel. `refreshSellerTrust` also writes
	// `seller_profile` internally; the listing scan and cart-add GROUP BY
	// are pure reads. No interdependency — saves one round-trip of latency
	// at the cost of three concurrent connections (well under
	// connection_limit = 13).
	const [{ trustMap, sellersTrustUpdated }, scanRows, cartAddCounts] =
		await Promise.all([
			refreshSellerTrust(ctx),
			loadRankableListings(ctx, cutoff),
			loadCartAddCounts(ctx),
		]);

	const tokenBoostEnabled = process.env.ENABLE_TOKEN_BOOST !== "false";
	const cartAddSignalEnabled = process.env.ENABLE_CART_ADD_SIGNAL !== "false";
	const saveSignalEnabled = process.env.ENABLE_SAVE_SIGNAL !== "false";
	const priceMultEnabled = process.env.ENABLE_PRICE_MULT !== "false";
	const premiumPriceEnabled = process.env.ENABLE_PREMIUM_PRICE !== "false";
	const imageDemeritEnabled = process.env.ENABLE_IMAGE_DEMERIT !== "false";

	// Sequential: demand aggregation needs listing IDs from the scan. The
	// cart/save kill switches drop their term from the engagement composite.
	const demand = await aggregateDemand(ctx, scanRows, {
		cartAddSignalEnabled,
		saveSignalEnabled,
	});

	if (demand.tokenizeMs > TOKENIZE_WARN_THRESHOLD_MS) {
		// Sentry dedupes by message fingerprint, so the per-tick fires collapse
		// to one alert in the UI. The structured `extra` carries the latest
		// observed cost; investigate the `titleTokens` denorm trigger (a) from
		// the refresh-job doc block when this lands.
		reportWarning(
			"Explore rank refresh: tokenization exceeded warning threshold",
			{
				operation: "explore_rank_refresh",
				extra: {
					tokenizeMs: demand.tokenizeMs,
					listingsScanned: scanRows.length,
					thresholdMs: TOKENIZE_WARN_THRESHOLD_MS,
				},
			},
		);
	}

	const now = new Date();

	let scoreMin = Number.POSITIVE_INFINITY;
	let scoreMax = Number.NEGATIVE_INFINITY;
	let sellerTrustMax = 0;
	let addToCartMax = 0;
	let saveCountMax = 0;
	let demandMultMax = TOKEN_BOOST_MIN;
	let priceMultMax = 1.0;
	let priceMultMin = 1.0;

	const pending = scanRows.map((r) => {
		const sellerTrust = trustMap.get(r.sellerProfileId) ?? 0;
		if (sellerTrust > sellerTrustMax) sellerTrustMax = sellerTrust;

		const addToCartCount = cartAddSignalEnabled
			? (cartAddCounts.get(r.id) ?? 0)
			: 0;
		if (addToCartCount > addToCartMax) addToCartMax = addToCartCount;

		const saveCount = saveSignalEnabled ? r.saveCount : 0;
		if (saveCount > saveCountMax) saveCountMax = saveCount;

		const matches = demand.matchedByListing.get(r.id);

		// View-demand multiplier (explore-ranking-v3 PR2). The worker already
		// computed each listing's subject-pooled, min-max-normalized demand in
		// `aggregateDemand`; the scorer just maps it through the clamp. The
		// kill switch (`ENABLE_TOKEN_BOOST=false`) leaves `normalizedDemand`
		// empty, so this reads 0 → neutral 1.0× — the additive collapse.
		const demandMult = tokenBoostEnabled
			? computeDemandMultiplier(
					{ normalizedDemand: demand.normalizedDemandByListing.get(r.id) ?? 0 },
					DEFAULT_RANKING_CONFIG,
				)
			: TOKEN_BOOST_MIN;
		if (demandMult > demandMultMax) demandMultMax = demandMult;

		// Effective price for this listing, computed once and reused by both
		// the multiplicative priceMult (vs-category sigmoid) and the additive
		// premium term in the base score (absolute-dollar log).
		const priceUSD = effectivePriceUSD(r);

		// Price-vs-median: use the HIGHEST median across this listing's
		// matched tokens (premium tokens like psa_10 pull the reference up,
		// so a cheap-PSA-10 is suspicious vs PSA 10 median, not vs character
		// median). Fall back to the catalog-wide median for listings whose
		// matched tokens don't have enough listings to anchor their own
		// median — keeps untokenized cheap junk from escaping the sigmoid.
		let priceMult = 1.0;
		if (priceMultEnabled) {
			let refMedianUSD: number | null = null;
			if (matches) {
				for (const m of matches) {
					const med = demand.medianPriceByKey.get(
						tokenKey(m.tokenKind, m.tokenValue),
					);
					if (
						med !== undefined &&
						(refMedianUSD === null || med > refMedianUSD)
					) {
						refMedianUSD = med;
					}
				}
			}
			if (refMedianUSD === null) refMedianUSD = demand.overallMedianPrice;
			priceMult = computePriceMult(
				{ priceUSD, refMedianUSD },
				DEFAULT_RANKING_CONFIG,
			);
		}
		if (priceMult > priceMultMax) priceMultMax = priceMult;
		if (priceMult < priceMultMin) priceMultMin = priceMult;

		// v2 (commit #6/#8/#8.5): recompute the base score on every tick.
		// sellerTrust + addToCartCount + (negative keyword scan in core)
		// change continuously between ticks (reviews land, carts fill,
		// descriptions edit); the rankBaseVersion gate alone can't detect
		// those. The IS DISTINCT FROM write guard below absorbs the cost
		// when nothing actually moved.
		const rankBaseScore = computeRankBaseScore(
			{
				title: r.title,
				description: r.description,
				sellerTrust,
				addToCartCount,
				saveCount,
				priceUSD: premiumPriceEnabled ? priceUSD : null,
				// Kill switch: pass null dims when disabled → the demerit
				// collapses to 0 without touching any other signal.
				heroWidth: imageDemeritEnabled ? r.heroWidth : null,
				heroHeight: imageDemeritEnabled ? r.heroHeight : null,
			},
			DEFAULT_RANKING_CONFIG,
		);
		const rankScore = computeRankScore(
			{ rankBaseScore, createdAt: r.createdAt, now, demandMult, priceMult },
			DEFAULT_RANKING_CONFIG,
		);
		if (rankScore < scoreMin) scoreMin = rankScore;
		if (rankScore > scoreMax) scoreMax = rankScore;

		return {
			id: r.id,
			rankScore,
			rankBaseScore,
			rankBaseVersion: RANK_BASE_VERSION,
			addToCartCount,
			// Stored into the reused `tokenBoost` column (now view-demand, not CVR).
			demandMult,
		};
	});

	let rowsUpdated = 0;
	for (let i = 0; i < pending.length; i += UPDATE_CHUNK) {
		const chunk = pending.slice(i, i + UPDATE_CHUNK);
		const values = Prisma.join(
			chunk.map(
				(p) =>
					Prisma.sql`(${p.id}, ${p.rankScore}::double precision, ${p.rankBaseScore}::double precision, ${p.rankBaseVersion}::int, ${p.addToCartCount}::int, ${p.demandMult}::double precision, ${TOKEN_BOOST_VERSION}::int)`,
			),
		);
		// Raw SQL targets the physical `auction` table (NL-284/NL-310 columns
		// are unmapped, so field name == column name).
		rowsUpdated += await prisma.$executeRaw`
			UPDATE "auction" AS a
			SET "rankScore"         = v.rank_score,
				"rankBaseScore"     = v.rank_base_score,
				"rankBaseVersion"   = v.rank_base_version,
				"addToCartCount"    = v.add_to_cart_count,
				"tokenBoost"        = v.token_boost,
				"tokenBoostVersion" = v.token_boost_version
			FROM (VALUES ${values}) AS v(
				id, rank_score, rank_base_score, rank_base_version,
				add_to_cart_count, token_boost, token_boost_version
			)
			WHERE a.id = v.id
				AND (a."rankScore"         IS DISTINCT FROM v.rank_score
					OR a."rankBaseScore"   IS DISTINCT FROM v.rank_base_score
					OR a."rankBaseVersion" IS DISTINCT FROM v.rank_base_version
					OR a."addToCartCount"  IS DISTINCT FROM v.add_to_cart_count
					OR a."tokenBoost"      IS DISTINCT FROM v.token_boost
					OR a."tokenBoostVersion" IS DISTINCT FROM v.token_boost_version)
		`;
	}

	// Rolls fresh snapshots: the explore snapshot cache key carries this
	// epoch, so a successful refresh retires all frozen page orders (§8).
	await redis.incr(EXPLORE_RANK_EPOCH_KEY);

	// Self-enable (§10): a successful run has proven scores exist and rolled
	// the epoch, so flip the kill switch on — but NX, so a human "0" stays a
	// durable disable and we never overwrite an intentional kill.
	await redis.set(EXPLORE_RANKING_ENABLED_KEY, "1", "NX");

	logger.info(
		{
			event: "explore_rank_refresh",
			rowsScanned: scanRows.length,
			rowsUpdated,
			sellersTrustUpdated,
			sellerTrustMax,
			addToCartMax,
			saveCountMax,
			// Demand signal (explore-ranking-v3 PR2): the demand multiplier ceiling
			// observed this tick and the peak raw engagement before normalization.
			demandMultMax,
			engagementMax: demand.engagementMax,
			demandListings: demand.normalizedDemandByListing.size,
			priceMultMax,
			priceMultMin,
			overallMedianPrice: demand.overallMedianPrice,
			tokenizeMs: demand.tokenizeMs,
			dictSize:
				TOKEN_DICTIONARY.characters.length +
				TOKEN_DICTIONARY.sets.length +
				TOKEN_DICTIONARY.rarity.length,
			tokenBoostEnabled,
			cartAddSignalEnabled,
			saveSignalEnabled,
			priceMultEnabled,
			premiumPriceEnabled,
			imageDemeritEnabled,
			durationMs: Date.now() - start,
			scoreMin: Number.isFinite(scoreMin) ? scoreMin : null,
			scoreMax: Number.isFinite(scoreMax) ? scoreMax : null,
		},
		"explore rank refresh complete",
	);
}
