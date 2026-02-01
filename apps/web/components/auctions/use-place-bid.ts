"use client";

import { fail } from "@nolie/actions";
import {
	type BidCreateResponse,
	BidCreateSchema,
} from "@nolie/schemas/auction/bid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BID_ERROR_MESSAGES, placeBid } from "@/lib/mutations/bids";
import { reportErrorMessage } from "@/lib/observability/sentry/report-error-message";
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

const BID_RESULT_TIMEOUT_MS = 10_000;

export function usePlaceBid(
	open: boolean,
	onOpenChange?: (open: boolean) => void,
) {
	const { id } = useAuctionData();
	const amount = useNextBidAmount();
	const { waitForResult } = useBidResultSubscription();
	const [submittedAmount, setSubmittedAmount] = useState<number | null>(null);
	const prevOpenRef = useRef(open);

	// Reset submitted amount when modal opens
	useEffect(() => {
		const prevOpen = prevOpenRef.current;
		const isOpening = !prevOpen && open;

		if (isOpening) {
			setSubmittedAmount(null);
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
				const apiResponse = await placeBid({ amount, auctionId: id });

				// If API-level failure (validation, auth, etc.), return immediately
				if (!apiResponse.success) {
					return apiResponse;
				}

				// Step 2: Wait for websocket confirmation
				const { requestId } = apiResponse.data as BidCreateResponse;

				// Create abort controller for this request
				abortControllerRef.current = new AbortController();

				try {
					// Combine timeout + manual abort signal
					const signal = AbortSignal.any([
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
					// Bid was rejected by the worker
					const errorMessage =
						BID_ERROR_MESSAGES[result.reason] ??
						"Your bid was rejected. Please try again.";
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
		[amount, id, waitForResult],
	);

	const result = usePlaceBidShared({
		createMutationFn,
		schema: BidCreateSchema,
		errorMessage:
			"Something went wrong when placing your bid. Please try again",
		open,
		onOpenChange: handleOpenChange,
		auctionId: id,
		bidAmount: amount,
		bidType: "bid_now",
	});

	return {
		...result,
		submittedAmount,
	};
}
