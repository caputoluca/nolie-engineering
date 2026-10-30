/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 * Left out is plumbing: the Redis client.
 */

import { redis } from "@nolie/redis";

const DIRTY_TTL_SECONDS = 3600; // 1 hour safety TTL

/**
 * Generic Redis inbox for ordered, sequential processing.
 *
 * Pattern:
 * - Producer: push() + markDirty() + kick drain job
 * - Consumer: pop() in loop, check isDirty() after drain, clearDirty() at round start
 */

function inboxKey(namespace: string, id: string) {
	return `inbox:${namespace}:${id}`;
}

function dirtyKey(namespace: string, id: string) {
	return `inbox:${namespace}:${id}:dirty`;
}

/**
 * Push an item to the end of an inbox (FIFO).
 * Items are stored as JSON strings.
 */
export async function push<T>(
	namespace: string,
	id: string,
	item: T,
): Promise<number> {
	const key = inboxKey(namespace, id);
	return redis.rpush(key, JSON.stringify(item));
}

/**
 * Pop an item from the front of an inbox (FIFO).
 * Returns null if inbox is empty.
 */
export async function pop<T>(namespace: string, id: string): Promise<T | null> {
	const key = inboxKey(namespace, id);
	const raw = await redis.lpop(key);
	if (!raw) return null;
	return JSON.parse(raw) as T;
}

/**
 * Peek at the front item without removing it.
 * Useful for inspection/debugging.
 */
export async function peek<T>(
	namespace: string,
	id: string,
): Promise<T | null> {
	const key = inboxKey(namespace, id);
	const raw = await redis.lindex(key, 0);
	if (!raw) return null;
	return JSON.parse(raw) as T;
}

/**
 * Get the current length of an inbox.
 * Useful for monitoring queue depth.
 */
export async function length(namespace: string, id: string): Promise<number> {
	const key = inboxKey(namespace, id);
	return redis.llen(key);
}

/**
 * Mark an inbox as dirty (new items arrived).
 * Used by producers after pushing items.
 */
export async function markDirty(
	namespace: string,
	id: string,
	ttlSeconds: number = DIRTY_TTL_SECONDS,
): Promise<void> {
	const key = dirtyKey(namespace, id);
	await redis.set(key, "1", "EX", ttlSeconds);
}

/**
 * Check if an inbox is marked dirty.
 * Used by consumers after draining to check for new items.
 */
export async function isDirty(namespace: string, id: string): Promise<boolean> {
	const key = dirtyKey(namespace, id);
	const value = await redis.get(key);
	return value === "1";
}

/**
 * Clear the dirty flag for an inbox.
 * Used by consumers at the start of each drain round.
 */
export async function clearDirty(namespace: string, id: string): Promise<void> {
	const key = dirtyKey(namespace, id);
	await redis.del(key);
}

/**
 * Delete an inbox and its dirty flag completely.
 * Used for cleanup after an auction is settled.
 * Returns the number of items that were in the inbox (0 if empty/didn't exist).
 */
export async function deleteAll(
	namespace: string,
	id: string,
): Promise<number> {
	const key = inboxKey(namespace, id);
	const dirty = dirtyKey(namespace, id);

	// Get length before deleting (for logging orphaned items)
	const len = await redis.llen(key);

	// Delete both keys
	await redis.del(key, dirty);

	return len;
}

/**
 * Atomically push an item to inbox and mark it dirty.
 */
export async function pushAndMarkDirty<T>(
	namespace: string,
	id: string,
	items: T | T[],
	ttlSeconds: number = DIRTY_TTL_SECONDS,
): Promise<number> {
	const list = Array.isArray(items) ? items : [items];
	if (list.length === 0) return 0;

	const key = inboxKey(namespace, id);
	const dirty = dirtyKey(namespace, id);

	const payload = list.map((item) => JSON.stringify(item));

	const results = await redis
		.multi()
		.rpush(key, ...payload)
		.set(dirty, "1", "EX", ttlSeconds)
		.exec();

	if (!results || results.length < 2) {
		throw new Error("Redis transaction aborted or incomplete");
	}

	const [rpushErr, rpushResult] = results[0] ?? [];
	const [setErr] = results[1] ?? [];

	if (rpushErr) throw rpushErr;
	if (setErr) throw setErr;

	return rpushResult as number;
}

/**
 * Create a typed inbox instance for a specific namespace.
 * The returned inbox has all methods bound to the namespace,
 * so you only need to provide the id parameter.
 *
 * @example
 * ```ts
 * const bidsInbox = createInbox<BidInboxItemType>("bids");
 * await bidsInbox.push("auction-123", { amount: 100, userId: "user-1", ... });
 * ```
 */
export function createInbox<T>(namespace: string) {
	return {
		push: (id: string, item: T): Promise<number> => {
			return push<T>(namespace, id, item);
		},
		pop: (id: string): Promise<T | null> => {
			return pop<T>(namespace, id);
		},
		peek: (id: string): Promise<T | null> => {
			return peek<T>(namespace, id);
		},
		length: (id: string): Promise<number> => {
			return length(namespace, id);
		},
		markDirty: (
			id: string,
			ttlSeconds: number = DIRTY_TTL_SECONDS,
		): Promise<void> => {
			return markDirty(namespace, id, ttlSeconds);
		},
		isDirty: (id: string): Promise<boolean> => {
			return isDirty(namespace, id);
		},
		clearDirty: (id: string): Promise<void> => {
			return clearDirty(namespace, id);
		},
		pushAndMarkDirty: (
			id: string,
			items: T | T[],
			ttlSeconds: number = DIRTY_TTL_SECONDS,
		): Promise<number> => {
			return pushAndMarkDirty<T>(namespace, id, items, ttlSeconds);
		},
		deleteAll: (id: string): Promise<number> => {
			return deleteAll(namespace, id);
		},
	};
}

export type Inbox<T> = ReturnType<typeof createInbox<T>>;
