import { client } from "../client.js";
import { PaymentErrorCode, type PaymentErrorCodeType } from "../errors.js";
import {
	idempotencyKeyWithVersion,
	isInsufficientFundsError,
	isStripeError,
	shouldThrowError,
	toCents,
} from "../utils.js";

export interface PaySellerInput {
	amount: number; // in dollars
	sellerConnectAccountId: string;
	orderId: string;
	buyerId: string;
	retryAttempt: number;
	sourceChargeId: string | null;
}

export type PaySellerResult =
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

export async function paySeller(
	input: PaySellerInput,
): Promise<PaySellerResult> {
	const amountInCents = toCents(input.amount);

	// Validate amount is positive
	// Note: The amount passed here is already the final netAmount (gross
	// minus platform commission and the charged Stripe processing pass-
	// through). Fee calculation happens at Earning creation, not here.
	if (amountInCents <= 0) {
		return {
			success: false,
			error: PaymentErrorCode.transfer_failed,
			message: `Amount (${amountInCents} cents) must be positive`,
		};
	}

	// v2: keyed on orderId (was auctionId+bidId in v1) so BIN/checkout orders
	// can transfer funds without an auction-only winningBidId.
	const idempotencyKey = idempotencyKeyWithVersion(
		`${input.orderId}-${input.sellerConnectAccountId}-${input.retryAttempt}`,
		2,
	);

	try {
		const transfer = await client.transfers.create(
			{
				amount: amountInCents,
				currency: "usd",
				destination: input.sellerConnectAccountId,
				metadata: {
					orderId: input.orderId,
					buyerId: input.buyerId,
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
					: "Unknown error while transferring to seller",
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
 * 2. **Amount Handling**: The `amount` parameter is the final netAmount calculated where the
 *    Earning is created (settle for auctions, charge.succeeded webhook for BIN). It already
 *    has the platform commission and the charged Stripe processing pass-through deducted.
 *    This function simply transfers that amount without recalculating fees.
 *
 * 3. **Validation**: Validates that the amount is positive before attempting transfer.
 *
 * 4. **Error Handling Strategy**:
 *    - **Retryable errors (THROW)**: Network issues, rate limits, API errors, idempotency errors
 *      These are thrown so the worker can retry the job
 *    - **Business errors (RETURN)**: Invalid account, insufficient funds, account restrictions
 *      These return structured failures with error codes for business logic handling
 *
 * 5. **Idempotency Keys**: Deterministic keys based on orderId/destination/retryAttempt
 *    ensure safe retries without duplicate transfers. Same operation = same key =
 *    idempotent. Versioned (v2) so payouts mid-flight when this changed don't collide
 *    with the v1 (auction/bid-keyed) keys.
 *    Reference: https://docs.stripe.com/api/idempotent_requests
 *
 * 6. **Metadata**: Includes orderId + buyerId for webhook processing and audit trails.
 *    The Order is the source of truth for origination context (auction win, BIN
 *    checkout, etc.) — look it up via orderId rather than denormalizing here.
 *
 * 7. **Immediate Payouts Safety**: Transfers are safe for immediate payouts as long as:
 *    - The connected account has sufficient balance
 *    - The account is in good standing
 *    - No account restrictions are in place
 *    Stripe will return appropriate errors if any of these conditions aren't met.
 */
