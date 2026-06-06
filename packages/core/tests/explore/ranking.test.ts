import { describe, expect, it } from "vitest";
import {
	applyDiversity,
	computeImageDemerit,
	computePriceMult,
	computeRankBaseScore,
	computeRankScore,
	computeTokenBoost,
	DEFAULT_RANKING_CONFIG,
	type DiversityCandidate,
	LONG_TITLE_MAX_CHARS,
	matchesMerchKeyword,
	matchesNegativeKeyword,
	PLATEAU_HI_USD,
	PLATEAU_LO_USD,
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
// v8: weight is now "max contribution when in the [LO, HI] band" — the plateau
// shape multiplies it by [0, 1], not log10(1 + price).
const PREMIUM_W = DEFAULT_RANKING_CONFIG.weights.premium; // 0.35

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

	it("applies the v8 price-band plateau: full credit in band, decay both sides", () => {
		// Null / undefined / zero / negative all collapse to neutral — listings
		// with no price (rare edge) get 0 premium contribution.
		const noPrice = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, priceUSD: null },
			DEFAULT_RANKING_CONFIG,
		);
		const zeroPrice = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, priceUSD: 0 },
			DEFAULT_RANKING_CONFIG,
		);

		// Inside the band [LO, HI] every price gets identical full credit. This
		// is the v7 → v8 change: v7 still preferred $300 over $35 via the log,
		// v8 says they're equally good within the cofounder-defined sweet spot.
		const atLo = computeRankBaseScore(
			{
				title: SHORT_TITLE,
				description: TEMPLATE_DESC,
				priceUSD: PLATEAU_LO_USD,
			},
			DEFAULT_RANKING_CONFIG,
		);
		const center = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, priceUSD: 100 },
			DEFAULT_RANKING_CONFIG,
		);
		const atHi = computeRankBaseScore(
			{
				title: SHORT_TITLE,
				description: TEMPLATE_DESC,
				priceUSD: PLATEAU_HI_USD,
			},
			DEFAULT_RANKING_CONFIG,
		);

		// Below the band: quadratic decay clamps to 0 fast. $1, $5 contribute
		// nothing (no separate "cheap floor" anymore — the shape does it).
		const buck = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, priceUSD: 1 },
			DEFAULT_RANKING_CONFIG,
		);
		const fiveBucks = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, priceUSD: 5 },
			DEFAULT_RANKING_CONFIG,
		);

		// Above the band: linear decay. $1k is still positive but less than the
		// band — this is the v8 "sprinkle outliers through the long tail"
		// design (vs v7 ceiling which scored $1k and $3k identically).
		const overBand = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, priceUSD: 1000 },
			DEFAULT_RANKING_CONFIG,
		);
		const wayOverBand = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC, priceUSD: 30_000 },
			DEFAULT_RANKING_CONFIG,
		);

		expect(noPrice).toBe(0);
		expect(zeroPrice).toBe(0);

		// Full credit, identical across the band.
		expect(atLo).toBeCloseTo(PREMIUM_W, 10);
		expect(center).toBeCloseTo(PREMIUM_W, 10);
		expect(atHi).toBeCloseTo(PREMIUM_W, 10);

		// Cheap clamps to exactly zero — no contribution, no penalty.
		expect(buck).toBe(0);
		expect(fiveBucks).toBe(0);

		// Above-band is positive but strictly less than the band, and
		// monotonically decaying.
		expect(overBand).toBeGreaterThan(0);
		expect(overBand).toBeLessThan(PREMIUM_W);
		expect(wayOverBand).toBeGreaterThanOrEqual(0);
		expect(wayOverBand).toBeLessThan(overBand);
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

	it("subtracts negativeKeywordPenalty when title contains a negative keyword", () => {
		// Wooden Eevee — the canonical case from the May 2026 preview.
		// Score should be exactly `-negativeKeywordPenalty` since title alone
		// triggers it and the description is a normal-length template.
		const wooden = computeRankBaseScore(
			{ title: "Wooden Eevee Card", description: TEMPLATE_DESC },
			DEFAULT_RANKING_CONFIG,
		);
		expect(wooden).toBeCloseTo(
			-DEFAULT_RANKING_CONFIG.negativeKeywordPenalty,
			10,
		);
	});

	it("fires the negative-keyword demerit from description as well as title", () => {
		// Title clean, description gives it away. Should still trigger.
		const fromDesc = computeRankBaseScore(
			{
				title: "Charizard Card",
				description:
					"This is a hand-carved wooden replica of the original card.",
			},
			DEFAULT_RANKING_CONFIG,
		);
		expect(fromDesc).toBeCloseTo(
			-DEFAULT_RANKING_CONFIG.negativeKeywordPenalty,
			10,
		);
	});

	it("does NOT false-positive on legitimate words containing keyword substrings", () => {
		// Word-boundary matching prevents "proxy" from matching
		// "approximately", "wooden" from matching "broadened", etc.
		const fine = computeRankBaseScore(
			{
				title: "Approximately Mint Charizard",
				description: "Card in approximately near-mint condition.",
			},
			DEFAULT_RANKING_CONFIG,
		);
		expect(fine).toBe(0);
	});

	it("the negativeKeywordPenalty knob is fully reversible (0 ⇒ no demerit)", () => {
		const input = { title: "Wooden Eevee Card", description: TEMPLATE_DESC };
		const penalized = computeRankBaseScore(input, DEFAULT_RANKING_CONFIG);
		const off = computeRankBaseScore(input, {
			...DEFAULT_RANKING_CONFIG,
			negativeKeywordPenalty: 0,
		});
		expect(penalized).toBe(-DEFAULT_RANKING_CONFIG.negativeKeywordPenalty);
		expect(off).toBe(0);
	});

	it("stacks negative-keyword with low-effort and long-title penalties", () => {
		// Worst-case listing: wooden + long title + no description.
		// All three penalties fire additively.
		const stacked = computeRankBaseScore(
			{
				title: `Hand carved wooden replica Charizard ${"x".repeat(40)}`,
				description: null,
			},
			DEFAULT_RANKING_CONFIG,
		);
		const expected =
			-DEFAULT_RANKING_CONFIG.negativeKeywordPenalty -
			DEFAULT_RANKING_CONFIG.longTitlePenalty -
			DEFAULT_RANKING_CONFIG.lowEffortPenalty;
		expect(stacked).toBeCloseTo(expected, 10);
	});

	it("subtracts merchKeywordPenalty when title names non-card merch", () => {
		// "Pikachu Hat" — the canonical June 2026 incident. Title alone fires it
		// and the description is a normal-length template, so the base is exactly
		// `-merchKeywordPenalty`.
		const hat = computeRankBaseScore(
			{
				title: "2026 Regional Championship Pikachu Hat",
				description: TEMPLATE_DESC,
			},
			DEFAULT_RANKING_CONFIG,
		);
		expect(hat).toBeCloseTo(-DEFAULT_RANKING_CONFIG.merchKeywordPenalty, 10);
	});

	it("drives a sweet-spot-priced merch listing's base negative (regression: hat at rank #1-2)", () => {
		// A $75 playmat sits dead-center of the premium plateau (full 0.35) but
		// the 0.50 merch demerit pushes the base below zero, so even brand-new
		// (max recency 0.30) its rankScore lands in the tail, not rank #1.
		const playmat = computeRankBaseScore(
			{
				title: "Pokemon Regional Championship Pikachu Premium Playmat",
				description: TEMPLATE_DESC,
				priceUSD: 75,
			},
			DEFAULT_RANKING_CONFIG,
		);
		// premium(0.35) − merch(0.50) = −0.15
		expect(playmat).toBeCloseTo(
			PREMIUM_W - DEFAULT_RANKING_CONFIG.merchKeywordPenalty,
			10,
		);
		expect(playmat).toBeLessThan(0);
	});

	it("fires the merch demerit from description as well as title", () => {
		const fromDesc = computeRankBaseScore(
			{
				title: "Charizard ex 199/165",
				description: "Comes bundled with a free Charizard plush. See photos.",
			},
			DEFAULT_RANKING_CONFIG,
		);
		expect(fromDesc).toBeCloseTo(
			-DEFAULT_RANKING_CONFIG.merchKeywordPenalty,
			10,
		);
	});

	it("does NOT demote real cards whose names embed a merch substring", () => {
		// Word boundaries: "Captain" must not trip "cap", "Magneton" must not
		// trip "magnet". These are real Pokemon — base must be a clean 0.
		const captain = computeRankBaseScore(
			{ title: "Captain Pikachu 131/131", description: TEMPLATE_DESC },
			DEFAULT_RANKING_CONFIG,
		);
		const magneton = computeRankBaseScore(
			{ title: "1996 Magneton 082/165", description: TEMPLATE_DESC },
			DEFAULT_RANKING_CONFIG,
		);
		expect(captain).toBe(0);
		expect(magneton).toBe(0);
	});

	it("does NOT demote sealed product (ETB / booster / pin collection)", () => {
		// Sealed inventory is legit and deliberately absent from MERCH_KEYWORDS.
		const etb = computeRankBaseScore(
			{ title: "Mega Evolution Elite Trainer Box", description: TEMPLATE_DESC },
			DEFAULT_RANKING_CONFIG,
		);
		const pins = computeRankBaseScore(
			{
				title: "Crown Zenith Inteleon Pin Collection",
				description: TEMPLATE_DESC,
			},
			DEFAULT_RANKING_CONFIG,
		);
		expect(etb).toBe(0);
		expect(pins).toBe(0);
	});

	it("the merchKeywordPenalty knob is fully reversible (0 ⇒ no demerit)", () => {
		const input = { title: "Pikachu Hat", description: TEMPLATE_DESC };
		const penalized = computeRankBaseScore(input, DEFAULT_RANKING_CONFIG);
		const off = computeRankBaseScore(input, {
			...DEFAULT_RANKING_CONFIG,
			merchKeywordPenalty: 0,
		});
		expect(penalized).toBe(-DEFAULT_RANKING_CONFIG.merchKeywordPenalty);
		expect(off).toBe(0);
	});
});

describe("matchesNegativeKeyword", () => {
	it("matches case-insensitively in title", async () => {
		expect(matchesNegativeKeyword("WOODEN Eevee Card", null)).toBe(true);
		expect(matchesNegativeKeyword("Wooden Eevee Card", null)).toBe(true);
		expect(matchesNegativeKeyword("Real PSA 10 Eevee", null)).toBe(false);
	});

	it("respects word boundaries to avoid false positives", async () => {
		// "approximately" contains "proxy" as substring but not as whole word.
		expect(matchesNegativeKeyword("Approximately NM Card", null)).toBe(false);
		// Direct "proxy" should still fire.
		expect(matchesNegativeKeyword("Proxy Charizard Card", null)).toBe(true);
	});

	it("handles hyphenated variants", async () => {
		expect(matchesNegativeKeyword("Hand-Carved Eevee", null)).toBe(true);
		expect(matchesNegativeKeyword("Hand Carved Eevee", null)).toBe(true);
		expect(matchesNegativeKeyword("Hand-made Pikachu", null)).toBe(true);
	});

	it("returns false for a clean listing", async () => {
		expect(
			matchesNegativeKeyword(
				"Charizard ex Holo PSA 10",
				"Pristine condition, near mint, see photos.",
			),
		).toBe(false);
	});
});

describe("matchesMerchKeyword", () => {
	it("matches case-insensitively in title", async () => {
		expect(matchesMerchKeyword("PIKACHU HAT", null)).toBe(true);
		expect(matchesMerchKeyword("Pikachu Premium Playmat", null)).toBe(true);
		expect(matchesMerchKeyword("Charizard ex PSA 10", null)).toBe(false);
	});

	it("respects word boundaries to avoid false positives on real cards", async () => {
		expect(matchesMerchKeyword("Captain Pikachu 131/131", null)).toBe(false);
		expect(matchesMerchKeyword("1996 Magneton 082/165", null)).toBe(false);
		expect(matchesMerchKeyword("Hatterene V Alt Art", null)).toBe(false);
		expect(matchesMerchKeyword("Pikachu Hat Never Worn", null)).toBe(true);
	});

	it("handles multi-word and hyphenated variants", async () => {
		expect(matchesMerchKeyword("Charizard T-Shirt", null)).toBe(true);
		expect(matchesMerchKeyword("Charizard T Shirt", null)).toBe(true);
		expect(matchesMerchKeyword("Tournament Play Mat", null)).toBe(true);
		expect(matchesMerchKeyword("Eevee Action Figure", null)).toBe(true);
	});

	it("does not match sealed product (deliberately excluded)", async () => {
		expect(matchesMerchKeyword("Elite Trainer Box", null)).toBe(false);
		expect(matchesMerchKeyword("Booster Box 36 Packs", null)).toBe(false);
		expect(matchesMerchKeyword("Crown Zenith Pin Collection", null)).toBe(
			false,
		);
	});

	it("returns false for a clean card listing", async () => {
		expect(
			matchesMerchKeyword(
				"Charizard ex Holo PSA 10",
				"Pristine condition, near mint, see photos.",
			),
		).toBe(false);
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

describe("computePriceMult", () => {
	it("returns 1.0 (neutral) when the listing has no price", async () => {
		const mult = computePriceMult(
			{ priceUSD: null, refMedianUSD: 50 },
			DEFAULT_RANKING_CONFIG,
		);
		expect(mult).toBe(1.0);
	});

	it("returns 1.0 (neutral) when no token median is available", async () => {
		const mult = computePriceMult(
			{ priceUSD: 25, refMedianUSD: null },
			DEFAULT_RANKING_CONFIG,
		);
		expect(mult).toBe(1.0);
	});

	it("returns exactly 1.0 at the median (log2(1) = 0 → tanh(0) = 0)", async () => {
		const mult = computePriceMult(
			{ priceUSD: 50, refMedianUSD: 50 },
			DEFAULT_RANKING_CONFIG,
		);
		expect(mult).toBe(1.0);
	});

	it("demotes below-median listings (e.g. $5 vs $50 median ≈ 0.90x)", async () => {
		// ratio = 0.1, log2(0.1) ≈ -3.32, tanh ≈ -0.998
		// mult = 1 + 0.10 · (-0.998) ≈ 0.900
		const mult = computePriceMult(
			{ priceUSD: 5, refMedianUSD: 50 },
			DEFAULT_RANKING_CONFIG,
		);
		expect(mult).toBeCloseTo(0.9, 2);
		expect(mult).toBeLessThan(1.0);
	});

	it("lifts above-median listings (e.g. $100 vs $50 median ≈ 1.08x)", async () => {
		// ratio = 2.0, log2(2) = 1, tanh(1) ≈ 0.762
		// mult = 1 + 0.10 · 0.762 ≈ 1.076
		const mult = computePriceMult(
			{ priceUSD: 100, refMedianUSD: 50 },
			DEFAULT_RANKING_CONFIG,
		);
		expect(mult).toBeCloseTo(1.076, 2);
		expect(mult).toBeGreaterThan(1.0);
	});

	it("clamps to priceMultMin for extreme below-median (saturates the sigmoid)", async () => {
		// ratio ≈ 0.001 — well past the 0.01 floor. tanh(log2(0.01)) = tanh(-6.64) ≈ -1
		// mult ≈ 1 - 0.10 = 0.90, which is within [0.85, 1.10] — not clamped to floor.
		// To force the floor we'd need a more aggressive k. Verify with k=0.30:
		const aggressive = {
			...DEFAULT_RANKING_CONFIG,
			priceMultSensitivity: 0.3,
		};
		const mult = computePriceMult(
			{ priceUSD: 0.5, refMedianUSD: 100 },
			aggressive,
		);
		expect(mult).toBe(aggressive.priceMultMin);
	});

	it("clamps to priceMultMax for extreme above-median", async () => {
		// $5000 vs $50 median = 100x; sigmoid saturates near +1.
		// With k=0.30 aggressive: mult = 1 + 0.30 ≈ 1.30, clamped to 1.10.
		const aggressive = {
			...DEFAULT_RANKING_CONFIG,
			priceMultSensitivity: 0.3,
		};
		const mult = computePriceMult(
			{ priceUSD: 5000, refMedianUSD: 50 },
			aggressive,
		);
		expect(mult).toBe(aggressive.priceMultMax);
	});

	it("treats priceUSD ≤ 0 as neutral (defensive against bad data)", async () => {
		expect(
			computePriceMult(
				{ priceUSD: 0, refMedianUSD: 50 },
				DEFAULT_RANKING_CONFIG,
			),
		).toBe(1.0);
		expect(
			computePriceMult(
				{ priceUSD: -10, refMedianUSD: 50 },
				DEFAULT_RANKING_CONFIG,
			),
		).toBe(1.0);
	});

	it("the priceMultSensitivity knob is fully reversible (0 ⇒ no adjustment)", async () => {
		// k=0 collapses the sigmoid contribution to zero; mult is always 1.0
		// regardless of the price/median ratio.
		const off = { ...DEFAULT_RANKING_CONFIG, priceMultSensitivity: 0 };
		expect(computePriceMult({ priceUSD: 1, refMedianUSD: 1000 }, off)).toBe(
			1.0,
		);
		expect(computePriceMult({ priceUSD: 1000, refMedianUSD: 1 }, off)).toBe(
			1.0,
		);
	});
});

describe("computeRankScore with priceMult", () => {
	it("priceMult multiplies the full (base + recency)·tokenBoost score", async () => {
		const now = new Date("2026-05-21T12:00:00Z");
		// Fresh listing, no base score, neutral tokenBoost → score = 0.30 · 1 · priceMult.
		const fresh = {
			rankBaseScore: 0,
			createdAt: now,
			now,
			tokenBoost: 1.0,
		};
		const neutral = computeRankScore(
			{ ...fresh, priceMult: 1.0 },
			DEFAULT_RANKING_CONFIG,
		);
		const lifted = computeRankScore(
			{ ...fresh, priceMult: 1.1 },
			DEFAULT_RANKING_CONFIG,
		);
		const demoted = computeRankScore(
			{ ...fresh, priceMult: 0.85 },
			DEFAULT_RANKING_CONFIG,
		);
		expect(neutral).toBeCloseTo(RECENCY_W, 10);
		expect(lifted).toBeCloseTo(RECENCY_W * 1.1, 10);
		expect(demoted).toBeCloseTo(RECENCY_W * 0.85, 10);
	});

	it("defaults priceMult to 1.0 — back-compat for callers that don't supply it", () => {
		const now = new Date("2026-05-21T12:00:00Z");
		const withDefault = computeRankScore(
			{ rankBaseScore: 0, createdAt: now, now, tokenBoost: 1.0 },
			DEFAULT_RANKING_CONFIG,
		);
		const withExplicit1 = computeRankScore(
			{
				rankBaseScore: 0,
				createdAt: now,
				now,
				tokenBoost: 1.0,
				priceMult: 1.0,
			},
			DEFAULT_RANKING_CONFIG,
		);
		expect(withDefault).toBe(withExplicit1);
	});

	it("composes tokenBoost and priceMult multiplicatively (1.20 × 0.90 = 1.08)", () => {
		const now = new Date("2026-05-21T12:00:00Z");
		const score = computeRankScore(
			{
				rankBaseScore: 0,
				createdAt: now,
				now,
				tokenBoost: 1.2,
				priceMult: 0.9,
			},
			DEFAULT_RANKING_CONFIG,
		);
		expect(score).toBeCloseTo(RECENCY_W * 1.2 * 0.9, 10);
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

describe("computeImageDemerit", () => {
	const cfg = DEFAULT_RANKING_CONFIG;
	const DEMERIT = cfg.lowResDemerit; // 0.15
	const K = cfg.imageDemeritDecayK; // 8

	it("fails open to 0 on missing or non-positive dimensions", () => {
		// Unscored / unreadable hero ⇒ never a penalty under uncertainty.
		expect(computeImageDemerit({}, cfg)).toBe(0);
		expect(
			computeImageDemerit({ heroWidth: 1200, heroHeight: null }, cfg),
		).toBe(0);
		expect(
			computeImageDemerit({ heroWidth: null, heroHeight: 1200 }, cfg),
		).toBe(0);
		expect(computeImageDemerit({ heroWidth: 0, heroHeight: 0 }, cfg)).toBe(0);
		expect(computeImageDemerit({ heroWidth: -10, heroHeight: 1200 }, cfg)).toBe(
			0,
		);
	});

	it("earns no demerit at or above resGoodPx (demotion-only)", () => {
		expect(
			computeImageDemerit(
				{ heroWidth: cfg.resGoodPx, heroHeight: cfg.resGoodPx },
				cfg,
			),
		).toBe(0);
		// The catalog norm (~1200px min-dim) is untouched.
		expect(
			computeImageDemerit({ heroWidth: 1200, heroHeight: 1600 }, cfg),
		).toBe(0);
	});

	it("applies the full demerit at or below resFullPx with no engagement", () => {
		// The literal top-of-feed offenders: 303px CGC slabs.
		expect(
			computeImageDemerit({ heroWidth: 303, heroHeight: 303 }, cfg),
		).toBeCloseTo(DEMERIT, 10);
		expect(
			computeImageDemerit(
				{ heroWidth: cfg.resFullPx, heroHeight: cfg.resFullPx },
				cfg,
			),
		).toBeCloseTo(DEMERIT, 10);
	});

	it("ramps linearly between resFullPx and resGoodPx", () => {
		// Midpoint of [500, 1100] = 800 ⇒ resFrac 0.5 ⇒ half the demerit.
		const midDim = (cfg.resFullPx + cfg.resGoodPx) / 2;
		expect(
			computeImageDemerit({ heroWidth: midDim, heroHeight: midDim }, cfg),
		).toBeCloseTo(DEMERIT * 0.5, 10);
	});

	it("keys off min(width, height) — EXIF-orientation-swap invariant", () => {
		// A 1600×303 landscape and a 303×1600 portrait demerit identically.
		const landscape = computeImageDemerit(
			{ heroWidth: 1600, heroHeight: 303 },
			cfg,
		);
		const portrait = computeImageDemerit(
			{ heroWidth: 303, heroHeight: 1600 },
			cfg,
		);
		expect(landscape).toBeCloseTo(DEMERIT, 10);
		expect(landscape).toBe(portrait);
	});

	it("decays toward 0 as engagement accrues (× K/(E+K))", () => {
		// E = addToCartCount + saveCount = K ⇒ exactly half the raw demerit.
		const halfDecayed = computeImageDemerit(
			{ heroWidth: 303, heroHeight: 303, addToCartCount: K, saveCount: 0 },
			cfg,
		);
		expect(halfDecayed).toBeCloseTo(DEMERIT * 0.5, 10);

		// Carts and saves both count toward E.
		const split = computeImageDemerit(
			{ heroWidth: 303, heroHeight: 303, addToCartCount: 4, saveCount: 4 },
			cfg,
		);
		expect(split).toBeCloseTo(DEMERIT * 0.5, 10);

		// Heavy engagement nearly erases the demerit.
		const proven = computeImageDemerit(
			{ heroWidth: 303, heroHeight: 303, addToCartCount: 92, saveCount: 0 },
			cfg,
		);
		expect(proven).toBeCloseTo(DEMERIT * (K / (92 + K)), 10);
	});

	it("is subtracted from computeRankBaseScore for a low-res hero", () => {
		// Two identical listings; only the hero resolution differs. The low-res
		// one's base is lower by exactly its (undecayed) demerit.
		const normal = computeRankBaseScore(
			{
				title: SHORT_TITLE,
				description: TEMPLATE_DESC,
				heroWidth: 1200,
				heroHeight: 1600,
			},
			cfg,
		);
		const lowRes = computeRankBaseScore(
			{
				title: SHORT_TITLE,
				description: TEMPLATE_DESC,
				heroWidth: 300,
				heroHeight: 400,
			},
			cfg,
		);
		expect(normal - lowRes).toBeCloseTo(DEMERIT, 10);
	});

	it("leaves the base score unchanged when hero dims are absent (kill-switch path)", () => {
		// The refresh worker passes null dims when ENABLE_IMAGE_DEMERIT is off.
		const withDims = computeRankBaseScore(
			{
				title: SHORT_TITLE,
				description: TEMPLATE_DESC,
				heroWidth: null,
				heroHeight: null,
			},
			cfg,
		);
		const withoutDims = computeRankBaseScore(
			{ title: SHORT_TITLE, description: TEMPLATE_DESC },
			cfg,
		);
		expect(withDims).toBe(withoutDims);
	});
});
