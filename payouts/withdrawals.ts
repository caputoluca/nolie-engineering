import {
	computeInstantWithdrawalFeeCents,
	computeStripeInstantCostCents,
	INSTANT_WITHDRAWAL_FEE_BPS,
	INSTANT_WITHDRAWAL_FEE_MIN_CENTS,
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
	WithdrawalContextResponse,
	WithdrawalMethod,
} from "@nolie/schemas/me/withdrawals";
import { sumUncachedWithdrawalCents } from "./payouts.js";

/**
 * One linked payout destination, as the withdrawal flow needs it. `instantEligible`
 * is PER external account (Stripe's `available_payout_methods`), so instant is a
 * property of the destination, never the seller.
 */
interface PayoutDestination {
	stripeExternalAccountId: string;
	type: "bank_account" | "card";
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
		// The seller enters the GROSS to transfer (what leaves their balance); they
		// receive that minus the instant fee. We pass the net to Stripe as the
		// payout `amount`, so the fee is collected on top and the full gross is
		// debited from the connect balance.
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
					type: true,
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

/**
 * The seller's withdrawable balance from the cached Stripe snapshot, minus the
 * in-flight withdrawals that snapshot doesn't yet reflect — the SAME math the
 * payouts page renders (`getPayoutsView`). Returns null when the cache was never
 * materialized (`syncedAt` null): we then have no trustworthy local figure and
 * defer entirely to Stripe's own balance gate. Not race-free for two SIMULTANEOUS
 * requests (both read before either inserts); Stripe's atomic check is the final
 * backstop. This closes the common case: a second withdrawal while an earlier one
 * is still in flight.
 */
async function getEffectiveAvailableCents(
	db: PrismaClient,
	sellerProfileId: string,
): Promise<number | null> {
	const cache = await db.sellerBalance.findUnique({
		where: { sellerProfileId },
		select: { availableCents: true, syncedAt: true },
	});
	if (!cache?.syncedAt) return null;
	return (
		cache.availableCents -
		(await sumUncachedWithdrawalCents(db, sellerProfileId, cache.syncedAt))
	);
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

	// The seller enters the GROSS amount to transfer — what leaves their connect
	// balance. For instant they receive that minus the fee; standard is free
	// (receive == amount). Stripe's payout `amount` is the RECEIVED figure, so we
	// pass `receiveCents` below and the fee is collected on top, debiting the full
	// `amountCents` from the balance. Each gate is on the figure it actually
	// bounds: `amountCents` for the balance, `receiveCents` for Stripe's payout
	// min/max + net_available.
	const feeChargedCents =
		method === "instant" ? computeInstantWithdrawalFeeCents(amountCents) : 0;
	const receiveCents = amountCents - feeChargedCents;

	if (receiveCents < WITHDRAWAL_MIN_CENTS) {
		throw errors.badRequest(
			`You need to receive at least $${(WITHDRAWAL_MIN_CENTS / 100).toFixed(2)} after fees`,
			{ code: "AMOUNT_BELOW_MIN" },
		);
	}

	// Pre-check against the cached Stripe balance, netting in-flight withdrawals
	// the cache hasn't absorbed (the payouts-page math). Fails fast with an
	// accurate message and closes the common double-withdraw instead of minting a
	// payout Stripe then rejects. Best-effort: null = no materialized cache, so
	// Stripe stays the authoritative gate. The live instant `net_available` gate
	// below is the tighter, authoritative check for instant.
	const effectiveAvailable = await getEffectiveAvailableCents(db, seller.id);
	if (effectiveAvailable !== null && amountCents > effectiveAvailable) {
		throw errors.badRequest("Amount exceeds your available balance", {
			code: "INSUFFICIENT_BALANCE",
		});
	}

	if (method === "instant") {
		if (!destination.instantEligible) {
			throw errors.badRequest(
				"Instant transfer isn't available for this account",
				{ code: "INSTANT_NOT_AVAILABLE" },
			);
		}
		if (receiveCents > INSTANT_WITHDRAWAL_MAX_CENTS) {
			throw errors.badRequest(
				`Instant transfers are capped at $${(INSTANT_WITHDRAWAL_MAX_CENTS / 100).toFixed(2)}`,
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
		if (netAvailable !== null && receiveCents > netAvailable) {
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

	let result: Awaited<ReturnType<PaymentsClient["seller"]["withdraw"]>>;
	try {
		result = await payments.seller.withdraw({
			connectAccountId: seller.connectAccountId,
			// Stripe's payout `amount` is what LANDS in the bank — the net. The fee
			// is collected on top, so the connect balance is debited the full gross
			// `amountCents`.
			amountCents: receiveCents,
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

	// Record the fee Stripe ACTUALLY collected (the Pricing-Tool application fee on
	// the payout) so platformFeeCents reconciles against Stripe rather than trusting
	// our pre-submit estimate. Falls back to the estimate for standard payouts (no
	// fee) or if Stripe hasn't attached the fee yet. The connect balance is debited
	// `receiveCents + fee`, so we store THAT as amountCents — keeping the invariant
	// amountCents − feeChargedCents == the amount the seller received (== what we
	// submitted to Stripe). Equals the entered gross whenever the estimate was exact.
	const recordedFeeCents = result.applicationFeeCents ?? feeChargedCents;
	const grossDebitedCents = receiveCents + recordedFeeCents;
	// Stripe's ~1% instant-payout cost to US (distinct from the markup we charge the
	// seller). Stripe bills the PLATFORM, not the connected-account payout, so it's
	// not readable from the payout object — record Stripe's documented flat 1% of
	// the payout amount as the cost basis (0 for the free standard lane). The exact
	// figure lives in Stripe's platform fee reporting; margin ≈ platformFee − this.
	const stripeCostCents =
		method === "instant" ? computeStripeInstantCostCents(receiveCents) : 0;

	// Write-once submit CAS (status = requested); the webhook never writes these.
	await db.withdrawal.updateMany({
		where: { id: withdrawalId, status: "requested" },
		data: {
			status,
			stripePayoutId: result.payoutId,
			stripeBalanceTransactionId: result.balanceTransactionId,
			arrivalDate: result.arrivalDate,
			amountCents: grossDebitedCents,
			feeChargedCents: recordedFeeCents,
			platformFeeCents: recordedFeeCents,
			stripeCostCents,
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
		amountCents: grossDebitedCents,
		method,
		feeCents: recordedFeeCents,
		// What lands in the bank — the gross they entered minus the instant fee.
		estimatedReceiveCents: receiveCents,
		stripePayoutId: result.payoutId,
		arrivalDate: result.arrivalDate?.toISOString() ?? null,
	};
}

/**
 * The transfer-flow read surface (NL-263 PR4): the seller's payout destinations,
 * the instant fee params (for the live client estimate), and the LIVE Stripe
 * balance (available + per-destination instant `net_available`). This is the one
 * payouts read that hits Stripe per request — it backs the fullscreen transfer
 * flow where the seller is about to move money, so the figures are authoritative
 * rather than the cached page-load snapshot. Shares the `loadSellerForWithdrawal`
 * gate, so a payouts-disabled seller gets the same typed error as the submit.
 */
export async function getWithdrawalContext(input: {
	db: PrismaClient;
	payments: PaymentsClient;
	userId: string;
}): Promise<WithdrawalContextResponse> {
	const { db, payments, userId } = input;
	const seller = await loadSellerForWithdrawal(db, userId);

	const balance = await payments.seller.getBalance(seller.connectAccountId);

	return {
		accounts: seller.payoutAccounts.map((a) => ({
			externalAccountId: a.stripeExternalAccountId,
			type: a.type,
			last4: a.last4,
			brand: a.brand,
			bankName: a.bankName,
			instantEligible: a.instantEligible,
			isDefault: a.defaultForCurrency,
		})),
		fee: {
			bps: INSTANT_WITHDRAWAL_FEE_BPS,
			minCents: INSTANT_WITHDRAWAL_FEE_MIN_CENTS,
		},
		limits: {
			minCents: WITHDRAWAL_MIN_CENTS,
			instantMaxCents: INSTANT_WITHDRAWAL_MAX_CENTS,
		},
		balance: {
			availableCents: balance.availableCents,
			perDestinationInstant: balance.instantAvailableByDestination.map((d) => ({
				externalAccountId: d.externalAccountId,
				netAvailableCents: d.netAvailableCents,
			})),
		},
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
