/**
 * /explore default-feed ranking — pure scorer + diversity pass (NL-284, NL-310).
 *
 * v1 (NL-284, locked 2026-05-17): recency-dominant additive scorer with a
 * soft low-effort demerit and per-seller diversity cap. See
 * docs/explore-ranking.md §5 for the cold-start catalog analysis that made
 * graded "quality" a fiction at the time.
 *
 * v2 (NL-310, this commit): the catalog grew 7× and cart shipped. v2 layers
 * three signals onto the v1 seam: (a) cart-adds (log-scaled engagement),
 * (b) populated `sellerTrust` (Bayesian-shrunk reviews + 1st Edition badge,
 * weight ramped 0 → 0.05 — sparse, but the seam is now live), and
 * (c) `tokenBoost` (Empirical-Bayes title-token popularity, max-of-tokens,
 * length-penalized). Composition turns multiplicative on `tokenBoost` so the
 * boost amplifies the additive signals without crowding them; everything else
 * stays additive (a cart-add is worth the same whether the listing is fresh
 * or stale). Recency comes down (0.45 → 0.30) now that other signals are
 * carrying weight. Kill-switch path: write `tokenBoost = 1.0` to every row →
 * multiplicative collapses cleanly to the additive form. See
 * docs/explore-ranking-v2.md §2 for the locked decisions.
 *
 * No I/O, no clock: `now` is injected into `computeRankScore` so the worker
 * refresh job is the sole owner of the time-varying term. Weights, sensitivity,
 * cap and penalties live in an immutable `RankingConfig` that is PASSED IN —
 * never read from a module global — so tests can override it and a future
 * LTR ranker slots in behind the same `(features, config) → score` signature
 * (docs/explore-ranking-v2.md §12).
 */

import type { MatchedToken } from "./token-dictionary";

export interface RankingConfig {
	weights: {
		recency: number;
		/**
		 * Seller-trust weight. v1 was 0; v2 ramps to 0.05 — sparse signal
		 * (only a handful of sellers have any reviews), the weight ramps to
		 * 0.15–0.20 as density grows. Honest framing: today this is mostly a
		 * placeholder so the seam is wired end-to-end (docs §7.4).
		 */
		sellerTrust: number;
		/**
		 * Cart-add weight applied to `log10(1 + addToCartCount)`. Log-scaled
		 * because the marginal value of the 51st cart-add is far less than
		 * the 5th. Starts at 0.10 — a listing with 5 cart-adds gets ≈ 0.078
		 * of boost, roughly a sixth of a day of fresh-recency at the new
		 * 0.30 recency weight (docs §8).
		 */
		cartAdd: number;
		/**
		 * Absolute-price premium weight applied to
		 * `log10(1 + min(priceUSD, PREMIUM_PRICE_CEILING_USD))`. Sub-linear
		 * AND capped at the ceiling: $300, $1000, $3000 all get the same
		 * premium contribution. Sits alongside a hard `CHEAP_FLOOR_PENALTY`
		 * for sub-$10 listings.
		 *
		 * Cold-start history:
		 *   v6 (RANK_BASE_VERSION 6, weight 0.30, NO ceiling, NO floor) —
		 *     shipped, broke. Unbounded log of price gave a $3,500 PSA card
		 *     ~$1.07 of pure premium boost (vs ~$0.30 max recency budget),
		 *     and any high-priced bad-photo listing dominated the top of the
		 *     feed regardless of quality. Spearman price-vs-rank correlation
		 *     measured at ~0.85 — pure price-sorting at the top.
		 *   v7 (this — weight 0.08, ceiling $300, floor $10/−0.15) — capped
		 *     so $300+ all tie on the premium term, and the bottom is
		 *     explicitly demoted. Within the premium band, tokens / recency /
		 *     trust take over the differentiation — the same job pCTR/pCVR
		 *     would do at Booking's scale, just with the signals we actually
		 *     have today.
		 */
		premium: number;
	};
	recencyHalfLifeHours: number;
	perSellerCap: number;
	/**
	 * Soft demerit subtracted from the base for title-echo / near-empty
	 * listings. Never a WHERE filter — fully reversible by setting it to 0.
	 */
	lowEffortPenalty: number;
	/**
	 * Additive demerit subtracted from the base when the title exceeds
	 * `LONG_TITLE_MAX_CHARS`. Pairs with the multiplicative length damper
	 * in `computeTokenBoost`. Smaller than the low-effort penalty because a
	 * long title is sometimes legitimate (TCG titles can carry set + rarity
	 * + grade); this deters obvious stuffing without burying real detail.
	 */
	longTitlePenalty: number;
	/**
	 * Sensitivity of `tokenBoost` to a token's z-score above the global pHat
	 * mean. The boost form is `1 + k · z`, clamped to `[TOKEN_BOOST_MIN,
	 * TOKEN_BOOST_MAX]`. At `k = 0.20`, a +1σ token (~top quartile) lands at
	 * 1.20; a top-decile token (~1.28σ) lands at ~1.256 — aligning with the
	 * doc's "top-decile hits ~1.25" target (docs §6.1, an "expected k ≈ 3"
	 * is the doc's published guess; the calibration math actually wants
	 * k ≈ 0.2 — tunable post-deploy from real distribution).
	 */
	tokenBoostSensitivity: number;
	/**
	 * Subtractive penalty applied to `rankBaseScore` when the listing's title
	 * or description matches any term in `NEGATIVE_KEYWORDS` (e.g. "wooden",
	 * "replica", "custom carved"). Catches non-TCG-card novelty listings that
	 * tokens + price-vs-median can't distinguish from real cards. Static list
	 * is a stopgap until per-listing engagement (LTR / Phase 4) can learn the
	 * same pattern from observed CTR.
	 */
	negativeKeywordPenalty: number;
	/**
	 * Sensitivity of the price-vs-median sigmoid (`k` in
	 * `mult = 1 + k · tanh(log2(price/median))`). At `k = 0.10` a listing
	 * priced at half its token's median lands at ~0.92x multiplier; double
	 * the median lands at ~1.08x. Tuned conservatively because we don't yet
	 * have engagement data to calibrate aggressive moves against; raise
	 * post-deploy if premium isn't surfacing enough.
	 */
	priceMultSensitivity: number;
	/**
	 * Floor on the price-vs-median sigmoid's multiplicative output. Below
	 * this the sigmoid clamps — protects against extreme demerits on
	 * legitimate low-priced listings (e.g. a $0.50 cold-start gateway buy).
	 */
	priceMultMin: number;
	/**
	 * Cap on the price-vs-median sigmoid's multiplicative output. Above this
	 * the sigmoid clamps — premium pricing should lift, but not dominate the
	 * other signals.
	 */
	priceMultMax: number;
}

/**
 * Bumped when the inputs or weights feeding `rankBaseScore` change. The
 * refresh job recomputes any row whose stored `rankBaseVersion` is lower
 * (docs/explore-ranking-v2.md §9 step 8) — doubles as the
 * retune-without-migration path.
 *   v1 → 2: photoCount/priceTier base replaced by low-effort demerit.
 *   v2 → 3: scorer accepts cart-add log term, long-title penalty term,
 *           and sellerTrust weight 0.05 (inputs still unwired at the
 *           refresh job — defaulted to 0).
 *   v3 → 4: refresh job now actually populates the sellerTrust input
 *           (commit #6: Bayesian-shrunk reviews + 1st Edition badge).
 *           Bump forces a one-time recompute of every existing row so the
 *           on-disk base score reflects real trust instead of the
 *           silently-zero default.
 *   v4 → 5: negative-keyword demerit added to the base. Pre-deploy data
 *           pass surfaced novelty items (wooden cards, replicas) tokens +
 *           price-vs-median couldn't catch.
 *   v5 → 6: absolute-price premium term added to the base
 *           (weights.premium · log10(1 + priceUSD)). Cold-start lever —
 *           catalog had no signal to differentiate premium from $1 commons
 *           that were floating to the top on recency alone. Vibes-check on
 *           the May 2026 prod export showed top-25 median going from $15
 *           (current) to $375 with the cranked weight, $1 cards sinking
 *           from rank ~58 to rank ~307. Forces a one-time recompute of
 *           every row at the new shape.
 *   v6 → 7: corrective tuning after v6 went live. Unbounded log @ 0.30
 *           surfaced bad-photo overpriced listings (price-vs-rank ρ ~0.85);
 *           no quality signal pushed back because we have no engagement
 *           signal yet. v7 keeps the same additive shape but (a) drops
 *           the weight 0.30 → 0.08, (b) caps the log at
 *           `PREMIUM_PRICE_CEILING_USD` so $300+ all get the same lift,
 *           (c) replaces the implicit-no-floor with a hard
 *           `CHEAP_FLOOR_PENALTY` for sub-`CHEAP_FLOOR_THRESHOLD_USD`
 *           listings. Within the premium band, tokens / recency / trust
 *           differentiate — the pCTR/pCVR substitute we have today. Vibes-
 *           check predicted top-25 median $375 → $172, $1 cards stay at
 *           rank ~240+, $1k+ listings sprinkle through ranks 30-120
 *           instead of dominating top-10.
 */
export const RANK_BASE_VERSION = 7;

/**
 * Saturation point for the absolute-price premium term. Above this dollar
 * value the `log10(1 + min(priceUSD, ceiling))` contribution is flat —
 * $300, $1000, $3000 all add the same number to `rankBaseScore`. Within the
 * premium band, ordering falls to tokens / recency / trust, which is the
 * pCTR/pCVR substitute we have today (Booking's `price × pCTR × pCVR`
 * pattern, without the engagement halves we'll add later).
 *
 * Picked $300 because it's the natural top of the "$35-$300 sweet spot" the
 * cofounder framed after the v6 deploy. Tunable post-deploy; raise when
 * engagement signal arrives and can carry the differentiation above the cap.
 */
export const PREMIUM_PRICE_CEILING_USD = 300;

/**
 * Listings priced below this get a flat `CHEAP_FLOOR_PENALTY` instead of
 * the (small) premium contribution. The "we don't want to show $1 cards
 * right now" lever — brute force but exactly addresses the failure mode
 * where fresh $1-5 commons float to the top of `/explore` on recency alone.
 */
export const CHEAP_FLOOR_THRESHOLD_USD = 10;
export const CHEAP_FLOOR_PENALTY = 0.15;

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
	weights: { recency: 0.3, sellerTrust: 0.05, cartAdd: 0.1, premium: 0.08 },
	recencyHalfLifeHours: 72,
	perSellerCap: 3,
	lowEffortPenalty: 0.12,
	longTitlePenalty: 0.04,
	tokenBoostSensitivity: 0.2,
	negativeKeywordPenalty: 0.08,
	priceMultSensitivity: 0.1,
	priceMultMin: 0.85,
	priceMultMax: 1.1,
};

/**
 * Title/description matches against this list subtract
 * `RankingConfig.negativeKeywordPenalty` from the base score. Targets the
 * specific class of listing tokens + price-vs-median can't catch — novelty
 * items priced like real cards (wooden carvings, custom proxies, replicas,
 * etc.). Each entry is matched as a whole-word substring on a normalized
 * (lowercase, punctuation-collapsed) join of title + description.
 *
 * Curated narrowly to avoid false positives. "Promo" is NOT here — legitimate
 * cards are tagged promos. Sellers can rename listings to bypass, but a
 * seller paying our fees to list a $20 wooden Eevee is unlikely to bother.
 *
 * Final removal trigger: when per-listing engagement (LTR / Phase 4) ships
 * and learns this pattern from observed CTR (months out per docs §16). Until
 * then this is the cheapest way to catch the failure mode.
 */
export const NEGATIVE_KEYWORDS: ReadonlyArray<string> = [
	"wooden",
	"hand carved",
	"hand-carved",
	"handmade",
	"hand made",
	"hand-made",
	"homemade",
	"home made",
	"home-made",
	"custom carved",
	"custom made",
	"replica",
	"fanmade",
	"fan made",
	"fan-made",
	"proxy",
	"proxies",
];

/**
 * Token-boost clamp range. 1.0 = neutral (no boost AND kill-switch value
 * the refresh job writes when ENABLE_TOKEN_BOOST is off). 1.30 = max — the
 * top of the curated dictionary's weight ladder. Out-of-range values from the
 * EB z-score formula clamp to this range BEFORE the length damper applies
 * (docs §6.1).
 */
export const TOKEN_BOOST_MIN = 1.0;
export const TOKEN_BOOST_MAX = 1.3;

/**
 * Above this length the multiplicative token-boost damper kicks in
 * (`min(1, LONG_TITLE_MAX_CHARS / titleLen)`) AND the additive
 * `longTitlePenalty` fires at the base-score level. Picked at 60 — Etsy
 * uses 70, eBay 60-70; TCG titles are naturally short, so we cap tight
 * (docs §2).
 */
export const LONG_TITLE_MAX_CHARS = 60;

/**
 * A trimmed description at or under this many characters is low-effort:
 * catches "NM", "Mint condition", "Promo - NM", "HP CONDITION" and the like
 * (the ≤20-char tail measured at ~8% of the v1 catalog).
 */
const LOW_EFFORT_DESC_MAX_CHARS = 20;

export interface RankBaseInput {
	title: string;
	description: string | null;
	/**
	 * Seller-trust signal in [0,1]. Populated in v2 (commit #6) from the
	 * Bayesian-shrunk review average + 1st Edition badge composite.
	 */
	sellerTrust?: number;
	/**
	 * Current cart-add count (live cart members, not historical). Refreshed
	 * by the worker from `cart_added − cart_removed` over the active cart
	 * state (docs §9 step 3). Log-scaled in the score.
	 */
	addToCartCount?: number;
	/**
	 * Listing's effective price in USD (fixed-price `price` or auction
	 * `startingBid`, both stored as `Decimal(10,2)` dollars). Null when
	 * neither is set (rare) → premium term collapses to 0 for that listing.
	 * Refresh-worker kill switch path also writes null to neutralize the term
	 * without touching other signals.
	 */
	priceUSD?: number | null;
}

function clamp01(v: number): number {
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

/**
 * Collapse whitespace + punctuation so a seller's near-identical relistings
 * key to the same string. "Charizard #4 (PSA 10)!!" → "charizard 4 psa 10".
 * Shared by the low-effort title-echo test and the diversity dedup.
 */
function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * The cold-start signal with real variance: a near-empty description, or one
 * that just echoes the title. v2 keeps this exactly as in v1 — the new
 * `addToCartCount` and `tokenBoost` signals are about *promoting* the top,
 * not changing what the bottom looks like.
 */
function isLowEffortListing(
	title: string,
	description: string | null,
): boolean {
	const d = (description ?? "").trim();
	if (d.length <= LOW_EFFORT_DESC_MAX_CHARS) return true;
	return normalizeTitle(d) === normalizeTitle(title);
}

function isLongTitle(title: string): boolean {
	return title.length > LONG_TITLE_MAX_CHARS;
}

/**
 * Pre-compiled word-boundary regexes for the negative-keyword scan. One
 * combined alternation per call to `matchesNegativeKeyword` would mean
 * recompiling on every score; instead compile once at module load and reuse.
 * Word-boundary `\b…\b` keeps "proxy" from firing on "approximately" and
 * "wooden" from firing on "woodenly" etc.
 */
const NEGATIVE_KEYWORD_REGEX = new RegExp(
	`\\b(?:${NEGATIVE_KEYWORDS.map((k) =>
		k.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
	).join("|")})\\b`,
	"i",
);

/**
 * True when the listing's title or description matches any
 * `NEGATIVE_KEYWORDS` entry. Joins title + description with a space so a
 * keyword in either field fires the match. Case-insensitive,
 * whole-word — see `NEGATIVE_KEYWORD_REGEX` for the false-positive guards.
 */
export function matchesNegativeKeyword(
	title: string,
	description: string | null,
): boolean {
	const haystack = `${title} ${description ?? ""}`;
	return NEGATIVE_KEYWORD_REGEX.test(haystack);
}

/**
 * Time-independent part of the score:
 *   sellerTrust·w + cartAdd·w + premium·w
 *     − lowEffort?·penalty − longTitle?·penalty − negKeyword?·penalty
 *
 * The premium term dominates the additive terms by design — at weight 0.30,
 * a $1,000 listing contributes ~0.90 to the base, more than 4× the max
 * cart-add contribution at realistic counts (`0.10·log10(101) ≈ 0.20`). This
 * is intentional cold-start positioning: no engagement signal exists yet,
 * so price is doing the differentiation work. The weight ramps DOWN as
 * engagement accrues; see `RankingConfig.weights.premium` for the trigger.
 */
export function computeRankBaseScore(
	input: RankBaseInput,
	config: RankingConfig,
): number {
	const trust = config.weights.sellerTrust * clamp01(input.sellerTrust ?? 0);
	const cartAddCount = Math.max(0, input.addToCartCount ?? 0);
	const cartAdd = config.weights.cartAdd * Math.log10(1 + cartAddCount);
	const priceUSD = input.priceUSD;
	let premium = 0;
	if (priceUSD !== null && priceUSD !== undefined && priceUSD > 0) {
		if (priceUSD < CHEAP_FLOOR_THRESHOLD_USD) {
			premium = -CHEAP_FLOOR_PENALTY;
		} else {
			const cappedPrice = Math.min(priceUSD, PREMIUM_PRICE_CEILING_USD);
			premium = config.weights.premium * Math.log10(1 + cappedPrice);
		}
	}
	const lowEffort = isLowEffortListing(input.title, input.description)
		? config.lowEffortPenalty
		: 0;
	const longTitle = isLongTitle(input.title) ? config.longTitlePenalty : 0;
	const negativeKeyword = matchesNegativeKeyword(input.title, input.description)
		? config.negativeKeywordPenalty
		: 0;
	return trust + cartAdd + premium - lowEffort - longTitle - negativeKeyword;
}

export interface RankScoreInput {
	rankBaseScore: number;
	createdAt: Date;
	now: Date;
	/**
	 * Per-listing multiplicative boost from `computeTokenBoost`. Defaults to
	 * `TOKEN_BOOST_MIN` (1.0 = neutral) so callers that don't yet supply it
	 * (legacy code paths, kill-switch state) get the additive v1-equivalent
	 * form. The v2 refresh worker writes this column on every listing.
	 */
	tokenBoost?: number;
	/**
	 * Per-listing multiplicative price-vs-median modifier from
	 * `computePriceMult`. Defaults to 1.0 (neutral) so callers that don't
	 * yet supply it (no price on listing, no median for matched tokens) get
	 * the unmodified token-boosted score.
	 */
	priceMult?: number;
}

export interface ComputePriceMultInput {
	/**
	 * Listing's effective price in USD. For fixed-price listings, the
	 * decimal `price`. For auctions, `startingBid` (cents) divided by 100.
	 * Null when the listing has no price (rare); collapses to neutral.
	 */
	priceUSD: number | null;
	/**
	 * Reference median price (USD) for the listing's best-matched dictionary
	 * token. "Best" = highest median across matched tokens — premium tokens
	 * (psa_10, alt_art) typically pull the reference up, which is the right
	 * behavior: a cheap PSA 10 is suspicious vs PSA 10 median, not vs
	 * character median. Null when no matched token has enough listings to
	 * compute a median; collapses to neutral.
	 */
	refMedianUSD: number | null;
}

/**
 * Per-listing price-vs-median multiplicative modifier (NL-310 commit #8.5 —
 * docs/explore-ranking-v2.md §10). Pure function over (listing price,
 * reference median, config).
 *
 *   ratio   = priceUSD / refMedianUSD
 *   sigmoid = tanh(log2(max(ratio, 0.01)))
 *   mult    = clamp(min, max, 1 + k · sigmoid)
 *
 * `log2(ratio)` puts the ratio on a symmetric log scale: 0.5x = -1,
 * 1x = 0, 2x = +1. `tanh` bounds the response so extreme ratios saturate
 * smoothly (no hard cliff at the clamp). Final clamp to `[priceMultMin,
 * priceMultMax]` keeps any single signal from dominating the rest.
 *
 * Edge cases:
 *   - `priceUSD ≤ 0` or null: neutral (1.0). Auctions before listing,
 *     listings with no price set.
 *   - `refMedianUSD ≤ 0` or null: neutral. Token bucket has no priced
 *     listings yet (cold-start), or no token matched.
 *   - `ratio < 0.01`: floored before log2 to avoid `-Infinity`. A listing
 *     priced at 1% of median or less hits the same demerit as 1% of median
 *     exactly — saturated.
 *
 * v2 rationale (docs §10):
 *   - Cheap-and-below-median listings ($1 commons with the right token,
 *     wooden curios priced like graded cards) get a small demerit so
 *     premium-tier inventory surfaces above them.
 *   - Above-median listings get a small lift so PSA 10s and graded
 *     premiums rise above raw versions of the same character.
 *   - Bounded range so price isn't a dominant lever: it complements
 *     engagement signals, doesn't compete with them.
 */
export function computePriceMult(
	input: ComputePriceMultInput,
	config: RankingConfig,
): number {
	if (input.priceUSD === null || input.priceUSD <= 0) return 1.0;
	if (input.refMedianUSD === null || input.refMedianUSD <= 0) return 1.0;
	const ratio = input.priceUSD / input.refMedianUSD;
	const sigmoid = Math.tanh(Math.log2(Math.max(ratio, 0.01)));
	return Math.max(
		config.priceMultMin,
		Math.min(config.priceMultMax, 1.0 + config.priceMultSensitivity * sigmoid),
	);
}

/**
 * Full score = (stored base + weighted recency decay) · tokenBoost · priceMult.
 * Both multiplicative modifiers default to 1.0 (neutral), so a caller that
 * supplies neither collapses cleanly to the v1 additive form. Kill-switch
 * paths write 1.0 to either column to neutralize that signal without
 * touching the others (docs §2, §8, §10).
 *
 * Composition order is irrelevant for the math (both are scalar
 * multipliers) but the ranking-design intent is:
 *   - tokenBoost amplifies the catalog-wide popularity of the listing's
 *     subject (charizard > generic);
 *   - priceMult differentiates listings within the same token bucket by
 *     how their price compares to that bucket's median (PSA 10 above raw,
 *     bulk-cheap below).
 */
export function computeRankScore(
	{
		rankBaseScore,
		createdAt,
		now,
		tokenBoost = TOKEN_BOOST_MIN,
		priceMult = 1.0,
	}: RankScoreInput,
	config: RankingConfig,
): number {
	const ageHours = Math.max(
		0,
		(now.getTime() - createdAt.getTime()) / 3_600_000,
	);
	const recency = 0.5 ** (ageHours / config.recencyHalfLifeHours);
	return (
		(rankBaseScore + config.weights.recency * recency) * tokenBoost * priceMult
	);
}

export interface ComputeTokenBoostInput {
	/**
	 * EB posterior means (`pHat`) of every token matched in the listing's
	 * title. Empty = no matches → `tokenBoost = TOKEN_BOOST_MIN`. The caller
	 * (refresh worker) resolves `MatchedToken[] → number[]` from the
	 * `token_popularity` table; tokens with no row yet (cold-start) are
	 * filtered out by the caller before getting here.
	 */
	tokenPHats: ReadonlyArray<number>;
	/**
	 * Mean of pHat across all known tokens at this refresh tick — the
	 * z-score baseline. Recomputed by the refresh worker each tick from the
	 * full `token_popularity` table.
	 */
	mu: number;
	/**
	 * Stdev of pHat across all known tokens at this refresh tick. ≤ 0
	 * collapses the boost to neutral (no signal to amplify).
	 */
	sigma: number;
	titleLen: number;
}

/**
 * Per-listing token-popularity boost. Pure function over (matched tokens'
 * pHats, population stats, title length).
 *
 *   raw       = 1 + k · (max(tokenPHats) − μ) / σ
 *   clamped   = clamp(raw, [TOKEN_BOOST_MIN, TOKEN_BOOST_MAX])
 *   damped    = clamped · min(1, LONG_TITLE_MAX_CHARS / titleLen)   if matched
 *             = TOKEN_BOOST_MIN                                      if not
 *
 * MAX of tokens (never sum, never mean) is the anti-keyword-stuffing guard —
 * Etsy and eBay converged on this independently (docs §2). The length damper
 * pairs with the additive `longTitlePenalty` on the base score so anyone
 * stuffing 5 hot tokens in a 120-char title pays both penalties; a listing
 * with no matched tokens skips the damper (it's a token-side correction, not
 * a universal long-title penalty — that's what `longTitlePenalty` is for).
 */
export function computeTokenBoost(
	input: ComputeTokenBoostInput,
	config: RankingConfig,
): number {
	if (input.tokenPHats.length === 0) return TOKEN_BOOST_MIN;
	if (input.sigma <= 0) return TOKEN_BOOST_MIN;

	let maxPHat = -Infinity;
	for (const p of input.tokenPHats) {
		if (p > maxPHat) maxPHat = p;
	}
	if (!Number.isFinite(maxPHat)) return TOKEN_BOOST_MIN;

	const z = (maxPHat - input.mu) / input.sigma;
	const raw = 1 + config.tokenBoostSensitivity * z;
	const clamped = Math.max(TOKEN_BOOST_MIN, Math.min(TOKEN_BOOST_MAX, raw));

	if (input.titleLen <= 0) return clamped;
	const lengthMult = Math.min(1, LONG_TITLE_MAX_CHARS / input.titleLen);
	return clamped * lengthMult;
}

/**
 * Re-exported so callers wiring the refresh worker don't have to import from
 * two different modules to assemble a `computeTokenBoost` call.
 */
export type { MatchedToken };

export interface DiversityCandidate {
	id: string;
	sellerProfileId: string;
	title: string;
}

/**
 * Global per-seller cap + near-identical dedup, applied ONCE over the full
 * ordered candidate list at snapshot-build time, BEFORE slicing. Demote
 * (push to a tail appended after the capped list) — never drop — so result
 * count is preserved and a small-catalog seller is never erased. Because
 * pagination is then a pure slice of this array, the global cap is exactly
 * correct across every page by construction (docs/explore-ranking.md §9).
 *
 * Unchanged from v1.
 */
export function applyDiversity(
	ordered: DiversityCandidate[],
	config: RankingConfig,
): string[] {
	const sellerCount = new Map<string, number>();
	const seenTitles = new Set<string>();
	const kept: string[] = [];
	const tail: string[] = [];

	for (const c of ordered) {
		const count = sellerCount.get(c.sellerProfileId) ?? 0;
		const titleKey = `${c.sellerProfileId}:${normalizeTitle(c.title)}`;

		if (count >= config.perSellerCap || seenTitles.has(titleKey)) {
			tail.push(c.id);
			continue;
		}

		kept.push(c.id);
		sellerCount.set(c.sellerProfileId, count + 1);
		seenTitles.add(titleKey);
	}

	return kept.concat(tail);
}
