import { describe, expect, it } from "vitest";
import {
	applyDiversity,
	computeRankBaseScore,
	computeRankScore,
	computeTokenBoost,
	DEFAULT_RANKING_CONFIG,
	type DiversityCandidate,
	LONG_TITLE_MAX_CHARS,
	type RankingConfig,
	TOKEN_BOOST_MAX,
	TOKEN_BOOST_MIN,
} from "../../src/explore/ranking.js";

const HOUR_MS = 3_600_000;

const PENALTY = DEFAULT_RANKING_CONFIG.lowEffortPenalty; // 0.12
const LONG_PENALTY = DEFAULT_RANKING_CONFIG.longTitlePenalty; // 0.04
const RECENCY_W = DEFAULT_RANKING_CONFIG.weights.recency; // 0.30
const CART_W = DEFAULT_RANKING_CONFIG.weights.cartAdd; // 0.10
const TRUST_W = DEFAULT_RANKING_CONFIG.weights.sellerTrust; // 0.05

// A normal description: ~80-char bulk-lister template (v1 catalog median 81).
// Must NOT be treated as low-effort (cold-start data analysis — docs §5).
const TEMPLATE_DESC =
	"Charizard 4/102 from Base Set (1999). See photos for exact condition.";
// A short title kept under LONG_TITLE_MAX_CHARS so length penalty doesn't fire.
const SHORT_TITLE = "Charizard 4/102";

describe("computeRankBaseScore", () => {
	it("returns 0 for a normal listing with no sellerTrust, cart-adds, or penalties", () => {
		const base = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC },
			DEFAULT_RANKING_CONFIG,
		);
		expect(base).toBe(0);
	});

	it("applies the soft low-effort demerit to empty / title-echo listings", () => {
		const empty = computeRankBaseScore(
			{ title: SHORT_TITLE, description: null },
			DEFAULT_RANKING_CONFIG,
		);
		const tooShort = computeRankBaseScore(
			{ title: SHORT_TITLE, description: "NM" },
			DEFAULT_RANKING_CONFIG,
		);
		const titleEcho = computeRankBaseScore(
			{
				title: SHORT_TITLE,
				description: "  charizard 4 102  ",
			},
			DEFAULT_RANKING_CONFIG,
		);

		expect(empty).toBe(-PENALTY);
		expect(tooShort).toBe(-PENALTY);
		expect(titleEcho).toBe(-PENALTY);
	});

	it("adds the cart-add term log-scaled in the count", () => {
		const zero = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, addToCartCount: 0 },
			DEFAULT_RANKING_CONFIG,
		);
		const five = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, addToCartCount: 5 },
			DEFAULT_RANKING_CONFIG,
		);
		const fifty = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, addToCartCount: 50 },
			DEFAULT_RANKING_CONFIG,
		);

		expect(zero).toBe(0);
		expect(five).toBeCloseTo(CART_W * Math.log10(6), 10);
		expect(fifty).toBeCloseTo(CART_W * Math.log10(51), 10);

		// Log-scaling: the marginal value of one extra cart-add diminishes as
		// the count grows. Going from 10 → 11 adds less than going from 1 → 2,
		// even though the absolute delta is the same.
		const one = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, addToCartCount: 1 },
			DEFAULT_RANKING_CONFIG,
		);
		const two = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, addToCartCount: 2 },
			DEFAULT_RANKING_CONFIG,
		);
		const ten = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, addToCartCount: 10 },
			DEFAULT_RANKING_CONFIG,
		);
		const eleven = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, addToCartCount: 11 },
			DEFAULT_RANKING_CONFIG,
		);
		expect(two - one).toBeGreaterThan(eleven - ten);
	});

	it("treats a negative cart-add count as 0 (defensive against bad worker input)", () => {
		const out = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, addToCartCount: -3 },
			DEFAULT_RANKING_CONFIG,
		);
		expect(out).toBe(0);
	});

	it("subtracts the long-title penalty above LONG_TITLE_MAX_CHARS", () => {
		const longTitle = "x".repeat(LONG_TITLE_MAX_CHARS + 1);
		const justUnder = "x".repeat(LONG_TITLE_MAX_CHARS);

		const longBase = computeRankBaseScore(
			{ title: longTitle, description: TEMPLATE_DESC },
			DEFAULT_RANKING_CONFIG,
		);
		const justUnderBase = computeRankBaseScore(
			{ title: justUnder, description: TEMPLATE_DESC },
			DEFAULT_RANKING_CONFIG,
		);

		expect(longBase).toBe(-LONG_PENALTY);
		expect(justUnderBase).toBe(0);
	});

	it("stacks the low-effort and long-title penalties", () => {
		const longTitle = "x".repeat(LONG_TITLE_MAX_CHARS + 1);
		const out = computeRankBaseScore(
			{ title: longTitle, description: null },
			DEFAULT_RANKING_CONFIG,
		);
		expect(out).toBeCloseTo(-(PENALTY + LONG_PENALTY), 10);
	});

	it("weights sellerTrust linearly and clamps the input to [0,1]", () => {
		const noTrust = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, sellerTrust: 0 },
			DEFAULT_RANKING_CONFIG,
		);
		const maxTrust = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, sellerTrust: 1 },
			DEFAULT_RANKING_CONFIG,
		);
		const overflow = computeRankBaseScore(
			{
				title: SHORT_TITLE,
				description: TEMPLATE_DESC,
				sellerTrust: 5,
			},
			DEFAULT_RANKING_CONFIG,
		);

		expect(noTrust).toBe(0);
		expect(maxTrust).toBeCloseTo(TRUST_W, 10);
		expect(overflow).toBeCloseTo(TRUST_W, 10);
	});

	it("the lowEffortPenalty knob is fully reversible (0 ⇒ no demerit)", () => {
		const input = { title: SHORT_TITLE, description: null };
		const penalized = computeRankBaseScore(input, DEFAULT_RANKING_CONFIG);
		const off = computeRankBaseScore(input, {
			...DEFAULT_RANKING_CONFIG,
			lowEffortPenalty: 0,
		});
		expect(penalized).toBe(-PENALTY);
		expect(off).toBe(0);
	});

	it("the longTitlePenalty knob is fully reversible (0 ⇒ no demerit)", () => {
		const input = {
			title: "x".repeat(LONG_TITLE_MAX_CHARS + 1),
			description: TEMPLATE_DESC,
		};
		const penalized = computeRankBaseScore(input, DEFAULT_RANKING_CONFIG);
		const off = computeRankBaseScore(input, {
			...DEFAULT_RANKING_CONFIG,
			longTitlePenalty: 0,
		});
		expect(penalized).toBe(-LONG_PENALTY);
		expect(off).toBe(0);
	});
});

describe("computeRankScore", () => {
	it("scores a newer listing strictly higher than an older one with the same base", () => {
		const now = new Date("2026-05-21T12:00:00Z");
		const rankBaseScore = 0;
		const tokenBoost = TOKEN_BOOST_MIN;

		const newer = computeRankScore(
			{
				rankBaseScore,
				createdAt: new Date(now.getTime() - 1 * HOUR_MS),
				now,
				tokenBoost,
			},
			DEFAULT_RANKING_CONFIG,
		);
		const older = computeRankScore(
			{
				rankBaseScore,
				createdAt: new Date(now.getTime() - 240 * HOUR_MS),
				now,
				tokenBoost,
			},
			DEFAULT_RANKING_CONFIG,
		);

		expect(newer).toBeGreaterThan(older);
	});

	it("halves the recency contribution at exactly one half-life of age (tokenBoost=1)", () => {
		const now = new Date("2026-05-21T12:00:00Z");
		const rankBaseScore = 0;
		const { recencyHalfLifeHours } = DEFAULT_RANKING_CONFIG;

		const atHalfLife = computeRankScore(
			{
				rankBaseScore,
				createdAt: new Date(now.getTime() - recencyHalfLifeHours * HOUR_MS),
				now,
				tokenBoost: TOKEN_BOOST_MIN,
			},
			DEFAULT_RANKING_CONFIG,
		);

		const recencyContribution = atHalfLife - rankBaseScore;
		const ageZeroContribution = RECENCY_W; // 0.5^0 = 1
		expect(recencyContribution).toBeCloseTo(ageZeroContribution * 0.5, 10);
	});

	it("floors a future-dated createdAt at age 0 (never exceeds the age-0 max)", () => {
		const now = new Date("2026-05-21T12:00:00Z");
		const rankBaseScore = 0;

		const future = computeRankScore(
			{
				rankBaseScore,
				createdAt: new Date(now.getTime() + 100 * HOUR_MS),
				now,
				tokenBoost: TOKEN_BOOST_MIN,
			},
			DEFAULT_RANKING_CONFIG,
		);
		const ageZero = computeRankScore(
			{ rankBaseScore, createdAt: now, now, tokenBoost: TOKEN_BOOST_MIN },
			DEFAULT_RANKING_CONFIG,
		);

		expect(future).toBe(ageZero);
		expect(future).toBe(rankBaseScore + RECENCY_W);
	});

	it("multiplies the additive score by tokenBoost (composition is multiplicative)", () => {
		const now = new Date("2026-05-21T12:00:00Z");
		const rankBaseScore = 0;
		const createdAt = new Date(now.getTime() - 0 * HOUR_MS); // age 0

		const neutral = computeRankScore(
			{ rankBaseScore, createdAt, now, tokenBoost: TOKEN_BOOST_MIN },
			DEFAULT_RANKING_CONFIG,
		);
		const boosted = computeRankScore(
			{ rankBaseScore, createdAt, now, tokenBoost: TOKEN_BOOST_MAX },
			DEFAULT_RANKING_CONFIG,
		);

		// Neutral: (0 + 0.30·1) · 1.0 = 0.30
		expect(neutral).toBeCloseTo(RECENCY_W, 10);
		// Boosted: (0 + 0.30·1) · 1.30 = 0.39
		expect(boosted).toBeCloseTo(RECENCY_W * TOKEN_BOOST_MAX, 10);
		expect(boosted).toBeCloseTo(neutral * TOKEN_BOOST_MAX, 10);
	});

	it("kill-switch: tokenBoost=1.0 collapses the multiplicative form to additive v1-shape", () => {
		// The doc's invariant: writing tokenBoost=1.0 to every row reproduces
		// the additive base+recency form exactly. This is what makes the
		// ENABLE_TOKEN_BOOST kill-switch a clean rollback.
		const now = new Date("2026-05-21T12:00:00Z");
		const createdAt = new Date(now.getTime() - 12 * HOUR_MS);
		const rankBaseScore = -0.05;

		const withBoost = computeRankScore(
			{ rankBaseScore, createdAt, now, tokenBoost: TOKEN_BOOST_MIN },
			DEFAULT_RANKING_CONFIG,
		);

		const ageHours = 12;
		const recency =
			0.5 ** (ageHours / DEFAULT_RANKING_CONFIG.recencyHalfLifeHours);
		const expectedAdditive = rankBaseScore + RECENCY_W * recency;

		expect(withBoost).toBeCloseTo(expectedAdditive, 10);
	});

	it("defaults tokenBoost to TOKEN_BOOST_MIN when caller omits it (back-compat)", () => {
		const now = new Date("2026-05-21T12:00:00Z");
		const createdAt = now;

		const omitted = computeRankScore(
			{ rankBaseScore: 0.05, createdAt, now },
			DEFAULT_RANKING_CONFIG,
		);
		const explicit = computeRankScore(
			{ rankBaseScore: 0.05, createdAt, now, tokenBoost: TOKEN_BOOST_MIN },
			DEFAULT_RANKING_CONFIG,
		);

		expect(omitted).toBe(explicit);
	});
});

describe("computeTokenBoost", () => {
	const stats = { mu: 0.1, sigma: 0.05 }; // realistic-ish bucket stats
	const shortTitleLen = SHORT_TITLE.length;

	it("returns TOKEN_BOOST_MIN (neutral) when no tokens matched", () => {
		const boost = computeTokenBoost(
			{ tokenPHats: [], ...stats, titleLen: shortTitleLen },
			DEFAULT_RANKING_CONFIG,
		);
		expect(boost).toBe(TOKEN_BOOST_MIN);
	});

	it("returns TOKEN_BOOST_MIN when sigma is zero (no signal to amplify)", () => {
		const boost = computeTokenBoost(
			{
				tokenPHats: [0.5, 0.6],
				mu: 0.1,
				sigma: 0,
				titleLen: shortTitleLen,
			},
			DEFAULT_RANKING_CONFIG,
		);
		expect(boost).toBe(TOKEN_BOOST_MIN);
	});

	it("clamps the boost to [TOKEN_BOOST_MIN, TOKEN_BOOST_MAX]", () => {
		// Hugely above-average token (z = 100) should clamp at MAX.
		const hot = computeTokenBoost(
			{
				tokenPHats: [stats.mu + 100 * stats.sigma],
				...stats,
				titleLen: shortTitleLen,
			},
			DEFAULT_RANKING_CONFIG,
		);
		// Hugely below-average token (z = -100) should clamp at MIN.
		const cold = computeTokenBoost(
			{
				tokenPHats: [stats.mu - 100 * stats.sigma],
				...stats,
				titleLen: shortTitleLen,
			},
			DEFAULT_RANKING_CONFIG,
		);

		expect(hot).toBe(TOKEN_BOOST_MAX);
		expect(cold).toBe(TOKEN_BOOST_MIN);
	});

	it("takes the MAX of matched tokens — never the sum (anti-stuffing guard)", () => {
		// Four matched tokens with the same hot pHat should give exactly the
		// SAME boost as a single matched token with that pHat. This is the
		// single most important anti-keyword-stuffing decision (docs §2).
		const hotP = stats.mu + 1.5 * stats.sigma;
		const oneHot = computeTokenBoost(
			{ tokenPHats: [hotP], ...stats, titleLen: shortTitleLen },
			DEFAULT_RANKING_CONFIG,
		);
		const fourHot = computeTokenBoost(
			{
				tokenPHats: [hotP, hotP, hotP, hotP],
				...stats,
				titleLen: shortTitleLen,
			},
			DEFAULT_RANKING_CONFIG,
		);
		// And the max wins even when paired with lukewarm tokens.
		const maxOfMixed = computeTokenBoost(
			{
				tokenPHats: [stats.mu, stats.mu - stats.sigma, hotP],
				...stats,
				titleLen: shortTitleLen,
			},
			DEFAULT_RANKING_CONFIG,
		);

		expect(fourHot).toBe(oneHot);
		expect(maxOfMixed).toBe(oneHot);
	});

	it("applies the length damper when title exceeds LONG_TITLE_MAX_CHARS", () => {
		const hotP = stats.mu + 100 * stats.sigma; // forces clamp to MAX
		const fits = computeTokenBoost(
			{ tokenPHats: [hotP], ...stats, titleLen: LONG_TITLE_MAX_CHARS },
			DEFAULT_RANKING_CONFIG,
		);
		const doubled = computeTokenBoost(
			{ tokenPHats: [hotP], ...stats, titleLen: LONG_TITLE_MAX_CHARS * 2 },
			DEFAULT_RANKING_CONFIG,
		);

		// At exactly LONG_TITLE_MAX_CHARS: damper is min(1, 60/60)=1, no penalty.
		expect(fits).toBe(TOKEN_BOOST_MAX);
		// At 2× the cap: damper is 60/120 = 0.5; boost halved.
		expect(doubled).toBeCloseTo(TOKEN_BOOST_MAX * 0.5, 10);
	});

	it("length damper does NOT fire for unmatched listings (preserves neutrality)", () => {
		// A 120-char title with NO matching tokens should still return MIN —
		// the damper is a *token-boost* correction, not a universal long-title
		// penalty (that's longTitlePenalty's job at the base-score level).
		const boost = computeTokenBoost(
			{ tokenPHats: [], ...stats, titleLen: 120 },
			DEFAULT_RANKING_CONFIG,
		);
		expect(boost).toBe(TOKEN_BOOST_MIN);
	});

	it("a stuffer (5 hot tokens, 120-char title) pays the damper more than they gain", () => {
		// The composite outcome that motivates pairing the damper with the
		// MAX guard: even with 5 maximally-hot tokens, the 120-char title
		// drags the boost below TOKEN_BOOST_MAX.
		const hotP = stats.mu + 100 * stats.sigma;
		const boost = computeTokenBoost(
			{
				tokenPHats: [hotP, hotP, hotP, hotP, hotP],
				...stats,
				titleLen: 120,
			},
			DEFAULT_RANKING_CONFIG,
		);

		expect(boost).toBeLessThan(TOKEN_BOOST_MAX);
		expect(boost).toBeCloseTo(TOKEN_BOOST_MAX * 0.5, 10);
	});

	it("respects the configured sensitivity (tokenBoostSensitivity tunes the slope)", () => {
		const hotP = stats.mu + 1.0 * stats.sigma; // exactly +1σ

		const defaultK = computeTokenBoost(
			{ tokenPHats: [hotP], ...stats, titleLen: shortTitleLen },
			DEFAULT_RANKING_CONFIG,
		);
		const doubledK: RankingConfig = {
			...DEFAULT_RANKING_CONFIG,
			tokenBoostSensitivity: DEFAULT_RANKING_CONFIG.tokenBoostSensitivity * 2,
		};
		const doubledOut = computeTokenBoost(
			{ tokenPHats: [hotP], ...stats, titleLen: shortTitleLen },
			doubledK,
		);

		// 1 + 0.20·1 = 1.20 with default; 1 + 0.40·1 = 1.40 with 2× → clamped 1.30.
		expect(defaultK).toBeCloseTo(
			1 + DEFAULT_RANKING_CONFIG.tokenBoostSensitivity,
			10,
		);
		expect(doubledOut).toBe(TOKEN_BOOST_MAX);
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

		expect(result).toHaveLength(ordered.length);
		expect(new Set(result)).toEqual(new Set(ordered.map((c) => c.id)));
		expect(result[result.length - 1]).toBe("a4");
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
			cand("a2", "A", "  charizard 4  "),
			cand("b1", "B", "Charizard #4!!!"),
		];

		const result = applyDiversity(ordered, DEFAULT_RANKING_CONFIG);

		expect(result).toHaveLength(3);
		expect(result).toEqual(["a1", "b1", "a2"]);
	});

	it("holds the per-seller cap across every simulated page slice", () => {
		const cap = DEFAULT_RANKING_CONFIG.perSellerCap; // 3
		const pageSize = 4;

		const ordered: DiversityCandidate[] = [];
		let filler = 0;
		for (let i = 0; i < 20; i++) {
			ordered.push(cand(`a${i}`, "A", `a-${i}`));
			ordered.push(cand(`f${filler}`, `S${filler}`, `f-${filler}`));
			filler++;
		}

		const result = applyDiversity(ordered, DEFAULT_RANKING_CONFIG);

		expect(result).toHaveLength(ordered.length);
		expect(new Set(result)).toEqual(new Set(ordered.map((c) => c.id)));

		const aIds = ordered
			.filter((c) => c.sellerProfileId === "A")
			.map((c) => c.id);
		const tailStart = result.length - (aIds.length - cap);
		const kept = result.slice(0, tailStart);

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

		expect(kept.filter((id) => id.startsWith("a"))).toHaveLength(cap);
	});
});
