import {
	computeInstantWithdrawalFeeCents,
	INSTANT_WITHDRAWAL_MAX_CENTS,
	WITHDRAWAL_MIN_CENTS,
} from "@nolie/core/constants/payouts";
import { isPrismaUniqueError, type PrismaClient } from "@nolie/db";
import { errors } from "@nolie/errors/http";
import {
	PaymentErrorCode,
	type PaymentErrorCodeType,
	type PaymentsClient,
	stripePayoutStatusToTerminal,
} from "@nolie/payments";
import type {
	RequestWithdrawalResponse,
	WithdrawalMethod,
} from "@nolie/schemas/me/withdrawals";

/**
 * One linked payout destination, as the withdrawal flow needs it. `instantEligible`
 * is PER external account (Stripe's `available_payout_methods`), so instant is a
 * property of the destination, never the seller.
 */
interface PayoutDestination {
	stripeExternalAccountId: string;
	instantEligible: boolean;
	defaultForCurrency: boolean;
	last4: string | null;
	brand: string | null;
	bankName: string | null;
}

interface SellerForWithdrawal {
	id: string;
	connectAccountId: string;
	payoutAccounts: PayoutDestination[];
}

// Shape selected for a Withdrawal row when returning its current state.
interface WithdrawalRow {
	id: string;
	status: "requested" | "submitted" | "paid" | "failed" | "canceled";
	amountCents: number;
	method: WithdrawalMethod;
	feeChargedCents: number;
	stripePayoutId: string | null;
	arrivalDate: Date | null;
}

const WITHDRAWAL_SELECT = {
	id: true,
	status: true,
	amountCents: true,
	method: true,
	feeChargedCents: true,
	stripePayoutId: true,
	arrivalDate: true,
} as const;

function toResponse(row: WithdrawalRow): RequestWithdrawalResponse {
	return {
		withdrawalId: row.id,
		status: row.status,
		amountCents: row.amountCents,
		method: row.method,
		feeCents: row.feeChargedCents,
		estimatedReceiveCents: row.amountCents - row.feeChargedCents,
		stripePayoutId: row.stripePayoutId,
		arrivalDate: row.arrivalDate?.toISOString() ?? null,
	};
}

/**
 * Load the seller's withdrawal context, asserting payouts are usable. Throws the
 * caller-facing error so the request path shares one gate.
 */
async function loadSellerForWithdrawal(
	db: PrismaClient,
	userId: string,
): Promise<SellerForWithdrawal> {
	const seller = await db.sellerProfile.findUnique({
		where: { userId },
		select: {
			id: true,
			connectAccountId: true,
			payoutsEnabled: true,
			payoutAccounts: {
				select: {
					stripeExternalAccountId: true,
					instantEligible: true,
					defaultForCurrency: true,
					last4: true,
					brand: true,
					bankName: true,
				},
			},
		},
	});

	if (!seller || !seller.connectAccountId || !seller.payoutsEnabled) {
		throw errors.badRequest("Payouts aren't enabled for this account", {
			code: "PAYOUTS_NOT_ENABLED",
		});
	}

	return {
		id: seller.id,
		connectAccountId: seller.connectAccountId,
		payoutAccounts: seller.payoutAccounts,
	};
}

/**
 * Pick the destination the money lands in. An explicit `externalAccountId` (the
 * picker) must be one of the seller's own accounts; otherwise the default-for-
 * currency account (or the sole account). The destination is always resolved +
 * shown BEFORE instant is offered — instant is gated on whether THIS destination
 * is instant-eligible, never silently rerouted to another account.
 */
function resolveDestination(
	accounts: PayoutDestination[],
	requestedExternalAccountId: string | undefined,
): PayoutDestination {
	if (requestedExternalAccountId) {
		const match = accounts.find(
			(a) => a.stripeExternalAccountId === requestedExternalAccountId,
		);
		if (!match) {
			throw errors.badRequest("That payout account isn't linked", {
				code: "INVALID_DESTINATION",
			});
		}
		return match;
	}

	const fallback =
		accounts.find((a) => a.defaultForCurrency) ??
		(accounts.length === 1 ? accounts[0] : undefined);

	if (!fallback) {
		throw errors.badRequest("No payout account is set up to withdraw to", {
			code: "NO_PAYOUT_ACCOUNT",
		});
	}
	return fallback;
}

/**
 * Live `instant_available.net_available` for one destination, or null if it
 * can't be determined (read error, or no per-destination figure). Mirrors the
 * destination resolution: match the destination, else fall back to the sole
 * entry for single-destination accounts.
 */
async function readInstantNetAvailable(
	payments: PaymentsClient,
	connectAccountId: string,
	externalAccountId: string,
): Promise<number | null> {
	const balance = await payments.seller.getBalance(connectAccountId);
	const byDestination = balance.instantAvailableByDestination;
	const match =
		byDestination.find((d) => d.externalAccountId === externalAccountId) ??
		(byDestination.length === 1 ? byDestination[0] : undefined);
	return match?.netAvailableCents ?? null;
}

/** Map a Stripe payout failure to the typed, seller-facing HTTP error. */
function withdrawalFailureError(
	error: PaymentErrorCodeType,
	message: string,
): never {
	switch (error) {
		case PaymentErrorCode.instant_unavailable:
			throw errors.badRequest(
				"Instant transfer isn't available right now. You can use a standard transfer instead.",
				{ code: "INSTANT_NOT_AVAILABLE" },
			);
		case PaymentErrorCode.insufficient_funds:
			throw errors.badRequest("Amount exceeds your available balance", {
				code: "INSUFFICIENT_BALANCE",
			});
		case PaymentErrorCode.invalid_stripe_account:
			throw errors.badRequest(
				"Your payout account can't receive transfers. Check your payout details.",
				{ code: "PAYOUT_ACCOUNT_INVALID" },
			);
		default:
			throw errors.badRequest(
				"We couldn't complete your transfer. Please try again.",
				{ code: "PAYOUT_FAILED", data: { message } },
			);
	}
}

export interface RequestWithdrawalInput {
	db: PrismaClient;
	payments: PaymentsClient;
	userId: string;
	amountCents: number;
	method: WithdrawalMethod;
	externalAccountId?: string;
	// Client-supplied idempotency key (the modal mints one per confirm-tap). When
	// present it becomes `Withdrawal.id` == the Stripe idempotency key, so a
	// double-tap or a retry-after-lost-response resolves to ONE payout. Absent →
	// a fresh row each call (fine for the happy path).
	idempotencyKey?: string;
}

/**
 * Withdraw cash from the seller's connect balance to their bank (NL-263).
 * SYNCHRONOUS — a user-initiated money action where the seller is waiting, so we
 * call Stripe in-request and return the real outcome (the Whatnot / Venmo / Cash
 * App pattern, and what Stripe's own embedded components do). The asynchronous
 * part is only the money LANDING (`payout.paid`/`failed`), tracked by webhooks +
 * the sweep.
 *
 * Flow: validate against local projections → live instant `net_available` gate
 * (instant only) → insert `Withdrawal(requested)` (id = Stripe idempotency key) →
 * `payouts.create` → flip the row and return. Failures surface as typed inline
 * errors (with the free-standard fallback for instant), never a deferred
 * notification. Idempotency: the row id is the Stripe key, so a retry/replay
 * returns the same payout — never a double-pay.
 */
export async function requestWithdrawal(
	input: RequestWithdrawalInput,
): Promise<RequestWithdrawalResponse> {
	const {
		db,
		payments,
		userId,
		amountCents,
		method,
		externalAccountId,
		idempotencyKey,
	} = input;

	// Idempotent resume: a repeat of the same client key returns the existing
	// withdrawal's state without re-submitting.
	if (idempotencyKey) {
		const existing = await db.withdrawal.findUnique({
			where: { id: idempotencyKey },
			select: WITHDRAWAL_SELECT,
		});
		if (existing) return toResponse(existing);
	}

	const seller = await loadSellerForWithdrawal(db, userId);
	const destination = resolveDestination(
		seller.payoutAccounts,
		externalAccountId,
	);

	if (amountCents < WITHDRAWAL_MIN_CENTS) {
		throw errors.badRequest(
			`Minimum withdrawal is ${WITHDRAWAL_MIN_CENTS} cents`,
			{ code: "AMOUNT_BELOW_MIN" },
		);
	}

	// We deliberately do NOT pre-check the STANDARD available balance: nothing
	// populates the SellerBalance cache in PR3 (it's the PR4 page's concern), and
	// payouts.create gates standard precisely (balance_insufficient → the accurate
	// "amount exceeds available" below). Stripe is the authoritative gate.
	if (method === "instant") {
		if (!destination.instantEligible) {
			throw errors.badRequest(
				"Instant transfer isn't available for this account",
				{ code: "INSTANT_NOT_AVAILABLE" },
			);
		}
		if (amountCents > INSTANT_WITHDRAWAL_MAX_CENTS) {
			throw errors.badRequest(
				`Instant transfers are capped at ${INSTANT_WITHDRAWAL_MAX_CENTS} cents`,
				{ code: "INSTANT_LIMIT_EXCEEDED" },
			);
		}
		// Live per-destination instant gate. Worth a Stripe read for instant
		// (premium, low volume) because Stripe has NO instant-specific
		// insufficient code: an instant payout over net_available but under the
		// general available balance comes back as generic `balance_insufficient`,
		// which would mislead the seller with "amount exceeds available" when they
		// DO have it (just not instantly). This is the only way to give the correct
		// "instant unavailable for this amount, use standard" message + fallback.
		// Best-effort: a read failure proceeds and lets payouts.create be the gate.
		const netAvailable = await readInstantNetAvailable(
			payments,
			seller.connectAccountId,
			destination.stripeExternalAccountId,
		).catch(() => null);
		if (netAvailable !== null && amountCents > netAvailable) {
			throw errors.badRequest(
				"Instant transfer isn't available for this amount right now. You can use a standard transfer instead.",
				{ code: "INSTANT_NOT_AVAILABLE" },
			);
		}
	}

	// Insert the row (id = the client key when given). A unique collision means a
	// concurrent double-tap already created it — resume that one.
	let withdrawal: WithdrawalRow;
	try {
		withdrawal = await db.withdrawal.create({
			data: {
				...(idempotencyKey ? { id: idempotencyKey } : {}),
				sellerProfileId: seller.id,
				connectAccountId: seller.connectAccountId,
				stripeExternalAccountId: destination.stripeExternalAccountId,
				amountCents,
				method,
				currency: "usd",
				status: "requested",
			},
			select: WITHDRAWAL_SELECT,
		});
	} catch (err) {
		if (idempotencyKey && isPrismaUniqueError(err)) {
			const existing = await db.withdrawal.findUnique({
				where: { id: idempotencyKey },
				select: WITHDRAWAL_SELECT,
			});
			if (existing) return toResponse(existing);
		}
		throw err;
	}

	const withdrawalId = withdrawal.id;
	const feeChargedCents =
		method === "instant" ? computeInstantWithdrawalFeeCents(amountCents) : 0;

	let result: Awaited<ReturnType<PaymentsClient["seller"]["withdraw"]>>;
	try {
		result = await payments.seller.withdraw({
			connectAccountId: seller.connectAccountId,
			amountCents,
			method,
			destinationExternalAccountId: destination.stripeExternalAccountId,
			idempotencyKey: withdrawalId,
			metadata: { withdrawalId, sellerProfileId: seller.id },
		});
	} catch {
		// `withdrawToBank` throws only on RETRYABLE errors (network / rate limit /
		// Stripe 5xx). The payout may or may not have been created; the row stays
		// `requested` and the same-key replay (client retry) or the sweep resolves
		// it. Surface a retryable error so the UI shows "try again".
		throw errors.serviceUnavailable(
			"We couldn't reach your bank. Please try again.",
			{ code: "PAYOUT_TEMPORARILY_UNAVAILABLE" },
		);
	}

	if (!result.success) {
		await markFailed(db, withdrawalId, result.error, result.message);
		withdrawalFailureError(result.error, result.message);
	}

	const now = new Date();
	const terminal = stripePayoutStatusToTerminal(result.status);
	const status = terminal ?? "submitted";

	// Write-once submit CAS (status = requested). Fee columns land HERE, once;
	// the webhook never writes them. stripeCostCents (Stripe's ~1% cost basis) is
	// left 0 and trued up against the payout's balance_transaction by the nightly
	// assertion. Mirrors the worker sweep's recovery flip.
	await db.withdrawal.updateMany({
		where: { id: withdrawalId, status: "requested" },
		data: {
			status,
			stripePayoutId: result.payoutId,
			stripeBalanceTransactionId: result.balanceTransactionId,
			arrivalDate: result.arrivalDate,
			feeChargedCents,
			platformFeeCents: feeChargedCents,
			stripeCostCents: 0,
			submittedAt: now,
			...(status === "paid" ? { paidAt: now } : {}),
			...(status === "failed" || status === "canceled"
				? { failedAt: now }
				: {}),
		},
	});

	return {
		withdrawalId,
		status,
		amountCents,
		method,
		feeCents: feeChargedCents,
		estimatedReceiveCents: amountCents - feeChargedCents,
		stripePayoutId: result.payoutId,
		arrivalDate: result.arrivalDate?.toISOString() ?? null,
	};
}

/** Submit failure: `requested → failed`. No money moved; nothing to roll back. */
async function markFailed(
	db: PrismaClient,
	withdrawalId: string,
	failureCode: string,
	failureMessage: string,
): Promise<void> {
	await db.withdrawal.updateMany({
		where: { id: withdrawalId, status: "requested" },
		data: {
			status: "failed",
			failedAt: new Date(),
			failureCode,
			failureMessage,
		},
	});
}
