"use client";

import type { ActionResponse } from "@nolie/actions";
import { fail } from "@nolie/actions";
import type { BidCreateSchema } from "@nolie/schemas/auction/bid";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { placeBid } from "@/lib/mutations/bids";
import { useAuctionData } from "./auction-provider";
import { useAuctionEnded } from "./use-auction-ended";
import { useNextBidAmount } from "./use-next-bid-amount";

const EXIT_ANIMATION_DURATION = 400;

export function usePlaceBid(
	open: boolean,
	onOpenChange?: (open: boolean) => void,
) {
	const { id } = useAuctionData();
	const amount = useNextBidAmount();
	const [showOutcome, setShowOutcome] = useState(false);
	const [didSubmit, setDidSubmit] = useState(false);
	const { isEnded } = useAuctionEnded();
	const prevOpenRef = useRef(open);
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);

	const mutation = useMutation({
		mutationFn: useCallback(async () => {
			setDidSubmit(true);
			if (isEnded) {
				return fail<typeof BidCreateSchema>({
					errors: {
						general: ["The auction has ended."],
					},
				});
			}
			const result = await placeBid({ amount, auctionId: id });
			return result;
		}, [amount, id, isEnded]),
		onSuccess: () => {
			setDidSubmit(true);
		},
		onError: () => {
			setDidSubmit(true);
		},
	});

	const [bidPlacedSuccessfully, setBidPlacedSuccessfully] = useState(false);

	// Map mutation state to ActionResponse format for backward compatibility
	const state = useMemo<ActionResponse<unknown, typeof BidCreateSchema>>(() => {
		// If mutation has data (success or failure ActionResponse), use it
		if (mutation.data) {
			return mutation.data;
		}

		// If mutation errored (unlikely but possible), create error state
		if (mutation.isError) {
			return {
				success: false,
				errors: {
					general: [
						mutation.error instanceof Error
							? mutation.error.message
							: "Something went wrong when placing your bid. Please try again",
					],
				},
				defaultValues: {},
			};
		}

		// Default state before mutation runs
		return {
			success: false,
			errors: {},
			defaultValues: {},
		};
	}, [mutation.data, mutation.isError, mutation.error]);

	// Create action function that calls mutateAsync for backward compatibility
	const action = useCallback(async () => {
		await mutation.mutateAsync();
	}, [mutation]);

	// Show outcome after submission and when state has result
	useEffect(() => {
		if (
			didSubmit &&
			(state.success || Object.keys(state.errors || {}).length > 0)
		) {
			setShowOutcome(true);
		}
	}, [didSubmit, state]);

	useEffect(() => {
		if (showOutcome && state.success) {
			setBidPlacedSuccessfully(true);
			const timeout = setTimeout(() => {
				onOpenChange?.(false);
			}, 1500);
			return () => clearTimeout(timeout);
		}
	}, [showOutcome, state.success, onOpenChange]);

	// Handle showOutcome reset based on modal open/close transitions
	useEffect(() => {
		const prevOpen = prevOpenRef.current;
		const isOpening = !prevOpen && open;
		const isClosing = prevOpen && !open;

		// Clear any pending timeout
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}

		if (isOpening) {
			// Modal is opening: reset immediately for fresh state
			setShowOutcome(false);
			setBidPlacedSuccessfully(false);
			setDidSubmit(false);
		} else if (isClosing) {
			// Modal is closing: delay reset until exit animation completes
			timeoutRef.current = setTimeout(() => {
				setShowOutcome(false);
				timeoutRef.current = null;
			}, EXIT_ANIMATION_DURATION);
		}

		// Update previous open state
		prevOpenRef.current = open;

		// Cleanup timeout on unmount
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
				timeoutRef.current = null;
			}
		};
	}, [open]);

	return {
		state,
		action,
		mutateAsync: mutation.mutateAsync,
		isPending: mutation.isPending,
		isSuccess: mutation.isSuccess,
		isError: mutation.isError,
		error: mutation.error,
		showOutcome,
		setShowOutcome,
		bidPlacedSuccessfully,
	};
}
