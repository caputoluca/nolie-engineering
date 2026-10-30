import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";

// zod renders `.nullable()` as `anyOf: [<schema>, { type: "null" }]`.
// Fastify's AJV runs with coerceTypes enabled and evaluates anyOf branches
// in order: against the numeric branch it coerces `null` → `0` (likewise
// `false` for booleans), that branch passes, and the `{ type: "null" }`
// branch is never reached — so a caller's `null` is silently rewritten to
// `0` before the handler runs (e.g. "reset a fee override to default"
// lands as a 0% override). Folding the null branch into the sibling's
// `type` array makes `null` directly valid, so AJV leaves it untouched.
// Scoped to the scalar types AJV actually coerces from null — string/enum
// nullables don't have this bug and a folded `enum` would reject `null`.
const COERCIBLE_FROM_NULL = new Set(["number", "integer", "boolean"]);

function foldNullableAnyOf(jsonSchema: Record<string, unknown>) {
	const anyOf = jsonSchema.anyOf;
	if (!Array.isArray(anyOf) || anyOf.length !== 2) return;

	const nullBranch = anyOf.find(
		(s) => s?.type === "null" && Object.keys(s).length === 1,
	);
	const other = anyOf.find((s) => s !== nullBranch);
	if (
		!nullBranch ||
		!other ||
		typeof other.type !== "string" ||
		!COERCIBLE_FROM_NULL.has(other.type) ||
		"enum" in other ||
		"const" in other ||
		"$ref" in other
	) {
		return;
	}

	jsonSchema.anyOf = undefined;
	Object.assign(jsonSchema, other, { type: [other.type, "null"] });
}

function asSchema(schema: z.ZodType) {
	return z.toJSONSchema(schema, {
		target: "draft-7",
		override: ({ jsonSchema }) => foldNullableAnyOf(jsonSchema),
	});
}

declare module "fastify" {
	interface FastifyInstance {
		asSchema: typeof asSchema;
	}
}

const plugin: FastifyPluginAsync = async (fastify) => {
	fastify.decorate("asSchema", asSchema);
};

export const schemasPlugin = fp(plugin, { name: "schemas-plugin" });
