/**
 * /explore default-feed ranking — pure scorer + diversity pass (NL-284).
 *
 * No I/O, no clock access: `now` is injected into `computeRankScore` so the
 * worker refresh job is the sole owner of the time-varying term and the
 * function stays deterministically testable. Weights/cap/penalty live in an
 * immutable `RankingConfig` that is PASSED IN — never read from a module
 * global — so tests can override it and runtime-config/LTR slot in later
 * behind the same signatures (docs/explore-ranking.md §5, §11).
 */

export interface RankingConfig {
	weights: {
		recency: number;
		quality: number;
		sellerTrust: number;
		priceTier: number;
	};
	recencyHalfLifeHours: number;
	perSellerCap: number;
	/** Soft multiplier applied to the bottom price band — never a WHERE filter. */
	priceFloorPenalty: number;
}

/**
 * Bumped when the inputs or weights feeding `rankBaseScore` change. The
 * refresh job recomputes any row whose stored `rankBaseVersion` is lower
 * (docs/explore-ranking.md §7 step 2) — this doubles as the
 * retune-without-migration path.
 */
export const RANK_BASE_VERSION = 1;

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
	// v1 (Path A): sellerTrust = 0. identityVerified is a listing eligibility
	// gate (constant across every listing ⇒ zero ranking power) and is
	// deliberately absent from the formula. The 1st Edition badge fast-follow
	// (NL-266) flips this weight to 0.20 by populating `sellerTrust` from the
	// existing first_edition determination — no formula rewrite.
	weights: { recency: 0.45, quality: 0.25, sellerTrust: 0, priceTier: 0.1 },
	recencyHalfLifeHours: 72,
	perSellerCap: 3,
	priceFloorPenalty: 0.5,
};

/**
 * Ascending price-band ceilings in cents. Band index `b` (0..N-1) maps to
 * tier `(b + 1) / N` ∈ {0.2..1.0} — deliberately NOT `b / (N-1)`, because
 * that puts the lowest band at exactly 0 and then `0 * priceFloorPenalty`
 * is inert: the penalty knob would do nothing. The `+1` gives the bottom
 * band a non-zero base (0.2) for the soft `priceFloorPenalty` down-rank to
 * actually bite and stay tunable. Fixed bands (not data-driven deciles) so
 * the scorer stays pure — it can't know the catalog distribution.
 */
const PRICE_BAND_CEILINGS_CENTS = [500, 2500, 10_000, 50_000] as const;
const PRICE_BAND_COUNT = PRICE_BAND_CEILINGS_CENTS.length + 1;

/** Neutral tier for a listing with no representative price (auction w/o data). */
const NEUTRAL_PRICE_TIER = 0.5;

export interface RankBaseInput {
	/** Gallery + hero image count. v1's only quality sub-feature. */
	photoCount: number;
	/**
	 * Representative price in cents: fixed-price `price`, else auction
	 * `startingBid`. Null ⇒ neutral price tier.
	 */
	priceCents: number | null;
	/**
	 * Seller-trust signal in [0,1]. v1 weight is 0 so the value is inert;
	 * the seam exists so the badge fast-follow only has to populate it.
	 */
	sellerTrust?: number;
}

function clamp01(v: number): number {
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

/**
 * Listing-quality sub-score in [0,1]. v1 = photo completeness only.
 * FAST-FOLLOW extends this to the mean of (photos, description length,
 * price-complete) — a one-line change here, no caller impact.
 */
function computeQuality(input: RankBaseInput): number {
	return clamp01(Math.min(input.photoCount, 5) / 5);
}

/** Price-tier sub-score in [0,1]; bottom band softly down-ranked. */
function computePriceTier(
	priceCents: number | null,
	config: RankingConfig,
): number {
	if (priceCents == null) return NEUTRAL_PRICE_TIER;

	let band: number = PRICE_BAND_CEILINGS_CENTS.length;
	for (let i = 0; i < PRICE_BAND_CEILINGS_CENTS.length; i++) {
		const ceiling = PRICE_BAND_CEILINGS_CENTS[i];
		if (ceiling !== undefined && priceCents < ceiling) {
			band = i;
			break;
		}
	}

	const tier = (band + 1) / PRICE_BAND_COUNT;
	return band === 0 ? tier * config.priceFloorPenalty : tier;
}

/**
 * Time-independent part of the score: weighted quality + sellerTrust +
 * priceTier. Written at listing create/update; rarely changes.
 */
export function computeRankBaseScore(
	input: RankBaseInput,
	config: RankingConfig,
): number {
	const { weights } = config;
	const quality = computeQuality(input);
	const sellerTrust = clamp01(input.sellerTrust ?? 0);
	const priceTier = computePriceTier(input.priceCents, config);

	return (
		weights.quality * quality +
		weights.sellerTrust * sellerTrust +
		weights.priceTier * priceTier
	);
}

export interface RankScoreInput {
	rankBaseScore: number;
	createdAt: Date;
	now: Date;
}

/**
 * Full score = stored base + weighted recency decay. recency =
 * 0.5 ^ (ageHours / halfLife) ∈ (0,1] — the only time-varying input.
 * Age is floored at 0 so a clock-skewed future `createdAt` can't exceed 1.
 */
export function computeRankScore(
	{ rankBaseScore, createdAt, now }: RankScoreInput,
	config: RankingConfig,
): number {
	const ageHours = Math.max(
		0,
		(now.getTime() - createdAt.getTime()) / 3_600_000,
	);
	const recency = 0.5 ** (ageHours / config.recencyHalfLifeHours);
	return rankBaseScore + config.weights.recency * recency;
}

export interface DiversityCandidate {
	id: string;
	sellerProfileId: string;
	title: string;
}

/**
 * Collapse whitespace + punctuation so a seller's near-identical relistings
 * key to the same string. "Charizard #4 (PSA 10)!!" → "charizard 4 psa 10".
 */
function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * Global per-seller cap + near-identical dedup, applied ONCE over the full
 * ordered candidate list at snapshot-build time, BEFORE slicing. Demote
 * (push to a tail appended after the capped list) — never drop — so result
 * count is preserved and a small-catalog seller is never erased. Because
 * pagination is then a pure slice of this array, the global cap is exactly
 * correct across every page by construction (docs/explore-ranking.md §9).
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
