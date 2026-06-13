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

// Loose ceilings, not formats: cert layouts vary per grader (PSA 8-9
// digits, TAG letter+7, …) and over-validating rejects real slabs. The
// grader's own lookup page is the source of truth for validity.
export const GRADE_MAX_LENGTH = 20;
export const CERT_NUMBER_MAX_LENGTH = 24;
