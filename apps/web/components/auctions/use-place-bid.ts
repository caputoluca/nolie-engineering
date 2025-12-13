"use client";

import { fail } from "@nolie/actions";
import type { BidCreateSchema } from "@nolie/schemas/auction/bid";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "@/hooks/action";
import { placeBid } from "@/lib/actions/bids";
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

	const baseAction = useCallback(async () => {
		setDidSubmit(true);
		if (isEnded) {
			return fail<typeof BidCreateSchema>({
				errors: {
					general: ["The auction has ended."],
				},
			});
		}
		const res = await placeBid({ amount, auctionId: id });
		return res;
	}, [amount, id, isEnded]);

	const [state, action] = useAction(baseAction);
	const [bidPlacedSuccessfully, setBidPlacedSuccessfully] = useState(false);

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
		showOutcome,
		setShowOutcome,
		bidPlacedSuccessfully,
	};
}
