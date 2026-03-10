/**
 * Payout release window: Number of days after marking as fulfilled
 * before the creator payout is automatically released.
 */
export const PAYOUT_RELEASE_WINDOW_IN_DAYS = 1;

/**
 * Calculates the payout release delay in milliseconds.
 * This is the delay used when scheduling payout jobs.
 */
export function getPayoutReleaseDelayMs(): number {
	return PAYOUT_RELEASE_WINDOW_IN_DAYS * 24 * 60 * 60 * 1000;
}
