"use client";

import { fail } from "@mazal/actions";
import type { BidCreateSchema } from "@mazal/schemas/auction/bid";
import { useCallback, useEffect, useState } from "react";
import { useAction } from "@/hooks/action";
import { useHaptics } from "@/hooks/use-haptics";
import { placeBid } from "@/lib/actions/bids";
import { useAuctionData } from "./auction-provider";
import { useAuctionEnded } from "./use-auction-ended";
import { useNextBidAmount } from "./use-next-bid-amount";

export function usePlaceBid(onOpenChange?: (open: boolean) => void) {
	const haptics = useHaptics();
	const { id } = useAuctionData();
	const amount = useNextBidAmount();
	const [showOutcome, setShowOutcome] = useState(false);
	const { isEnded } = useAuctionEnded();

	const baseAction = useCallback(async () => {
		if (isEnded) {
			return fail<typeof BidCreateSchema>({
				errors: {
					general: ["The auction has ended."],
				},
			});
		}
		const res = await placeBid({ amount, auctionId: id });
		if (res.success) {
			haptics.success();
		} else {
			haptics.error();
		}
		setShowOutcome(true);
		return res;
	}, [amount, id, haptics, isEnded]);

	const [state, action] = useAction(baseAction);

	useEffect(() => {
		if (showOutcome && state.success) {
			setTimeout(() => {
				onOpenChange?.(false);
			}, 200);
		}
	}, [showOutcome, state.success, onOpenChange]);

	return { state, action, showOutcome, setShowOutcome };
}
