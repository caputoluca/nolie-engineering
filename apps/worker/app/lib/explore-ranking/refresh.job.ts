import { DAY_MS, SOLD_VISIBILITY_DAYS } from "@nolie/core/constants/listings";
import {
	computeRankBaseScore,
	computeRankScore,
	DEFAULT_RANKING_CONFIG,
	EXPLORE_RANK_EPOCH_KEY,
	EXPLORE_RANKING_ENABLED_KEY,
	RANK_BASE_VERSION,
} from "@nolie/core/explore";
import {
	computeReviewAvgShrunk,
	computeSellerTrust,
	normalizeRating,
} from "@nolie/core/seller-trust";
import { ListingStatus, Prisma } from "@nolie/db";
import type { WorkerContextBase } from "../context.js";

const UPDATE_CHUNK = 500;

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

/**
 * /explore default-feed ranking refresh (NL-284, docs/explore-ranking.md §7;
 * NL-310 v2 commit #6 extends with sellerTrust). Sole writer of the
 * time-decaying `rankScore`. Pure formula lives in `@nolie/core/explore` —
 * no SQL/TS duplication. The `IS DISTINCT FROM` write guard churns only
 * rows whose stored value moved: `rankScore` advances every scheduled run
 * because `now` advances — that is intended; the 10-minute cadence (not
 * byte-stable idempotency) is what keeps writes negligible per §7. A
 * same-instant BullMQ retry IS a true no-op, so retries are safe.
 *
 * v2 ordering: (1) refresh seller-trust state — one read, one write, in-
 * memory computes the `sellerTrust` map and the persisted `reviewAvgShrunk`
 * column from the same row; (2) recompute every listing's base score with
 * the populated trust input; (3) write rankScore.
 *
 * Scale escape hatch (§7 [DEFER], trigger-gated): the recency UPDATE can move
 * fully server-side (`SET rankScore = rankBaseScore + :wR * power(0.5,
 * extract(epoch from (now()-"createdAt"))/3600/:halfLife)`), zero rows in app
 * memory. NOT done now because that form assumes `rankBaseScore` is already
 * correct in-column — it does not cover the trust-input recompute below
 * (sellerTrust changes whenever reviews land or a badge flips, regardless
 * of rankBaseVersion). A pushdown must keep the base recompute (a reduced TS
 * pass) or it silently leaves listings scored on stale trust. The
 * cutoff-bounded scan keeps this sub-ms until that trigger actually fires.
 */
export async function refresh(ctx: WorkerContextBase): Promise<void> {
	const { prisma, redis, logger } = ctx;
	const start = Date.now();

	const { trustMap, sellersTrustUpdated } = await refreshSellerTrust(ctx);

	// Bounded scan (§7 step 1): live-ish statuses unconditionally, plus any
	// row written within the sold-visibility cutoff. Superset of every
	// explore-visible row; old terminal rows drop out so this never degrades
	// into a full-table scan as the catalog grows.
	const cutoff = new Date(Date.now() - SOLD_VISIBILITY_DAYS * DAY_MS);
	const rows = await prisma.listing.findMany({
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
		},
	});

	const now = new Date();
	let scoreMin = Number.POSITIVE_INFINITY;
	let scoreMax = Number.NEGATIVE_INFINITY;
	let sellerTrustMax = 0;

	const pending = rows.map((r) => {
		const sellerTrust = trustMap.get(r.sellerProfileId) ?? 0;
		if (sellerTrust > sellerTrustMax) sellerTrustMax = sellerTrust;

		// v2 (commit #6): recompute the base score on every tick. sellerTrust
		// changes whenever a review lands or a 1st Edition badge flips, and
		// the rankBaseVersion gate alone can't detect those. The
		// IS DISTINCT FROM write guard below absorbs the cost when nothing
		// actually moved.
		const rankBaseScore = computeRankBaseScore(
			{
				title: r.title,
				description: r.description,
				sellerTrust,
			},
			DEFAULT_RANKING_CONFIG,
		);
		const rankBaseVersion = RANK_BASE_VERSION;

		const rankScore = computeRankScore(
			{ rankBaseScore, createdAt: r.createdAt, now },
			DEFAULT_RANKING_CONFIG,
		);
		if (rankScore < scoreMin) scoreMin = rankScore;
		if (rankScore > scoreMax) scoreMax = rankScore;

		return { id: r.id, rankScore, rankBaseScore, rankBaseVersion };
	});

	let rowsUpdated = 0;
	for (let i = 0; i < pending.length; i += UPDATE_CHUNK) {
		const chunk = pending.slice(i, i + UPDATE_CHUNK);
		const values = Prisma.join(
			chunk.map(
				(p) =>
					Prisma.sql`(${p.id}, ${p.rankScore}::double precision, ${p.rankBaseScore}::double precision, ${p.rankBaseVersion}::int)`,
			),
		);
		// Raw SQL targets the physical `auction` table (NL-284 columns are
		// unmapped, so field name == column name).
		rowsUpdated += await prisma.$executeRaw`
			UPDATE "auction" AS a
			SET "rankScore" = v.rank_score,
				"rankBaseScore" = v.rank_base_score,
				"rankBaseVersion" = v.rank_base_version
			FROM (VALUES ${values}) AS v(id, rank_score, rank_base_score, rank_base_version)
			WHERE a.id = v.id
				AND (a."rankScore" IS DISTINCT FROM v.rank_score
					OR a."rankBaseScore" IS DISTINCT FROM v.rank_base_score
					OR a."rankBaseVersion" IS DISTINCT FROM v.rank_base_version)
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
			rowsScanned: rows.length,
			rowsUpdated,
			sellersTrustUpdated,
			sellerTrustMax,
			durationMs: Date.now() - start,
			scoreMin: Number.isFinite(scoreMin) ? scoreMin : null,
			scoreMax: Number.isFinite(scoreMax) ? scoreMax : null,
		},
		"explore rank refresh complete",
	);
}
