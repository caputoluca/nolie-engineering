import { DAY_MS, SOLD_VISIBILITY_DAYS } from "@nolie/core/constants/listings";
import {
	computeRankBaseScore,
	computeRankScore,
	DEFAULT_RANKING_CONFIG,
	EXPLORE_RANK_EPOCH_KEY,
	EXPLORE_RANKING_ENABLED_KEY,
	RANK_BASE_VERSION,
} from "@nolie/core/explore";
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

function toCents(value: Prisma.Decimal | null): number | null {
	return value == null ? null : Math.round(value.toNumber() * 100);
}

/**
 * /explore default-feed ranking refresh (NL-284, docs/explore-ranking.md §7).
 * Sole writer of the time-decaying `rankScore`. Pure formula lives in
 * `@nolie/core/explore` — no SQL/TS duplication. The `IS DISTINCT FROM`
 * write guard churns only rows whose stored value moved: the base columns
 * (`rankBaseScore`/`rankBaseVersion`) move only on a version bump, while
 * `rankScore` advances every scheduled run because `now` advances — that is
 * intended; the 10-minute cadence (not byte-stable idempotency) is what
 * keeps writes negligible per §7. A same-instant BullMQ retry IS a true
 * no-op, so retries are safe.
 *
 * Scale escape hatch (§7 [DEFER], trigger-gated): the recency UPDATE can move
 * fully server-side (`SET rankScore = rankBaseScore + :wR * power(0.5,
 * extract(epoch from (now()-"createdAt"))/3600/:halfLife)`), zero rows in app
 * memory. NOT done now because that form assumes `rankBaseScore` is already
 * correct in-column — it does not cover the self-healing base recompute below
 * (stale `rankBaseVersion` / migrated rows defaulted to 0). A pushdown must
 * keep that base self-heal (a reduced TS pass) or it silently leaves the
 * existing catalog scored on recency only. The cutoff-bounded scan keeps this
 * sub-ms until that trigger actually fires.
 */
export async function refresh(ctx: WorkerContextBase): Promise<void> {
	const { prisma, redis, logger } = ctx;
	const start = Date.now();

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
			createdAt: true,
			rankBaseScore: true,
			rankBaseVersion: true,
			listingType: true,
			price: true,
			startingBid: true,
			_count: { select: { listingAssets: true } },
		},
	});

	const now = new Date();
	let scoreMin = Number.POSITIVE_INFINITY;
	let scoreMax = Number.NEGATIVE_INFINITY;

	const pending = rows.map((r) => {
		let rankBaseScore = r.rankBaseScore;
		let rankBaseVersion = r.rankBaseVersion;

		// Self-healing backfill + retune path: recompute the base for rows
		// written under an older RANK_BASE_VERSION (also covers freshly
		// migrated rows defaulted to 0).
		if (rankBaseVersion < RANK_BASE_VERSION) {
			const priceCents =
				r.listingType === "fixed_price"
					? toCents(r.price)
					: toCents(r.startingBid);
			rankBaseScore = computeRankBaseScore(
				{ photoCount: r._count.listingAssets, priceCents },
				DEFAULT_RANKING_CONFIG,
			);
			rankBaseVersion = RANK_BASE_VERSION;
		}

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
			durationMs: Date.now() - start,
			scoreMin: Number.isFinite(scoreMin) ? scoreMin : null,
			scoreMax: Number.isFinite(scoreMax) ? scoreMax : null,
		},
		"explore rank refresh complete",
	);
}
