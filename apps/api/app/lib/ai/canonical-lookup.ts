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
	certNumber: string | null;
	rarity: string | null;
	parallel: string | null;
	language: string | null;
}

export interface CanonicalLookupResult {
	record: CanonicalRecord;
	canonical: {
		imageUrl: string | null;
		source: "tcgdex" | "label_ocr" | "ai_guess";
	};
}

interface TcgdexBriefCard {
	id: string;
	localId: string;
	name: string;
}

interface TcgdexCardDetail {
	id: string;
	name: string;
	localId: string;
	image?: string;
	rarity?: string;
	set: {
		id: string;
		name: string;
		cardCount?: { official?: number; total?: number };
	};
}

const TCGDEX_API = "https://api.tcgdex.net/v2";
const LOOKUP_TIMEOUT_MS = 4000;

// Map our extractor's language enum to TCGdex's path segment. Our enum carries
// only `ZH` (we can't tell simplified vs traditional from a photo); `zh-tw` has
// broader Pokemon TCG coverage on TCGdex than `zh-cn`, so default there. OTHER
// and UNKNOWN fall back to `en` — most cards are English; on a miss the lookup
// returns null and we drop to the unverified path.
const TCGDEX_LANG_BY_ENUM: Record<string, string> = {
	EN: "en",
	JA: "ja",
	KO: "ko",
	ZH: "zh-tw",
	OTHER: "en",
	UNKNOWN: "en",
};

function trimLeadingZeros(num: string): string {
	return num.replace(/^0+/, "") || "0";
}

// Render the card number with its printed denominator when we have one. We use
// `cardCount.official` because that's the number printed on the card face
// (e.g. "199/165") even for cards numbered beyond it like Special Illustration
// Rares. Skip the denominator for alphanumeric promo IDs ("SWSH001",
// "SM-P 045") where there is no printed denominator on the card.
function formatCardNumber(detail: TcgdexCardDetail): string {
	const official = detail.set.cardCount?.official;
	if (!official || official <= 0) return detail.localId;
	if (!/^\d+$/.test(detail.localId)) return detail.localId;
	return `${detail.localId}/${official}`;
}

// TAG cert format is published on their cert-search page: one letter then
// seven digits (e.g. "A1234567"). The model loves to hallucinate plausible
// 8-digit numerics here because the cert is rotated -90° on the slab edge —
// drop anything that doesn't match so a wrong cert never reaches buyers.
// Other graders' formats aren't published, so we don't gate them.
const TAG_CERT_PATTERN = /^[A-Z]\d{7}$/;

function sanitizeCertForGrader(
	grader: string | null,
	cert: string | null,
): string | null {
	if (!cert || grader !== "TAG") return cert;
	if (TAG_CERT_PATTERN.test(cert)) return cert;
	logger.warn(
		{ grader, cert },
		"[ai-listing] cert: TAG cert failed format check, dropping",
	);
	return null;
}

/** Empty string is the AI's "not visible" sentinel; treat as null. */
function nz(s: string | null | undefined): string | null {
	if (s == null) return null;
	const trimmed = s.trim();
	return trimmed.length === 0 ? null : trimmed;
}

/** UNKNOWN is the AI's "couldn't tell" sentinel for grader/language. */
function nzEnum(s: string | null | undefined): string | null {
	const v = nz(s);
	return v === "UNKNOWN" ? null : v;
}

async function searchTcgdex(
	name: string,
	cardNumber: string,
	language: string | null | undefined,
): Promise<TcgdexCardDetail | null> {
	const numerator = cardNumber.split("/")[0]?.trim();
	if (!numerator) return null;

	const trimmed = trimLeadingZeros(numerator);
	const lang = (language && TCGDEX_LANG_BY_ENUM[language]) ?? "en";
	const searchUrl = `${TCGDEX_API}/${lang}/cards?name=${encodeURIComponent(name)}`;

	const searchRes = await fetch(searchUrl, {
		signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		headers: { accept: "application/json" },
	});
	if (!searchRes.ok) {
		throw new Error(`tcgdex search ${searchRes.status}`);
	}

	const matches = (await searchRes.json()) as TcgdexBriefCard[];
	const hit = matches.find((c) => trimLeadingZeros(c.localId) === trimmed);
	if (!hit) return null;

	const detailUrl = `${TCGDEX_API}/${lang}/cards/${encodeURIComponent(hit.id)}`;
	const detailRes = await fetch(detailUrl, {
		signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		headers: { accept: "application/json" },
	});
	if (!detailRes.ok) {
		throw new Error(`tcgdex detail ${detailRes.status}`);
	}

	const detail = (await detailRes.json()) as TcgdexCardDetail;
	if (!detail.set?.id) return null;
	return detail;
}

export async function lookupCanonical(
	facts: ExtractedCardFacts,
): Promise<CanonicalLookupResult> {
	logger.debug(
		{ kind: facts.kind, confidence: facts.confidence },
		"[ai-listing] canonical: start",
	);
	const result = await lookupCanonicalInner(facts);
	logger.debug(
		{
			source: result.canonical.source,
			hasImage: !!result.canonical.imageUrl,
			record: result.record,
		},
		"[ai-listing] canonical: done",
	);
	return result;
}

async function lookupCanonicalInner(
	facts: ExtractedCardFacts,
): Promise<CanonicalLookupResult> {
	if (facts.kind === "slab") {
		const f = facts.fields;
		const grader = nzEnum(f.grader);
		return {
			record: {
				kind: "slab",
				year: nz(f.year),
				setName: nz(f.setName),
				subject: nz(f.subject),
				cardNumber: nz(f.cardNumber),
				grader,
				grade: nz(f.grade),
				certNumber: sanitizeCertForGrader(grader, nz(f.certNumber)),
				rarity: null,
				parallel: null,
				language: nzEnum(f.language),
			},
			canonical: { imageUrl: null, source: "label_ocr" },
		};
	}

	if (facts.kind === "raw_sports") {
		const f = facts.fields;
		return {
			record: {
				kind: "raw_sports",
				year: nz(f.year),
				setName: null,
				subject: nz(f.player),
				cardNumber: nz(f.cardNumber),
				grader: null,
				grade: null,
				certNumber: null,
				rarity: null,
				parallel: null,
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
				certNumber: null,
				rarity: null,
				parallel: null,
				language: null,
			},
			canonical: { imageUrl: null, source: "ai_guess" },
		};
	}

	const f = facts.fields;
	// Unverified path: TCGdex didn't confirm this card. Drop every field a buyer
	// could be misled by — set, number, rarity. The writer short-circuits to
	// empty copy on source=ai_guess for raw_*, so this record is essentially a
	// signal to the seller to write their own.
	const fallback: CanonicalLookupResult = {
		record: {
			kind: "raw_pokemon",
			year: f.year,
			setName: null,
			subject: f.name,
			cardNumber: null,
			grader: null,
			grade: null,
			certNumber: null,
			rarity: null,
			parallel: null,
			language: f.language,
		},
		canonical: { imageUrl: null, source: "ai_guess" },
	};

	if (!f.name || !f.cardNumber) {
		return fallback;
	}

	try {
		const match = await searchTcgdex(f.name, f.cardNumber, f.language);
		if (!match) return fallback;

		return {
			record: {
				kind: "raw_pokemon",
				year: f.year,
				setName: match.set.name,
				subject: match.name,
				cardNumber: formatCardNumber(match),
				grader: null,
				grade: null,
				certNumber: null,
				rarity: match.rarity ?? null,
				parallel: null,
				language: f.language,
			},
			canonical: {
				imageUrl: match.image ? `${match.image}/high.webp` : null,
				source: "tcgdex",
			},
		};
	} catch (err) {
		logger.warn(
			{ err, name: f.name, cardNumber: f.cardNumber },
			"tcgdex lookup failed, falling back to AI guess",
		);
		return fallback;
	}
}
