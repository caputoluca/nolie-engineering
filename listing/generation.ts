/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 *
 * Left out of this folder:
 * - CATEGORY_ABSTAIN: "unknown", the model's answer when it can't tell an
 *   item's category.
 * Everything else is plumbing: database types, logging, Sentry.
 */

import type { Prisma, PrismaClient } from "@nolie/db";
import { CATEGORY_ABSTAIN } from "@nolie/schemas/ai/categories";
import type {
	CanonicalSource,
	ExtractedCardFacts,
} from "@nolie/schemas/ai/listing-extraction";
import { logger } from "../../logger.js";
import type { CanonicalRecord } from "../ai/canonical-lookup.js";
import {
	EXTRACTION_MODEL,
	EXTRACTION_PROMPT_VERSION,
	EXTRACTION_SCHEMA_VERSION,
} from "../ai/listing-extraction.js";
import { reportError } from "../observability/sentry/report.js";

/** "unknown" abstain collapses to null so the predicted-vs-final delta reads cleanly. */
function toPredictedCategory(facts: ExtractedCardFacts): string | null {
	return facts.category === CATEGORY_ABSTAIN ? null : facts.category;
}

interface RecordListingGenerationInput {
	db: PrismaClient;
	/** The authenticated user who ran /generate. */
	userId: string;
	/** Wizard session id — groups re-rolls; null if the client didn't send one. */
	sessionId: string | null;
	photoKeys: string[];
	facts: ExtractedCardFacts;
	canonical: CanonicalRecord;
	canonicalSource: CanonicalSource;
	title: string;
	description: string;
}

/**
 * Log one AI generation server-side at /generate (NL-349) — the prediction half
 * of a prediction-log + delayed-label-join corpus. Writing it here (not at
 * create) is what keeps the training signal trustworthy: the raw facts and the
 * predicted category can't be tampered with by the client, and every generation
 * — including abandoned/re-rolled ones — is captured.
 *
 * Best-effort: returns the new row's id, or null on failure. A failed log must
 * never break the wizard; the seller just creates a listing without provenance.
 */
export async function recordListingGeneration(
	input: RecordListingGenerationInput,
): Promise<string | null> {
	const { db, userId, sessionId, photoKeys, facts, canonical } = input;
	try {
		const generation = await db.listingGeneration.create({
			data: {
				userId,
				sessionId,
				photoKeys,
				modelId: EXTRACTION_MODEL,
				promptVersion: EXTRACTION_PROMPT_VERSION,
				schemaVersion: EXTRACTION_SCHEMA_VERSION,
				confidence: facts.confidence,
				facts: facts as Prisma.InputJsonValue,
				canonical: canonical as unknown as Prisma.InputJsonValue,
				canonicalSource: input.canonicalSource,
				predictedCategory: toPredictedCategory(facts),
				suggestedTitle: input.title || null,
				suggestedDescription: input.description || null,
			},
			select: { id: true },
		});
		return generation.id;
	} catch (error) {
		logger.error({ error, userId }, "Failed to record listing generation");
		reportError(error, {
			operation: "listing_generation_record",
			extra: { userId },
		});
		return null;
	}
}

interface LinkGenerationToListingInput {
	db: PrismaClient;
	generationId: string;
	/** Must match the generation's userId — a generation only links for its owner. */
	userId: string;
	listingId: string;
	/** The seller-confirmed category on the listing (`data.categoryId`), or null. */
	finalCategory: string | null;
}

/**
 * Join the seller's confirmed category onto a logged generation when a listing
 * is created from it (NL-349). The correction delta is NOT stored — it's derived
 * from the SERVER-stored `predictedCategory` vs `sellerFinalCategory`, so the
 * client can't poison the training signal.
 *
 * One ownership-filtered `updateMany` (no prior read): the `userId` predicate
 * enforces that a generation only links for its owner, and `listingId: null`
 * makes it idempotent (an already-linked or foreign generation simply matches
 * nothing). Best-effort — a no-match or a write error is logged, never thrown,
 * so it can't block listing creation.
 */
export async function linkGenerationToListing(
	input: LinkGenerationToListingInput,
): Promise<void> {
	const { db, generationId, userId, listingId, finalCategory } = input;
	try {
		const { count } = await db.listingGeneration.updateMany({
			where: { id: generationId, userId, listingId: null },
			data: { listingId, sellerFinalCategory: finalCategory },
		});
		if (count === 0) {
			logger.warn(
				{ generationId, userId, listingId },
				"Generation not linked: unknown id, not the caller's, or already linked",
			);
		}
	} catch (error) {
		logger.error(
			{ error, generationId, listingId },
			"Failed to link generation to listing",
		);
		reportError(error, {
			operation: "listing_generation_link",
			extra: { generationId, listingId },
		});
	}
}
