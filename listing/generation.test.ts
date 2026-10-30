/**
 * Integration tests for NL-349 — AI generation log + category linkage.
 *
 * The AI prediction is logged server-side at /generate (here seeded via the
 * real `recordListingGeneration`); `POST /listings` echoes the `generationId`
 * and the server joins the seller's confirmed category onto it. Verifies:
 * - A confirmed category lands on the listing and links the generation (delta is
 *   derived: predicted === final → not corrected).
 * - A seller override links with predicted !== final (a correction).
 * - An AI abstain with no seller pick links with a null category.
 * - A generation only links for its OWNER — another user can't poison it.
 * - The `Category` table is seeded from the code constant (drift guard).
 */

import { prisma } from "@nolie/db";
import type { ExtractedCardFacts } from "@nolie/schemas/ai/listing-extraction";
import { CATEGORIES } from "@nolie/schemas/listing/categories";
import { describe, expect, it } from "vitest";
import { EXTRACTION_MODEL } from "../../../app/lib/ai/listing-extraction.js";
import { recordListingGeneration } from "../../../app/lib/listings/generation.js";
import {
	assertResponse,
	createApiClient,
	createListing,
	createTestSellerUser,
} from "../../helpers/index.js";

/** A raw Pokémon single the model classified as `pokemon`. */
const POKEMON_FACTS: ExtractedCardFacts = {
	kind: "raw_pokemon",
	confidence: 0.82,
	fields: {
		name: "Pikachu",
		cardNumber: "058/102",
		setHint: "Base Set",
		year: "1999",
		apparentRarity: "Common",
		language: "EN",
	},
	game: "Pokemon",
	category: "pokemon",
};

/** The model couldn't identify the item — abstained on category. */
const ABSTAIN_FACTS: ExtractedCardFacts = {
	kind: "other",
	confidence: 0.1,
	fields: {},
	game: "",
	category: "unknown",
};

/** Seed a server-side generation row the way /generate would. Returns its id. */
async function seedGeneration(userId: string, facts: ExtractedCardFacts) {
	const id = await recordListingGeneration({
		db: prisma,
		userId,
		sessionId: "test-session",
		photoKeys: ["test-hero-image.jpg"],
		facts,
		canonical: {
			kind: facts.kind,
			year: null,
			setName: null,
			subject: null,
			cardNumber: null,
			grader: null,
			grade: null,
			rarity: null,
			parallel: null,
			language: null,
		},
		canonicalSource: "ai_guess",
		title: "Pikachu Base Set",
		description: "A great test item available for immediate purchase",
	});
	if (!id) throw new Error("seedGeneration: generation row was not written");
	return id;
}

function binData(overrides?: Record<string, unknown>) {
	return {
		listingType: "fixed_price" as const,
		title: "Pikachu Base Set",
		description: "A great test item available for immediate purchase",
		price: 50,
		assets: [
			{ key: "test-bin-hero.jpg", role: "hero" as const },
			{ key: "test-bin-back.jpg", role: "gallery" as const },
		],
		shipping: { preset: "standard_card" },
		...overrides,
	};
}

describe("listing generation log + category linkage (NL-349)", () => {
	it("lands a confirmed category and links the generation (no correction)", async () => {
		// Arrange
		const seller = await createTestSellerUser({ onboarded: true });
		const api = createApiClient(seller);
		const generationId = await seedGeneration(seller.user.id, POKEMON_FACTS);

		// Act — seller confirms the AI's prediction (categoryId === predicted)
		const response = await createListing(
			api,
			binData({ generationId, categoryId: "pokemon" }),
		);
		const { id } = await assertResponse<{ id: string; slug: string }>(
			response,
			201,
		);

		// Assert — category on the listing
		const listing = await prisma.listing.findUniqueOrThrow({
			where: { id },
			select: { categoryId: true },
		});
		expect(listing.categoryId).toBe("pokemon");

		// Assert — generation linked, label joined, facts + game hedge intact
		const generation = await prisma.listingGeneration.findUniqueOrThrow({
			where: { id: generationId },
		});
		expect(generation).toMatchObject({
			listingId: id,
			predictedCategory: "pokemon",
			sellerFinalCategory: "pokemon",
			modelId: EXTRACTION_MODEL,
		});
		// Derived delta: predicted === final → not corrected.
		expect(generation.predictedCategory).toBe(generation.sellerFinalCategory);
		expect(generation.facts).toEqual(POKEMON_FACTS);
		expect((generation.facts as { game: string }).game).toBe("Pokemon");
	});

	it("links with a correction when the seller overrides the AI category", async () => {
		// Arrange
		const seller = await createTestSellerUser({ onboarded: true });
		const api = createApiClient(seller);
		const generationId = await seedGeneration(seller.user.id, POKEMON_FACTS);

		// Act — AI said pokemon, seller picked magic
		const response = await createListing(
			api,
			binData({ generationId, categoryId: "magic" }),
		);
		const { id } = await assertResponse<{ id: string; slug: string }>(
			response,
			201,
		);

		// Assert
		const listing = await prisma.listing.findUniqueOrThrow({
			where: { id },
			select: { categoryId: true },
		});
		expect(listing.categoryId).toBe("magic");

		const generation = await prisma.listingGeneration.findUniqueOrThrow({
			where: { id: generationId },
		});
		expect(generation.predictedCategory).toBe("pokemon");
		expect(generation.sellerFinalCategory).toBe("magic");
		// Derived delta: predicted !== final → corrected.
		expect(generation.predictedCategory).not.toBe(
			generation.sellerFinalCategory,
		);
	});

	it("links an AI abstain with a null category when the seller doesn't pick", async () => {
		// Arrange
		const seller = await createTestSellerUser({ onboarded: true });
		const api = createApiClient(seller);
		const generationId = await seedGeneration(seller.user.id, ABSTAIN_FACTS);

		// Act
		const response = await createListing(api, binData({ generationId }));
		const { id } = await assertResponse<{ id: string; slug: string }>(
			response,
			201,
		);

		// Assert — null category on both sides
		const listing = await prisma.listing.findUniqueOrThrow({
			where: { id },
			select: { categoryId: true },
		});
		expect(listing.categoryId).toBeNull();

		const generation = await prisma.listingGeneration.findUniqueOrThrow({
			where: { id: generationId },
		});
		expect(generation).toMatchObject({
			listingId: id,
			predictedCategory: null,
			sellerFinalCategory: null,
		});
	});

	it("only links a generation for its owner — a different user can't poison it", async () => {
		// Arrange — sellerA owns the generation
		const sellerA = await createTestSellerUser({ onboarded: true });
		const generationId = await seedGeneration(sellerA.user.id, POKEMON_FACTS);

		// Act — sellerB tries to create a listing referencing A's generation
		const sellerB = await createTestSellerUser({ onboarded: true });
		const apiB = createApiClient(sellerB);
		const response = await createListing(
			apiB,
			binData({ generationId, categoryId: "magic" }),
		);
		const { id } = await assertResponse<{ id: string; slug: string }>(
			response,
			201,
		);

		// Assert — B's own listing still gets B's category...
		const listing = await prisma.listing.findUniqueOrThrow({
			where: { id },
			select: { categoryId: true },
		});
		expect(listing.categoryId).toBe("magic");

		// ...but A's generation is untouched (the userId filter blocked the link).
		const generation = await prisma.listingGeneration.findUniqueOrThrow({
			where: { id: generationId },
		});
		expect(generation.listingId).toBeNull();
		expect(generation.sellerFinalCategory).toBeNull();
	});

	it("links a generation once — a second listing from the same id can't relink it", async () => {
		// The `listingId: null` guard on the link's updateMany is what makes it
		// idempotent (re-roll, double-submit, or a stale generationId reused on a
		// later listing). The first listing wins; a second create echoing the same
		// generationId must not re-point the label.
		// Arrange
		const seller = await createTestSellerUser({ onboarded: true });
		const api = createApiClient(seller);
		const generationId = await seedGeneration(seller.user.id, POKEMON_FACTS);

		// Act — listing A claims the generation, listing B reuses the same id
		const responseA = await createListing(
			api,
			binData({ generationId, categoryId: "pokemon" }),
		);
		const { id: listingA } = await assertResponse<{ id: string }>(
			responseA,
			201,
		);
		const responseB = await createListing(
			api,
			binData({ generationId, categoryId: "magic" }),
		);
		const { id: listingB } = await assertResponse<{ id: string }>(
			responseB,
			201,
		);

		// Assert — B is a valid listing with its own category...
		expect(listingB).not.toBe(listingA);
		const bRow = await prisma.listing.findUniqueOrThrow({
			where: { id: listingB },
			select: { categoryId: true },
		});
		expect(bRow.categoryId).toBe("magic");

		// ...but the generation stays linked to A, label unchanged.
		const generation = await prisma.listingGeneration.findUniqueOrThrow({
			where: { id: generationId },
		});
		expect(generation.listingId).toBe(listingA);
		expect(generation.sellerFinalCategory).toBe("pokemon");
	});

	it("seeds the category taxonomy from the code constant", async () => {
		// The migration seed must stay in lockstep with CATEGORIES — every key
		// present, names + order matching, no extra rows. Guards against the AI
		// predicting a key with no Category row to map to (FK failure).
		const categories = await prisma.category.findMany({
			orderBy: { sortOrder: "asc" },
		});

		expect(categories).toHaveLength(CATEGORIES.length);
		const byId = new Map(categories.map((c) => [c.id, c]));
		for (const expected of CATEGORIES) {
			const row = byId.get(expected.key);
			expect(row, `category "${expected.key}" should be seeded`).toBeDefined();
			expect(row).toMatchObject({
				displayName: expected.displayName,
				sortOrder: expected.sortOrder,
				active: true,
			});
		}
	});
});
