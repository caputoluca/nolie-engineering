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

const MODEL = "claude-haiku-4-5-20251001";

const PROMPT = dedent`
You are extracting structured identifiers from a photo of a collectible card.
You will NOT describe the card or write any copy. Only extract what is printed
on the card or printed on the slab label.

First, classify the card:
- "slab" if the card is encapsulated in a graded plastic slab (PSA, BGS, CGC, TAG, SGC).
- "raw_pokemon" if it is a raw (ungraded) Pokemon card (any language).
- "raw_sports" if it is a raw sports card (baseball, basketball, football, hockey, soccer).
- "other" if it is anything else (sealed product, comic, unknown).

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

For slabs: the cert number is the long numeric ID printed on the label, usually
below or near the grade. The grader (PSA, BGS, CGC, TAG, SGC) is identified by
the slab manufacturer's logo and label style.

Use ISO 639-1 codes for language: "EN" (English), "JA" (Japanese), "KO" (Korean),
"ZH" (Chinese, simplified or traditional), or "OTHER".
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
		model: MODEL,
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
