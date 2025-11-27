import { platformFees } from "@mazal/config";
import { client } from "../client.js";
import { PaymentErrorCode, type PaymentErrorCodeType } from "../errors.js";
import {
	createIdempotencyKey,
	isStripeError,
	shouldThrowError,
	toCents,
} from "../utils.js";

export interface PayCreatorInput {
	amount: number; // in dollars
	creatorConnectAccountId: string;
	auctionId: string;
	fanId: string;
	bidId: string;
}

export type PayCreatorResult =
	| { success: true; transferId: string }
	| {
			success: false;
			error: PaymentErrorCodeType;
			message: string;
			transferId?: string;
	  };

function calculateApplicationFee(amountInCents: number) {
	return Math.round(amountInCents * platformFees.applicationFeeRate);
}

export async function payCreator(
	input: PayCreatorInput,
): Promise<PayCreatorResult> {
	const amountInCents = toCents(input.amount);
	const feeInCents = calculateApplicationFee(amountInCents);

	// Validate fee doesn't exceed amount (defensive programming)
	if (feeInCents > amountInCents) {
		return {
			success: false,
			error: PaymentErrorCode.transfer_failed,
			message: `Fee (${feeInCents} cents) exceeds amount (${amountInCents} cents)`,
		};
	}

	const netAmount = amountInCents - feeInCents;

	// Validate net amount is non-negative
	if (netAmount < 0) {
		return {
			success: false,
			error: PaymentErrorCode.transfer_failed,
			message: `Net amount (${netAmount} cents) is negative`,
		};
	}

	const idempotencyKey = createIdempotencyKey({
		auctionId: input.auctionId,
		fanId: input.fanId,
		bidId: input.bidId,
		resourceId: input.creatorConnectAccountId,
	});

	try {
		const transfer = await client.transfers.create(
			{
				amount: netAmount,
				currency: "usd",
				destination: input.creatorConnectAccountId,
				metadata: {
					auctionId: input.auctionId,
					fanId: input.fanId,
					bidId: input.bidId,
				},
			},
			{ idempotencyKey },
		);

		return { success: true, transferId: transfer.id };
	} catch (err: unknown) {
		// Handle Stripe errors
		if (isStripeError(err)) {
			// Retryable errors: throw for worker retry
			if (shouldThrowError(err)) {
				throw err;
			}

			// Non-retryable business logic errors: return structured failure
			// Examples: invalid account, insufficient funds, account restrictions
			return {
				success: false,
				error: PaymentErrorCode.transfer_failed,
				message: err.message ?? "Transfer failed",
			};
		}

		// Non-Stripe errors: check if retryable (network issues, timeouts)
		if (shouldThrowError(err)) {
			throw err;
		}

		// Unknown non-retryable errors
		return {
			success: false,
			error: PaymentErrorCode.unknown,
			message:
				err instanceof Error
					? err.message
					: "Unknown error while transferring to creator",
		};
	}
}

/**
 * IMPLEMENTATION NOTES - Stripe Compliance & Retry Semantics
 *
 * This implementation follows Stripe's best practices for separate charges and transfers:
 *
 * 1. **Transfer API (Not Payouts)**: Uses `transfers.create()` to move funds to connected
 *    accounts. This is the correct approach for separate charge + transfer flows, as opposed
 *    to using `transfer_data` in PaymentIntent (which we avoid per Stripe recommendations).
 *    Reference: https://docs.stripe.com/connect/separate-charges-and-transfers
 *
 * 2. **Fee Calculation**: Calculates application fee as percentage of total amount, then
 *    transfers the net amount (amount - fee) to the creator. This implements the fee-withheld
 *    model where the platform keeps the fee.
 *    Reference: https://docs.stripe.com/connect/payments-fees
 *
 * 3. **Fee Validation**: Defensive checks ensure fee never exceeds amount and net amount
 *    is non-negative. While mathematically impossible with percentage < 100%, this prevents
 *    edge cases from causing invalid transfers.
 *
 * 4. **Error Handling Strategy**:
 *    - **Retryable errors (THROW)**: Network issues, rate limits, API errors, idempotency errors
 *      These are thrown so the worker can retry the job
 *    - **Business errors (RETURN)**: Invalid account, insufficient funds, account restrictions
 *      These return structured failures with error codes for business logic handling
 *
 * 5. **Idempotency Keys**: Deterministic keys based on auction/winner/bid/destination ensure
 *    safe retries without duplicate transfers. Same operation = same key = idempotent.
 *    Reference: https://docs.stripe.com/api/idempotent_requests
 *
 * 6. **Metadata**: Includes all relevant identifiers for webhook processing and audit trails.
 *    This links the transfer back to the auction, winner, and bid.
 *
 * 7. **Immediate Payouts Safety**: Transfers are safe for immediate payouts as long as:
 *    - The connected account has sufficient balance
 *    - The account is in good standing
 *    - No account restrictions are in place
 *    Stripe will return appropriate errors if any of these conditions aren't met.
 */
