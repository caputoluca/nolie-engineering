/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 * Left out is plumbing: the auction status type.
 */

import type { AuctionStatusType } from "@nolie/schemas/auction/status";

/**
 * Lightweight per-card auction state managed outside React.
 *
 * Each visible auction card gets its own store instance that is updated
 * by realtime Ably events (bids, extensions, ended). Cards read from
 * the store via `useSyncExternalStore` so only the affected card
 * re-renders when an event arrives.
 *
 * Stores persist in a module-level registry (`Map`) so that when a card
 * scrolls back into the viewport, the last-known values display
 * instantly while the Ably channel reattaches.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface AuctionCardState {
	highestBidAmount: number | null;
	bidCount: number;
	endAt: string;
	isEnded: boolean;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class AuctionCardStore {
	private state: AuctionCardState;
	private listeners = new Set<() => void>();

	constructor(initial: AuctionCardState) {
		this.state = initial;
	}

	// --- useSyncExternalStore interface ---

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = (): AuctionCardState => this.state;

	getServerSnapshot = (): AuctionCardState => this.state;

	// --- Mutations (called by realtime event handlers) ---

	applyBid(amount: number): void {
		this.updateState((prev) => ({
			...prev,
			highestBidAmount:
				prev.highestBidAmount === null || amount > prev.highestBidAmount
					? amount
					: prev.highestBidAmount,
			bidCount: prev.bidCount + 1,
		}));
	}

	applyExtension(newEndAt: string): void {
		this.updateState((prev) => ({
			...prev,
			endAt: newEndAt,
		}));
	}

	markEnded(): void {
		this.updateState((prev) => ({
			...prev,
			isEnded: true,
		}));
	}

	/**
	 * Correct the highest bid amount without touching bidCount.
	 * Used when a bid rejection includes the actual current highest —
	 * idempotent: no-op if the store already has a higher or equal value.
	 */
	correctHighestBid(amount: number): void {
		this.updateState((prev) => ({
			...prev,
			highestBidAmount:
				prev.highestBidAmount === null || amount > prev.highestBidAmount
					? amount
					: prev.highestBidAmount,
		}));
	}

	/**
	 * Re-seed the store with fresh server data (e.g. on resubscribe after
	 * scrolling back into view). Only applies values that are "newer" so
	 * we never regress a realtime update with stale REST data.
	 */
	reconcile(data: AuctionCardState): void {
		this.updateState((prev) => ({
			highestBidAmount: newerAmount(
				prev.highestBidAmount,
				data.highestBidAmount,
			),
			bidCount: Math.max(prev.bidCount, data.bidCount),
			endAt:
				new Date(data.endAt).getTime() > new Date(prev.endAt).getTime()
					? data.endAt
					: prev.endAt,
			isEnded: prev.isEnded || data.isEnded,
		}));
	}

	// --- Internals ---

	private updateState(
		updater: (prev: AuctionCardState) => AuctionCardState,
	): void {
		const prev = this.state;
		const next = updater(prev);

		if (
			prev.highestBidAmount !== next.highestBidAmount ||
			prev.bidCount !== next.bidCount ||
			prev.endAt !== next.endAt ||
			prev.isEnded !== next.isEnded
		) {
			this.state = next;
			for (const listener of this.listeners) {
				listener();
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const stores = new Map<string, AuctionCardStore>();

/**
 * Get or create a store for the given auction. If the store already exists
 * (card scrolled out then back), the existing instance is returned with
 * its last-known state intact.
 */
export function getAuctionCardStore(
	auctionId: string,
	initial: AuctionCardState,
): AuctionCardStore {
	let store = stores.get(auctionId);
	if (!store) {
		store = new AuctionCardStore(initial);
		stores.set(auctionId, store);
	}
	return store;
}

/**
 * Remove a store from the registry. Call when you know the auction is no
 * longer relevant (e.g. explore page unmounts entirely).
 */
export function removeAuctionCardStore(auctionId: string): void {
	stores.delete(auctionId);
}

/**
 * Clear all stores. Useful for page-level cleanup.
 */
export function clearAuctionCardStores(): void {
	stores.clear();
}

/**
 * Apply a bid to an existing card store (if one exists).
 * Called from bid-success callbacks so that navigating back to a page
 * with auction cards (e.g. explore) shows the updated price immediately.
 * No-ops if the store hasn't been created yet (card was never rendered).
 */
export function applyBidToCardStore(auctionId: string, amount: number): void {
	stores.get(auctionId)?.applyBid(amount);
}

/**
 * Correct the highest bid amount on an existing card store without
 * incrementing bidCount. Idempotent — no-op if the store already has
 * a higher value or doesn't exist.
 */
export function correctCardStoreBid(auctionId: string, amount: number): void {
	stores.get(auctionId)?.correctHighestBid(amount);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newerAmount(a: number | null, b: number | null): number | null {
	if (a === null) return b;
	if (b === null) return a;
	return Math.max(a, b);
}

/**
 * Derive initial card state from the props already available on
 * `AuctionCardAuction`. Avoids duplicating the mapping at every call site.
 */
export function toAuctionCardState(auction: {
	highestBidAmount: number | null;
	bidCount: number;
	endAt: string;
	status: AuctionStatusType;
}): AuctionCardState {
	return {
		highestBidAmount: auction.highestBidAmount,
		bidCount: auction.bidCount,
		endAt: auction.endAt,
		isEnded:
			auction.status === "closed" ||
			auction.status === "failed" ||
			auction.status === "cancelled" ||
			auction.status === "sold",
	};
}
