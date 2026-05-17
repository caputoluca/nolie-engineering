import { describe, expect, it } from "vitest";
import {
	applyDiversity,
	computeRankBaseScore,
	computeRankScore,
	DEFAULT_RANKING_CONFIG,
	type DiversityCandidate,
	type RankingConfig,
} from "../../src/explore/ranking.js";

const HOUR_MS = 3_600_000;

// v1 (sellerTrust weight 0): base ∈ [0, 0.35], full score ∈ [0, 0.80].
const BASE_MAX = 0.35;
const SCORE_MAX = 0.8;

describe("computeRankBaseScore / computeRankScore", () => {
	it("keeps base and full scores within v1 bounds across extremes", () => {
		const extremes = [
			{ photoCount: 0, priceCents: null },
			{ photoCount: 0, priceCents: 100 }, // bottom price band
			{ photoCount: 5, priceCents: 100_000 }, // top price band
			{ photoCount: 50, priceCents: 100_000 }, // photo count saturated
		];
		const now = new Date("2026-05-17T12:00:00Z");
		const ages = [now, new Date("2010-01-01T00:00:00Z")]; // now and very old

		for (const input of extremes) {
			const base = computeRankBaseScore(input, DEFAULT_RANKING_CONFIG);
			expect(base).toBeGreaterThanOrEqual(0);
			expect(base).toBeLessThanOrEqual(BASE_MAX);

			for (const createdAt of ages) {
				const score = computeRankScore(
					{ rankBaseScore: base, createdAt, now },
					DEFAULT_RANKING_CONFIG,
				);
				expect(score).toBeGreaterThanOrEqual(0);
				expect(score).toBeLessThanOrEqual(SCORE_MAX);
			}
		}
	});

	it("scores a newer listing strictly higher than an older one with the same base", () => {
		const now = new Date("2026-05-17T12:00:00Z");
		const rankBaseScore = 0.2;

		const newer = computeRankScore(
			{
				rankBaseScore,
				createdAt: new Date(now.getTime() - 1 * HOUR_MS),
				now,
			},
			DEFAULT_RANKING_CONFIG,
		);
		const older = computeRankScore(
			{
				rankBaseScore,
				createdAt: new Date(now.getTime() - 240 * HOUR_MS),
				now,
			},
			DEFAULT_RANKING_CONFIG,
		);

		expect(newer).toBeGreaterThan(older);
	});

	it("halves the recency contribution at exactly one half-life of age", () => {
		const now = new Date("2026-05-17T12:00:00Z");
		const rankBaseScore = 0.2;
		const { recencyHalfLifeHours } = DEFAULT_RANKING_CONFIG;

		const atHalfLife = computeRankScore(
			{
				rankBaseScore,
				createdAt: new Date(now.getTime() - recencyHalfLifeHours * HOUR_MS),
				now,
			},
			DEFAULT_RANKING_CONFIG,
		);

		const recencyContribution = atHalfLife - rankBaseScore;
		const ageZeroContribution = DEFAULT_RANKING_CONFIG.weights.recency; // 0.5^0 = 1
		expect(recencyContribution).toBeCloseTo(ageZeroContribution * 0.5, 10);
	});

	it("floors a future-dated createdAt at age 0 (never exceeds the age-0 max)", () => {
		const now = new Date("2026-05-17T12:00:00Z");
		const rankBaseScore = 0.3;

		const future = computeRankScore(
			{
				rankBaseScore,
				createdAt: new Date(now.getTime() + 100 * HOUR_MS),
				now,
			},
			DEFAULT_RANKING_CONFIG,
		);
		const ageZero = computeRankScore(
			{ rankBaseScore, createdAt: now, now },
			DEFAULT_RANKING_CONFIG,
		);

		expect(future).toBe(ageZero);
		expect(future).toBe(rankBaseScore + DEFAULT_RANKING_CONFIG.weights.recency);
	});

	it("raises a photo-rich listing's base score when the quality weight increases", () => {
		const input = { photoCount: 5, priceCents: 100_000 };

		const higherQuality: RankingConfig = {
			...DEFAULT_RANKING_CONFIG,
			weights: { ...DEFAULT_RANKING_CONFIG.weights, quality: 0.5 },
		};

		const baseDefault = computeRankBaseScore(input, DEFAULT_RANKING_CONFIG);
		const baseHigher = computeRankBaseScore(input, higherQuality);

		expect(baseHigher).toBeGreaterThan(baseDefault);
	});

	it("gives more photos a higher base score and saturates at 5", () => {
		const priceCents = 100_000;
		const zero = computeRankBaseScore(
			{ photoCount: 0, priceCents },
			DEFAULT_RANKING_CONFIG,
		);
		const three = computeRankBaseScore(
			{ photoCount: 3, priceCents },
			DEFAULT_RANKING_CONFIG,
		);
		const five = computeRankBaseScore(
			{ photoCount: 5, priceCents },
			DEFAULT_RANKING_CONFIG,
		);
		const six = computeRankBaseScore(
			{ photoCount: 6, priceCents },
			DEFAULT_RANKING_CONFIG,
		);

		expect(three).toBeGreaterThan(zero);
		expect(five).toBeGreaterThan(three);
		expect(six).toBe(five); // min(photoCount, 5) / 5 saturates
	});

	it("softly down-ranks the bottom price band and treats null price as neutral middle", () => {
		const photoCount = 0; // isolate the priceTier contribution
		const bottomBand = computeRankBaseScore(
			{ photoCount, priceCents: 100 }, // < 500 ⇒ bottom band
			DEFAULT_RANKING_CONFIG,
		);
		const higherBand = computeRankBaseScore(
			{ photoCount, priceCents: 1_000 }, // 500..2500 ⇒ band above bottom
			DEFAULT_RANKING_CONFIG,
		);
		const nullPrice = computeRankBaseScore(
			{ photoCount, priceCents: null },
			DEFAULT_RANKING_CONFIG,
		);

		expect(bottomBand).toBeLessThan(higherBand);
		// null is the neutral 0.5 tier — above the bottom band, not penalized.
		expect(nullPrice).toBeGreaterThan(bottomBand);
		expect(nullPrice).toBeGreaterThan(higherBand);

		// The priceFloorPenalty knob must actually move the bottom band —
		// guards the regression where band 0's tier was 0 so the multiplier
		// was inert (any penalty produced the same score).
		const penalized = computeRankBaseScore(
			{ photoCount, priceCents: 100 },
			{ ...DEFAULT_RANKING_CONFIG, priceFloorPenalty: 0.5 },
		);
		const unpenalized = computeRankBaseScore(
			{ photoCount, priceCents: 100 },
			{ ...DEFAULT_RANKING_CONFIG, priceFloorPenalty: 1 },
		);
		expect(penalized).toBeLessThan(unpenalized);
	});
});

describe("applyDiversity", () => {
	const cand = (
		id: string,
		sellerProfileId: string,
		title = id,
	): DiversityCandidate => ({ id, sellerProfileId, title });

	it("demotes a seller's 4th item past the cap without dropping anything", () => {
		const ordered: DiversityCandidate[] = [
			cand("a1", "A", "alpha"),
			cand("b1", "B", "beta"),
			cand("a2", "A", "gamma"),
			cand("c1", "C", "delta"),
			cand("a3", "A", "epsilon"),
			cand("a4", "A", "zeta"), // 4th from A — over perSellerCap (3)
			cand("d1", "D", "eta"),
		];

		const result = applyDiversity(ordered, DEFAULT_RANKING_CONFIG);

		// Nothing dropped: same length, same id set.
		expect(result).toHaveLength(ordered.length);
		expect(new Set(result)).toEqual(new Set(ordered.map((c) => c.id)));

		// a4 is demoted to the very end (after all kept items).
		expect(result[result.length - 1]).toBe("a4");

		// Relative order of the kept items is otherwise preserved.
		expect(result.slice(0, ordered.length - 1)).toEqual([
			"a1",
			"b1",
			"a2",
			"c1",
			"a3",
			"d1",
		]);
	});

	it("demotes a same-seller near-identical duplicate even under the cap", () => {
		const ordered: DiversityCandidate[] = [
			cand("a1", "A", "Charizard #4!!!"),
			cand("a2", "A", "  charizard 4  "), // normalizes equal to a1, same seller
			cand("b1", "B", "Charizard #4!!!"), // same title, DIFFERENT seller
		];

		const result = applyDiversity(ordered, DEFAULT_RANKING_CONFIG);

		expect(result).toHaveLength(3);
		// a2 is the near-dup of a1 (same seller) ⇒ demoted to the tail.
		expect(result).toEqual(["a1", "b1", "a2"]);
	});

	it("holds the per-seller cap across every simulated page slice", () => {
		const cap = DEFAULT_RANKING_CONFIG.perSellerCap; // 3
		const pageSize = 4;

		// Seller A appears far more than `cap` times, interleaved with fillers.
		// A naive per-page cap would still let A occupy `cap` slots in EACH
		// page; the global pre-slice cap must keep A's total in the kept region
		// at exactly `cap`.
		const ordered: DiversityCandidate[] = [];
		let filler = 0;
		for (let i = 0; i < 20; i++) {
			ordered.push(cand(`a${i}`, "A", `a-${i}`));
			ordered.push(cand(`f${filler}`, `S${filler}`, `f-${filler}`));
			filler++;
		}

		const result = applyDiversity(ordered, DEFAULT_RANKING_CONFIG);

		// Nothing dropped.
		expect(result).toHaveLength(ordered.length);
		expect(new Set(result)).toEqual(new Set(ordered.map((c) => c.id)));

		// Kept (non-tail) region: A's demoted items all sit contiguously at the
		// end, so the kept region is everything before the first demoted id.
		const aIds = ordered
			.filter((c) => c.sellerProfileId === "A")
			.map((c) => c.id);
		const keptACount = aIds.filter(
			(id) => result.indexOf(id) < result.length - aIds.length + cap,
		).length;

		// More precisely: derive the kept region as the prefix that ends right
		// before the first over-cap A id is demoted into the tail.
		const tailStart = result.length - (aIds.length - cap);
		const kept = result.slice(0, tailStart);

		// No page — and no union of consecutive pages — exceeds the cap for A
		// within the kept region.
		for (let start = 0; start < kept.length; start += pageSize) {
			const page = kept.slice(start, start + pageSize);
			const inPage = page.filter((id) => id.startsWith("a")).length;
			expect(inPage).toBeLessThanOrEqual(cap);
		}
		for (let lo = 0; lo < kept.length; lo += pageSize) {
			for (
				let hi = lo + pageSize;
				hi <= kept.length + pageSize;
				hi += pageSize
			) {
				const union = kept.slice(lo, Math.min(hi, kept.length));
				const inUnion = union.filter((id) => id.startsWith("a")).length;
				expect(inUnion).toBeLessThanOrEqual(cap);
			}
		}

		// And the kept region contains exactly `cap` of A's items in total.
		expect(keptACount).toBe(cap);
		expect(kept.filter((id) => id.startsWith("a"))).toHaveLength(cap);
	});
});
