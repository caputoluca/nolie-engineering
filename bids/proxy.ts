/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 * Nothing is left out: it imports nothing.
 */

/**
 * Calculates the clearing price for a proxy bid using second-price auction logic.
 *
 * The winning proxy should bid the minimum amount needed to win, which is:
 * - The maximum of: (second-highest proxy max, current highest bid) + increment
 * - But not more than the proxy's own maxAmount
 *
 * This implements the standard proxy bidding formula:
 * `min(highestProxyMax, max(secondHighestProxyMax, currentHighestBid) + increment)`
 *
 * Returns null if the calculated amount wouldn't beat or equal the current highest bid
 * (meaning the proxy cannot outbid, even at its maximum).
 * We allow equal bids for tie-breaking proxies.
 *
 * Pure function with no database dependencies. Used by both API and worker
 * for consistent proxy bid calculations.
 *
 * @param highestProxyMax - The maximum amount the highest proxy is willing to pay
 * @param secondHighestProxyMax - The maximum amount the second-highest proxy is willing to pay (null if only one proxy)
 * @param currentHighestBid - The current highest bid amount in the auction
 * @param increment - The minimum bid increment required
 * @returns The clearing price amount, or null if the proxy cannot outbid
 */
export function calculateProxyAmount({
	highestProxyMax,
	secondHighestProxyMax,
	currentHighestBid,
	increment,
}: {
	highestProxyMax: number;
	secondHighestProxyMax: number | null;
	currentHighestBid: number;
	increment: number;
}): number | null {
	const runnerUp = Math.max(secondHighestProxyMax ?? 0, currentHighestBid);
	const nextBid = Math.min(highestProxyMax, runnerUp + increment);
	return nextBid >= currentHighestBid ? nextBid : null;
}
