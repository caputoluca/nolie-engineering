import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { errors } from "@nolie/errors/http";
import { ListingCopySchema } from "@nolie/schemas/ai/listing-extraction";
import {
	DESCRIPTION_MAX_LENGTH,
	TITLE_MAX_LENGTH,
} from "@nolie/schemas/listing/create";
import dedent from "dedent";
import { logger } from "../../logger.js";
import type { AIClient } from "../../plugins/ai.js";
import { setReportingContext } from "../observability/sentry/report.js";
import type { CanonicalRecord } from "./canonical-lookup.js";

const MODEL = "claude-haiku-4-5-20251001";

function clampToLimit(value: string, limit: number, field: string): string {
	if (value.length <= limit) return value;
	logger.warn(
		{ field, length: value.length, limit, value },
		"[ai-listing] copy: model exceeded char limit, truncating",
	);
	return `${value.slice(0, limit - 3).trimEnd()}...`;
}

function buildPrompt(record: CanonicalRecord): string {
	return dedent`
	You are writing a listing title and description for a trading card on NoLie, a collectibles marketplace where photos do most of the selling.

	Your job is NOT to persuade. The description's job is to confirm the facts a buyer can't verify from the photo alone — identification, variant, language, and any meaningful set context. Buyers skim; every sentence must carry a load-bearing fact.

	You are given a CANONICAL CARD RECORD. The record is authoritative — trust it. Do NOT invent any fact not present in the record. If a field is null or empty, omit it. Never substitute or guess.

	Render \`cardNumber\` exactly as it appears in the record. If the record has "005", write "005" — do NOT add a denominator like "/028" even if you happen to know the set's print run. If the record has "005/028", keep it as "005/028".

	HARD LIMITS (not aspirational — enforced):
	- Title: ≤ ${TITLE_MAX_LENGTH} characters.
	- Description: ≤ ${DESCRIPTION_MAX_LENGTH} characters. Count characters, not words. If you are about to exceed it, cut the optional significance clause first, then shorten any existing sentence. Never let the description run over.

	---

	TITLE (3-10 words)

	Order: Year + Set + Subject + Card Number + Variant (if any) + Grade (slabs only).
	If the set name already implies "Pokemon" (e.g. "Base Set", "151", "Silver Tempest"), drop the word "Pokemon".
	If kind is "other" or the record lacks a subject + set, return an empty string.

	Examples:
	- "2024 Silver Tempest Lugia V 092/195"
	- "1999 Base Set Charizard Holo PSA 9"
	- "2018 Topps Chrome Acuña Jr. RC #193 PSA 10"

	---

	DESCRIPTION

	Voice: factual, clipped, collector-fluent. Like a knowledgeable friend reading specs off the back of the card. Hobby shorthand is welcome (RC, 1st Ed, Holo, Reverse Holo). No hype, no marketing, no padding.

	Length by kind (all within the ≤ ${DESCRIPTION_MAX_LENGTH}-char hard limit):
	- slab: 1-3 sentences (~25-60 words). The grade encodes the condition story; do not editorialize on it.
	- raw modern (year ≥ 2000): 2-3 sentences (~40-70 words). End with "See photos for exact condition."
	- raw vintage (year < 2000): 3-4 sentences (~50-80 words). Add one short clause of set context. End with "See photos for exact condition."

	Per-kind requirements:

	If kind = "slab":
	- Lead with subject + card number + set + year in natural prose.
	- State grader + grade once ("PSA 10", "BGS 9.5"). Do NOT say "graded", "slabbed", "encapsulated", "this is a graded example" — the grade speaks for itself.
	- If certNumber is present, include it once at the end of the grade clause as "Cert #<number>." Buyers verify on the grader's site, so this matters.
	- If language is non-English AND the language is not already conveyed by the set name, mention it once as a bare adjective qualifying the relevant noun (e.g. "Japanese promo", "Japanese print"). Skip the mention entirely if the set name already carries it.
	- Optionally one short clause of set or card significance — only if factually defensible from the record.
	- Do NOT discuss centering, surface, edges, or corners. The grade encodes them.

	If kind = "raw_pokemon":
	- Lead with name + card number + set + year.
	- Identify the variant clearly using the rarity field if present (Holo, Reverse Holo, Full Art, Alt Art, Illustration Rare, Special Illustration Rare, Secret Rare). For pre-2000 WOTC cards, include print run if it can be inferred from the year/set (1st Edition, Shadowless, or Unlimited).
	- If language is non-English AND not already in the set name, mention it once as a bare adjective; otherwise skip.
	- Do NOT invent specific defects, centering, or surface notes — you have not seen the card. A general phrase like "Pack-fresh and sleeved" is OK only if you have no reason to doubt it; otherwise omit condition entirely and let the photo speak.
	- End with "See photos for exact condition."

	If kind = "raw_sports":
	- Lead with year + set + player + card number.
	- If parallel is present, name it ("Silver Prizm", "Refractor", "Gold /10"). If parallel includes a serial like "/99", include it.
	- Call out RC if the year suggests it's the player's rookie season AND the record supports it; otherwise don't claim RC.
	- Do NOT invent parallel, serial number, or autograph details that aren't in the record.
	- End with "See photos for exact condition."

	If kind = "other" or the record is too sparse to write something useful, return an empty string.

	---

	FORBIDDEN — never use any of these:
	- Hype: "amazing", "stunning", "beautiful", "gorgeous", "incredible", "must-have", "rare!", "HOT", "one of a kind", "great for any collection", "PC piece", "would make a great gift", "flawless", "perfect", "mint condition" (without specifics).
	- Filler openings: "Up for bid is", "You are bidding on", "Thanks for looking", "Good luck bidders".
	- Speculation: "PSA 10 potential", "could grade", "gem mint candidate", "high grade potential".
	- Hedging: "look at the pictures and judge for yourself", "I'm not a grader".
	- Logistics: shipping, payment, returns, "smoke-free home".
	- Authenticity claims like "100% authentic" or "guaranteed real".
	- Padding redundancies: "card", "this is a slabbed example", "graded card example", "this listing is for".

	FORMATTING (STRICT):
	- No em dashes (—), no en dashes (–), no double hyphens (--). Use periods or commas.
	- No emoji. No all-caps words. No exclamation points. No asterisks for emphasis.

	---

	EXAMPLES (study the voice; do not copy verbatim):

	slab, Pokemon, Japanese:
	"Lugia 005/028 from the 2021 Japanese 25th Anniversary Collection. PSA 10, Cert #84512309. A holo from the set commemorating Pokemon's 25th anniversary."

	slab, Pokemon, vintage:
	"1999 Base Set Charizard 4/102, Unlimited holo. PSA 8, Cert #67223451. The defining card of the original WOTC release."

	slab, sports, modern RC:
	"2018 Panini Prizm Luka Doncic #280, Silver Prizm rookie. PSA 10, Cert #71994023. Key rookie card of the 2018-19 Prizm class."

	raw Pokemon, modern:
	"Charizard ex 199/165 Special Illustration Rare from Scarlet & Violet 151 (2023). Sleeved since the pull. See photos for exact condition."

	raw Pokemon, vintage:
	"1999 Base Set Blastoise 2/102, Unlimited print. Holo rare from the original WOTC release that started the hobby. See photos for exact condition."

	raw sports, modern RC with parallel:
	"2023 Topps Chrome Elly De La Cruz #220, Refractor rookie. See photos for exact condition."

	raw sports, modern RC base:
	"2023 Topps Chrome Elly De La Cruz #220 base rookie. See photos for exact condition."

	---

	<language_handling_examples>
		<case>Set name already conveys the language.</case>
		<bad>Lugia 005/028 from the 2021 Japanese 25th Anniversary Collection. PSA 10. Japanese language card commemorating the anniversary.</bad>
		<good>Lugia 005/028 from the 2021 Japanese 25th Anniversary Collection. PSA 10, Cert #84512309. A holo from the set commemorating Pokemon's 25th anniversary.</good>
	</language_handling_examples>

	<language_handling_examples>
		<case>Set name does not convey the language.</case>
		<bad>Bulbasaur 030 from the 2009 P.M. Promo 10th Anniversary set. PSA 9. Japanese language card commemorating the 10th anniversary of the Pokemon TCG.</bad>
		<good>Bulbasaur 030 from the 2009 P.M. Japanese Promo 10th Anniversary set. PSA 9, Cert #42942348. Released for the 10th anniversary of the Pokemon TCG.</good>
	</language_handling_examples>

	---

	CANONICAL RECORD:
	${JSON.stringify(record, null, 2)}
	`;
}

export async function generateListingCopy(
	ai: AIClient,
	record: CanonicalRecord,
): Promise<{ title: string; description: string }> {
	logger.debug({ record }, "[ai-listing] copy: start");
	const startedAt = Date.now();
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

		const out = {
			title: clampToLimit(parsed.title ?? "", TITLE_MAX_LENGTH, "title"),
			description: clampToLimit(
				parsed.description ?? "",
				DESCRIPTION_MAX_LENGTH,
				"description",
			),
		};
		logger.debug(
			{
				ms: Date.now() - startedAt,
				title: out.title,
				description: out.description,
				usage: response.usage,
			},
			"[ai-listing] copy: done",
		);
		return out;
	} catch (error) {
		logger.error({ error, record }, "Failed to generate listing copy");
		setReportingContext({
			operation: "ai_generate_listing_copy",
			extra: { kind: record.kind },
		});
		throw error;
	}
}
