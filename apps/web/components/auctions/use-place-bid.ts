"use client";

import { fail } from "@nolie/actions";
import { computeNextBidAmount } from "@nolie/core/auctions";
import { anySignal } from "@nolie/http";
import {
	type BidCreateResponse,
	BidCreateSchema,
} from "@nolie/schemas/auction/bid";
import { BidValidationCode } from "@nolie/schemas/auction/bid-validation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { correctCardStoreBid } from "@/components/auction-card/store";
import { BID_ERROR_MESSAGES, placeBid } from "@/lib/mutations/bids";
import { reportErrorMessage } from "@/lib/observability/sentry/report-error-message";
import { usePdpReferrer } from "@/lib/referrer";
import { useAuctionData } from "./auction-provider";
import { useBidResultSubscription } from "./bid-result-subscription-provider";
import { useNextBidAmount } from "./use-next-bid-amount";
import { usePlaceBidShared } from "./use-place-bid-shared";

/**
 * Special marker for timeout - UI uses this to show warning state
 */
export const BID_TIMEOUT_ERROR = "BID_CONFIRMATION_TIMEOUT";

/**
 * Check if errors array contains the timeout error marker
 */
export function isBidTimeoutError(errors?: string[]): boolean {
	return errors?.includes(BID_TIMEOUT_ERROR) ?? false;
}

/**
 * Whether the bid failed because the buyer's account is suspended from buying
 * (dispute automation P3). Retrying can never succeed, so the outcome modal
 * offers a Close button instead of "Try again". Matches on the mapped message
 * (the source of truth for both the sync API-error map and the worker rejection
 * path), so it stays correct if the copy changes.
 */
export function isBidSuspendedError(errors?: string[]): boolean {
	return (
		errors?.includes(BID_ERROR_MESSAGES[BidValidationCode.buyer_suspended]) ??
		false
	);
}

const BID_RESULT_TIMEOUT_MS = 10_000;

export function usePlaceBid(
	open: boolean,
	onOpenChange?: (open: boolean) => void,
) {
	const { id, startingBid } = useAuctionData();
	const storeAmount = useNextBidAmount();
	const { waitForResult } = useBidResultSubscription();
	// §19 — originating-feed triad captured from URL params at PDP load.
	// Null for direct-PDP visits. Threaded onto X-NL-Referrer-* headers
	// inside placeBid so the bid_placed engagement event attributes back
	// to the surface/slot the user came from.
	const referrer = usePdpReferrer();
	const [submittedAmount, setSubmittedAmount] = useState<number | null>(null);
	const [correctedHighestBidAmount, setCorrectedHighestBidAmount] = useState<
		number | null
	>(null);
	const prevOpenRef = useRef(open);

	// The corrected amount takes precedence over the store amount after a
	// bid_too_low rejection, so "Try again" submits the right value.
	const amount =
		correctedHighestBidAmount != null
			? Math.max(
					computeNextBidAmount({
						current: correctedHighestBidAmount,
						startingBid,
					}),
					storeAmount,
				)
			: storeAmount;

	// Reset transient state when modal opens
	useEffect(() => {
		const prevOpen = prevOpenRef.current;
		const isOpening = !prevOpen && open;

		if (isOpening) {
			setSubmittedAmount(null);
			setCorrectedHighestBidAmount(null);
		}

		prevOpenRef.current = open;
	}, [open]);

	// AbortController for cancelling the wait if modal closes
	const abortControllerRef = useRef<AbortController | null>(null);

	// Abort any pending wait when modal closes
	const handleOpenChange = useCallback(
		(newOpen: boolean) => {
			if (!newOpen && abortControllerRef.current) {
				abortControllerRef.current.abort();
				abortControllerRef.current = null;
			}
			onOpenChange?.(newOpen);
		},
		[onOpenChange],
	);

	const createMutationFn = useMemo(
		() => (isEnded: boolean) => {
			return async (_arg?: undefined) => {
				if (isEnded) {
					return fail<typeof BidCreateSchema>({
						errors: {
							general: ["The auction has ended."],
						},
					});
				}

				// Track the submitted amount for confirmation display
				setSubmittedAmount(amount);

				// Step 1: Call API to queue the bid
				const apiResponse = await placeBid({
					amount,
					auctionId: id,
					referrer,
				});

				// If API-level failure (validation, auth, etc.), return immediately
				if (!apiResponse.success) {
					const currentHighest =
						apiResponse.defaultValues && "amount" in apiResponse.defaultValues
							? apiResponse.defaultValues.amount
							: null;
					if (typeof currentHighest === "number") {
						correctCardStoreBid(id, currentHighest);
						setCorrectedHighestBidAmount(currentHighest);
					}
					return apiResponse;
				}

				// Step 2: Wait for websocket confirmation
				const { requestId } = apiResponse.data as BidCreateResponse;

				// Create abort controller for this request
				abortControllerRef.current = new AbortController();

				try {
					// Combine timeout + manual abort signal (AbortSignal.any
					// is unavailable before Safari 17.4 — anySignal falls back)
					const signal = anySignal([
						AbortSignal.timeout(BID_RESULT_TIMEOUT_MS),
						abortControllerRef.current.signal,
					]);

					const result = await waitForResult(requestId, signal);

					if (result.success) {
						// Bid was accepted by the worker
						return {
							success: true as const,
							data: result.bid,
						};
					}
					// Bid was rejected by the worker — correct stale state if possible
					if (result.currentHighestBidAmount) {
						correctCardStoreBid(id, result.currentHighestBidAmount);
						setCorrectedHighestBidAmount(result.currentHighestBidAmount);
					}

					const errorMessage =
						BID_ERROR_MESSAGES[result.reason] ??
						"Your bid was rejected. Try again.";
					return fail<typeof BidCreateSchema>({
						errors: {
							general: [errorMessage],
						},
					});
				} catch (e) {
					// Handle abort/timeout
					if (e instanceof DOMException) {
						// TimeoutError = AbortSignal.timeout() fired (spec-compliant browsers)
						// AbortError with "timed out" = timeout in some browsers
						// AbortError without "timed out" = manual abort (modal closed)
						const isTimeout =
							e.name === "TimeoutError" ||
							(e.name === "AbortError" && e.message.includes("timed out"));

						if (isTimeout) {
							// Timeout - show warning state
							reportErrorMessage("Bid result confirmation timed out", {
								level: "warning",
								operation: "bid_result_timeout",
								extra: { auctionId: id, requestId },
							});
							return fail<typeof BidCreateSchema>({
								errors: {
									general: [BID_TIMEOUT_ERROR],
								},
							});
						}

						if (e.name === "AbortError") {
							// Manual cancel (modal closed) - return neutral state
							// This won't be shown since modal is closing
							return fail<typeof BidCreateSchema>({
								errors: {},
							});
						}
					}
					// Unexpected error
					throw e;
				} finally {
					abortControllerRef.current = null;
				}
			};
		},
		[amount, id, waitForResult, referrer],
	);

	const result = usePlaceBidShared({
		createMutationFn,
		schema: BidCreateSchema,
		errorMessage: "Couldn't place your bid. Try again.",
		open,
		onOpenChange: handleOpenChange,
		auctionId: id,
		bidAmount: amount,
		bidType: "bid_now",
	});

	return {
		...result,
		submittedAmount,
		/** The effective bid amount — always matches what will be submitted. */
		amount,
		rawCorrectedHighestBidAmount: correctedHighestBidAmount,
	};
}
