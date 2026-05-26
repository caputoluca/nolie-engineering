import { DAY_MS, SOLD_VISIBILITY_DAYS } from "@nolie/core/constants/listings";
import { EngagementEventName } from "@nolie/core/engagement/catalog";
import {
	computePHat,
	computePriceMult,
	computeRankBaseScore,
	computeRankScore,
	computeTokenBoost,
	DEFAULT_RANKING_CONFIG,
	EXPLORE_RANK_EPOCH_KEY,
	EXPLORE_RANKING_ENABLED_KEY,
	type MatchedToken,
	matchTokens,
	priorFromDictWeight,
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

// Token-popularity aggregation window + decay (docs/explore-ranking-v2.md §6.1).
// 30d window, 7d half-life — events 7d old count half, 14d old count quarter.
const TOKEN_POPULARITY_WINDOW_DAYS = 30;
const TOKEN_POPULARITY_HALF_LIFE_DAYS = 7;

// `successes = cart_added + PURCHASE_SUCCESS_WEIGHT · purchase_completed` — a
// purchase is a stronger intent signal than a cart-add. Doc §17 open Q#6
// flags the 3× as tunable from real data.
const PURCHASE_SUCCESS_WEIGHT = 3;

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

interface TokenAcc {
	kind: string;
	value: string;
	successes: number;
	trials: number;
}

interface TokenPopularityResult {
	/** listingId → matched dictionary tokens. Tokenized once here and reused
	 * by the scoring pass — never tokenize the same title twice per tick. */
	matchedByListing: Map<string, MatchedToken[]>;
	/** `${tokenKind}:${tokenValue}` → EB posterior `pHat`. Empty when the
	 * `ENABLE_TOKEN_BOOST` kill switch is off or no signal landed yet. */
	pHatByKey: Map<string, number>;
	/** `${tokenKind}:${tokenValue}` → median price (USD) across listings
	 * matching this token. Tokens with fewer than `PRICE_MEDIAN_MIN_BUCKET`
	 * priced listings are absent — caller falls back to `overallMedianPrice`. */
	medianPriceByKey: Map<string, number>;
	/** Catalog-wide median price (USD) — the fallback when a listing's
	 * matched tokens don't have enough listings to anchor their own median.
	 * Null when no listing in the scan has a price. */
	overallMedianPrice: number | null;
	/** Mean of `pHat` across all known tokens — the z-score baseline for
	 * `computeTokenBoost`. */
	mu: number;
	/** Stdev of `pHat` across all known tokens. ≤ 0 collapses the boost to
	 * neutral in the scorer (no signal to amplify). */
	sigma: number;
	/** Rows actually written to `token_popularity` this tick. */
	tokensRefreshed: number;
	/** Wall time of the `matchTokens` loop over every rankable listing.
	 * Alarmed against `TOKENIZE_WARN_THRESHOLD_MS` — the §6.2
	 * denorm-titleTokens escape hatch's only invisible trigger. */
	tokenizeMs: number;
}

interface EventAggRow {
	listingId: string;
	eventName: string;
	w: number;
}

function tokenKey(kind: string, value: string): string {
	return `${kind}:${value}`;
}

/**
 * Lookup table: `${kind}:${value}` → curator-set `weight` from the
 * dictionary. Built once at module load — the dictionary is large enough
 * that scanning per-token at refresh time would burn a few ms per tick we
 * don't need to spend.
 */
const DICT_WEIGHT_BY_KEY = (() => {
	const m = new Map<string, number>();
	for (const e of TOKEN_DICTIONARY.characters)
		m.set(tokenKey("character", e.token), e.weight);
	for (const e of TOKEN_DICTIONARY.sets)
		m.set(tokenKey("set", e.token), e.weight);
	for (const e of TOKEN_DICTIONARY.rarity)
		m.set(tokenKey("rarity", e.token), e.weight);
	return m;
})();

/**
 * Every `(kind, value)` pair from the dictionary, in scan order. Used by the
 * refresh job to write a `token_popularity` row per dictionary entry on
 * every tick — even tokens with zero observed events get a row whose pHat
 * reflects the curator's `weight` prior. Listings matching a "cold" token
 * still get a meaningful tokenBoost from the prior alone.
 */
const ALL_DICTIONARY_TOKENS: ReadonlyArray<{ kind: string; value: string }> = [
	...TOKEN_DICTIONARY.characters.map((e) => ({
		kind: "character",
		value: e.token,
	})),
	...TOKEN_DICTIONARY.sets.map((e) => ({ kind: "set", value: e.token })),
	...TOKEN_DICTIONARY.rarity.map((e) => ({ kind: "rarity", value: e.token })),
];

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
		},
	});
}

/**
 * Live cart-add count per listing (NL-310 commit #8 — docs §9 step 3).
 * Single GROUP BY over the live `CartItem` table. "Current members, not
 * historical count" — the historical `cart_added` event stream feeds
 * `token_popularity`; this is a freshness signal added to the base score.
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

/**
 * Aggregate 30d of `engagement_event` into `token_popularity` and return
 * the in-memory pHat lookup + matched-token map for the scoring pass
 * (NL-310 commit #8 — docs §6, §9 stages 1-2).
 *
 * Single read over the partitioned event table; tokenization runs once
 * per listing here (timed against the `TOKENIZE_WARN_THRESHOLD_MS` budget)
 * and the resulting `matchedByListing` is reused by the scoring pass — no
 * double-tokenize per tick. Empirical-Bayes posterior per (tokenKind,
 * tokenValue); prior fit by method-of-moments per `tokenKind` bucket.
 *
 * Signal definitions (doc §6.1):
 *   successes = (decayed `cart_added`) + 3 · (decayed `purchase_completed`)
 *   trials    = max(decayed `listing_impression`, decayed `listing_viewed`)
 * The `max` smooths the transition from `listing_viewed` (noisier but
 * immediately available proxy) to `listing_impression` (real IPS
 * denominator) as the impression log accrues history. Exponential 7-day
 * half-life weighting applied SQL-side so a single decayed scalar per
 * (listing, event_name) crosses the wire.
 *
 * Scope: only events on currently-rankable listings contribute. A removed
 * listing's historical signal is lost — fine, because removed listings
 * can't be re-ranked anyway and the dictionary token will accrue fresh
 * signal from new listings that contain it.
 *
 * Kill switch: `ENABLE_TOKEN_BOOST=false` short-circuits BEFORE the SQL
 * read and the upsert. We still tokenize titles (downstream code expects
 * a populated `matchedByListing` so the kill-switch path can write
 * `tokenBoost=1.0` uniformly without a second tokenize pass).
 */
async function aggregateTokenPopularity(
	ctx: WorkerContextBase,
	scan: ReadonlyArray<RankableListing>,
): Promise<TokenPopularityResult> {
	const tokStart = Date.now();
	const matchedByListing = new Map<string, MatchedToken[]>();
	for (const r of scan) {
		matchedByListing.set(r.id, matchTokens(r.title, TOKEN_DICTIONARY));
	}
	const tokenizeMs = Date.now() - tokStart;

	const empty = {
		pHatByKey: new Map<string, number>(),
		medianPriceByKey: new Map<string, number>(),
		overallMedianPrice: null,
		mu: 0,
		sigma: 0,
		tokensRefreshed: 0,
	};

	if (process.env.ENABLE_TOKEN_BOOST === "false" || scan.length === 0) {
		return { matchedByListing, tokenizeMs, ...empty };
	}

	const idsSql = Prisma.join(scan.map((r) => Prisma.sql`${r.id}`));
	const eventAgg = await ctx.prisma.$queryRaw<EventAggRow[]>`
		SELECT
			listing_id AS "listingId",
			event_name AS "eventName",
			SUM(POWER(
				0.5,
				EXTRACT(EPOCH FROM (now() - occurred_at)) / 86400.0 / ${TOKEN_POPULARITY_HALF_LIFE_DAYS}::float
			))::float AS "w"
		FROM engagement_event
		WHERE occurred_at >= now() - (${TOKEN_POPULARITY_WINDOW_DAYS}::int * INTERVAL '1 day')
		  AND listing_id IN (${idsSql})
		  AND event_name IN (
		    ${EngagementEventName.listingImpression},
		    ${EngagementEventName.listingViewed},
		    ${EngagementEventName.cartAdded},
		    ${EngagementEventName.purchaseCompleted}
		  )
		GROUP BY listing_id, event_name
	`;

	interface ListingCounts {
		impressions: number;
		viewed: number;
		cartAdded: number;
		purchases: number;
	}
	const countsByListing = new Map<string, ListingCounts>();
	for (const row of eventAgg) {
		const c = countsByListing.get(row.listingId) ?? {
			impressions: 0,
			viewed: 0,
			cartAdded: 0,
			purchases: 0,
		};
		switch (row.eventName) {
			case EngagementEventName.listingImpression:
				c.impressions = row.w;
				break;
			case EngagementEventName.listingViewed:
				c.viewed = row.w;
				break;
			case EngagementEventName.cartAdded:
				c.cartAdded = row.w;
				break;
			case EngagementEventName.purchaseCompleted:
				c.purchases = row.w;
				break;
		}
		countsByListing.set(row.listingId, c);
	}

	// Fan listings × matched tokens → per-token accumulators.
	const accByKey = new Map<string, TokenAcc>();
	for (const [listingId, matches] of matchedByListing) {
		if (matches.length === 0) continue;
		const c = countsByListing.get(listingId);
		if (!c) continue;
		const successes = c.cartAdded + PURCHASE_SUCCESS_WEIGHT * c.purchases;
		const trials = Math.max(c.impressions, c.viewed);
		if (successes === 0 && trials === 0) continue;
		for (const m of matches) {
			const k = tokenKey(m.tokenKind, m.tokenValue);
			const a = accByKey.get(k) ?? {
				kind: m.tokenKind,
				value: m.tokenValue,
				successes: 0,
				trials: 0,
			};
			a.successes += successes;
			a.trials += trials;
			accByKey.set(k, a);
		}
	}

	// Price aggregation (NL-310 commit #8.5 — docs §10). Single pass over
	// the scan pools the listing's effective price into every matched-token
	// bucket; medians per bucket drive the per-listing `priceMult` sigmoid in
	// the scoring loop below. Untokenized listings contribute to the overall
	// median fallback so the sigmoid is still meaningful for them.
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

	// Build pHat for EVERY dictionary token (NL-310 commit #8.5 — Bayesian
	// dict-weight prior). Per-token prior derived from the curator's
	// `weight` field; observed events update the posterior smoothly as
	// trials grow. Listings matching a "cold" (zero-event) token still
	// get a meaningful tokenBoost from the prior alone — gives day-1
	// differentiation without waiting for engagement events.
	//
	// Iterating ALL_DICTIONARY_TOKENS (not just accByKey) means we write a
	// row for every dictionary entry on every tick — ~115 rows, fine at
	// this scale. The previous per-kind method-of-moments fit is gone; the
	// curator's weight encodes the prior we want directly. The per-token
	// `medianPrice` is co-persisted (null when the bucket is below
	// PRICE_MEDIAN_MIN_BUCKET — caller falls back to the overall median).
	const pHatByKey = new Map<string, number>();
	const upsertRows: Array<
		TokenAcc & {
			pHat: number;
			alpha: number;
			beta: number;
			medianPrice: number | null;
		}
	> = [];
	for (const t of ALL_DICTIONARY_TOKENS) {
		const k = tokenKey(t.kind, t.value);
		const weight = DICT_WEIGHT_BY_KEY.get(k) ?? 1.0;
		const prior = priorFromDictWeight(weight);
		const obs = accByKey.get(k);
		const successes = obs?.successes ?? 0;
		const trials = obs?.trials ?? 0;
		const pHat = computePHat({
			successes,
			trials,
			alpha: prior.alpha,
			beta: prior.beta,
		});
		pHatByKey.set(k, pHat);
		upsertRows.push({
			kind: t.kind,
			value: t.value,
			successes,
			trials,
			pHat,
			alpha: prior.alpha,
			beta: prior.beta,
			medianPrice: medianPriceByKey.get(k) ?? null,
		});
	}

	let tokensRefreshed = 0;
	for (let i = 0; i < upsertRows.length; i += UPDATE_CHUNK) {
		const chunk = upsertRows.slice(i, i + UPDATE_CHUNK);
		const values = Prisma.join(
			chunk.map(
				(u) =>
					Prisma.sql`(${u.kind}, ${u.value}, ${Math.round(u.successes)}::int, ${Math.round(u.trials)}::int, ${u.pHat}::double precision, ${u.alpha}::double precision, ${u.beta}::double precision, ${u.medianPrice}::double precision, now())`,
			),
		);
		tokensRefreshed += await ctx.prisma.$executeRaw`
			INSERT INTO token_popularity (
				"tokenKind", "tokenValue", successes, trials,
				"pHat", "priorAlpha", "priorBeta", "medianPrice", "computedAt"
			) VALUES ${values}
			ON CONFLICT ("tokenKind", "tokenValue") DO UPDATE SET
				successes     = EXCLUDED.successes,
				trials        = EXCLUDED.trials,
				"pHat"        = EXCLUDED."pHat",
				"priorAlpha"  = EXCLUDED."priorAlpha",
				"priorBeta"   = EXCLUDED."priorBeta",
				"medianPrice" = EXCLUDED."medianPrice",
				"computedAt"  = EXCLUDED."computedAt"
		`;
	}

	// μ, σ over the just-computed pHats — z-score baseline for the per-listing
	// `computeTokenBoost` call. With a single token σ collapses to 0, which
	// the scorer reads as "no signal to amplify" and returns TOKEN_BOOST_MIN.
	const pHats = Array.from(pHatByKey.values());
	const mu = pHats.reduce((s, p) => s + p, 0) / pHats.length;
	const variance =
		pHats.length > 1
			? pHats.reduce((s, p) => s + (p - mu) ** 2, 0) / pHats.length
			: 0;
	const sigma = Math.sqrt(variance);

	return {
		matchedByListing,
		pHatByKey,
		medianPriceByKey,
		overallMedianPrice,
		mu,
		sigma,
		tokensRefreshed,
		tokenizeMs,
	};
}

/**
 * /explore default-feed ranking refresh (NL-284 docs/explore-ranking.md §7;
 * NL-310 v2 commit #6 extends with sellerTrust; commit #8 with token
 * popularity + live cart-add count). Sole writer of the time-decaying
 * `rankScore`, `Listing.addToCartCount`, `Listing.tokenBoost`,
 * `SellerProfile.reviewAvgShrunk`, and `token_popularity`. Pure scoring
 * formula lives in `@nolie/core/explore` — no SQL/TS duplication.
 *
 * DB shape per tick (commit #8): 4 reads + 3 sets of bulk writes + 2 Redis
 * ops. Three of the four reads (`seller_profile` CTE, listing scan,
 * cart_item GROUP BY) are mutually independent — kicked off in parallel
 * via `Promise.all`. The fourth (`engagement_event` aggregation) depends
 * on the listing-scan IDs and follows. All writes are guarded by
 * `IS DISTINCT FROM` (listings + sellers) or `ON CONFLICT DO UPDATE`
 * (token_popularity) — `rankScore` advances every scheduled run because
 * `now` advances; that is intended, the 10-minute cadence (not byte-stable
 * idempotency) keeps writes negligible. Same-instant BullMQ retry is a
 * true no-op, so retries are safe.
 *
 * `titleTokens` denorm column intentionally NOT added (docs §4.1 vs §6.2
 * contradiction resolved against §4.1 per the May 2026 research pass).
 * Tokenization runs once per tick inside `aggregateTokenPopularity` and
 * the resulting map is reused by the scoring pass — ~10ms at current
 * catalog size. Triggers to revisit and denorm (any one):
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
 * app memory. NOT done now — the SQL pushdown can't recompute the v2 base
 * inputs (sellerTrust / addToCartCount / tokenBoost) without making the
 * SQL formula a fragile mirror of the pure scorer. The cutoff-bounded
 * scan keeps this sub-ms until that trigger fires.
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

	// Sequential: aggregation needs listing IDs from the scan.
	const tokenPop = await aggregateTokenPopularity(ctx, scanRows);

	if (tokenPop.tokenizeMs > TOKENIZE_WARN_THRESHOLD_MS) {
		// Sentry dedupes by message fingerprint, so the per-tick fires collapse
		// to one alert in the UI. The structured `extra` carries the latest
		// observed cost; investigate the `titleTokens` denorm trigger (a) from
		// the refresh-job doc block when this lands.
		reportWarning(
			"Explore rank refresh: tokenization exceeded warning threshold",
			{
				operation: "explore_rank_refresh",
				extra: {
					tokenizeMs: tokenPop.tokenizeMs,
					listingsScanned: scanRows.length,
					thresholdMs: TOKENIZE_WARN_THRESHOLD_MS,
				},
			},
		);
	}

	const now = new Date();
	const tokenBoostEnabled = process.env.ENABLE_TOKEN_BOOST !== "false";
	const cartAddSignalEnabled = process.env.ENABLE_CART_ADD_SIGNAL !== "false";
	const saveSignalEnabled = process.env.ENABLE_SAVE_SIGNAL !== "false";
	const priceMultEnabled = process.env.ENABLE_PRICE_MULT !== "false";
	const premiumPriceEnabled = process.env.ENABLE_PREMIUM_PRICE !== "false";

	let scoreMin = Number.POSITIVE_INFINITY;
	let scoreMax = Number.NEGATIVE_INFINITY;
	let sellerTrustMax = 0;
	let addToCartMax = 0;
	let saveCountMax = 0;
	let tokenBoostMax = TOKEN_BOOST_MIN;
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

		const matches = tokenPop.matchedByListing.get(r.id);

		// Map matched tokens → known pHats. Tokens with no row in
		// token_popularity yet (cold-start) drop out — `computeTokenBoost`
		// treats an empty array as "no signal" and returns TOKEN_BOOST_MIN.
		let tokenBoost = TOKEN_BOOST_MIN;
		if (tokenBoostEnabled) {
			const pHats: number[] = [];
			if (matches) {
				for (const m of matches) {
					const p = tokenPop.pHatByKey.get(tokenKey(m.tokenKind, m.tokenValue));
					if (p !== undefined) pHats.push(p);
				}
			}
			tokenBoost = computeTokenBoost(
				{
					tokenPHats: pHats,
					mu: tokenPop.mu,
					sigma: tokenPop.sigma,
					titleLen: r.title.length,
				},
				DEFAULT_RANKING_CONFIG,
			);
		}
		if (tokenBoost > tokenBoostMax) tokenBoostMax = tokenBoost;

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
					const med = tokenPop.medianPriceByKey.get(
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
			if (refMedianUSD === null) refMedianUSD = tokenPop.overallMedianPrice;
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
			},
			DEFAULT_RANKING_CONFIG,
		);
		const rankScore = computeRankScore(
			{ rankBaseScore, createdAt: r.createdAt, now, tokenBoost, priceMult },
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
			tokenBoost,
		};
	});

	let rowsUpdated = 0;
	for (let i = 0; i < pending.length; i += UPDATE_CHUNK) {
		const chunk = pending.slice(i, i + UPDATE_CHUNK);
		const values = Prisma.join(
			chunk.map(
				(p) =>
					Prisma.sql`(${p.id}, ${p.rankScore}::double precision, ${p.rankBaseScore}::double precision, ${p.rankBaseVersion}::int, ${p.addToCartCount}::int, ${p.tokenBoost}::double precision, ${TOKEN_BOOST_VERSION}::int)`,
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
			tokensRefreshed: tokenPop.tokensRefreshed,
			sellerTrustMax,
			addToCartMax,
			saveCountMax,
			tokenBoostMax,
			priceMultMax,
			priceMultMin,
			overallMedianPrice: tokenPop.overallMedianPrice,
			tokenizeMs: tokenPop.tokenizeMs,
			dictSize:
				TOKEN_DICTIONARY.characters.length +
				TOKEN_DICTIONARY.sets.length +
				TOKEN_DICTIONARY.rarity.length,
			tokenBoostEnabled,
			cartAddSignalEnabled,
			saveSignalEnabled,
			priceMultEnabled,
			premiumPriceEnabled,
			durationMs: Date.now() - start,
			scoreMin: Number.isFinite(scoreMin) ? scoreMin : null,
			scoreMax: Number.isFinite(scoreMax) ? scoreMax : null,
		},
		"explore rank refresh complete",
	);
}
