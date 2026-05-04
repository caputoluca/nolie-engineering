import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
	type ExtractedCardFacts,
	ExtractedCardFactsSchema,
} from "@nolie/schemas/ai/listing-extraction";
import dedent from "dedent";
import type { AIClient } from "../../plugins/ai.js";
import { getPublicURL } from "../uploads.js";

const MODEL = "claude-sonnet-4-6";

const PROMPT = dedent`
You are extracting structured identifiers from a photo of a collectible card.
You will NOT describe the card or write any copy. Only extract what is printed
on the card or printed on the slab label.

First, classify the card:
- "slab" if the card is encapsulated in a graded plastic slab (PSA, BGS, CGC, TAG, SGC).
- "raw_pokemon" if it is a raw (ungraded) Pokemon card (any language).
- "raw_sports" if it is a raw sports card (baseball, basketball, football, hockey, soccer).
- "other" if it is anything else (sealed product, comic, unknown).

For each kind, extract the fields described in the schema. Set a field to
null if it is not clearly visible. Do NOT guess. Do NOT use prior knowledge of
what a card "should" say — only what you can see in the photo.

Return a confidence score 0-1 reflecting your overall extraction confidence.
Below 0.5, prefer null fields over guesses.

For Pokemon raw cards: the card number ("092/119" style) is usually printed in
small text near the bottom-left or bottom-right corner of the card. This is the
most important field for canonical lookup — find it if possible.

For slabs: the cert number is the long numeric ID printed on the label, usually
below or near the grade. The grader (PSA, BGS, CGC, TAG, SGC) is identified by
the slab manufacturer's logo and label style.

Use ISO 639-1 codes for language: "EN" (English), "JA" (Japanese), "KO" (Korean),
"ZH" (Chinese, simplified or traditional), or "OTHER".
`;

export async function extractCardFacts({
	ai,
	imageKey,
}: {
	ai: AIClient;
	imageKey: string;
}): Promise<ExtractedCardFacts> {
	const imageUrl = getPublicURL(imageKey);

	const response = await ai.claude.messages.parse({
		model: MODEL,
		max_tokens: 1024,
		messages: [
			{
				role: "user",
				content: [
					{ type: "image", source: { type: "url", url: imageUrl } },
					{ type: "text", text: PROMPT },
				],
			},
		],
		output_config: {
			format: zodOutputFormat(ExtractedCardFactsSchema),
		},
	});

	return (
		response.parsed_output ?? {
			kind: "other",
			confidence: 0,
			fields: {},
		}
	);
}
