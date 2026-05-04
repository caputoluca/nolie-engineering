import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { errors } from "@nolie/errors/http";
import { ListingCopySchema } from "@nolie/schemas/ai/listing-extraction";
import dedent from "dedent";
import { logger } from "../../logger.js";
import type { AIClient } from "../../plugins/ai.js";
import { setReportingContext } from "../observability/sentry/report.js";
import type { CanonicalRecord } from "./canonical-lookup.js";

const MODEL = "claude-sonnet-4-6";

function buildPrompt(record: CanonicalRecord): string {
	return dedent`
	You are writing a listing title and description for a trading card on NoLie, a collectibles marketplace.

	You are given a CANONICAL CARD RECORD. The record is authoritative — trust it.
	Do NOT invent any fact not present in the record.
	If a field is null or missing, omit it. Never substitute or guess.

	---

	TITLE (3-10 words)

	Order: Year + Set + Subject + Card Number + Variant (if any) + Grade (if slab).
	Examples:
	- "2024 Pokemon Silver Tempest Lugia V 092/195"
	- "1999 Pokemon Base Set Charizard Holo PSA 9"
	- "2018 Topps Chrome Acuña Jr. RC #193"

	If the kind is "slab", end the title with the grader and grade (e.g. "PSA 9", "BGS 9.5", "CGC 10").
	If the kind is "other" or the record is too sparse to form a confident title, return an empty string for title.

	DESCRIPTION (2-4 sentences)

	- Lead with what the buyer is getting (year, set, subject, card number, condition or grade).
	- Note language if non-English (e.g. "Japanese", "Korean", "Chinese").
	- Plain, factual prose.
	- Do NOT add hype, urgency, or sales language.
	- Do NOT mention shipping, payment, returns, or platform mechanics.
	- Do NOT invent details not in the record.
	- If the record is too sparse to write a useful description, return an empty string.

	FORMATTING (STRICT)
	- No em dashes (—), no en dashes (–), no double hyphens (--).
	- Use periods or commas instead.
	- No emojis.

	---

	CANONICAL RECORD:
	${JSON.stringify(record, null, 2)}
	`;
}

export async function generateListingCopy(
	ai: AIClient,
	record: CanonicalRecord,
): Promise<{ title: string; description: string }> {
	try {
		const response = await ai.claude.messages.parse({
			model: MODEL,
			max_tokens: 512,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: buildPrompt(record) }],
				},
			],
			output_config: {
				format: zodOutputFormat(ListingCopySchema),
			},
		});

		const parsed = response.parsed_output;
		if (!parsed) {
			logger.error({ record, response }, "No parsed output returned from AI");
			throw errors.serviceUnavailable(
				"AI generation temporarily unavailable. Please try again.",
			);
		}

		return {
			title: parsed.title || "",
			description: parsed.description || "",
		};
	} catch (error) {
		logger.error({ error, record }, "Failed to generate listing copy");
		setReportingContext({
			operation: "ai_generate_listing_copy",
			extra: { kind: record.kind },
		});
		throw error;
	}
}
