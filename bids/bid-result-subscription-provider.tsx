/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 * Left out: the realtime client (useRealtime, useRealtimeContext), which holds
 * the page's one socket and renews its token; realtime/ tells that story.
 * Everything else is plumbing: types, React, the user, logging, error reporting.
 */

"use client";

import type { BidResultEventSchema } from "@nolie/schemas/auction/bid";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
} from "react";
import type { z } from "zod";
import { logger } from "@/lib/logger";
import {
	reportErrorMessage,
	setReportingContext,
} from "@/lib/observability/sentry/report-error-message";
import { useRealtimeContext } from "./realtime-provider";
import { useRealtime } from "./use-realtime";
import { useUser } from "./use-user";

export type BidResultEvent = z.infer<typeof BidResultEventSchema>;

interface PendingBid {
	resolve: (event: BidResultEvent) => void;
	reject: (error: Error) => void;
}

interface BidResultSubscriptionContextValue {
	/**
	 * Ensure the bid result subscription is active.
	 * Call this when opening the bid modal.
	 * - If already subscribed: no-op (returns immediately)
	 * - If reauth in progress: awaits it, then subscribes
	 * - Otherwise: subscribes immediately
	 */
	ensureSubscribed: () => Promise<void>;
	/**
	 * Wait for a bid result matching the given requestId.
	 * @param requestId - The requestId returned from the bid API
	 * @param signal - Optional AbortSignal for timeout/cancellation
	 * @returns Promise that resolves with the BidResultEvent
	 * @throws DOMException with name "AbortError" if signal is aborted
	 */
	waitForResult: (
		requestId: string,
		signal?: AbortSignal,
	) => Promise<BidResultEvent>;
}

const BidResultSubscriptionContext =
	createContext<BidResultSubscriptionContextValue | null>(null);

const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * Provider that manages the bid result websocket subscription.
 *
 * Subscription strategy:
 * - Eager: If user exists on mount, subscribe immediately
 * - Lazy: If user logs in mid-session, subscribe when modal opens via ensureSubscribed()
 * - Cleanup: Unsubscribe and detach channel when user logs out (prevents FAILED state)
 * - Recovery: If channel enters FAILED state, release it, reauthorize, and let
 *   the next ensureSubscribed() re-subscribe with a fresh channel
 */
export function BidResultSubscriptionProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const { client, getReauthorizePromise, reauthorize } = useRealtimeContext();
	const rt = useRealtime();
	const user = useUser();

	const pendingBidsRef = useRef<Map<string, PendingBid>>(new Map());
	// Buffer for bid results that arrive via WebSocket before waitForResult() is called.
	// Handles the race where the worker publishes faster than the HTTP response returns.
	const earlyResultsRef = useRef<Map<string, BidResultEvent>>(new Map());
	const unsubscribeRef = useRef<(() => void) | null>(null);
	const subscribedUserIdRef = useRef<string | null>(null);
	const channelFailedCleanupRef = useRef<(() => void) | null>(null);
	const recoveryAttemptsRef = useRef(0);

	// Helper to subscribe to user channel
	const subscribe = useCallback(
		(userId: string) => {
			if (subscribedUserIdRef.current === userId) {
				return; // Already subscribed
			}

			// Clean up any previous failure listener
			if (channelFailedCleanupRef.current) {
				channelFailedCleanupRef.current();
				channelFailedCleanupRef.current = null;
			}

			try {
				unsubscribeRef.current = rt.bid.result.subscribe(userId, (event) => {
					const pending = pendingBidsRef.current.get(event.requestId);
					if (pending) {
						pendingBidsRef.current.delete(event.requestId);
						pending.resolve(event);
					} else {
						// Result arrived before waitForResult() — buffer it
						earlyResultsRef.current.set(event.requestId, event);
					}
				});

				// Monitor channel for FAILED state (e.g., token capability denied)
				const channelName = `user:${userId}`;
				channelFailedCleanupRef.current = client.onChannelFailed(
					channelName,
					(stateChange) => {
						const reset = () => {
							// Clean up the failed subscription and listener
							if (channelFailedCleanupRef.current) {
								channelFailedCleanupRef.current();
								channelFailedCleanupRef.current = null;
							}
							if (unsubscribeRef.current) {
								unsubscribeRef.current();
								unsubscribeRef.current = null;
							}

							// Release the failed channel so next subscribe gets a fresh one
							client.releaseChannel(channelName);
							subscribedUserIdRef.current = null;
							for (const [requestId, pending] of pendingBidsRef.current) {
								pending.reject(
									new DOMException(
										`Channel failed while waiting for bid ${requestId}`,
										"AbortError",
									),
								);
							}
							pendingBidsRef.current.clear();
							earlyResultsRef.current.clear();
						};
						const attempt = recoveryAttemptsRef.current;
						logger.error(
							{ userId, reason: stateChange.reason, attempt },
							"User channel failed, attempting recovery",
						);

						if (attempt >= MAX_RECOVERY_ATTEMPTS) {
							reportErrorMessage(
								"User bid result subscription failed, recovery exhausted",
								{
									operation: "bid_result_channel_recovery_exhausted",
									tags: { userId },
								},
							);
							reset();
							return;
						}

						recoveryAttemptsRef.current = attempt + 1;

						// Fire-and-forget: reauthorize to get fresh token.
						// ensureSubscribed() will await it via getReauthorizePromise()
						reauthorize();

						// Clean up the failed subscription and listener
						reset();
					},
				);

				subscribedUserIdRef.current = userId;
				recoveryAttemptsRef.current = 0;
				logger.debug({ userId }, "Bid result subscription active");
			} catch (error) {
				logger.error({ error, userId }, "Failed to subscribe to bid results");
				setReportingContext({
					operation: "bid_result_subscription",
					extra: { userId },
				});
				throw error;
			}
		},
		[rt, client, reauthorize],
	);

	// Helper to cleanup subscription
	const cleanup = useCallback(
		(userId: string | null) => {
			if (channelFailedCleanupRef.current) {
				channelFailedCleanupRef.current();
				channelFailedCleanupRef.current = null;
			}

			if (unsubscribeRef.current) {
				unsubscribeRef.current();
				unsubscribeRef.current = null;
			}

			// Detach the channel to prevent FAILED state when token capabilities change
			// Only detaches if channel is attached (avoids race conditions on page refresh)
			if (userId) {
				client.detachChannel(`user:${userId}`);
			}

			subscribedUserIdRef.current = null;
		},
		[client],
	);

	// No eager subscribe — the channel attaches lazily on first modal open
	// via ensureSubscribed(). This avoids a race where the child effect fires
	// before RealtimeProvider's reauthorize effect (React fires child effects
	// first), causing a "channel denied" error with a stale anonymous token.
	// Channel attach is ~50ms (one WebSocket roundtrip), invisible to the user.

	// Cleanup when user logs out
	useEffect(() => {
		if (!user?.id && subscribedUserIdRef.current) {
			const userId = subscribedUserIdRef.current;
			cleanup(userId);
			recoveryAttemptsRef.current = 0;

			// Reject any pending bids
			for (const [requestId, pending] of pendingBidsRef.current) {
				pending.reject(
					new DOMException(
						`User logged out while waiting for bid ${requestId}`,
						"AbortError",
					),
				);
			}
			pendingBidsRef.current.clear();
			earlyResultsRef.current.clear();
		}
	}, [user?.id, cleanup]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			const userId = subscribedUserIdRef.current;
			cleanup(userId);
			for (const [requestId, pending] of pendingBidsRef.current) {
				pending.reject(
					new DOMException(
						`Provider unmounted while waiting for bid ${requestId}`,
						"AbortError",
					),
				);
			}
			pendingBidsRef.current.clear();
			earlyResultsRef.current.clear();
		};
	}, [cleanup]);

	// Ensure subscription is active - call when modal opens
	const ensureSubscribed = useCallback(async () => {
		if (!user?.id) {
			return; // No user, can't subscribe
		}

		if (subscribedUserIdRef.current === user.id) {
			return; // Already subscribed
		}

		// Trigger reauth if a new token was primed (e.g. sign-up redirect
		// where the Ably client still has anonymous capabilities).
		// We do this here rather than relying on RealtimeProvider's effect
		// because React fires child effects before parent effects.
		if (client.needsReauth) {
			client.clearNeedsReauth();
			reauthorize();
		}

		// Wait for any pending reauthorization (including one we just started)
		const pendingReauth = getReauthorizePromise();
		if (pendingReauth) {
			await pendingReauth;
		}

		// Now safe to subscribe
		subscribe(user.id);
	}, [user?.id, client, reauthorize, getReauthorizePromise, subscribe]);

	const waitForResult = useCallback(
		(requestId: string, signal?: AbortSignal): Promise<BidResultEvent> => {
			// Check if result already arrived before we started waiting
			const earlyResult = earlyResultsRef.current.get(requestId);
			if (earlyResult) {
				earlyResultsRef.current.delete(requestId);
				return Promise.resolve(earlyResult);
			}

			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
					return;
				}

				const onAbort = () => {
					pendingBidsRef.current.delete(requestId);
					reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				pendingBidsRef.current.set(requestId, {
					resolve: (event) => {
						signal?.removeEventListener("abort", onAbort);
						resolve(event);
					},
					reject: (error) => {
						signal?.removeEventListener("abort", onAbort);
						reject(error);
					},
				});
			});
		},
		[],
	);

	return (
		<BidResultSubscriptionContext.Provider
			value={{ ensureSubscribed, waitForResult }}
		>
			{children}
		</BidResultSubscriptionContext.Provider>
	);
}

/**
 * Hook to access the bid result subscription context.
 * Must be used inside BidResultSubscriptionProvider.
 */
export function useBidResultSubscription(): BidResultSubscriptionContextValue {
	const context = useContext(BidResultSubscriptionContext);
	if (!context) {
		throw new Error(
			"useBidResultSubscription must be used inside <BidResultSubscriptionProvider>",
		);
	}
	return context;
}
