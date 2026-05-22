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
 */
export const RANK_BASE_VERSION = 4;

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
	weights: { recency: 0.3, sellerTrust: 0.05, cartAdd: 0.1 },
	recencyHalfLifeHours: 72,
	perSellerCap: 3,
	lowEffortPenalty: 0.12,
	longTitlePenalty: 0.04,
	tokenBoostSensitivity: 0.2,
};

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
 * Time-independent part of the score. v2 form:
 *   sellerTrust·w − lowEffort?·penalty − longTitle?·penalty + log10(1+atc)·w
 *
 * Range with default config: roughly `[-0.16, 0.05 + cartAdd]`. The cart-add
 * term is unbounded in principle but log10-capped in practice; a listing with
 * 100 cart-adds (the historical max we'd expect in v2) contributes
 * `0.10·log10(101) ≈ 0.20`.
 */
export function computeRankBaseScore(
	input: RankBaseInput,
	config: RankingConfig,
): number {
	const trust = config.weights.sellerTrust * clamp01(input.sellerTrust ?? 0);
	const cartAddCount = Math.max(0, input.addToCartCount ?? 0);
	const cartAdd = config.weights.cartAdd * Math.log10(1 + cartAddCount);
	const lowEffort = isLowEffortListing(input.title, input.description)
		? config.lowEffortPenalty
		: 0;
	const longTitle = isLongTitle(input.title) ? config.longTitlePenalty : 0;
	return trust + cartAdd - lowEffort - longTitle;
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
}

/**
 * Full score = (stored base + weighted recency decay) · tokenBoost.
 * Multiplicative on tokenBoost only — additive composition would let a hot
 * token dominate and there'd be no clean kill switch. tokenBoost = 1.0
 * collapses to the v1 additive form algebraically (docs §2, §8).
 */
export function computeRankScore(
	{
		rankBaseScore,
		createdAt,
		now,
		tokenBoost = TOKEN_BOOST_MIN,
	}: RankScoreInput,
	config: RankingConfig,
): number {
	const ageHours = Math.max(
		0,
		(now.getTime() - createdAt.getTime()) / 3_600_000,
	);
	const recency = 0.5 ** (ageHours / config.recencyHalfLifeHours);
	return (rankBaseScore + config.weights.recency * recency) * tokenBoost;
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
