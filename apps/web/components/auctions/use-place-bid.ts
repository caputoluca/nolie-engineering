"use client";

import { fail } from "@nolie/actions";
import { BidCreateSchema } from "@nolie/schemas/auction/bid";
import { useMemo } from "react";
import { placeBid } from "@/lib/mutations/bids";
import { useAuctionData } from "./auction-provider";
import { useNextBidAmount } from "./use-next-bid-amount";
import { usePlaceBidShared } from "./use-place-bid-shared";

export function usePlaceBid(
	open: boolean,
	onOpenChange?: (open: boolean) => void,
) {
	const { id } = useAuctionData();
	const amount = useNextBidAmount();

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
				return await placeBid({ amount, auctionId: id });
			};
		},
		[amount, id],
	);

	return usePlaceBidShared({
		createMutationFn,
		schema: BidCreateSchema,
		errorMessage:
			"Something went wrong when placing your bid. Please try again",
		open,
		onOpenChange,
		auctionId: id,
		bidAmount: amount,
		bidType: "bid_now",
	});
}
