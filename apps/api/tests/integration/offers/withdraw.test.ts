/**
 * POST /offers/:offerId/withdraw integration tests.
 *
 * Withdraw is structurally idempotent — no separate idempotency key. The CAS
 * narrows on `state = pending AND expiresAt > now()`, so a re-issued withdraw
 * by the original proposer returns the existing row, and any other terminal
 * transition (decline/expire/cancel) wins the race cleanly.
 *
 * Real Postgres + real Fastify. No external services in path.
 */
import { OfferState, prisma } from "@nolie/db";
import { describe, expect, it } from "vitest";
import { assertResponse, type createApiClient } from "../../helpers/index.js";
import {
	postSubmitOffer,
	postWithdrawOffer,
	setupOfferableListing,
	setupReadyBuyer,
	uniqueIdempotencyKey,
} from "./_helpers.js";

async function submitPending(
	api: ReturnType<typeof createApiClient>,
	listingId: string,
) {
	const response = await postSubmitOffer(api, listingId, {
		amountCents: 4000,
		idempotencyKey: uniqueIdempotencyKey("setup"),
	});
	const body = await assertResponse<{ id: string; state: string }>(
		response,
		201,
	);
	expect(body.state).toBe(OfferState.pending);
	return body.id;
}

describe("POST /offers/:offerId/withdraw", () => {
	it("transitions pending → withdrawn for the proposer", async () => {
		const { listing } = await setupOfferableListing();
		const buyer = await setupReadyBuyer();
		const offerId = await submitPending(buyer.api, listing.id);

		const response = await postWithdrawOffer(buyer.api, offerId);
		const body = await assertResponse<{
			state: string;
			resolvedAt: string | null;
			resolvedBy: string | null;
		}>(response, 200);

		expect(body.state).toBe(OfferState.withdrawn);
		expect(body.resolvedAt).not.toBeNull();
		expect(body.resolvedBy).toBe(buyer.session.user.id);

		// DB matches.
		const row = await prisma.offer.findUniqueOrThrow({
			where: { id: offerId },
		});
		expect(row.state).toBe(OfferState.withdrawn);
		expect(row.resolvedBy).toBe(buyer.session.user.id);
	});

	it("rejects a withdraw from someone other than the proposer", async () => {
		const { listing } = await setupOfferableListing();
		const buyer = await setupReadyBuyer();
		const otherBuyer = await setupReadyBuyer();
		const offerId = await submitPending(buyer.api, listing.id);

		const response = await postWithdrawOffer(otherBuyer.api, offerId);
		const body = await assertResponse<{ code: string }>(response, 403);
		expect(body.code).toBe("OFFER_NOT_PROPOSER");

		// State unchanged.
		const row = await prisma.offer.findUniqueOrThrow({
			where: { id: offerId },
		});
		expect(row.state).toBe(OfferState.pending);
	});

	it("returns 404 OFFER_NOT_FOUND for an unknown offer id", async () => {
		const buyer = await setupReadyBuyer();

		const response = await postWithdrawOffer(buyer.api, "clx-does-not-exist");
		const body = await assertResponse<{ code: string }>(response, 404);
		expect(body.code).toBe("OFFER_NOT_FOUND");
	});

	it("returns 409 OFFER_NO_LONGER_PENDING when the offer is already terminal", async () => {
		// Auto-decline produces a terminal `declined` row inline at submit.
		const { listing } = await setupOfferableListing({
			priceDollars: 50,
			autoDeclineBelowPct: 70,
		});
		const buyer = await setupReadyBuyer();

		const submit = await postSubmitOffer(buyer.api, listing.id, {
			amountCents: 3000,
			idempotencyKey: uniqueIdempotencyKey("declined"),
		});
		const submitBody = await assertResponse<{ id: string; state: string }>(
			submit,
			201,
		);
		expect(submitBody.state).toBe(OfferState.declined);

		const response = await postWithdrawOffer(buyer.api, submitBody.id);
		const body = await assertResponse<{ code: string }>(response, 409);
		expect(body.code).toBe("OFFER_NO_LONGER_PENDING");
	});

	it("idempotent replay: re-issued withdraw returns the same row, no second mutation", async () => {
		const { listing } = await setupOfferableListing();
		const buyer = await setupReadyBuyer();
		const offerId = await submitPending(buyer.api, listing.id);

		const first = await postWithdrawOffer(buyer.api, offerId);
		const firstBody = await assertResponse<{
			state: string;
			resolvedAt: string;
			updatedAt: string;
		}>(first, 200);

		const second = await postWithdrawOffer(buyer.api, offerId);
		const secondBody = await assertResponse<{
			state: string;
			resolvedAt: string;
			updatedAt: string;
		}>(second, 200);

		expect(secondBody.state).toBe(OfferState.withdrawn);
		// Row wasn't re-mutated — updatedAt + resolvedAt stay frozen.
		expect(secondBody.resolvedAt).toBe(firstBody.resolvedAt);
		expect(secondBody.updatedAt).toBe(firstBody.updatedAt);
	});

	it("rejects withdraw on a pending-but-expired row (expiry override)", async () => {
		const { listing } = await setupOfferableListing();
		const buyer = await setupReadyBuyer();
		const offerId = await submitPending(buyer.api, listing.id);

		// Pre-expire the row — TTL elapsed, but reconciler hasn't ticked yet.
		await prisma.offer.update({
			where: { id: offerId },
			data: { expiresAt: new Date(Date.now() - 60_000) },
		});

		const response = await postWithdrawOffer(buyer.api, offerId);
		const body = await assertResponse<{ code: string }>(response, 409);
		expect(body.code).toBe("OFFER_NO_LONGER_PENDING");

		// The DB column is still pending — reconciler hasn't run, but the
		// withdraw lib correctly treats expiresAt-past as terminal.
		const row = await prisma.offer.findUniqueOrThrow({
			where: { id: offerId },
		});
		expect(row.state).toBe(OfferState.pending);
	});
});
