import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";

function asSchema(schema: z.ZodType) {
	return z.toJSONSchema(schema, { target: "draft-7" });
}

declare module "fastify" {
	interface FastifyInstance {
		schemas: {
			asSchema: typeof asSchema;
		};
	}
}

const plugin: FastifyPluginAsync = async (fastify) => {
	fastify.decorate("asSchema", asSchema);
};

export const schemasPlugin = fp(plugin, { name: "schemas-plugin" });
