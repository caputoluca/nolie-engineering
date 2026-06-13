import { z } from "zod";

/**
 * Grading companies the wizard's slab extraction recognizes (NL-374).
 * Lowercase mirrors the Prisma `Grader` enum; display labels and the
 * public cert-lookup URLs live in the frontend. `other` is a real but
 * non-major grader the seller named — an unreadable/unknown grader stays
 * null instead, so the authenticity box never asserts a company we
 * didn't identify.
 */
export const GraderSchema = z.enum([
	"psa",
	"bgs",
	"cgc",
	"tag",
	"sgc",
	"other",
]);

export type Grader = z.infer<typeof GraderSchema>;

// Loose ceilings (a sanity cap, not a format) — cert layouts vary, so this
// only bounds length. The per-grader shape check is `isValidCertForGrader`.
export const GRADE_MAX_LENGTH = 20;
export const CERT_NUMBER_MAX_LENGTH = 24;

/**
 * Per-grader cert-number shapes (NL-374), each validated against the real
 * catalog before adoption: every genuine cert we hold passes, only OCR
 * misreads / card-numbers-mistaken-for-certs fail. Used to keep a wrong cert
 * out of the verify deep-link — a bad cert 404s the grader's lookup, which is
 * worse than no cert. Permissive within each grader's published/observed range
 * so legacy certs and leading zeros still pass:
 *   PSA  8–9 digits (8 since 1991; 9 since it passed 100M certs in late 2024)
 *   CGC  8–14 digits (a structured submission+item number; hyphen stripped first)
 *   BGS  8–11 digits (zero-padded)
 *   SGC  7–8 digits, or the legacy 7-digits + "-" + 3-digits form
 *   TAG  one uppercase letter + 7 digits
 *   other  unknown grader → only a loose alphanumeric floor
 */
export const CERT_PATTERNS: Record<Grader, RegExp> = {
	psa: /^\d{8,9}$/,
	cgc: /^\d{8,14}$/,
	bgs: /^\d{8,11}$/,
	sgc: /^(?:\d{7,8}|\d{7}-\d{3})$/,
	tag: /^[A-Z]\d{7}$/,
	other: /^[A-Za-z0-9]{5,20}$/,
};

/**
 * Does `cert` look like a genuine cert for `grader`? False when the grader is
 * null (a cert with no grader can't drive a verify link) or the cert fails the
 * grader's shape. CGC's printed hyphen is stripped first. Callers drop/hold the
 * cert on false — never the whole listing.
 */
export function isValidCertForGrader(
	grader: Grader | null,
	cert: string,
): boolean {
	if (!grader) return false;
	const c = cert.trim();
	if (!c) return false;
	return CERT_PATTERNS[grader].test(grader === "cgc" ? c.replace(/-/g, "") : c);
}

/**
 * Map the slab extractor's UPPERCASE grader enum ("PSA", "OTHER", "UNKNOWN", …)
 * onto the Prisma `Grader`. UNKNOWN / "" / anything unrecognized → null (never
 * assert a company we didn't read). Single source of truth for the live wizard,
 * the create path, and the backfill so they classify identically.
 */
export function graderFromExtraction(raw: string): Grader | null {
	const lower = raw.trim().toLowerCase();
	return GraderSchema.options.includes(lower as Grader)
		? (lower as Grader)
		: null;
}

// 8.5 down to 1 is identical across every grader (half steps throughout).
const LOWER_SCALE = [
	"8.5",
	"8",
	"7.5",
	"7",
	"6.5",
	"6",
	"5.5",
	"5",
	"4.5",
	"4",
	"3.5",
	"3",
	"2.5",
	"2",
	"1.5",
	"1",
];

/**
 * Per-grader label vocabularies, verified against each company's published
 * scale (NL-374). PSA and TAG print no 9.5; BGS/CGC/SGC do. BGS, CGC, SGC,
 * and TAG each print two flavors of 10. PSA, CGC, and SGC issue
 * Authentic / Authentic Altered (genuine, no numeric grade); BGS and TAG
 * don't. `other` gets the generic superset. This is the single source of
 * truth for the grade select (wizard), server-side normalization (create +
 * generate + backfill), and the authenticity box render.
 */
export const GRADE_OPTIONS: Record<Grader, string[]> = {
	psa: ["10", "9", ...LOWER_SCALE, "Authentic", "Authentic Altered"],
	bgs: ["Black Label 10", "10", "9.5", "9", ...LOWER_SCALE],
	cgc: [
		"Pristine 10",
		"Gem Mint 10",
		"9.5",
		"9",
		...LOWER_SCALE,
		"Authentic",
		"Authentic Altered",
	],
	sgc: [
		"Pristine 10",
		"Gem Mint 10",
		"9.5",
		"9",
		...LOWER_SCALE,
		"Authentic",
		"Authentic Altered",
	],
	tag: ["Pristine 10", "Gem Mint 10", "9", ...LOWER_SCALE],
	other: ["10", "9.5", "9", ...LOWER_SCALE, "Authentic"],
};

/**
 * Map a free-text extracted/submitted grade ("GEM MT 10", "Gem Mint 10", "9.5")
 * onto the grader's option list: exact case-insensitive match first, then the
 * numeric token. "" when nothing maps — callers drop it to null (server-side
 * write paths) or fall back to the verbatim label (display). This is the one
 * gate that keeps an off-vocabulary grade ("EX", a PSA "9.5") out of the DB,
 * rather than trusting the wizard's select to be the only guard.
 */
export function normalizeGrade(grader: Grader | null, raw: string): string {
	const options = GRADE_OPTIONS[grader ?? "other"];
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const exact = options.find((o) => o.toLowerCase() === trimmed.toLowerCase());
	if (exact) return exact;
	const numeric = trimmed.match(/\d+(?:\.\d)?/)?.[0];
	if (numeric && options.includes(numeric)) return numeric;
	return "";
}
