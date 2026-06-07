import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { S3Client } from "@aws-sdk/client-s3";
import { errors } from "@nolie/errors/http";
import {
	type ExtractedCardFacts,
	ExtractedCardFactsSchema,
} from "@nolie/schemas/ai/listing-extraction";
import { Upload } from "@nolie/schemas/upload";
import dedent from "dedent";
import { logger } from "../../logger.js";
import type { AIClient } from "../../plugins/ai.js";
import { getBucket, getFolder, getPresignedReadURL } from "../uploads.js";

const KEY_PREFIX = `${getFolder(Upload.auctionAsset)}/`;

export const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

// Versioned provenance (NL-349): bump when the prompt or the structured-output
// schema changes so a recorded `ListingAiExtraction` row can be reproduced /
// evaluated against the exact extraction code that produced it.
export const EXTRACTION_PROMPT_VERSION = 1;
export const EXTRACTION_SCHEMA_VERSION = 1;

const PROMPT = dedent`
You are extracting structured identifiers from a photo of a collectible card.
You will NOT describe the card or write any copy. Only extract what is printed
on the card or printed on the slab label.

First, classify the card:
- "slab" if the card is encapsulated in a graded plastic slab (PSA, BGS, CGC, TAG, SGC).
- "raw_pokemon" if it is a raw (ungraded) Pokemon card (any language). Signals: HP value top-right, energy symbols, weakness/resistance bar, set symbol bottom-right.
- "raw_sports" if it is a raw sports card (baseball, basketball, football, hockey, soccer).
- "raw_tcg_other" if it is a raw TCG single from Magic: The Gathering, Yu-Gi-Oh!, Lorcana, One Piece, Digimon, or Flesh & Blood. Signals: mana symbols, attribute icons (LIGHT/DARK), ink cost, life value.
- "other" for anything else, including sealed product (booster boxes, ETBs, packs) of any game, accessories, comics, and non-cards.

If any Pokemon signal is present (HP value, energy symbol, weakness/resistance bar), classify as "raw_pokemon", never "raw_tcg_other". Sealed product is always "other", never "raw_tcg_other".

For each kind, extract the fields described in the schema. Set a string field
to an empty string ("") if it is not clearly visible. Set the grader and
language enums to "UNKNOWN" if you can't tell. Use "OTHER" only if you CAN
tell but the value isn't in the listed options (e.g. a non-major grader, a
non-CJK language). Do NOT guess. Do NOT use prior knowledge of what a card
"should" say — only what you can see in the photo.

Return a confidence score 0-1 reflecting your overall extraction confidence.
Below 0.5, prefer null fields over guesses.

Card number rules (apply to slabs, raw Pokemon, and raw sports):
- The card number is printed in small text near the bottom-left or bottom-right
  corner of the card itself. This is the most important field for lookup.
- For slabs, read the card number off the encapsulated card itself, not just
  the slab label. Graders sometimes abbreviate the number on the label.
- If the printed number includes a denominator (e.g. "005/028", "092/119",
  "199/165"), capture the FULL string with the slash and denominator. Never
  strip the denominator. "005/028" is correct; "005" alone is wrong when the
  card prints the denominator.
- If no denominator is printed (some sports cards just show "#193"), capture
  what is visible.

For slabs: the cert number is the alphanumeric ID printed on the slab label.
The grader (PSA, BGS, CGC, TAG, SGC) is identified by the manufacturer's logo
and label style. Cert layout varies by grader:

- PSA: cert is on the front label, at the bottom right.
- BGS / CGC / SGC: cert is somewhere on the front-facing main label (exact
  position varies by era and product line).
- TAG: cert is printed rotated 90° along the SIDE edge of the slab and reads
  bottom-to-top. It is NOT on the front-facing label. The format is one
  letter followed by seven digits (e.g. "A1234567"). If the side edge is not
  visible in the photos, set certNumber to "" — do not invent one.

For ANY grader: if you cannot read the cert digits with confidence from the
photos, set certNumber to "". Confabulating a plausible-looking cert is
worse than returning "" — buyers verify cert numbers on the grader's site,
so a wrong cert leads to a refund and a lost-trust review.

Use ISO 639-1 codes for language: "EN" (English), "JA" (Japanese), "KO" (Korean),
"ZH" (Chinese, simplified or traditional), or "OTHER".

<cert_extraction_examples>
	<case>TAG slab, side edge visible — read the rotated cert.</case>
	<good>certNumber: "A1234567"</good>
</cert_extraction_examples>

<cert_extraction_examples>
	<case>TAG slab, only front of slab in the photos (cert side not shown).</case>
	<bad>certNumber: "A9876543"  (invented from priors)</bad>
	<good>certNumber: ""</good>
</cert_extraction_examples>

<cert_extraction_examples>
	<case>Any slab, cert region blurry or partially obscured.</case>
	<bad>certNumber: "12345678"  (best-guess fabrication)</bad>
	<good>certNumber: ""</good>
</cert_extraction_examples>

---

Finally, classify the item's GAME and buyer-facing CATEGORY. This is separate
from everything above and must not change any field you already extracted.

game: the franchise as printed or recognizable — "Pokemon", "Magic: The
Gathering", "One Piece", "Yu-Gi-Oh!", "Disney Lorcana", "Dragon Ball", and so
on. Report it even for sealed product, accessories, or art. Use "" only if you
genuinely cannot tell.

category: apply the FIRST rule that matches, top to bottom, then stop:
1. A sealed / unopened product of any game (booster box, ETB, booster pack,
   sealed tin) -> "sealed"
2. An accessory (card sleeves, playmat, deck box, binder, toploader) -> "accessories"
3. A standalone print, poster, or piece of artwork that is NOT a playable
   card -> "art"
4. A single playable card, raw or graded -> its game: "pokemon", "magic",
   "onepiece", "yugioh", "lorcana", or "dragonball"
5. The item or its game cannot be identified -> "unknown"

Rules that prevent the common mistakes:
- Alt-art, full-art, special-illustration, and illustration-rare cards are
  still CARDS. Classify them by game (rule 4). NEVER "art".
- "art" is only for items that are not cards at all (a framed print, an
  artist's poster). If you can see card text, HP, mana, or a card number, it is
  a card, not art.
- A graded slab is still a single card -> classify by the game inside the slab.
- A game not listed in rule 4 (Digimon, Flesh & Blood, a sports card) has no
  category here: set category to "unknown" but still report what you can in game.
- category is independent of kind: a sealed box is kind "other" but category
  "sealed"; a slab is kind "slab" but category is its game.

<category_examples>
	<example>
		<item>Raw Charizard single, Pokemon</item>
		<game>Pokemon</game>
		<category>pokemon</category>
	</example>
	<example>
		<item>Pokemon Elite Trainer Box, shrink-wrapped</item>
		<game>Pokemon</game>
		<category>sealed</category>
		<why>Rule 1 — a sealed product wins over the game.</why>
	</example>
	<example>
		<item>Umbreon VMAX alternate-art card</item>
		<game>Pokemon</game>
		<category>pokemon</category>
		<why>An alt-art CARD is a card. Rule 4, never "art".</why>
	</example>
	<example>
		<item>One Piece TCG playmat</item>
		<game>One Piece</game>
		<category>accessories</category>
	</example>
	<example>
		<item>Raw Magic: The Gathering dual-land single</item>
		<game>Magic: The Gathering</game>
		<category>magic</category>
	</example>
	<example>
		<item>Unlabeled mixed lot, item unclear from the photo</item>
		<game></game>
		<category>unknown</category>
	</example>
</category_examples>
`;

export async function extractCardFacts({
	ai,
	storage,
	imageKeys,
}: {
	ai: AIClient;
	storage: S3Client;
	imageKeys: string[];
}): Promise<ExtractedCardFacts> {
	if (imageKeys.some((k) => !k.startsWith(KEY_PREFIX))) {
		throw errors.badRequest("imageKeys must reference auction assets", {
			code: "INVALID_IMAGE_KEY",
		});
	}

	const bucket = getBucket(Upload.auctionAsset);
	const imageUrls = await Promise.all(
		imageKeys.map((key) => getPresignedReadURL({ storage, bucket, key })),
	);
	logger.debug(
		{ imageCount: imageKeys.length, imageKeys },
		"[ai-listing] extract: start",
	);
	const imageBlocks = imageUrls.map(
		(url) =>
			({
				type: "image",
				source: { type: "url", url },
			}) as const,
	);

	const startedAt = Date.now();
	const response = await ai.claude.messages.parse({
		model: EXTRACTION_MODEL,
		max_tokens: 1024,
		messages: [
			{
				role: "user",
				content: [...imageBlocks, { type: "text", text: PROMPT }],
			},
		],
		output_config: {
			format: zodOutputFormat(ExtractedCardFactsSchema),
		},
	});

	const parsed = response.parsed_output ?? {
		kind: "other" as const,
		confidence: 0,
		fields: {},
		game: "",
		category: "unknown" as const,
	};
	logger.debug(
		{
			ms: Date.now() - startedAt,
			kind: parsed.kind,
			confidence: parsed.confidence,
			fields: parsed.fields,
			usage: response.usage,
		},
		"[ai-listing] extract: done",
	);
	return parsed;
}
