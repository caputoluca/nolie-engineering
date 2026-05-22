import { Prisma } from "@nolie/db";
import type {
	EngagementEventEnvelope,
	engagementEventsQueue,
} from "@nolie/queues/engagement-events";
import type { NoLieJob } from "@nolie/queues/types";
import type { WorkerContextBase } from "../context.js";

/**
 * Engagement event batched writer (NL-310, docs/explore-ranking-v2.md §5.3).
 *
 * BullMQ jobs deliver one envelope at a time. To get the doc's "multi-row
 * INSERT per batch" property we hold envelopes in an in-memory buffer that
 * flushes when it hits FLUSH_THRESHOLD events OR FLUSH_INTERVAL_MS elapses,
 * whichever comes first. Each handler returns a Promise tied to its batch's
 * flush — BullMQ keeps the job in `active` state until the flush resolves,
 * so a process crash mid-batch leaves the jobs in Redis for the next worker
 * to redeliver (acceptable best-effort loss bound per §5.3).
 *
 * Dedup is at the DB layer via `ON CONFLICT (event_id, occurred_at) DO
 * NOTHING` — `event_id` + `occurred_at` are stamped once in `events.emit`
 * and replayed verbatim on BullMQ retries.
 *
 * Worker concurrency must be ≥ FLUSH_THRESHOLD so the buffer can actually
 * fill (otherwise BullMQ's processor stalls before we can batch).
 */
const FLUSH_THRESHOLD = 100;
const FLUSH_INTERVAL_MS = 1000;

interface BufferedEntry {
	envelope: EngagementEventEnvelope;
	resolve: () => void;
	reject: (err: Error) => void;
}

let buffer: BufferedEntry[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushInFlight = false;

async function flushBuffer(ctx: WorkerContextBase): Promise<void> {
	if (flushInFlight || buffer.length === 0) return;
	flushInFlight = true;

	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}

	const batch = buffer;
	buffer = [];

	const start = Date.now();
	try {
		const inserted = await bulkInsertEvents(
			ctx.prisma,
			batch.map((e) => e.envelope),
		);
		ctx.logger.info(
			{
				event: "engagement_batch_write",
				batchSize: batch.length,
				inserted,
				dupesDropped: batch.length - inserted,
				durationMs: Date.now() - start,
			},
			"engagement event batch written",
		);
		for (const entry of batch) entry.resolve();
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		// Reject every job in this batch — BullMQ retries each individually,
		// which is fine: the next retry attempt batches them with whatever's
		// arrived since, and ON CONFLICT absorbs any rows that did land before
		// the throw.
		for (const entry of batch) entry.reject(error);
	} finally {
		flushInFlight = false;
		// Anything that arrived during the flush kicks off a fresh timer; the
		// FLUSH_THRESHOLD branch in the handler already covers the >=100 case.
		if (buffer.length > 0 && !flushTimer) {
			flushTimer = setTimeout(() => void flushBuffer(ctx), FLUSH_INTERVAL_MS);
		}
	}
}

async function bulkInsertEvents(
	prisma: WorkerContextBase["prisma"],
	envelopes: EngagementEventEnvelope[],
): Promise<number> {
	if (envelopes.length === 0) return 0;

	const values = Prisma.join(
		envelopes.map(
			(e) => Prisma.sql`(
				${e.eventId}::uuid,
				${e.eventName},
				${e.eventVersion}::smallint,
				${e.occurredAt}::timestamptz,
				${e.userId},
				${e.anonymousId},
				${e.sessionId},
				${e.listingId},
				${e.sellerId},
				${e.orderId},
				${e.surface},
				${e.queryId}::uuid,
				${e.rankPosition}::smallint,
				${e.rankEpoch},
				${e.referrerSurface},
				${e.client},
				${e.appVersion},
				${e.userAgent},
				${e.ipCountry},
				${JSON.stringify(e.payload)}::jsonb
			)`,
		),
	);

	const inserted = await prisma.$executeRaw`
		INSERT INTO engagement_event (
			event_id, event_name, event_version, occurred_at,
			user_id, anonymous_id, session_id,
			listing_id, seller_id, order_id,
			surface, query_id, rank_position, rank_epoch,
			referrer_surface, client, app_version, user_agent, ip_country,
			payload
		) VALUES ${values}
		ON CONFLICT (event_id, occurred_at) DO NOTHING
	`;
	return inserted;
}

export function writeEngagementEvent(
	job: NoLieJob<typeof engagementEventsQueue, "write">,
	ctx: WorkerContextBase,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		buffer.push({ envelope: job.data, resolve, reject });
		if (buffer.length >= FLUSH_THRESHOLD) {
			void flushBuffer(ctx);
		} else if (!flushTimer) {
			flushTimer = setTimeout(() => void flushBuffer(ctx), FLUSH_INTERVAL_MS);
		}
	});
}
