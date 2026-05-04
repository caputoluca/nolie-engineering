import type { ExtractedCardFacts } from "@nolie/schemas/ai/listing-extraction";
import { logger } from "../../logger.js";

export interface CanonicalRecord {
	kind: ExtractedCardFacts["kind"];
	year: string | null;
	setName: string | null;
	subject: string | null;
	cardNumber: string | null;
	grader: string | null;
	grade: string | null;
	rarity: string | null;
	language: string | null;
}

export interface CanonicalLookupResult {
	record: CanonicalRecord;
	canonical: {
		imageUrl: string | null;
		source: "pokemontcg" | "label_ocr" | "ai_guess";
	};
}

interface PokemonTcgCard {
	name: string;
	number: string;
	rarity?: string;
	images?: { small?: string; large?: string };
	set?: { name?: string; releaseDate?: string };
}

const POKEMONTCG_API = "https://api.pokemontcg.io/v2/cards";
const LOOKUP_TIMEOUT_MS = 4000;

function trimLeadingZeros(num: string): string {
	return num.replace(/^0+/, "") || "0";
}

function yearFromReleaseDate(date: string | undefined): string | null {
	if (!date) return null;
	const match = date.match(/^(\d{4})/);
	return match?.[1] ?? null;
}

async function searchPokemonTcg(
	name: string,
	cardNumber: string,
): Promise<PokemonTcgCard | null> {
	const numerator = cardNumber.split("/")[0]?.trim();
	if (!numerator) return null;

	const trimmed = trimLeadingZeros(numerator);
	const q = `name:"${name.replace(/"/g, "")}" number:${trimmed}`;
	const url = `${POKEMONTCG_API}?q=${encodeURIComponent(q)}&pageSize=1`;

	const res = await fetch(url, {
		signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		headers: { accept: "application/json" },
	});

	if (!res.ok) {
		throw new Error(`pokemontcg.io ${res.status}`);
	}

	const body = (await res.json()) as { data?: PokemonTcgCard[] };
	return body.data?.[0] ?? null;
}

export async function lookupCanonical(
	facts: ExtractedCardFacts,
): Promise<CanonicalLookupResult> {
	if (facts.kind === "slab") {
		const f = facts.fields;
		return {
			record: {
				kind: "slab",
				year: f.year,
				setName: f.setName,
				subject: f.subject,
				cardNumber: f.cardNumber,
				grader: f.grader,
				grade: f.grade,
				rarity: null,
				language: f.language,
			},
			canonical: { imageUrl: null, source: "label_ocr" },
		};
	}

	if (facts.kind === "raw_sports") {
		const f = facts.fields;
		return {
			record: {
				kind: "raw_sports",
				year: f.year,
				setName: f.setName,
				subject: f.player,
				cardNumber: f.cardNumber,
				grader: null,
				grade: null,
				rarity: null,
				language: null,
			},
			canonical: { imageUrl: null, source: "ai_guess" },
		};
	}

	if (facts.kind === "other") {
		return {
			record: {
				kind: "other",
				year: null,
				setName: null,
				subject: null,
				cardNumber: null,
				grader: null,
				grade: null,
				rarity: null,
				language: null,
			},
			canonical: { imageUrl: null, source: "ai_guess" },
		};
	}

	const f = facts.fields;
	const fallback: CanonicalLookupResult = {
		record: {
			kind: "raw_pokemon",
			year: f.year,
			setName: f.setHint,
			subject: f.name,
			cardNumber: f.cardNumber,
			grader: null,
			grade: null,
			rarity: f.apparentRarity,
			language: f.language,
		},
		canonical: { imageUrl: null, source: "ai_guess" },
	};

	if (!f.name || !f.cardNumber) {
		return fallback;
	}

	try {
		const match = await searchPokemonTcg(f.name, f.cardNumber);
		if (!match) return fallback;

		return {
			record: {
				kind: "raw_pokemon",
				year: yearFromReleaseDate(match.set?.releaseDate) ?? f.year,
				setName: match.set?.name ?? f.setHint,
				subject: match.name,
				cardNumber: match.number,
				grader: null,
				grade: null,
				rarity: match.rarity ?? f.apparentRarity,
				language: f.language,
			},
			canonical: {
				imageUrl: match.images?.large ?? match.images?.small ?? null,
				source: "pokemontcg",
			},
		};
	} catch (err) {
		logger.warn(
			{ err, name: f.name, cardNumber: f.cardNumber },
			"pokemontcg.io lookup failed, falling back to AI guess",
		);
		return fallback;
	}
}
