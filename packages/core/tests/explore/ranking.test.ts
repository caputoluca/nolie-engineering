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

// v1 (sellerTrust weight 0): base ∈ [-lowEffortPenalty, 0], full score ∈
// [-lowEffortPenalty, recencyWeight].
const PENALTY = DEFAULT_RANKING_CONFIG.lowEffortPenalty; // 0.12
const RECENCY_W = DEFAULT_RANKING_CONFIG.weights.recency; // 0.45

// The cold-start catalog norm: a ~80-char bulk-lister template. Must NOT be
// treated as low-effort (median desc len is 81 chars — see §5 analysis).
const TEMPLATE_DESC =
	"Charizard 4/102 from Base Set (1999). See photos for exact condition.";

describe("computeRankBaseScore / computeRankScore", () => {
	it("keeps base and full scores within v1 bounds across extremes", () => {
		const extremes = [
			{ title: "Charizard", description: null }, // empty ⇒ low-effort
			{ title: "Charizard", description: "Charizard" }, // title echo
			{ title: "Charizard", description: TEMPLATE_DESC }, // normal
		];
		const now = new Date("2026-05-17T12:00:00Z");
		const ages = [now, new Date("2010-01-01T00:00:00Z")]; // now and very old

		for (const input of extremes) {
			const base = computeRankBaseScore(input, DEFAULT_RANKING_CONFIG);
			expect(base).toBeGreaterThanOrEqual(-PENALTY);
			expect(base).toBeLessThanOrEqual(0);

			for (const createdAt of ages) {
				const score = computeRankScore(
					{ rankBaseScore: base, createdAt, now },
					DEFAULT_RANKING_CONFIG,
				);
				expect(score).toBeGreaterThanOrEqual(-PENALTY);
				expect(score).toBeLessThanOrEqual(RECENCY_W);
			}
		}
	});

	it("scores a newer listing strictly higher than an older one with the same base", () => {
		const now = new Date("2026-05-17T12:00:00Z");
		const rankBaseScore = 0;

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
		const rankBaseScore = 0;
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
		const rankBaseScore = 0;

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

	it("softly demotes low-effort listings (empty / title-echo) but not the template norm", () => {
		const title = "2002 Pokemon 151 Nidoran 029/165";

		const empty = computeRankBaseScore(
			{ title, description: null },
			DEFAULT_RANKING_CONFIG,
		);
		const tooShort = computeRankBaseScore(
			{ title, description: "NM" },
			DEFAULT_RANKING_CONFIG,
		);
		const titleEcho = computeRankBaseScore(
			{ title, description: "  2002 Pokemon 151 Nidoran 029/165  " },
			DEFAULT_RANKING_CONFIG,
		);
		const normal = computeRankBaseScore(
			{ title, description: TEMPLATE_DESC },
			DEFAULT_RANKING_CONFIG,
		);

		// Every low-effort form gets the same soft demerit; the template norm
		// is untouched (a graded quality score would be fiction here — §5).
		expect(empty).toBe(-PENALTY);
		expect(tooShort).toBe(-PENALTY);
		expect(titleEcho).toBe(-PENALTY);
		expect(normal).toBe(0);
		expect(normal).toBeGreaterThan(titleEcho);

		// The demerit is a soft down-rank, not burial: a fresh low-effort
		// listing still outranks the same listing a week later.
		const now = new Date("2026-05-17T12:00:00Z");
		const freshLowEffort = computeRankScore(
			{ rankBaseScore: empty, createdAt: now, now },
			DEFAULT_RANKING_CONFIG,
		);
		expect(freshLowEffort).toBeGreaterThan(0);
	});

	it("the lowEffortPenalty knob is fully reversible (0 ⇒ no demerit)", () => {
		const input = { title: "Charizard", description: null };

		const penalized = computeRankBaseScore(input, DEFAULT_RANKING_CONFIG);
		const off = computeRankBaseScore(input, {
			...DEFAULT_RANKING_CONFIG,
			lowEffortPenalty: 0,
		});

		expect(penalized).toBe(-PENALTY);
		expect(off).toBe(0);
	});

	it("keeps the sellerTrust seam inert at weight 0 but live when the weight is flipped", () => {
		const input = { title: "Charizard", description: TEMPLATE_DESC };

		// v1: weight 0 ⇒ a trusted seller scores identically to an unknown one.
		const trustedV1 = computeRankBaseScore(
			{ ...input, sellerTrust: 1 },
			DEFAULT_RANKING_CONFIG,
		);
		const unknownV1 = computeRankBaseScore(
			{ ...input, sellerTrust: 0 },
			DEFAULT_RANKING_CONFIG,
		);
		expect(trustedV1).toBe(unknownV1);

		// Badge fast-follow (NL-266): flip the weight, no formula rewrite.
		const withBadge: RankingConfig = {
			...DEFAULT_RANKING_CONFIG,
			weights: { ...DEFAULT_RANKING_CONFIG.weights, sellerTrust: 0.2 },
		};
		const trusted = computeRankBaseScore(
			{ ...input, sellerTrust: 1 },
			withBadge,
		);
		const unknown = computeRankBaseScore(
			{ ...input, sellerTrust: 0 },
			withBadge,
		);
		expect(trusted).toBeGreaterThan(unknown);
		expect(trusted - unknown).toBeCloseTo(0.2, 10);
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
