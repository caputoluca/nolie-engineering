/**
 * /explore default-feed ranking — pure scorer + diversity pass (NL-284, NL-310).
 *
 * v1 (NL-284, locked 2026-05-17): recency-dominant additive scorer with a
 * soft low-effort demerit and per-seller diversity cap. See
 * docs/explore-ranking.md §5 for the cold-start catalog analysis that made
 * graded "quality" a fiction at the time.
 *
 * v2 (NL-310): the catalog grew 7× and cart shipped. v2 layers three signals
 * onto the v1 seam: (a) cart-adds (log-scaled engagement), (b) populated
 * `sellerTrust` (Bayesian-shrunk reviews + 1st Edition badge, weight ramped
 * 0 → 0.05 — sparse, but the seam is now live), and (c) a per-listing
 * multiplicative boost. Composition turns multiplicative on that boost so it
 * amplifies the additive signals without crowding them; everything else stays
 * additive (a cart-add is worth the same whether the listing is fresh or
 * stale). Recency came down (0.45 → 0.30) now that other signals are carrying
 * weight. Kill-switch path: write the boost = 1.0 to every row → multiplicative
 * collapses cleanly to the additive form. See docs/explore-ranking-v2.md §2.
 *
 * v3 PR2 (explore-ranking-v3 §5.2, this commit): the v2 multiplier was an
 * Empirical-Bayes z-score over per-token CONVERSION RATE. At ~0.18% catalog
 * CVR that signal is mathematically inverted/inert — popular tokens get ≈no
 * boost, only zero-traffic tokens float up. Replaced by `computeDemandMultiplier`,
 * a per-listing VIEW-DEMAND multiplier: distinct 30d viewers (bot-filtered) +
 * weighted saves + weighted cart events, pooled toward the listing's subject
 * (character/set) demand, log1p'd, min-max-normalized across the rankable scan,
 * and mapped to `[1.0, DEMAND_MULT_MAX]`. The physical `tokenBoost` /
 * `tokenBoostVersion` columns are reused (no migration) but now carry demand,
 * not CVR. Recency drops further (0.30 → 0.20) as a real demand signal takes
 * over differentiation. PR1's image-resolution demerit and the premium plateau
 * are untouched — they live entirely in `computeRankBaseScore`. Kill switch:
 * `ENABLE_TOKEN_BOOST=false` still writes 1.0 to every row → additive collapse.
 *
 * No I/O, no clock: `now` is injected into `computeRankScore` so the worker
 * refresh job is the sole owner of the time-varying term. Weights, sensitivity,
 * cap and penalties live in an immutable `RankingConfig` that is PASSED IN —
 * never read from a module global — so tests can override it and a future
 * LTR ranker slots in behind the same `(features, config) → score` signature
 * (docs/explore-ranking-v2.md §12).
 */

import { SortPriority } from "../auctions/sort";
import type { MatchedToken } from "./token-dictionary";

export interface RankingConfig {
	weights: {
		recency: number;
		/**
		 * Seller-trust weight. v1 was 0; v2 wired the seam at 0.05 — which
		 * measured as a literal no-op in prod (the rating-only composite had
		 * zero spread across all sellers; see TRUST_REVIEW_WEIGHT in
		 * @nolie/core/seller-trust). v4 (NL-371) doubles it to 0.10 alongside
		 * the re-centered composite (rating + completed sales − strikes):
		 * replay on the Jun 2026 export showed experienced sellers gaining
		 * ≤13 ranks and zero-sales sellers slipping 5-13 — a real tie-breaker
		 * at ~1/3 the premium term, still nowhere near dominating.
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
		 * Save weight applied to `log10(1 + saveCount)`. Same log shape as
		 * cartAdd; weight starts at half the cartAdd value because a save is
		 * a softer commitment signal than a cart-add (bookmark vs. immediate
		 * buy intent). A listing with 10 saves gets ≈ 0.05 of boost at
		 * weight 0.05 — small enough to leave the locked v1 weights
		 * (recency / lowEffort) doing the load-bearing work, large enough to
		 * differentiate inside otherwise-tied buckets. Re-tune from real
		 * save-rate distribution once the events have a few weeks of data.
		 */
		save: number;
		/**
		 * Maximum price-band contribution. The shape is an asymmetric plateau
		 * in log10(price) space (`sweetSpotPlateauShape`): full credit
		 * (`weight × 1.0`) across `[PLATEAU_LO_USD, PLATEAU_HI_USD]`,
		 * quadratic decay below (sub-$10 → 0, no separate floor needed),
		 * linear decay above ($1k → ~0.74 × weight, $3k → 0.5 × weight) so
		 * expensive outliers sprinkle through the long tail rather than
		 * collapse at the bottom.
		 *
		 * Cold-start history:
		 *   v6 (weight 0.30, log10(price), NO ceiling, NO floor) — shipped,
		 *     broke. Unbounded log gave a $3,500 PSA card ~$1.07 of premium
		 *     boost (vs ~$0.30 max recency budget); high-priced bad-photo
		 *     listings dominated the top regardless of quality (Spearman
		 *     price-vs-rank ρ ~0.85 — pure price-sorting).
		 *   v7 (weight 0.08, log10, ceiling $300, floor $10/−0.15) —
		 *     bounded the log and demoted the bottom. Top-25 median landed
		 *     at $172 (top of the band, not the middle); above the ceiling
		 *     all prices collapsed to the same score ($300 = $3k), which
		 *     buried real $1k+ graded outliers entirely.
		 *   v8 (this — weight 0.35, plateau $35-$300) — the BAND is the
		 *     peak (not a single point). Vibes-check on the May 23 prod
		 *     CSV (356 listings) put top-25 median at $99 (band center)
		 *     and surfaced $1k+ graded cards at ranks ~90-220 instead of
		 *     ranks 28-90 (v7-M tuning) or rank 1 (v6 failure mode).
		 */
		premium: number;
	};
	recencyHalfLifeHours: number;
	/**
	 * Max listings from one seller within ANY `perSellerWindow` consecutive
	 * slots of the diversity-reflowed order (genuinely sliding, so two at one
	 * page's end can't meet two at the next page's start). Overflow defers to
	 * later slots — never to the feed tail.
	 */
	perSellerCap: number;
	/**
	 * Length (in slots) of the sliding stretch `perSellerCap` is enforced
	 * over. One feed page by default (matches `DEFAULT_EXPLORE_LIMIT` and the
	 * slot policy's `pageSize`).
	 */
	perSellerWindow: number;
	/**
	 * Soft demerit subtracted from the base for title-echo / near-empty
	 * listings. Never a WHERE filter — fully reversible by setting it to 0.
	 */
	lowEffortPenalty: number;
	/**
	 * Additive demerit subtracted from the base when the title exceeds
	 * `LONG_TITLE_MAX_CHARS`. Smaller than the low-effort penalty because a
	 * long title is sometimes legitimate (TCG titles can carry set + rarity
	 * + grade); this deters obvious stuffing without burying real detail.
	 */
	longTitlePenalty: number;
	/**
	 * Sensitivity of the view-demand multiplier to a listing's normalized
	 * demand (explore-ranking-v3 PR2). The multiplier form is
	 * `clamp(1 + k · normalizedDemand, [TOKEN_BOOST_MIN, DEMAND_MULT_MAX])`,
	 * where `normalizedDemand ∈ [0,1]` is the min-max-normalized log1p of the
	 * listing's subject-pooled engagement (distinct viewers + weighted
	 * saves/carts). At `k = 1.0` the top-demand listing earns the full 2.0×
	 * and a zero-demand listing collapses to 1.0× (neutral). Replaces the
	 * inverted Empirical-Bayes token-CVR z-score, which was mathematically
	 * inert at our ~0.18% catalog conversion rate (docs/explore-ranking-v3.md
	 * §5.2). Tunable post-deploy from the live demand distribution.
	 */
	demandSensitivity: number;
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
	 * Subtractive penalty applied to `rankBaseScore` when the title or
	 * description names a non-card merch item (see `MERCH_KEYWORDS`: hat,
	 * playmat, plush, funko, figurine, …). Larger than
	 * `negativeKeywordPenalty` by design: novelty fakes (wooden/replica) are
	 * a soft nudge, but legit merch priced in the $35-$300 sweet spot otherwise
	 * maxes the premium + recency terms and lands at the very top of /explore
	 * with no counter-signal (the dictionary tokenBoost is z-score-neutral at
	 * cold start, so a character name in the title does nothing). At 0.50 a
	 * sweet-spot merch listing's base goes negative, so even brand-new it sits
	 * deep in the tail rather than rank #1-2. Fully reversible (set to 0); not
	 * a WHERE filter. Superseded by the persisted-`kind` feed gate (Phase 2).
	 */
	merchKeywordPenalty: number;
	/**
	 * Max low-resolution demerit (explore-ranking-v3 PR1, §5.1.4). Subtracted
	 * from the base — a hero at/below `resFullPx` min-dimension and with zero
	 * engagement loses the full `lowResDemerit`; the penalty ramps linearly to 0
	 * at `resGoodPx` and decays toward 0 as engagement accrues
	 * (`imageDemeritDecayK`). Demotion-only: a high-res hero earns nothing. This
	 * is the visible fix for "ugly (low-res) photos at the top of /explore" — the
	 * offenders are low-resolution slabs/screenshots, not blurry images (blur is
	 * deferred, §5.1.0). Fully reversible (set to 0); the refresh `ENABLE_IMAGE_
	 * DEMERIT` kill switch neutralizes it without a version bump.
	 */
	lowResDemerit: number;
	/**
	 * Min-dimension (px) at/below which the resolution demerit is at full
	 * strength. `min(heroWidth, heroHeight)` — invariant to the EXIF-orientation
	 * w/h swap (§5.1.1).
	 */
	resFullPx: number;
	/**
	 * Min-dimension (px) at/above which the resolution demerit is zero. Tuned
	 * toward the catalog norm (~1200px median min-dim) so the sub-1000px tail
	 * (303px slabs, 699px screenshots) sinks while the norm is untouched
	 * (§5.1.4).
	 */
	resGoodPx: number;
	/**
	 * Cold-start prior strength for the image demerit's engagement decay
	 * (`demerit ×= K/(E+K)`, `E = addToCartCount + saveCount`). Full demerit
	 * while unproven, fading as real engagement judges the listing — a proven
	 * seller's low-res photo stops being penalized once buyers cart/save it.
	 */
	imageDemeritDecayK: number;
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
 *   v7 → 8: replaced the v7 additive log10 + ceiling + cheap-floor with
 *           a single asymmetric plateau shape (`sweetSpotPlateauShape`):
 *           full credit across `[PLATEAU_LO_USD, PLATEAU_HI_USD]`,
 *           quadratic decay below (sub-$10 → 0 boost — no separate floor
 *           needed), linear decay above so $1k+ outliers sprinkle through
 *           the long tail instead of collapsing to the v7 ceiling. Weight
 *           bumped 0.08 → 0.35 (the plateau output is bounded [0,1], not
 *           log-scaled, so the weight is now literally "max contribution
 *           when in the band"). Vibes-check on May 23 prod CSV (356
 *           listings) moved top-25 median $172 → $99 and dispersed $1k+
 *           cards from ranks 28-90 → 90-220. Forces a one-time recompute
 *           of every row at the new shape.
 *   v8 → 9: merch demerit added to the base (`merchKeywordPenalty`, a strong
 *           0.50 subtraction on non-card merch nouns — hat, playmat, plush,
 *           funko, figurine, …). Live-catalog data (June 2026) showed the
 *           two freshest in-band listings were a Pikachu playmat and a
 *           Pikachu hat sitting at /explore ranks #1-2: the recency + price-
 *           band terms max out for any $35-$300 listing and nothing
 *           distinguished merch from a card. This is the cheap, removable
 *           stopgap; the durable fix persists the AI-classified `kind` and
 *           gates the feed on it (Phase 2). Bump forces a one-time
 *           recompute so existing merch sinks on the next refresh tick.
 *   v9 → 10: image-resolution demerit added to the base (explore-ranking-v3
 *           PR1, §5.1.4). `computeImageDemerit` subtracts a graduated low-res
 *           penalty keyed off the denormalized `heroWidth`/`heroHeight`, decayed
 *           by engagement. Demotion-only; fail-open (null dims ⇒ 0). The bump
 *           forces a one-time recompute so existing listings pick up the demerit
 *           on the next refresh tick once their hero dims are backfilled. Gated
 *           by the `ENABLE_IMAGE_DEMERIT` kill switch at the refresh worker.
 *   v10 → 11: seller-trust rework (NL-371). The v2 rating-only composite
 *           measured zero spread in prod (every seller clamped at 1.0 — a
 *           constant); the trust composite is re-centered around completed
 *           sales and active strikes (see @nolie/core/seller-trust) and the
 *           weight doubles 0.05 → 0.10. Replay-validated on the Jun 2026
 *           export. Bump forces a one-time recompute at the new shape.
 */
export const RANK_BASE_VERSION = 11;

/**
 * Lower edge of the price sweet-spot band. Inside `[LO, HI]` the plateau
 * shape returns 1.0 (full credit × `weights.premium`); below LO it decays
 * quadratically and clamps to 0 fast — sub-$10 listings end up with zero
 * premium contribution, so they don't float to the top on recency alone.
 * Picked at $35 from cofounder's framing of the sweet spot.
 */
export const PLATEAU_LO_USD = 35;

/**
 * Upper edge of the price sweet-spot band. Above HI the plateau shape
 * decays linearly (gentle), so expensive outliers — $1k+ graded cards,
 * sealed booster boxes — sprinkle through the middle/late pages rather
 * than collapse at the bottom. This is the pCTR/pCVR substitute we have
 * today (Booking's `price × pCTR × pCVR` without the engagement halves):
 * tokens / recency / trust differentiate above the band.
 *
 * Picked $300 because it's the natural top of the "$35-$300 sweet spot."
 * Tunable post-deploy; raise when engagement signal arrives and can carry
 * differentiation deeper into the premium tier.
 */
export const PLATEAU_HI_USD = 300;

/**
 * Curvature of the below-band quadratic decay
 * (`shape = 1 − k · (logLO − logP)²`). At 2.0:
 *   $20  → ~0.88  (small demerit relative to band)
 *   $10  → ~0.41  (clearly demerited)
 *   $5   →    0   (clamped — way down)
 *   $1   →    0   (clamped)
 * Higher values steepen the cliff; lower values soften it.
 */
export const PLATEAU_BELOW_CURVATURE = 2.0;

/**
 * Slope of the above-band linear decay
 * (`shape = 1 − k · (logP − logHI)`). At 0.5:
 *   $500    → ~0.89  (slight outlier lift)
 *   $1,000  → ~0.74  (mid-tail sprinkle)
 *   $3,000  →  0.5   (deep-tail sprinkle)
 *   $10,000 → ~0.24  (rare cards still visible at depth)
 * Lower values are gentler (more outlier visibility); higher values bite
 * faster (closer to a hard ceiling).
 */
export const PLATEAU_ABOVE_SLOPE = 0.5;

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
	weights: {
		// v3 PR2: dropped 0.30 → 0.20. The view-demand multiplier
		// (`computeDemandMultiplier`) now carries differentiation that recency
		// was over-weighting at cold start; lowering it lets a high-demand older
		// listing outrank a fresh-but-ignored one (half-life 72h unchanged).
		recency: 0.2,
		sellerTrust: 0.1,
		cartAdd: 0.1,
		save: 0.05,
		premium: 0.35,
	},
	recencyHalfLifeHours: 72,
	// Sliding-window per-seller cap: at most `perSellerCap` listings from one
	// seller in any `perSellerWindow` consecutive slots, overflow DEFERRED to
	// the following slots — a prolific seller reads as ~2 cards per page all
	// the way down. The original global cap appended a seller's 3rd+ listings
	// after the ENTIRE snapshot (behind even sub-gate junk); the June 2026
	// prod replay showed a 69-listing seller at slots 8, 17, then 153+ under
	// the global cap vs 8, 18, 33, 41, 47… under the window (preview-track23
	// PART C). Pattern is standard practice: eBay caps sellers per result
	// set, Pinterest/Xiaohongshu re-rank with a sliding window, Twitter/X
	// decays repeated authors — none of them bury overflow at the tail. Cap
	// kept at 2 (explore-ranking-v3 §5.1.6: one seller held 4 of the top 12
	// without it). Demote-not-drop + applied at snapshot build, so it's
	// instantly reversible with no version bump. Their profile page is the
	// uncapped storefront.
	perSellerCap: 2,
	perSellerWindow: 12,
	lowEffortPenalty: 0.12,
	longTitlePenalty: 0.04,
	demandSensitivity: 1.0,
	negativeKeywordPenalty: 0.08,
	merchKeywordPenalty: 0.5,
	// Image-resolution demerit (explore-ranking-v3 PR1, §5.1.4). v1 starting
	// point validated on the Phase-0 spike: at lowResDemerit 0.15 the 303px
	// top-of-feed slabs fall from #1-3 to ~#22-28 while the 1200px norm is
	// untouched (resGoodPx 1100 ≈ just under the catalog median min-dim, so
	// only the sub-1000px tail is demoted). Tune via a RANK_BASE_VERSION bump.
	lowResDemerit: 0.15,
	resFullPx: 500,
	resGoodPx: 1100,
	imageDemeritDecayK: 8,
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
 * Non-card merch nouns. A title/description match subtracts the (larger)
 * `RankingConfig.merchKeywordPenalty`. Distinct from `NEGATIVE_KEYWORDS`
 * (which targets novelty *fakes* of cards — wooden carvings, replicas): this
 * targets legitimate, sellable, but non-single-card inventory — apparel,
 * plushes, figures, playmats, accessories — that the price-band + recency
 * terms otherwise float to the top of a card-focused feed.
 *
 * Curated for precision: matched whole-word (see `MERCH_KEYWORD_REGEX`), so
 * "cap" can't fire on "Captain" and "magnet" can't fire on "Magneton".
 * SEALED PRODUCT IS DELIBERATELY ABSENT — "elite trainer box", "booster",
 * "tin", "pin collection" are real card inventory and must NOT be demoted.
 * This is a stopgap; the durable fix is the persisted AI `kind` gate
 * (Phase 2), which classifies these as `other` at the source. Sellers can
 * rename to dodge, but the AI gate closes that.
 */
export const MERCH_KEYWORDS: ReadonlyArray<string> = [
	"hat",
	"cap",
	"beanie",
	"playmat",
	"play mat",
	"plush",
	"plushie",
	"plushies",
	"funko",
	"figurine",
	"action figure",
	"bobblehead",
	"bobble head",
	"keychain",
	"key chain",
	"lanyard",
	"backpack",
	"hoodie",
	"t-shirt",
	"tshirt",
	"t shirt",
	"mug",
	"tumbler",
	"poster",
	"costume",
	"cosplay",
	"statue",
	"magnet",
];

/**
 * Demand-multiplier clamp floor. 1.0 = neutral — both "no demand" (the bottom
 * of the normalized range) AND the kill-switch value the refresh job writes to
 * every row when `ENABLE_TOKEN_BOOST` is off. Named `TOKEN_BOOST_*` for
 * continuity with the reused physical `tokenBoost` column (the multiplier value
 * is stored there); the signal it carries is now view-demand, not CVR.
 */
export const TOKEN_BOOST_MIN = 1.0;

/**
 * Demand-multiplier clamp ceiling (explore-ranking-v3 PR2). The top-demand
 * listing in the rankable scan earns `1 + demandSensitivity·1 = 2.0×` at the
 * default sensitivity; the clamp caps any future sensitivity retune so demand
 * can lift hard but never wholly dominate the additive base + recency.
 */
export const DEMAND_MULT_MAX = 2.0;

/**
 * Above this length the additive `longTitlePenalty` fires at the base-score
 * level. Picked at 60 — Etsy uses 70, eBay 60-70; TCG titles are naturally
 * short, so we cap tight (docs §2).
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
	 * Current save count for this listing (live `SavedListing` rows; the
	 * `Listing.saveCount` denormalization is maintained inline by the API on
	 * each save/unsave, unlike the cart's worker-refreshed counter). Log-scaled
	 * in the score with a softer weight than cartAdd — saves are bookmarks,
	 * not buy intent.
	 */
	saveCount?: number;
	/**
	 * Listing's effective price in USD (fixed-price `price` or auction
	 * `startingBid`, both stored as `Decimal(10,2)` dollars). Null when
	 * neither is set (rare) → premium term collapses to 0 for that listing.
	 * Refresh-worker kill switch path also writes null to neutralize the term
	 * without touching other signals.
	 */
	priceUSD?: number | null;
	/**
	 * Denormalized hero-image width/height in pixels (explore-ranking-v3 PR1).
	 * Written by the `image-quality` score job, read by the refresh worker from
	 * `Listing.heroWidth/heroHeight`. Null/undefined when the hero is unscored or
	 * the probe failed — `computeImageDemerit` fails open to 0 in that case, so an
	 * unscored or unreadable listing is never penalized. The refresh worker passes
	 * null for both when the `ENABLE_IMAGE_DEMERIT` kill switch is off.
	 */
	heroWidth?: number | null;
	heroHeight?: number | null;
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
 * Same compile-once / whole-word strategy as `NEGATIVE_KEYWORD_REGEX`, over
 * `MERCH_KEYWORDS`. Word boundaries are load-bearing here: they keep "cap"
 * off "Captain", "magnet" off "Magneton", "hat" off "Hatterene", etc.
 */
const MERCH_KEYWORD_REGEX = new RegExp(
	`\\b(?:${MERCH_KEYWORDS.map((k) =>
		k.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
	).join("|")})\\b`,
	"i",
);

/**
 * True when the listing's title or description names a non-card merch item
 * (`MERCH_KEYWORDS`). Same title+description join and case-insensitive,
 * whole-word matching as `matchesNegativeKeyword`.
 */
export function matchesMerchKeyword(
	title: string,
	description: string | null,
): boolean {
	const haystack = `${title} ${description ?? ""}`;
	return MERCH_KEYWORD_REGEX.test(haystack);
}

/**
 * Asymmetric plateau in log10(price) space. Full credit (1.0) across
 * `[PLATEAU_LO_USD, PLATEAU_HI_USD]`, quadratic decay below (sub-$10
 * clamps to 0), linear decay above (the long tail). Clamped to `[0, 1]`.
 *
 * The asymmetry is the load-bearing design choice: cheap stuff should sink
 * fast (we don't want $1 cards visible on /explore) but expensive stuff
 * should sprinkle through the long tail rather than collapse at the bottom
 * (we DO want $1k+ outliers visible, just not at the top). See the v8
 * entry on `RANK_BASE_VERSION` for the failure mode this replaces.
 *
 * Caller filters `priceUSD ≤ 0` and null before invoking — premium term
 * collapses to 0 for those at the call site.
 */
function sweetSpotPlateauShape(priceUSD: number): number {
	const logP = Math.log10(priceUSD);
	const logLo = Math.log10(PLATEAU_LO_USD);
	const logHi = Math.log10(PLATEAU_HI_USD);
	if (logP >= logLo && logP <= logHi) return 1.0;
	if (logP < logLo) {
		const dist = logLo - logP;
		return Math.max(0, 1 - PLATEAU_BELOW_CURVATURE * dist * dist);
	}
	const dist = logP - logHi;
	return Math.max(0, 1 - PLATEAU_ABOVE_SLOPE * dist);
}

/**
 * Resolution-only image demerit (explore-ranking-v3 PR1, §5.1.4). Pure function
 * over the denormalized hero dimensions + engagement. Demotion-only: a high-res
 * hero earns nothing, a low-res one is penalized.
 *
 *   minDim   = min(heroWidth, heroHeight)            ← EXIF-swap-invariant
 *   resFrac  = clamp01((resGoodPx − minDim) / (resGoodPx − resFullPx))
 *   raw      = lowResDemerit · resFrac               ← full at ≤resFullPx, 0 at ≥resGoodPx
 *   decay    = K / (E + K),  E = addToCartCount + saveCount
 *   demerit  = raw · decay                           ← fades as engagement proves the listing
 *
 * Fail-open is the load-bearing safety property: a null/zero/undefined hero
 * dimension (unscored listing, or a probe failure that left dims null) yields 0,
 * so uncertainty never produces a penalty. Blur and aspect are deliberately NOT
 * here — blur's Laplacian metric proved unreliable and aspect is a presentation
 * concern, not a ranking signal (§5.1.0).
 */
export function computeImageDemerit(
	input: Pick<
		RankBaseInput,
		"heroWidth" | "heroHeight" | "addToCartCount" | "saveCount"
	>,
	config: RankingConfig,
): number {
	const w = input.heroWidth;
	const h = input.heroHeight;
	// Fail-open: unscored or unreadable hero earns no demerit.
	if (w == null || h == null || w <= 0 || h <= 0) return 0;

	const span = config.resGoodPx - config.resFullPx;
	if (span <= 0) return 0;

	const minDim = Math.min(w, h);
	const resFrac = clamp01((config.resGoodPx - minDim) / span);
	if (resFrac <= 0) return 0;

	const raw = config.lowResDemerit * resFrac;
	const engagement =
		Math.max(0, input.addToCartCount ?? 0) + Math.max(0, input.saveCount ?? 0);
	const decay =
		config.imageDemeritDecayK / (engagement + config.imageDemeritDecayK);
	return raw * decay;
}

/**
 * Time-independent part of the score:
 *   sellerTrust·w + cartAdd·w + save·w + premium·w·plateauShape(price)
 *     − lowEffort?·penalty − longTitle?·penalty − negKeyword?·penalty
 *     − merchKeyword?·penalty − imageDemerit
 *
 * The premium term dominates the additive terms by design — at weight 0.35,
 * a sweet-spot listing ($35-$300) contributes the full 0.35 to the base,
 * more than the entire recency budget (0.30) and ~3× the realistic
 * cart-add contribution (`0.10·log10(11) ≈ 0.10`). Intentional cold-start
 * positioning: no engagement signal exists yet, so the price band is
 * carrying the differentiation work. The weight ramps DOWN as engagement
 * accrues; see `RankingConfig.weights.premium` for the trigger.
 *
 * `save` is half cartAdd's weight by default — soft signal, deliberately
 * small until data lets us tune up.
 */
export function computeRankBaseScore(
	input: RankBaseInput,
	config: RankingConfig,
): number {
	const trust = config.weights.sellerTrust * clamp01(input.sellerTrust ?? 0);
	const cartAddCount = Math.max(0, input.addToCartCount ?? 0);
	const cartAdd = config.weights.cartAdd * Math.log10(1 + cartAddCount);
	const saveCount = Math.max(0, input.saveCount ?? 0);
	const save = config.weights.save * Math.log10(1 + saveCount);
	const priceUSD = input.priceUSD;
	const premium =
		priceUSD !== null && priceUSD !== undefined && priceUSD > 0
			? config.weights.premium * sweetSpotPlateauShape(priceUSD)
			: 0;
	const lowEffort = isLowEffortListing(input.title, input.description)
		? config.lowEffortPenalty
		: 0;
	const longTitle = isLongTitle(input.title) ? config.longTitlePenalty : 0;
	const negativeKeyword = matchesNegativeKeyword(input.title, input.description)
		? config.negativeKeywordPenalty
		: 0;
	const merchKeyword = matchesMerchKeyword(input.title, input.description)
		? config.merchKeywordPenalty
		: 0;
	const imageDemerit = computeImageDemerit(input, config);
	return (
		trust +
		cartAdd +
		save +
		premium -
		lowEffort -
		longTitle -
		negativeKeyword -
		merchKeyword -
		imageDemerit
	);
}

export interface RankScoreInput {
	rankBaseScore: number;
	createdAt: Date;
	now: Date;
	/**
	 * Per-listing multiplicative view-demand boost from
	 * `computeDemandMultiplier` (explore-ranking-v3 PR2). Defaults to
	 * `TOKEN_BOOST_MIN` (1.0 = neutral) so callers that don't supply it
	 * (legacy code paths, kill-switch state) get the additive v1-equivalent
	 * form. The refresh worker writes this into the (reused) `tokenBoost`
	 * column on every listing.
	 */
	demandMult?: number;
	/**
	 * Per-listing multiplicative price-vs-median modifier from
	 * `computePriceMult`. Defaults to 1.0 (neutral) so callers that don't
	 * yet supply it (no price on listing, no median for matched tokens) get
	 * the unmodified demand-boosted score.
	 */
	priceMult?: number;
}

/**
 * Effective dollar price for ranking purposes: fixed-price listings use
 * `price`, auctions use `startingBid` (both `Decimal(10,2)` DOLLARS in the
 * DB — `startingBid` is NOT cents despite the name). Inputs are `unknown` so
 * every caller's shape fits without this package importing Prisma types:
 * Prisma `Decimal` (worker scan rows, API reads), plain `number` (create
 * payloads), or null. Returns null when unpriced/invalid — premium and gate
 * terms collapse to neutral for those.
 *
 * Single source of truth: the worker refresh job, the explore snapshot build,
 * and the create-time seed all call this — the inline copies drifted once.
 */
export function effectivePriceUSD(input: {
	listingType: string;
	price: unknown;
	startingBid: unknown;
}): number | null {
	const raw =
		input.listingType === "fixed_price"
			? input.price
			: input.listingType === "auction"
				? input.startingBid
				: null;
	if (raw === null || raw === undefined) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : null;
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
 * Full score = (stored base + weighted recency decay) · demandMult · priceMult.
 * Both multiplicative modifiers default to 1.0 (neutral), so a caller that
 * supplies neither collapses cleanly to the v1 additive form. Kill-switch
 * paths write 1.0 to either column to neutralize that signal without
 * touching the others (docs §2, §10; v3 §5.2).
 *
 * Composition order is irrelevant for the math (both are scalar
 * multipliers) but the ranking-design intent is:
 *   - demandMult amplifies the listing's view-demand, pooled toward its
 *     subject (a high-viewer/high-save Charizard outranks an ignored one);
 *   - priceMult differentiates listings within the same token bucket by
 *     how their price compares to that bucket's median (PSA 10 above raw,
 *     bulk-cheap below).
 */
export function computeRankScore(
	{
		rankBaseScore,
		createdAt,
		now,
		demandMult = TOKEN_BOOST_MIN,
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
		(rankBaseScore + config.weights.recency * recency) * demandMult * priceMult
	);
}

export interface ComputeDemandMultiplierInput {
	/**
	 * The listing's rank-quantile-normalized view-demand in `[0,1]`
	 * (explore-ranking-v4; was min-max in v3 PR2). Computed by the refresh
	 * worker as the log1p of the listing's subject-pooled DECAYED engagement
	 * (decayed distinct viewers + weighted decayed saves/carts/purchases),
	 * passed through `quantileNormalize` over the explore-served scan. 0 = the
	 * least-demanded listing in the scan (collapses to neutral), 1 = the most.
	 */
	normalizedDemand: number;
}

/**
 * Per-listing view-demand multiplier (explore-ranking-v3 PR2, §5.2). Pure
 * function over the listing's normalized demand.
 *
 *   mult = clamp(1 + demandSensitivity · normalizedDemand,
 *                [TOKEN_BOOST_MIN, DEMAND_MULT_MAX])
 *
 * Replaces the v2 Empirical-Bayes token-CVR z-score (`computeTokenBoost`),
 * which was inert at our ~0.18% catalog conversion rate. Demand is a far
 * stronger signal: a listing real buyers view, save, and cart should rank
 * above one nobody looks at, regardless of its title tokens. The subject
 * pooling that produces `normalizedDemand` (done worker-side) lets a fresh
 * listing of a popular character inherit that character's demand before it
 * accrues its own — the multiplier itself stays a pure clamp.
 *
 * `normalizedDemand` is already clamped to `[0,1]` by the worker's min-max
 * normalization; the output clamp is the load-bearing one (caps any future
 * `demandSensitivity` retune).
 */
export function computeDemandMultiplier(
	input: ComputeDemandMultiplierInput,
	config: RankingConfig,
): number {
	const raw = 1 + config.demandSensitivity * input.normalizedDemand;
	return Math.max(TOKEN_BOOST_MIN, Math.min(DEMAND_MULT_MAX, raw));
}

export interface QuantileValue {
	id: string;
	value: number;
}

/**
 * Rank-quantile normalization to `[0,1]` (explore-ranking-v4). Replaces
 * min-max for the demand signal: engagement is heavy-tailed, so min-max lets
 * a single outlier stretch the range and squash the body into a narrow band
 * (observed in prod: 76% of the catalog landed in demand-mult 1.20-1.50, 47%
 * in one decile). Rank percentiles are outlier-immune by construction — the
 * body spreads flat (~10% per decile) regardless of the tail.
 *
 * Ties share the percentile of the tie group's FIRST rank (min-rank, not
 * mean-rank). Load-bearing for the floor invariant: in a cold catalog every
 * zero-demand listing ties at the bottom, and min-rank keeps that whole group
 * at pct 0 → neutral 1.0× — mean-rank would gift a large bottom tie group a
 * ~1.5× boost for having no demand at all.
 *
 * n ≤ 1, or all values tied → 0 for everyone: nothing to differentiate, the
 * multiplier collapses to neutral (same as min-max's span-0 behavior).
 */
export function quantileNormalize(
	values: ReadonlyArray<QuantileValue>,
): Map<string, number> {
	const out = new Map<string, number>();
	const n = values.length;
	if (n === 0) return out;
	if (n === 1) {
		out.set((values[0] as QuantileValue).id, 0);
		return out;
	}
	const sorted = [...values].sort((a, b) => a.value - b.value);
	let i = 0;
	while (i < n) {
		let j = i;
		while (
			j + 1 < n &&
			(sorted[j + 1] as QuantileValue).value ===
				(sorted[i] as QuantileValue).value
		) {
			j++;
		}
		const pct = i / (n - 1);
		for (let k = i; k <= j; k++) {
			out.set((sorted[k] as QuantileValue).id, pct);
		}
		i = j + 1;
	}
	return out;
}

/**
 * Re-exported so callers wiring the refresh worker don't have to import from
 * two different modules to assemble the matched-token → demand pipeline.
 */
export type { MatchedToken };

export interface DiversityCandidate {
	id: string;
	sellerProfileId: string;
	title: string;
	/**
	 * Snapshot sort bucket (`SortPriority`). The diversity reflow never moves
	 * a listing across bucket boundaries — deferring an ACTIVE_BIN row must
	 * not let a SCHEDULED row jump ahead of it. Optional so callers without
	 * bucketed input (offline preview scripts) reflow as a single bucket.
	 */
	sortPriority?: number;
}

export interface SnapshotOrderCandidate {
	id: string;
	sortPriority: number;
	sortTimeMs: bigint;
	rankScore: number;
}

/**
 * §12 ordering used by every ranked listings surface (explore + profile
 * `featured` sort): live auctions (`ACTIVE_AUCTION` bucket) stay
 * ending-soonest on `sortTimeMs` so a near-closing auction can't be buried
 * behind a higher-rankScore upcoming one; every other bucket orders by
 * stored `rankScore` desc. `sortPriority` is always primary; `id` is the
 * stable tiebreaker.
 *
 * Lives here (not at the explore call site) so the single-seller profile
 * path can reuse the exact same ordering without re-deriving it — the two
 * surfaces MUST agree byte-for-byte or "same listing, different position
 * on explore vs profile" becomes a bug source.
 */
export function compareForSnapshot(
	a: SnapshotOrderCandidate,
	b: SnapshotOrderCandidate,
): number {
	if (a.sortPriority !== b.sortPriority) {
		return a.sortPriority - b.sortPriority;
	}
	if (a.sortPriority === SortPriority.ACTIVE_AUCTION) {
		if (a.sortTimeMs !== b.sortTimeMs) {
			return a.sortTimeMs < b.sortTimeMs ? -1 : 1;
		}
	} else if (a.rankScore !== b.rankScore) {
		return b.rankScore - a.rankScore;
	}
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Sliding-window per-seller cap + near-identical dedup, applied ONCE over the
 * full ordered candidate list at snapshot-build time, BEFORE slicing. At most
 * `perSellerCap` listings per seller in ANY `perSellerWindow` consecutive
 * slots; overflow DEFERS to the next available slot instead of demoting to
 * the feed tail (the v1 global cap exiled a seller's 3rd+ listings behind the
 * entire ~2k-row snapshot — see the `perSellerCap` config note for the prod
 * replay numbers and industry precedent). Never drop — result count is
 * preserved and a small-catalog seller is never erased. Because pagination is
 * a pure slice of this array and the window is genuinely sliding, the cap
 * holds across every page AND across page boundaries by construction.
 *
 * Two behaviors survive from v1 unchanged:
 *   - Same-seller near-identical relistings (normalized-title dup) still go
 *     to the global tail — spacing five copies of one card two-per-page would
 *     serve the same card on every page.
 *   - When only capped sellers remain in a bucket, the cap yields and they
 *     pack densely — a full feed beats a strictly-spaced short one.
 *
 * The reflow runs per `sortPriority` bucket: deferring an ACTIVE_BIN row must
 * never let a SCHEDULED/ENDED row jump ahead of it. Input MUST already be
 * `sortPriority`-ordered (it is — `compareForSnapshot` sorts on it first);
 * buckets are detected as contiguous runs, so an unsorted input would split
 * one logical bucket into several independently-spaced runs.
 */
export function applyDiversity(
	ordered: DiversityCandidate[],
	config: RankingConfig,
): string[] {
	const seenTitles = new Set<string>();
	const dupTail: string[] = [];
	const unique: DiversityCandidate[] = [];
	for (const c of ordered) {
		const titleKey = `${c.sellerProfileId}:${normalizeTitle(c.title)}`;
		if (seenTitles.has(titleKey)) {
			dupTail.push(c.id);
			continue;
		}
		seenTitles.add(titleKey);
		unique.push(c);
	}

	const cap = Math.max(1, config.perSellerCap);
	const win = Math.max(1, config.perSellerWindow);
	const out: string[] = [];

	let bucketStart = 0;
	for (let i = 1; i <= unique.length; i++) {
		if (
			i === unique.length ||
			(unique[i] as DiversityCandidate).sortPriority !==
				(unique[bucketStart] as DiversityCandidate).sortPriority
		) {
			reflowBucket(unique.slice(bucketStart, i), cap, win, out);
			bucketStart = i;
		}
	}

	return out.concat(dupTail);
}

/**
 * Greedy sliding-window reflow of one sort bucket, appending to `out`. At
 * each slot, place the highest-ranked pending candidate whose seller has
 * fewer than `cap` placements among the previous `win - 1` slots; when no
 * candidate qualifies (only capped sellers remain), the cap yields to keep
 * the feed dense.
 */
function reflowBucket(
	bucket: DiversityCandidate[],
	cap: number,
	win: number,
	out: string[],
): void {
	const pending = [...bucket];
	/** Sellers of the last `win - 1` placements; counts age out as it slides. */
	const recent: string[] = [];
	const counts = new Map<string, number>();
	while (pending.length > 0) {
		let idx = pending.findIndex(
			(c) => (counts.get(c.sellerProfileId) ?? 0) < cap,
		);
		if (idx < 0) idx = 0;
		const c = pending.splice(idx, 1)[0] as DiversityCandidate;
		out.push(c.id);
		counts.set(c.sellerProfileId, (counts.get(c.sellerProfileId) ?? 0) + 1);
		recent.push(c.sellerProfileId);
		if (recent.length > win - 1) {
			const aged = recent.shift() as string;
			counts.set(aged, (counts.get(aged) ?? 0) - 1);
		}
	}
}
