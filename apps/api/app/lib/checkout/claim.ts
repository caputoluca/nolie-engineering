import { randomUUID } from "node:crypto";
import type { ServerAnalytics } from "@nolie/analytics/server";
import {
	finalizeCheckoutTx,
	loadFinalizableOrdersByIds,
	runCheckoutSideEffects,
} from "@nolie/checkout";
import { isBnplEligibleAmount } from "@nolie/core/constants/bnpl";
import type { SellerVacationPeriod } from "@nolie/core/orders";
import type { PrismaClient } from "@nolie/db";
import { PaymentStatus } from "@nolie/db";
import { errors, HttpError } from "@nolie/errors/http";
import { joinName } from "@nolie/lib/name";
import type { ServerMarketing } from "@nolie/marketing/server";
import { PaymentErrorCode, type PaymentsClient } from "@nolie/payments";
import { isStripeRateLimitError } from "@nolie/payments/utils";
import type { QueueOf } from "@nolie/queues";
import type { RestClient } from "@nolie/realtime/server";
import type {
	BnplBillingDetails,
	CheckoutClaimBody,
	CheckoutClaimSuccess,
	CheckoutCreditChangedData,
	CheckoutLineTotals,
} from "@nolie/schemas/checkout/claim";
import {
	CheckoutClaimErrorCode,
	isBnplClaim,
	isGuestClaim,
} from "@nolie/schemas/checkout/claim";
import type { FulfillmentMethodType } from "@nolie/schemas/fulfillment";
import { getSpendableBalance, holdCredits } from "@nolie/wallet";
import { COUNTRY_CODE_US } from "../../constants/country.js";
import { logger } from "../../logger.js";
import { assertBuyingNotSuspended } from "../buyer/suspension.js";
import { apiTx } from "../db/tx.js";
import {
	reportError,
	setReportingContext,
} from "../observability/sentry/report.js";
import { fanOutCanceledSiblings } from "../offers/cancel-fanout.js";
import { assertOrdersOpen } from "../wind-down.js";
import { BUNDLE_SHIPPING_FORMULA } from "./bundle-shipping.js";
import {
	buildAndValidateGroups,
	type CheckoutListingTotals,
	type ComputedCheckoutTotals,
	type ComputedFulfillmentGroup,
	computeCheckoutTotals,
} from "./compute-totals.js";
import { applyCreditToCheckout } from "./credit.js";
import {
	computeIdempotencyPayloadHash,
	validateIdempotencyKeyFormat,
} from "./idempotency.js";
import { type CheckoutListing, partitionCheckoutListings } from "./listings.js";
import {
	type MaterializationGroup,
	materializeOrders,
	type PickupSnapshot,
	type ShipFromSnapshot,
	type ShipToSnapshot,
} from "./materialize-orders.js";
import { reserveListings } from "./reserve.js";
import { resolveInFlightCheckout } from "./resume-guard.js";

/** Claim-before-charge hold — see flat-pricing-bin-checkout.md "Reservation TTL". */
const RESERVATION_TTL_MS = 10 * 60 * 1000;

/**
 * NL-378 — BNPL gets a longer hold than the 10-min card window. The buyer
 * leaves our page for the Affirm/Klarna redirect (account creation, soft credit
 * check, schedule review), so 10 min is too tight. The reservation reconciler
 * (`apps/worker/app/checkout/reconcile.job.ts`) compares only the stored
 * `reservedUntil`, so a per-rail TTL needs no sweeper change. This same instant
 * also drives the wallet-credit `holdExpiresAt`.
 */
const BNPL_RESERVATION_TTL_MS = 25 * 60 * 1000;

interface ClaimInput {
	db: PrismaClient;
	payments: PaymentsClient;
	/** Queue handles for the credit-only ($0) finalize side-effects. The
	 *  Stripe path triggers the same fan-out via the worker's PI.succeeded
	 *  handler, so these are only used when the buyer's credit covers
	 *  everything and we skip Stripe entirely. */
	queues: {
		engagementEvents: QueueOf<"engagementEvents">;
		notifications: QueueOf<"notifications">;
		klaviyoSaves: QueueOf<"klaviyoSaves">;
	};
	realtime: RestClient;
	analytics: ServerAnalytics;
	marketing: ServerMarketing;
	buyerId: string;
	/** Card rail (`{ paymentMethodId }`, saved card), BNPL rail (`{ bnpl }`,
	 *  NL-378), or guest rail (`{ collectPaymentMethod: true }`, a freshly-
	 *  collected card with no saved customer/method — NL-298). */
	body: CheckoutClaimBody;
	/** §19 — the claim request's originating-impression triad (from the
	 *  `X-NL-Referrer-*` headers). Fallback for cartless Buy-Now lines whose
	 *  triad rides the claim request rather than a cart item. All-null when the
	 *  client sent no referrer headers. */
	requestReferrer: {
		queryId: string | null;
		rankPosition: number | null;
		surface: string | null;
	};
}

/**
 * Brandur-pattern claim: atomic local writes first, foreign API call second.
 *
 *   Tx A      consume quote, reserve listings, bulk-create Orders (paymentIntentId=null)
 *   Stripe    create PaymentIntent (idempotency-keyed on body.idempotencyKey)
 *   Tx B      updateMany Orders to set paymentIntentId
 *
 * Abandonment safety net is the periodic checkout reservation reconciler
 * (apps/worker/app/checkout/reconciler.ts) — it scans `Listing.reservedUntil`
 * and cancels stuck PIs, which fires `payment_intent.canceled` for the
 * existing webhook to handle. No per-claim BullMQ job needed.
 *
 * Stripe's idempotency key turns retries into the recovery mechanism — no
 * explicit compensating cancel needed. If the process crashes between Tx A
 * and Tx B, a buyer retry replays through `replayIfExists` which detects
 * the null-PI Orders and resumes from the Stripe call onward.
 */
export async function claimCheckout(
	input: ClaimInput,
): Promise<CheckoutClaimSuccess> {
	const { db, payments, buyerId, body } = input;
	const isBnpl = isBnplClaim(body);
	const isGuest = isGuestClaim(body);
	// NL-298 Phase 5 — the wallet lane priced its quote from the redacted,
	// street-less address Apple/Google reveal at `onShippingAddressChange`
	// (ZIP-centroid tax). The buyer authorized that exact total in the sheet and
	// we can't raise it, so the tax recompute below must reproduce the ZIP-centroid
	// basis (recompute street-less) rather than rooftop — else an intra-ZIP tax
	// boundary would trip a spurious `PRICE_CHANGED` after the sheet authorized.
	// `walletIdentity` (present only on this lane's claim) is the signal; the
	// finalized street is for the Order's shipping snapshot, not the tax.
	const isWalletLane = isGuestClaim(body) && !!body.walletIdentity;

	// 0) Validate idempotency key format up-front. Cheap synchronous check —
	//    rejects low-entropy / malformed keys before they hit any DB or Stripe
	//    work. Stripe / Square / AWS / IETF-draft pattern.
	validateIdempotencyKeyFormat(body.idempotencyKey);

	// 0b) Compute the canonical payload hash once. Used twice:
	//      - on replay: compare to the stored hash; mismatch → 422
	//      - on fresh insert: persisted on Order so future replays can compare
	const payloadHash = computeIdempotencyPayloadHash(
		isBnpl
			? { quoteId: body.quoteId, bnpl: body.bnpl }
			: isGuest
				? { quoteId: body.quoteId, collectPaymentMethod: true }
				: { quoteId: body.quoteId, paymentMethodId: body.paymentMethodId },
	);

	// 1) Idempotency replay — same buyer + same key returns the same Order set
	//    and the same PI clientSecret. Handles two replay scenarios:
	//      a) Orders + paymentIntentId set → just return clientSecret.
	//      b) Orders + paymentIntentId null → previous attempt died between Tx A
	//         and Tx B; resume from the Stripe call.
	const replay = await replayIfExists({
		db,
		payments,
		buyerId,
		body,
		incomingPayloadHash: payloadHash,
	});
	if (replay) return replay;

	// 2) Pre-flight reads (no tx — fast lookups, run in parallel).
	const quote = ensureQuoteUsable(
		await db.checkoutQuote.findUnique({
			where: { id: body.quoteId },
			include: { lines: true },
		}),
		buyerId,
	);

	const listingIds = quote.lines.map((l) => l.listingId);

	// NL-378 — resume/supersede guard. The replay path above keys on the
	// idempotencyKey; a buyer returning after abandoning the BNPL/3DS redirect
	// arrives with a *fresh* key, so it can't match. Before we reserve + open a
	// PI, reconcile any in-flight order the buyer already has for these listings:
	// supersede an uncommitted one (releasing its hold so the reads below see the
	// listings as active again), or block with `payment_in_progress` if its PI
	// already committed — never a second charge. Runs before the pre-flight reads
	// so a superseded hold is back to `active` by the time we partition.
	await resolveInFlightCheckout({ db, payments, buyerId, listingIds });

	// Buyer fulfillment choices come from the persisted quote lines — at claim
	// time we trust the snapshot. Fulfillment changes require a fresh quote;
	// the claim body never overrides.
	const buyerChoiceByListing = new Map<string, FulfillmentMethodType>(
		quote.lines.map((l) => [l.listingId, asResolvedMethod(l.fulfillmentMode)]),
	);

	const [{ listings, unavailableListingIds }, buyer, spendable, paymentMethod] =
		await Promise.all([
			partitionCheckoutListings(db, buyerId, listingIds),
			db.user.findUnique({
				where: { id: buyerId },
				select: {
					email: true,
					phone: true,
					taxExemptStatus: true,
					buyingSuspendedAt: true,
					billing: { select: { customerId: true } },
					shippingAddresses: quote.shippingAddressId
						? {
								where: { id: quote.shippingAddressId },
								select: {
									id: true,
									fullName: true,
									line1: true,
									line2: true,
									city: true,
									state: true,
									postalCode: true,
									country: true,
								},
								take: 1,
							}
						: false,
				},
			}),
			// Spendable balance (`availableCents` minus past-TTL grants pending
			// expire) — drives the credit drift check below. Reading spendable
			// here matches what the quote was computed against; the hold writer
			// in Tx A then materialises the expiry so the actual CAS is backed
			// by the same number the drift check approved.
			getSpendableBalance({ db, userId: buyerId }),
			// Card rail only — load the selected saved payment method (scoped to
			// this buyer's billing). BNPL and the guest rail have no saved method,
			// so we skip the lookup entirely rather than fetch-and-ignore. Parallel
			// with the reads above, so no added latency on the card path.
			isBnpl || isGuest
				? Promise.resolve(null)
				: db.paymentMethod.findFirst({
						where: {
							id: body.paymentMethodId,
							userBilling: { userId: buyerId },
						},
						select: {
							id: true,
							stripePaymentMethodId: true,
							brand: true,
							last4: true,
						},
					}),
		]);

	// A listing went unavailable between quote and claim — sold, pulled, or its
	// seller suspended (NL-230 Layer 1). Collect *every* such id, not just the
	// first, so the buyer can drop them all in one step. Same error contract as
	// the in-tx reservation race below, so the FE renders one "no longer
	// available" banner regardless of which gate caught it. Thrown before any
	// charge or reservation — nothing has moved yet.
	if (unavailableListingIds.length > 0) {
		throw new HttpError(
			"Some listings are no longer available",
			CheckoutClaimErrorCode.unavailable_listings,
			{ statusCode: 409, data: { unavailableListingIds } },
		);
	}

	if (!buyer) {
		// buyerId comes from the authenticated session (or a freshly-minted guest
		// User), so a missing row is an internal inconsistency, not a client error.
		throw errors.internal("Buyer not found for checkout claim", {
			code: "BUYER_NOT_FOUND",
		});
	}

	// Buying suspension gate (dispute automation P3). Thrown before any charge or
	// reservation — nothing has moved yet.
	assertBuyingNotSuspended(buyer);
	assertOrdersOpen();
	const customerId = buyer.billing?.customerId;
	// Saved-card and BNPL rails charge a pre-saved customer; the guest rail
	// charges a freshly-collected method client-side and needs no customer here.
	if (!isGuest && !customerId) {
		throw errors.badRequest(
			"Buyer is missing a Stripe customer. Set up payment first.",
			{ code: "BUYER_MISSING_WALLET" },
		);
	}
	// Card rail requires the saved payment method (loaded above); BNPL and the
	// guest rail have none.
	if (!isBnpl && !isGuest && !paymentMethod) {
		throw errors.badRequest("Payment method not found for this buyer", {
			code: "PAYMENT_METHOD_NOT_FOUND",
		});
	}

	// Authed quotes resolve the ship-to from the saved-address book; a guest
	// quote (NL-298) carries the typed ship-to raw on the quote itself. Both
	// converge on the same shape so the country gate, tax address, and Order
	// ship-to snapshot below are rail-agnostic.
	const shipAddress: ClaimShipAddress | null =
		quote.shippingAddressId && buyer.shippingAddresses
			? (buyer.shippingAddresses[0] ?? null)
			: guestShipAddressFromQuote(quote);
	if (quote.shippingAddressId && !shipAddress) {
		throw errors.badRequest("Shipping address not found for this buyer", {
			code: "SHIPPING_ADDRESS_NOT_FOUND",
		});
	}

	// 3) Self-purchase guard — never allow buyer to claim their own listing.
	for (const l of listings) {
		if (l.sellerUserId === buyerId) {
			throw errors.forbidden("Cannot purchase your own listing", {
				code: CheckoutClaimErrorCode.self_purchase,
			});
		}
	}

	// 3b) Country gate (defense-in-depth) — quote.ts surfaces a non-blocking
	// flag so the FE disables Place Order; claim refuses to materialize an
	// Order with a non-US ship-to. Only checked when there's a ship line: a
	// 100%-pickup quote requires no buyer ship address.
	const hasShipLine = Array.from(buyerChoiceByListing.values()).some(
		(m) => m === "shipping",
	);
	if (
		hasShipLine &&
		shipAddress &&
		shipAddress.country.toUpperCase() !== COUNTRY_CODE_US
	) {
		throw new HttpError(
			"Shipping is only available within the United States",
			CheckoutClaimErrorCode.shipping_country_not_supported,
			{ statusCode: 422 },
		);
	}

	// 4) Pickup snapshots — full address fields needed for both Order pickup
	//    snapshot AND tax-address fallback when there's no ship-to.
	const pickupSnapshotByLocationId = await loadPickupSnapshots(db, listings);

	// 5) Resolve the tax address. Mirror quote-time logic: if any ship line, use
	//    buyer ship-to; else first pickup location. For the wallet lane, strip the
	//    street so the recompute reproduces the ZIP-centroid basis the buyer
	//    authorized in the sheet (the quote was priced street-less). The full
	//    `shipAddress` still drives the country gate + the Order ship-to snapshot.
	const taxShipAddress =
		isWalletLane && shipAddress
			? { ...shipAddress, line1: undefined }
			: shipAddress;
	const taxAddress = resolveClaimTaxAddress({
		listings,
		buyerChoiceByListing,
		shipAddress: taxShipAddress,
		pickupSnapshotByLocationId,
	});
	if (!taxAddress) {
		throw errors.badRequest(
			"Cannot resolve a tax address for this checkout (no ship-to and no pickup location available)",
			{ code: "TAX_ADDRESS_UNRESOLVED" },
		);
	}

	// 6) Recompute fresh totals + drift check. Group + validate upfront so
	//    a stale fulfillment choice (listing's mode/pickup-location changed
	//    after the quote) fails fast with 422.
	const { items: groupableItems, groups: validatedGroups } =
		buildAndValidateGroups(listings, buyerChoiceByListing);
	const fresh = await computeCheckoutTotals({
		listings,
		items: groupableItems,
		groups: validatedGroups,
		taxAddress,
		// NL-298 — a guest's typed email can dedupe to a real (possibly tax-exempt)
		// account, but a typed email is not proof of inbox ownership, so the
		// exemption must not apply on a sessionless claim. Mirrors the quote path,
		// which skips the buyer load entirely for guests. To use the exemption, the
		// buyer signs in.
		taxExempt: !isGuest && buyer.taxExemptStatus === "approved",
		payments,
	});

	// Credit drift check — recompute against current wallet using the
	// opt-in stance captured on the persisted quote (the buyer's source of
	// truth). Mismatch with the credit number we rendered to the buyer
	// throws CREDIT_CHANGED; FE re-quotes (cart-hash includes the wallet
	// snapshot so the next quote call returns fresh credit).
	const credit = applyCreditToCheckout({
		useCredit: quote.useCredit,
		walletSpendableCents: spendable.spendableCents,
		groupTotalsCents: fresh.groups.map((g) => g.totalCents),
	});
	if (credit.totalCreditCents !== quote.appliedCreditCents) {
		throw new HttpError(
			"Wallet credit changed since quote",
			CheckoutClaimErrorCode.credit_changed,
			{
				statusCode: 409,
				data: {
					expectedCreditCents: quote.appliedCreditCents,
					actualCreditCents: credit.totalCreditCents,
				} satisfies CheckoutCreditChangedData,
			},
		);
	}

	const drift = computeDrift(quote.lines, fresh.perListing);
	if (drift) {
		const newQuote = await db.checkoutQuote.create({
			data: {
				buyerId,
				shippingAddressId: shipAddress?.id ?? null,
				totalCents: fresh.totalCents,
				taxCalculationId: fresh.taxCalculationId,
				cartHash: quote.cartHash,
				expiresAt: quote.expiresAt,
				lines: {
					createMany: {
						data: fresh.perListing.map((p) => ({
							listingId: p.listingId,
							fulfillmentMode: p.fulfillmentMode,
							priceCents: p.priceCents,
							taxCents: p.taxCents,
							shippingCents: p.shippingCents,
							totalCents: p.totalCents,
						})),
					},
				},
			},
			select: { id: true },
		});
		throw new HttpError(
			"Prices changed since quote",
			CheckoutClaimErrorCode.price_changed,
			{
				statusCode: 409,
				data: {
					newQuoteId: newQuote.id,
					oldTotalCents: quote.totalCents,
					newTotalCents: fresh.totalCents,
					diffByListing: drift,
				},
			},
		);
	}

	// 7) Build materialization groups — one Order per fulfillment group.
	const listingsById = new Map(listings.map((l) => [l.id, l]));
	const materializationGroups: MaterializationGroup[] = fresh.groups.map(
		(g) => ({
			orderId: randomUUID(),
			sellerProfileId: g.sellerProfileId,
			fulfillmentMode: g.fulfillmentMode,
			shippingPresetKey: g.shippingPresetKey,
			shippingServiceKey: g.shippingServiceKey,
			signatureRequired: g.signatureRequired,
			listings: g.listingIds
				.map((id) => listingsById.get(id))
				.filter((l): l is CheckoutListing => l !== undefined),
		}),
	);

	const sellerProfileIdsWithShipGroup = new Set(
		fresh.groups
			.filter((g) => g.fulfillmentMode === "shipping")
			.map((g) => g.sellerProfileId),
	);
	const shipFromBySellerProfile = await loadShipFromBySellerProfile(
		db,
		Array.from(sellerProfileIdsWithShipGroup),
	);

	// Vacation rides along on each listing row via `checkoutListingSelect`
	// (one JOIN, no extra roundtrip). Dedupe to one entry per seller — the
	// rows for the same seller carry the same period.
	const vacationBySellerProfileId = new Map<string, SellerVacationPeriod>();
	for (const l of listings) {
		if (l.sellerVacation) {
			vacationBySellerProfileId.set(l.sellerProfileId, l.sellerVacation);
		}
	}

	const shipTo: ShipToSnapshot | null = shipAddress
		? {
				name: shipAddress.fullName,
				line1: shipAddress.line1,
				line2: shipAddress.line2,
				city: shipAddress.city,
				state: shipAddress.state,
				postalCode: shipAddress.postalCode,
				country: shipAddress.country,
				// NL-298 — a guest never provides a phone (the typed ship-to carries
				// none) and a typed email can dedupe to a real account, so the deduped
				// account's phone must NOT snapshot onto the Order: it would surface on
				// the sessionless, token-scoped confirmation (a cross-account PII leak).
				phone: isGuest ? null : buyer.phone,
			}
		: null;

	const totalsByListingId = new Map(
		fresh.perListing.map((t) => [t.listingId, t]),
	);
	const consumedMarkerOrderId = materializationGroups[0]?.orderId;
	if (!consumedMarkerOrderId) {
		throw errors.internal("No fulfillment groups in claim", {
			code: "NO_FULFILLMENT_GROUPS",
		});
	}
	const reservedUntil = new Date(
		Date.now() + (isBnpl ? BNPL_RESERVATION_TTL_MS : RESERVATION_TTL_MS),
	);

	// The floor rule in `applyCreditToCheckout` guarantees this is either 0
	// (credit covers everything → bypass Stripe, finalize inline) or ≥ $0.50
	// (normal Stripe path). No values in between can land here.
	const chargedAmountCents = fresh.totalCents - credit.totalCreditCents;
	const isCreditOnlyCheckout = chargedAmountCents === 0;
	const paidAt = new Date();

	// NL-378 — server-side BNPL floor. The quote computes `bnplEligible` and the
	// FE only renders the rails when true, but the claim is the charge-creating
	// path and must not trust the client: a crafted body could open an
	// Affirm/Klarna PI on a sub-floor amount — a PI the provider rejects at
	// confirm, plus a needlessly held reservation. Gauge the *payable* (gross −
	// credit), the same number the quote gated on. Credit-covered ($0) BNPL is
	// rerouted to the credit-only path below, so it's exempt. Checked before
	// Tx A so a refused claim reserves nothing.
	if (
		isBnpl &&
		!isCreditOnlyCheckout &&
		!isBnplEligibleAmount(chargedAmountCents)
	) {
		throw new HttpError(
			"This order doesn't qualify for Pay over time",
			CheckoutClaimErrorCode.bnpl_unavailable_for_amount,
			{ statusCode: 422, data: { payableCents: chargedAmountCents } },
		);
	}

	// NL-378 — when wallet credit covers the whole order there's nothing to
	// finance, so a BNPL selection is moot: fall through to the credit-only ($0)
	// path and record it as a credit/$0 order (not the provider) rather than
	// erroring. BNPL billing comes from the ship-to when present; a pickup-only
	// order passes no address and the provider collects it on its hosted page
	// (Affirm self-collects; Klarna collects in the redirect flow).
	const recordedPaymentMethodType =
		isBnpl && !isCreditOnlyCheckout ? body.bnpl : "card";

	// 8) Tx A — atomic DB writes only. Fast (no external calls).
	const txResult = await apiTx(db, async (tx) => {
		const consumed = await tx.checkoutQuote.updateMany({
			where: {
				id: quote.id,
				buyerId,
				consumedByOrderId: null,
				expiresAt: { gt: new Date() },
			},
			data: { consumedByOrderId: consumedMarkerOrderId },
		});
		if (consumed.count === 0) {
			const refresh = await tx.checkoutQuote.findUnique({
				where: { id: quote.id },
				select: { expiresAt: true },
			});
			if (refresh && refresh.expiresAt < new Date()) {
				throw new HttpError(
					"Quote expired",
					CheckoutClaimErrorCode.quote_expired,
					{ statusCode: 410 },
				);
			}
			throw new HttpError(
				"Quote is no longer valid",
				CheckoutClaimErrorCode.invalid_quote,
				{ statusCode: 422 },
			);
		}

		const { unavailableListingIds } = await reserveListings(tx, {
			groups: materializationGroups.map((g) => ({
				orderId: g.orderId,
				listingIds: g.listings.map((l) => l.id),
			})),
			reservedUntil,
		});
		if (unavailableListingIds.length > 0) {
			throw new HttpError(
				"Some listings became unavailable",
				CheckoutClaimErrorCode.unavailable_listings,
				{
					statusCode: 409,
					data: { unavailableListingIds },
				},
			);
		}

		const materialized = await materializeOrders({
			tx,
			buyerId,
			buyerEmailSnapshot: buyer.email,
			idempotencyKey: body.idempotencyKey,
			idempotencyPayloadHash: payloadHash,
			groups: materializationGroups,
			totalsByListingId,
			shipTo,
			shipFromBySellerProfile,
			pickupSnapshotByLocationId,
			paymentMethodBrand: isBnpl ? null : (paymentMethod?.brand ?? null),
			paymentMethodLast4: isBnpl ? null : (paymentMethod?.last4 ?? null),
			paymentMethodType: recordedPaymentMethodType,
			vacationBySellerProfileId,
			requestReferrer: input.requestReferrer,
		});

		// Credit holds — batched. One wallet CAS + one createManyAndReturn
		// regardless of group count, then a single AppliedCredit createMany.
		// `holdExpiresAt` aligns with the listing reservation TTL so the
		// reservation reconciler's PI-cancel path naturally releases the hold
		// alongside the orders. PI ID isn't known yet (Stripe call follows
		// Tx A); Tx B backfills `AppliedCredit.paymentIntentId`.
		const holdSpecs = materializationGroups
			.map((g, i) => ({
				orderId: g.orderId,
				amountCents: credit.perGroupCreditCents[i] ?? 0,
			}))
			.filter((h) => h.amountCents > 0);
		if (holdSpecs.length > 0) {
			const holdEntries = await holdCredits({
				db: tx,
				userId: buyerId,
				holdExpiresAt: reservedUntil,
				holds: holdSpecs.map((h) => ({
					orderId: h.orderId,
					amountCents: h.amountCents,
					idempotencyKey: `${h.orderId}:hold`,
				})),
			});
			await tx.appliedCredit.createMany({
				data: holdEntries.map((e, i) => {
					const spec = holdSpecs[i];
					if (!spec) {
						// Order-preservation invariant in holdCredits: entries[i] is
						// the hold for specs[i]. If they ever diverge, fail loud.
						throw errors.internal("Hold/applied-credit ordering mismatch", {
							code: "WALLET_HOLD_ORDER_MISMATCH",
						});
					}
					return {
						orderId: spec.orderId,
						walletId: e.walletId,
						appliedCents: spec.amountCents,
						holdEntryId: e.id,
					};
				}),
			});
		}

		// Credit-only ($0) path: finalize inside the same Tx A so orders,
		// holds, captures, listing→sold, sibling-offer cancellation, and
		// Earning/Label rows all commit atomically. No Stripe call, no Tx B.
		// The shared `finalizeCheckoutTx` lives in `@nolie/checkout` and is
		// the same function the worker's PI.succeeded handler calls — the
		// only difference is `chargeId: null`.
		if (isCreditOnlyCheckout) {
			const orders = await loadFinalizableOrdersByIds(
				tx,
				materialized.orderIds,
			);
			const finalize = await finalizeCheckoutTx({
				tx,
				orders,
				chargeId: null,
				paidAt,
				onAnomalousFallback: ({ orderId }) => {
					reportError(
						new Error(
							"checkout.claim ($0): ShippingLabel sized from fallback dims — non-letter listing reached payment with no package dims",
						),
						{
							operation: "claim_zero_charge_label_fallback_dims",
							extra: { orderId },
						},
					);
				},
			});
			return { ...materialized, finalize, orders };
		}

		return { ...materialized, finalize: null, orders: null };
	});
	const orderIds = txResult.orderIds;

	if (isCreditOnlyCheckout && txResult.finalize && txResult.orders) {
		// Side-effects + sibling fan-out happen post-tx. Mirrors the worker's
		// PI.succeeded flow exactly except no paymentIntentId.
		runCheckoutSideEffects({
			orders: txResult.orders,
			paymentIntentId: null,
			paidAt,
			queues: input.queues,
			logger,
			reportError,
			analytics: input.analytics,
			marketing: input.marketing,
		});
		fanOutCanceledSiblings({
			realtime: input.realtime,
			notificationsQueue: input.queues.notifications,
			siblings: txResult.finalize.cancelledSiblings,
			state: txResult.finalize.cancelledSiblingState,
			resolvedAt: txResult.finalize.cancelledSiblingsResolvedAt,
			resolvedBy: null,
			context: "claim_zero_charge",
		});
		logger.info(
			{ buyerId, quoteId: quote.id, orderIds },
			"checkout.claim: success ($0 credit-only)",
		);
		return {
			clientSecret: null,
			paymentIntentId: null,
			orderIds,
			bnplBilling: null,
		};
	}

	// 9) Stripe call (no tx). Idempotency-keyed on body.idempotencyKey — buyer
	//    retries land on the same PI. Abandonment is handled by the periodic
	//    checkout reservation reconciler (apps/worker/app/checkout/reconciler.ts),
	//    not a per-claim BullMQ job — see Saleor / stripe-magento2 prior art.
	const sellerProfileIds = uniqueSellerProfileIds(fresh.groups);
	// `chargedAmountCents` declared above — Order rows still keep gross
	// totals so receipts can render the gross-then-tender breakdown;
	// AppliedCredit carries the credit slice per Order for refund-time
	// proration.
	const piMetadata = buildPaymentIntentMetadata({
		fresh,
		buyerId,
		sellerProfileIds,
		orderIds,
		quoteId: quote.id,
		idempotencyKey: body.idempotencyKey,
		creditAppliedCents: credit.totalCreditCents,
	});
	// One Stripe call per rail. The guest rail charges customer-less (the fresh
	// card is attached client-side at confirm); the card and BNPL rails charge
	// the saved customer the gates above already required — each branch re-checks
	// what it reads so the values narrow to non-null without a cast or assertion.
	let piResult: Awaited<
		ReturnType<typeof payments.customer.createCheckoutPaymentIntent>
	>;
	if (isGuest) {
		piResult = await payments.customer.createGuestCheckoutPaymentIntent({
			idempotencyKey: body.idempotencyKey,
			buyerId,
			// Always customer-less on the guest rail: the fresh card is attached at
			// confirm. NL-298 — never inherit the customer of a deduped real account
			// (a typed email isn't proof of inbox ownership). Attaching the guest
			// charge to their Stripe customer breaks isolation and would, once
			// `setup_future_usage` ships (card vault), vault a stranger's card onto
			// their customer.
			customerId: undefined,
			amountCents: chargedAmountCents,
			taxCalculationId: fresh.taxCalculationId ?? undefined,
			metadata: piMetadata,
		});
	} else if (isBnpl) {
		if (!customerId) {
			throw errors.internal("BNPL claim reached charge with no customer", {
				code: "BNPL_CHARGE_NO_CUSTOMER",
			});
		}
		piResult = await payments.customer.createBnplCheckoutPaymentIntent({
			idempotencyKey: body.idempotencyKey,
			buyerId,
			customerId,
			provider: body.bnpl,
			amountCents: chargedAmountCents,
			taxCalculationId: fresh.taxCalculationId ?? undefined,
			metadata: piMetadata,
			address: toBnplAddress(shipTo, buyer.email),
		});
	} else {
		if (!customerId || !paymentMethod) {
			throw errors.internal(
				"Card claim reached charge with no customer/method",
				{
					code: "CARD_CHARGE_NO_CONTEXT",
				},
			);
		}
		piResult = await payments.customer.createCheckoutPaymentIntent({
			idempotencyKey: body.idempotencyKey,
			buyerId,
			customerId,
			paymentMethodId: paymentMethod.stripePaymentMethodId,
			amountCents: chargedAmountCents,
			taxCalculationId: fresh.taxCalculationId ?? undefined,
			metadata: piMetadata,
		});
	}
	if (!piResult.success) {
		if (piResult.error === PaymentErrorCode.rate_limit_exceeded) {
			throw errors.tooManyRequests(
				"We are experiencing high demand. Please try again in a moment.",
				{ code: "STRIPE_RATE_LIMIT_EXCEEDED" },
			);
		}
		setReportingContext({
			operation: "checkout_pi_create_failed",
			extra: {
				buyerId,
				quoteId: quote.id,
				orderIds,
				stripeError: piResult.error,
				stripeErrorCode: piResult.stripeErrorCode,
			},
		});
		// Orders sit at paymentIntentId=null; buyer retry resumes via the replay
		// path. The reservation reconciler is the longer-term cleanup.
		throw errors.internal("PaymentIntent creation failed", {
			code: "PI_CREATION_FAILED",
		});
	}

	// 10) Tx B — link the PI to the Orders. Bounded WHERE clause guards against
	//     a concurrent retry already linking them. Same backfill happens on
	//     `AppliedCredit.paymentIntentId` when this checkout consumed credit
	//     so the webhook side (capture / release / refund) can pivot off the
	//     PI ID without a join through Order.
	await db.order.updateMany({
		where: {
			id: { in: orderIds },
			buyerId,
			idempotencyKey: body.idempotencyKey,
			paymentIntentId: null,
		},
		data: { paymentIntentId: piResult.paymentIntentId },
	});
	if (credit.totalCreditCents > 0) {
		await db.appliedCredit.updateMany({
			where: { orderId: { in: orderIds }, paymentIntentId: null },
			data: { paymentIntentId: piResult.paymentIntentId },
		});
	}

	logger.info(
		{
			buyerId,
			quoteId: quote.id,
			paymentIntentId: piResult.paymentIntentId,
			orderIds,
		},
		"checkout.claim: success",
	);

	return {
		clientSecret: piResult.clientSecret,
		paymentIntentId: piResult.paymentIntentId,
		orderIds,
		bnplBilling: isBnpl ? toBnplAddress(shipTo, buyer.email) : null,
	};
}

interface PersistedQuoteLine {
	listingId: string;
	/** DB enum carries `shipping | pickup | pickup_optional`; only the first two are valid here. */
	fulfillmentMode: string;
	priceCents: number;
	taxCents: number;
	shippingCents: number;
	totalCents: number;
}

interface PersistedQuote {
	id: string;
	// Nullable since NL-298 Phase 5 (the wallet lane's identity-less quote). A
	// real claim always stamps a buyer first, so `ensureQuoteUsable`'s
	// `buyerId !== buyerId` check rejects a still-null (unstamped) quote.
	buyerId: string | null;
	consumedByOrderId: string | null;
	expiresAt: Date;
	shippingAddressId: string | null;
	// NL-298 — a guest's typed ship-to, persisted raw on the quote (guests have
	// no saved `ShippingAddress`). Null on authed quotes, which carry a
	// `shippingAddressId` instead. Read back here for the tax recompute + the
	// Order ship-to snapshot.
	guestShipToName: string | null;
	guestShipToLine1: string | null;
	guestShipToLine2: string | null;
	guestShipToCity: string | null;
	guestShipToState: string | null;
	guestShipToPostalCode: string | null;
	guestShipToCountry: string | null;
	cartHash: string | null;
	totalCents: number;
	appliedCreditCents: number;
	useCredit: boolean;
	lines: PersistedQuoteLine[];
}

function ensureQuoteUsable(
	quote: PersistedQuote | null,
	buyerId: string,
): PersistedQuote {
	if (!quote || quote.buyerId !== buyerId) {
		// Don't disclose the existence of someone else's quote — same code path.
		throw new HttpError(
			"Quote not found",
			CheckoutClaimErrorCode.invalid_quote,
			{ statusCode: 422 },
		);
	}
	if (quote.consumedByOrderId) {
		throw new HttpError(
			"Quote was already used",
			CheckoutClaimErrorCode.invalid_quote,
			{ statusCode: 422 },
		);
	}
	if (quote.expiresAt < new Date()) {
		throw new HttpError("Quote expired", CheckoutClaimErrorCode.quote_expired, {
			statusCode: 410,
		});
	}
	return quote;
}

/** Unified ship-to shape — a saved-address row or a guest's quote-borne ship-to. */
interface ClaimShipAddress {
	id: string | null;
	fullName: string;
	line1: string;
	line2: string | null;
	city: string;
	state: string;
	postalCode: string;
	country: string;
}

/**
 * NL-298 — reconstruct the ship-to from a guest quote's persisted raw fields
 * (the guest has no saved `ShippingAddress`). Null when the quote carries no
 * guest ship-to (an authed quote, or a 100%-pickup guest quote). The seven
 * columns are always written together, so a present `line1` implies the rest.
 */
function guestShipAddressFromQuote(
	quote: PersistedQuote,
): ClaimShipAddress | null {
	if (!quote.guestShipToLine1) return null;
	return {
		// Guests always supply a recipient name (schema-required), so this is set
		// whenever the address is; `?? ""` only satisfies the nullable column type.
		id: null,
		fullName: quote.guestShipToName ?? "",
		line1: quote.guestShipToLine1,
		line2: quote.guestShipToLine2,
		city: quote.guestShipToCity ?? "",
		state: quote.guestShipToState ?? "",
		postalCode: quote.guestShipToPostalCode ?? "",
		country: quote.guestShipToCountry ?? "",
	};
}

async function replayIfExists({
	db,
	payments,
	buyerId,
	body,
	incomingPayloadHash,
}: {
	db: PrismaClient;
	payments: PaymentsClient;
	buyerId: string;
	body: ClaimInput["body"];
	incomingPayloadHash: string;
}): Promise<CheckoutClaimSuccess | null> {
	const siblings = await db.order.findMany({
		where: { buyerId, idempotencyKey: body.idempotencyKey },
		select: {
			id: true,
			paymentIntentId: true,
			paymentStatus: true,
			subtotalCents: true,
			shippingCents: true,
			taxCents: true,
			applicationFeeCents: true,
			totalCents: true,
			sellerProfileId: true,
			idempotencyPayloadHash: true,
			// NL-378 — ship-to snapshot + buyer email, for rebuilding the BNPL
			// billing details handed back to the client on a replay confirm.
			shipToName: true,
			shipToLine1: true,
			shipToLine2: true,
			shipToCity: true,
			shipToState: true,
			shipToPostalCode: true,
			shipToCountry: true,
			buyerEmailSnapshot: true,
		},
	});
	if (siblings.length === 0) return null;

	// Stripe-style replay-with-different-payload guard. Same buyer + same key
	// landing here with a different (quoteId, paymentMethodId) means the SPA
	// reused a stale key — refuse, don't silently confirm the wrong payment.
	const storedHash = siblings.find(
		(s) => s.idempotencyPayloadHash !== null,
	)?.idempotencyPayloadHash;
	if (storedHash && storedHash !== incomingPayloadHash) {
		throw new HttpError(
			"Idempotency key reused with a different payload",
			"IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
			{ statusCode: 422 },
		);
	}

	const orderIds = siblings.map((s) => s.id);
	const linkedPI = siblings.find((s) => s.paymentIntentId);

	// Replay path C — credit-only ($0) finalize already ran. No PI was ever
	// linked AND every sibling is already succeeded → idempotent return of
	// the same success envelope the first call produced. Has to come before
	// path B (which would try to resume Stripe with a $0 amount).
	if (
		!linkedPI &&
		siblings.every((s) => s.paymentStatus === PaymentStatus.succeeded)
	) {
		return {
			clientSecret: null,
			paymentIntentId: null,
			orderIds,
			bnplBilling: null,
		};
	}

	// BNPL replay re-confirms client-side, so it needs the billing details again.
	// Rebuild them from a sibling Order's frozen ship-to snapshot.
	const replayBilling = isBnplClaim(body)
		? bnplBillingFromOrderSnapshot(siblings.find((s) => s.shipToLine1) ?? null)
		: null;

	// Replay path A — PI was already linked. Just refetch the clientSecret.
	if (linkedPI?.paymentIntentId) {
		let pi: Awaited<ReturnType<typeof payments.customer.retrievePaymentIntent>>;
		try {
			pi = await payments.customer.retrievePaymentIntent(
				linkedPI.paymentIntentId,
			);
		} catch (err) {
			if (isStripeRateLimitError(err)) {
				throw errors.tooManyRequests(
					"We are experiencing high demand. Please try again in a moment.",
					{ code: "STRIPE_RATE_LIMIT_EXCEEDED" },
				);
			}
			throw err;
		}
		if (pi.status === "canceled" || pi.status === "succeeded") {
			throw new HttpError(
				"Original PaymentIntent is no longer in flight",
				"REPLAY_PI_TERMINAL",
				{ statusCode: 410, data: { paymentIntentStatus: pi.status } },
			);
		}
		// Card declined on the prior confirm attempt — Stripe transitions the PI
		// to `requires_payment_method` and clears the `payment_method` slot. The
		// next `stripe.confirmPayment(clientSecret)` would otherwise hit Stripe
		// with no PM attached and surface a generic processing-error message.
		// Re-attach the saved card so the retry charges normally.
		//
		// BNPL never pre-attaches a payment method: `requires_payment_method` is
		// just the buyer's last redirect not completing, and the retry confirms
		// fresh via `confirmAffirmPayment`/`confirmKlarnaPayment` client-side. So
		// for BNPL we skip the re-attach and return the same clientSecret as-is.
		// The guest rail likewise has no saved method — the buyer re-confirms with
		// a freshly-entered card against the same clientSecret — so it skips too.
		if (
			!isBnplClaim(body) &&
			!isGuestClaim(body) &&
			pi.status === "requires_payment_method"
		) {
			const { stripePaymentMethodId } = await loadReplayWalletContext({
				db,
				buyerId,
				paymentMethodId: body.paymentMethodId,
			});
			try {
				const updated = await payments.customer.updatePaymentIntent({
					paymentIntentId: pi.id,
					paymentMethodId: stripePaymentMethodId,
				});
				pi = {
					id: updated.id,
					status: updated.status,
					clientSecret: updated.clientSecret,
					latestChargeId: pi.latestChargeId,
				};
			} catch (err) {
				if (isStripeRateLimitError(err)) {
					throw errors.tooManyRequests(
						"We are experiencing high demand. Please try again in a moment.",
						{ code: "STRIPE_RATE_LIMIT_EXCEEDED" },
					);
				}
				throw err;
			}
		}
		if (!pi.clientSecret) {
			setReportingContext({
				operation: "checkout_replay_pi_no_client_secret",
				extra: { buyerId, paymentIntentId: linkedPI.paymentIntentId },
			});
			throw errors.internal("Replay PaymentIntent missing client_secret", {
				code: "REPLAY_PI_NO_CLIENT_SECRET",
			});
		}
		return {
			clientSecret: pi.clientSecret,
			paymentIntentId: pi.id,
			orderIds,
			bnplBilling: replayBilling,
		};
	}

	// Replay path B — Orders exist but no PI was linked yet. Previous attempt
	// died between Tx A and Tx B (or the Stripe call itself never landed).
	// Resume by re-calling Stripe with the same idempotency key — Stripe
	// returns the same PI it created last time, or creates a fresh one.
	return resumeWithoutLinkedPI({ db, payments, buyerId, body, siblings });
}

async function resumeWithoutLinkedPI({
	db,
	payments,
	buyerId,
	body,
	siblings,
}: {
	db: PrismaClient;
	payments: PaymentsClient;
	buyerId: string;
	body: ClaimInput["body"];
	siblings: {
		id: string;
		subtotalCents: number;
		shippingCents: number;
		taxCents: number;
		applicationFeeCents: number;
		totalCents: number;
		sellerProfileId: string;
	}[];
}): Promise<CheckoutClaimSuccess> {
	const isBnpl = isBnplClaim(body);
	const isGuest = isGuestClaim(body);

	const orderIds = siblings.map((s) => s.id);
	const sellerProfileIds = Array.from(
		new Set(siblings.map((s) => s.sellerProfileId)),
	);
	const quote = await db.checkoutQuote.findFirst({
		where: { consumedByOrderId: { in: orderIds }, buyerId },
		select: { id: true, taxCalculationId: true },
	});

	const aggregate = siblings.reduce(
		(acc, s) => ({
			subtotalCents: acc.subtotalCents + s.subtotalCents,
			shippingCents: acc.shippingCents + s.shippingCents,
			taxCents: acc.taxCents + s.taxCents,
			applicationFeeCents: acc.applicationFeeCents + s.applicationFeeCents,
			totalCents: acc.totalCents + s.totalCents,
		}),
		{
			subtotalCents: 0,
			shippingCents: 0,
			taxCents: 0,
			applicationFeeCents: 0,
			totalCents: 0,
		},
	);

	// Credit holds already landed in the original Tx A — replay must charge
	// `gross − held credit`, mirroring the fresh path's `chargedAmountCents`.
	// Reading from AppliedCredit (not re-computing from wallet) means a wallet
	// change between attempts can't alter the amount we charge after the buyer
	// agreed to it.
	const appliedCreditAggregate = await db.appliedCredit.aggregate({
		where: { orderId: { in: orderIds } },
		_sum: { appliedCents: true },
	});
	const replayCreditAppliedCents =
		appliedCreditAggregate._sum.appliedCents ?? 0;
	const chargedAmountCents = aggregate.totalCents - replayCreditAppliedCents;

	const replayMetadata = {
		subtotalCents: aggregate.subtotalCents,
		shippingCents: aggregate.shippingCents,
		taxCents: aggregate.taxCents,
		applicationFeeCents: aggregate.applicationFeeCents,
		totalCents: aggregate.totalCents,
		creditAppliedCents: replayCreditAppliedCents,
		buyerId,
		sellerProfileIds: sellerProfileIds.join(","),
		orderIds: orderIds.join(","),
		quoteId: quote?.id ?? "",
		idempotencyKey: body.idempotencyKey,
		bundleShippingFormula: BUNDLE_SHIPPING_FORMULA,
	};

	let piResult: Awaited<
		ReturnType<typeof payments.customer.createCheckoutPaymentIntent>
	>;
	// Billing handed back to the client for the BNPL confirm (null on the card rail).
	let replayBilling: BnplBillingDetails | null = null;
	if (isBnpl) {
		// BNPL resume — recreate the same single-method PI (idempotency-keyed, so
		// Stripe returns the original if it ever landed). Customer + the ship-to
		// snapshot come from the already-materialized Orders, never re-derived.
		const { customerId, address } = await loadReplayBnplContext({
			db,
			buyerId,
			orderIds,
		});
		replayBilling = address;
		piResult = await payments.customer.createBnplCheckoutPaymentIntent({
			idempotencyKey: body.idempotencyKey,
			buyerId,
			customerId,
			provider: body.bnpl,
			amountCents: chargedAmountCents,
			taxCalculationId: quote?.taxCalculationId ?? undefined,
			metadata: replayMetadata,
			address,
		});
	} else if (isGuest) {
		// Guest resume — recreate the same empty PI (idempotency-keyed, so Stripe
		// returns the original if it ever landed). The buyer re-confirms with a
		// freshly-entered card against the returned clientSecret. Always
		// customer-less, identical to the first attempt (`claimCheckout`): NL-298 —
		// never inherit a deduped real account's Stripe customer (a typed email
		// isn't proof of inbox ownership). Keeping both call sites identical is what
		// stops a resume from opening a customer-mismatched PI.
		piResult = await payments.customer.createGuestCheckoutPaymentIntent({
			idempotencyKey: body.idempotencyKey,
			buyerId,
			customerId: undefined,
			amountCents: chargedAmountCents,
			taxCalculationId: quote?.taxCalculationId ?? undefined,
			metadata: replayMetadata,
		});
	} else {
		const { customerId, stripePaymentMethodId } = await loadReplayWalletContext(
			{
				db,
				buyerId,
				paymentMethodId: body.paymentMethodId,
			},
		);
		piResult = await payments.customer.createCheckoutPaymentIntent({
			idempotencyKey: body.idempotencyKey,
			buyerId,
			customerId,
			paymentMethodId: stripePaymentMethodId,
			amountCents: chargedAmountCents,
			taxCalculationId: quote?.taxCalculationId ?? undefined,
			metadata: replayMetadata,
		});
	}
	if (!piResult.success) {
		if (piResult.error === PaymentErrorCode.rate_limit_exceeded) {
			throw errors.tooManyRequests(
				"We are experiencing high demand. Please try again in a moment.",
				{ code: "STRIPE_RATE_LIMIT_EXCEEDED" },
			);
		}
		setReportingContext({
			operation: "checkout_replay_pi_create_failed",
			extra: { buyerId, orderIds, stripeError: piResult.error },
		});
		throw errors.internal("Replay PaymentIntent creation failed", {
			code: "REPLAY_PI_CREATION_FAILED",
		});
	}

	await db.order.updateMany({
		where: {
			id: { in: orderIds },
			buyerId,
			idempotencyKey: body.idempotencyKey,
			paymentIntentId: null,
		},
		data: { paymentIntentId: piResult.paymentIntentId },
	});
	if (replayCreditAppliedCents > 0) {
		await db.appliedCredit.updateMany({
			where: { orderId: { in: orderIds }, paymentIntentId: null },
			data: { paymentIntentId: piResult.paymentIntentId },
		});
	}

	logger.info(
		{
			buyerId,
			orderIds,
			paymentIntentId: piResult.paymentIntentId,
		},
		"checkout.claim: replay resumed (PI linked)",
	);

	return {
		clientSecret: piResult.clientSecret,
		paymentIntentId: piResult.paymentIntentId,
		orderIds,
		bnplBilling: replayBilling,
	};
}

async function loadShipFromBySellerProfile(
	db: PrismaClient,
	sellerProfileIds: string[],
): Promise<Map<string, ShipFromSnapshot>> {
	if (sellerProfileIds.length === 0) return new Map();
	const sellers = await db.sellerProfile.findMany({
		where: { id: { in: sellerProfileIds } },
		select: {
			id: true,
			user: {
				select: {
					phone: true,
					firstName: true,
					lastName: true,
					handle: true,
					// NL-230: seller zone for the shipping-escalation due-instants.
					timezone: true,
				},
			},
			shippingFromAddress: {
				select: {
					fullName: true,
					line1: true,
					line2: true,
					city: true,
					state: true,
					postalCode: true,
					country: true,
				},
			},
		},
	});

	const map = new Map<string, ShipFromSnapshot>();
	for (const seller of sellers) {
		const addr = seller.shippingFromAddress;
		if (!addr) {
			throw errors.badRequest(
				"Seller has no ship-from address; cannot fulfill BIN",
				{
					code: "SELLER_MISSING_SHIP_FROM",
					data: { sellerProfileId: seller.id },
				},
			);
		}
		map.set(seller.id, {
			name:
				addr.fullName ??
				seller.user.handle ??
				joinName(seller.user.firstName, seller.user.lastName),
			line1: addr.line1,
			line2: addr.line2,
			city: addr.city,
			state: addr.state,
			postalCode: addr.postalCode,
			country: addr.country,
			phone: seller.user.phone,
			timezone: seller.user.timezone,
		});
	}
	return map;
}

async function loadPickupSnapshots(
	db: PrismaClient,
	listings: CheckoutListing[],
): Promise<Map<string, PickupSnapshot>> {
	const ids = Array.from(
		new Set(
			listings
				.map((l) => l.pickupLocationId)
				.filter((id): id is string => id !== null),
		),
	);
	if (ids.length === 0) return new Map();
	const rows = await db.pickupLocation.findMany({
		where: { id: { in: ids } },
		select: {
			id: true,
			name: true,
			line1: true,
			line2: true,
			city: true,
			state: true,
			postalCode: true,
			country: true,
			instructions: true,
			latitude: true,
			longitude: true,
		},
	});
	return new Map(
		rows.map((r) => [
			r.id,
			{
				pickupLocationId: r.id,
				name: r.name,
				line1: r.line1,
				line2: r.line2,
				city: r.city,
				state: r.state,
				postalCode: r.postalCode,
				country: r.country,
				instructions: r.instructions,
				latitude: r.latitude,
				longitude: r.longitude,
			},
		]),
	);
}

interface TaxAddress {
	/** Optional — absent for the wallet lane's ZIP-centroid (street-less) tax basis. */
	line1?: string;
	line2: string | null;
	city: string;
	state: string;
	postalCode: string;
	country: string;
}

function resolveClaimTaxAddress(input: {
	listings: CheckoutListing[];
	buyerChoiceByListing: Map<string, FulfillmentMethodType>;
	shipAddress: {
		line1?: string;
		line2: string | null;
		city: string;
		state: string;
		postalCode: string;
		country: string;
	} | null;
	pickupSnapshotByLocationId: Map<string, PickupSnapshot>;
}): TaxAddress | null {
	const hasShipLine = input.listings.some(
		(l) => input.buyerChoiceByListing.get(l.id) === "shipping",
	);
	if (hasShipLine) {
		return input.shipAddress;
	}
	for (const l of input.listings) {
		if (input.buyerChoiceByListing.get(l.id) !== "pickup") continue;
		if (!l.pickupLocationId) continue;
		const snap = input.pickupSnapshotByLocationId.get(l.pickupLocationId);
		if (!snap) continue;
		return {
			line1: snap.line1,
			line2: snap.line2,
			city: snap.city,
			state: snap.state,
			postalCode: snap.postalCode,
			country: snap.country,
		};
	}
	return null;
}

function asResolvedMethod(mode: string): FulfillmentMethodType {
	if (mode === "shipping" || mode === "pickup") return mode;
	// Quote-time validation forbids `pickup_optional` on a CheckoutQuoteLine.
	// If it lands here, it's a writer-side bug.
	throw errors.internal(`Unresolved fulfillment mode on quote line: ${mode}`, {
		code: "QUOTE_LINE_UNRESOLVED_MODE",
	});
}

function uniqueSellerProfileIds(groups: ComputedFulfillmentGroup[]): string[] {
	return Array.from(new Set(groups.map((g) => g.sellerProfileId)));
}

/**
 * NL-378 — buyer name + address for the BNPL `billing_details`/`shipping`,
 * sourced from the ship-to snapshot. Null for a pickup-only checkout (no buyer
 * ship address). The payments layer attaches it to the PI only for Klarna; for
 * Affirm it's supplied client-side at confirm.
 */
function toBnplAddress(
	shipTo: ShipToSnapshot | null,
	email: string,
): {
	name: string;
	email: string;
	line1: string;
	line2: string | null;
	city: string;
	state: string;
	postalCode: string;
	country: string;
} | null {
	if (!shipTo) return null;
	return {
		name: shipTo.name,
		email,
		line1: shipTo.line1,
		line2: shipTo.line2,
		city: shipTo.city,
		state: shipTo.state,
		postalCode: shipTo.postalCode,
		country: shipTo.country,
	};
}

/**
 * NL-378 — rebuild BNPL billing from an Order's frozen ship-to snapshot, for the
 * replay path (the client re-confirms and needs the details again). Null when the
 * order has no ship-to (pickup-only).
 */
function bnplBillingFromOrderSnapshot(
	order: {
		shipToName: string | null;
		shipToLine1: string | null;
		shipToLine2: string | null;
		shipToCity: string | null;
		shipToState: string | null;
		shipToPostalCode: string | null;
		shipToCountry: string | null;
		buyerEmailSnapshot: string;
	} | null,
): BnplBillingDetails | null {
	if (!order?.shipToLine1) return null;
	return {
		name: order.shipToName ?? "",
		email: order.buyerEmailSnapshot,
		line1: order.shipToLine1,
		line2: order.shipToLine2,
		city: order.shipToCity ?? "",
		state: order.shipToState ?? "",
		postalCode: order.shipToPostalCode ?? "",
		country: order.shipToCountry ?? "",
	};
}

function buildPaymentIntentMetadata(input: {
	fresh: ComputedCheckoutTotals;
	buyerId: string;
	sellerProfileIds: string[];
	orderIds: string[];
	quoteId: string;
	idempotencyKey: string;
	creditAppliedCents: number;
}): Record<string, string | number | boolean> {
	return {
		subtotalCents: input.fresh.subtotalCents,
		shippingCents: input.fresh.shippingTotalCents,
		taxCents: input.fresh.taxTotalCents,
		applicationFeeCents: input.fresh.applicationFeeTotalCents,
		totalCents: input.fresh.totalCents,
		creditAppliedCents: input.creditAppliedCents,
		buyerId: input.buyerId,
		sellerProfileIds: input.sellerProfileIds.join(","),
		orderIds: input.orderIds.join(","),
		quoteId: input.quoteId,
		idempotencyKey: input.idempotencyKey,
		bundleShippingFormula: BUNDLE_SHIPPING_FORMULA,
	};
}

interface DriftRow {
	listingId: string;
	oldTotals: CheckoutLineTotals;
	newTotals: CheckoutLineTotals;
}

function computeDrift(
	quoteLines: PersistedQuoteLine[],
	freshPerListing: CheckoutListingTotals[],
): DriftRow[] | null {
	const priorByListing = new Map(quoteLines.map((l) => [l.listingId, l]));
	const drifted: DriftRow[] = [];
	for (const fresh of freshPerListing) {
		const prior = priorByListing.get(fresh.listingId);
		if (!prior) continue;
		if (prior.totalCents !== fresh.totalCents) {
			drifted.push({
				listingId: fresh.listingId,
				oldTotals: {
					priceCents: prior.priceCents,
					taxCents: prior.taxCents,
					shippingCents: prior.shippingCents,
					totalCents: prior.totalCents,
				},
				newTotals: {
					priceCents: fresh.priceCents,
					taxCents: fresh.taxCents,
					shippingCents: fresh.shippingCents,
					totalCents: fresh.totalCents,
				},
			});
		}
	}
	return drifted.length > 0 ? drifted : null;
}

async function loadReplayWalletContext(input: {
	db: PrismaClient;
	buyerId: string;
	paymentMethodId: string;
}): Promise<{ customerId: string; stripePaymentMethodId: string }> {
	const buyer = await input.db.user.findUnique({
		where: { id: input.buyerId },
		select: {
			billing: {
				select: {
					customerId: true,
					paymentMethods: {
						where: { id: input.paymentMethodId },
						select: { stripePaymentMethodId: true },
						take: 1,
					},
				},
			},
		},
	});
	const customerId = buyer?.billing?.customerId;
	const stripePaymentMethodId =
		buyer?.billing?.paymentMethods[0]?.stripePaymentMethodId;
	if (!customerId || !stripePaymentMethodId) {
		throw errors.badRequest(
			"Buyer wallet or payment method missing during replay",
			{ code: "REPLAY_BUYER_WALLET_MISSING" },
		);
	}
	return { customerId, stripePaymentMethodId };
}

/**
 * NL-378 — BNPL replay context. No saved payment method (BNPL has none): just
 * the Stripe customer plus the ship-to snapshot frozen on the Orders at
 * materialize time (the source the Klarna `billing_details`/`shipping` came
 * from on the original attempt — re-derived from the same place so the resumed
 * PI is identical). Address is null for a pickup-only bundle.
 */
async function loadReplayBnplContext(input: {
	db: PrismaClient;
	buyerId: string;
	orderIds: string[];
}): Promise<{
	customerId: string;
	address: ReturnType<typeof toBnplAddress>;
}> {
	const [buyer, order] = await Promise.all([
		input.db.user.findUnique({
			where: { id: input.buyerId },
			select: { email: true, billing: { select: { customerId: true } } },
		}),
		input.db.order.findFirst({
			where: { id: { in: input.orderIds }, shipToLine1: { not: null } },
			select: {
				shipToName: true,
				shipToLine1: true,
				shipToLine2: true,
				shipToCity: true,
				shipToState: true,
				shipToPostalCode: true,
				shipToCountry: true,
				shipToPhone: true,
			},
		}),
	]);
	const customerId = buyer?.billing?.customerId;
	if (!customerId || !buyer) {
		throw errors.badRequest("Buyer wallet missing during BNPL replay", {
			code: "REPLAY_BUYER_WALLET_MISSING",
		});
	}
	const shipTo: ShipToSnapshot | null =
		order?.shipToLine1 != null
			? {
					name: order.shipToName ?? "",
					line1: order.shipToLine1,
					line2: order.shipToLine2,
					city: order.shipToCity ?? "",
					state: order.shipToState ?? "",
					postalCode: order.shipToPostalCode ?? "",
					country: order.shipToCountry ?? "",
					phone: order.shipToPhone,
				}
			: null;
	return { customerId, address: toBnplAddress(shipTo, buyer.email) };
}

export type { CheckoutListing, ComputedCheckoutTotals };
