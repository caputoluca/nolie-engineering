/**
 * /explore default-feed ranking — pure scorer + diversity pass (NL-284).
 *
 * v1 calibration (locked after analysing the live catalog — see
 * docs/explore-ranking.md §5): a cold-start, tool-generated collectibles
 * catalog has NO usable positive quality variance. ~79% of listings have
 * exactly 2 photos, description length is a spike (median 81 / p90 101 chars,
 * bulk-lister templates), and every listing has a price — so `photoCount`,
 * `descLen` and `priceComplete` are all inert and a graded "quality" weight
 * would be fiction. Median time-to-sale is 1.4d (p90 6.6d), so recency IS the
 * right primary signal, not a compromise. The one real signal is the *bottom*:
 * title-echo / near-empty listings (~10%). So v1 = recency-dominant + a soft
 * low-effort demerit + the per-seller diversity cap. `sellerTrust` stays a
 * live seam (weight 0 in v1; the 1st Edition badge fast-follow NL-266 flips it
 * to 0.20 by populating the input — no formula rewrite). Graded quality and
 * price tiers were removed, not zeroed: re-deriving them would need a real,
 * varying signal this vertical doesn't have at cold-start.
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
		/**
		 * Seller-trust weight. 0 in v1 (`sellerTrust` input is inert); the
		 * 1st Edition badge fast-follow (NL-266) flips this to 0.20.
		 */
		sellerTrust: number;
	};
	recencyHalfLifeHours: number;
	perSellerCap: number;
	/**
	 * Soft demerit subtracted from the base for title-echo / near-empty
	 * listings. Never a WHERE filter — fully reversible by setting it to 0.
	 */
	lowEffortPenalty: number;
}

/**
 * Bumped when the inputs or weights feeding `rankBaseScore` change. The
 * refresh job recomputes any row whose stored `rankBaseVersion` is lower
 * (docs/explore-ranking.md §7 step 2) — this doubles as the
 * retune-without-migration path. v1→2: photoCount/priceTier base replaced by
 * the low-effort demerit after the cold-start catalog analysis.
 */
export const RANK_BASE_VERSION = 2;

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
	weights: { recency: 0.45, sellerTrust: 0 },
	recencyHalfLifeHours: 72, // validated: 1.4d median / 6.6d p90 sell-through
	perSellerCap: 3,
	lowEffortPenalty: 0.12, // ≈1.3 days of recency: a visible demote, not burial
};

/**
 * A trimmed description at or under this many characters is low-effort:
 * catches "NM", "Mint condition", "Promo - NM", "HP CONDITION" and the like
 * (the ≤20-char tail measured at ~8% of the live catalog).
 */
const LOW_EFFORT_DESC_MAX_CHARS = 20;

export interface RankBaseInput {
	title: string;
	description: string | null;
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
 * The only signal with real variance in a cold-start tool-generated catalog:
 * a near-empty description, or one that just echoes the title. Everything
 * else (photo count, description length, price-complete) is structurally
 * constant here, so v1 demotes the bottom rather than grading a fictional top.
 */
function isLowEffortListing(
	title: string,
	description: string | null,
): boolean {
	const d = (description ?? "").trim();
	if (d.length <= LOW_EFFORT_DESC_MAX_CHARS) return true;
	return normalizeTitle(d) === normalizeTitle(title);
}

/**
 * Time-independent part of the score: weighted sellerTrust (0 in v1) minus a
 * soft low-effort demerit. Written at listing create/update; rarely changes.
 * Range in v1: [-lowEffortPenalty, 0].
 */
export function computeRankBaseScore(
	input: RankBaseInput,
	config: RankingConfig,
): number {
	const trust = config.weights.sellerTrust * clamp01(input.sellerTrust ?? 0);
	const penalty = isLowEffortListing(input.title, input.description)
		? config.lowEffortPenalty
		: 0;
	return trust - penalty;
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
