import { client } from "../client.js";
import { PaymentErrorCode, type PaymentErrorCodeType } from "../errors.js";
import {
	createIdempotencyKey,
	isInsufficientFundsError,
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
	retryAttempt: number;
	sourceChargeId: string | null;
}

export type PayCreatorResult =
	| {
			success: true;
			transferId: string;
			netAmount: number;
			destinationPaymentId: string;
	  }
	| {
			success: false;
			error: PaymentErrorCodeType;
			message: string;
			transferId?: string;
	  };

export async function payCreator(
	input: PayCreatorInput,
): Promise<PayCreatorResult> {
	const amountInCents = toCents(input.amount);

	// Validate amount is positive
	// Note: The amount passed here is already the final netAmount (grossAmount - platformFee - processingFee)
	// Fee calculation happens in settle.ts when creating CreatorEarning, not here
	if (amountInCents <= 0) {
		return {
			success: false,
			error: PaymentErrorCode.transfer_failed,
			message: `Amount (${amountInCents} cents) must be positive`,
		};
	}

	const idempotencyKeyBase = createIdempotencyKey({
		auctionId: input.auctionId,
		fanId: input.fanId,
		bidId: input.bidId,
		resourceId: input.creatorConnectAccountId,
	});

	const idempotencyKey = `${idempotencyKeyBase}-${input.retryAttempt}`;

	try {
		const transfer = await client.transfers.create(
			{
				amount: amountInCents,
				currency: "usd",
				destination: input.creatorConnectAccountId,
				metadata: {
					auctionId: input.auctionId,
					fanId: input.fanId,
					bidId: input.bidId,
				},
				...(input.sourceChargeId
					? { source_transaction: input.sourceChargeId }
					: {}),
			},
			{ idempotencyKey },
		);

		let destPaymentId: string;
		if (typeof transfer.destination_payment === "string") {
			destPaymentId = transfer.destination_payment;
		} else if (transfer.destination_payment) {
			destPaymentId = transfer.destination_payment.id;
		} else {
			// This should never happen for transfers to Connect accounts
			// destination_payment is always present when destination is a Stripe account
			return {
				success: false,
				error: PaymentErrorCode.unknown,
				message: "Failed to retrieve destination payment id",
			};
		}

		return {
			success: true,
			transferId: transfer.id,
			destinationPaymentId: destPaymentId,
			netAmount: amountInCents,
		};
	} catch (err: unknown) {
		// Handle Stripe errors
		if (isStripeError(err)) {
			// Retryable errors: throw for worker retry
			if (shouldThrowError(err)) {
				throw err;
			}

			if (isInsufficientFundsError(err)) {
				// Insufficient funds error: return structured failure
				return {
					success: false,
					error: PaymentErrorCode.insufficient_funds,
					message: err.message,
				};
			} else {
				// Non-retryable business logic errors: return structured failure
				// Examples: invalid account, insufficient funds, account restrictions
				return {
					success: false,
					error: PaymentErrorCode.transfer_failed,
					message: err.message,
				};
			}
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
 * 2. **Amount Handling**: The `amount` parameter is already the final netAmount calculated in
 *    settle.ts (grossAmount - platformFee - processingFee). This function simply transfers
 *    that amount without recalculating fees. Fee calculation happens when creating CreatorEarning
 *    records, not during transfer.
 *
 * 3. **Validation**: Validates that the amount is positive before attempting transfer.
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
