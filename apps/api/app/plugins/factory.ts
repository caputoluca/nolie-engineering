import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

type Method = "GET" | "POST" | "PUT" | "DELETE";
type Role = "admin" | "user" | "entrant";
type JSONOrZodSchema = z.ZodTypeAny | Record<string, unknown>;

interface RouteConfig {
	public?: boolean;
	roles?: Role[];
}

interface CreateRouteSchema<
	TBody extends JSONOrZodSchema | undefined = undefined,
	TQuery extends JSONOrZodSchema | undefined = undefined,
	TParams extends JSONOrZodSchema | undefined = undefined,
	THeaders extends JSONOrZodSchema | undefined = undefined,
	TRes extends Record<number, JSONOrZodSchema> = Record<
		number,
		JSONOrZodSchema
	>,
> {
	body?: TBody;
	query?: TQuery;
	params?: TParams;
	headers?: THeaders;
	response?: TRes;
}

interface CreateRouteOptions<
	TBody extends JSONOrZodSchema | undefined = undefined,
	TQuery extends JSONOrZodSchema | undefined = undefined,
	TParams extends JSONOrZodSchema | undefined = undefined,
	THeaders extends JSONOrZodSchema | undefined = undefined,
	TRes extends Record<number, JSONOrZodSchema> = Record<
		number,
		JSONOrZodSchema
	>,
> {
	method: Method | Method[];
	url: string;
	config?: RouteConfig;
	schema?: CreateRouteSchema<TBody, TQuery, TParams, THeaders, TRes>;
	handler: (
		request: FastifyRequest<{
			Body: TBody extends z.ZodTypeAny ? z.infer<TBody> : unknown;
			Querystring: TQuery extends z.ZodTypeAny ? z.infer<TQuery> : unknown;
			Params: TParams extends z.ZodTypeAny ? z.infer<TParams> : unknown;
			Headers: THeaders extends z.ZodTypeAny ? z.infer<THeaders> : unknown;
		}>,
		reply: FastifyReply,
	) => Promise<
		TRes extends Record<number, z.ZodTypeAny>
			? z.infer<TRes[keyof TRes]>
			: unknown
	>;
}

// ---------------------------------------------

export function isZodSchema(value: unknown): value is z.ZodTypeAny {
	return (
		typeof value === "object" &&
		value !== null &&
		"parse" in value &&
		"_def" in value &&
		typeof (value as { parse: unknown }).parse === "function" &&
		typeof (value as { _def: unknown })._def === "object"
	);
}

function buildSchema(
	fastify: FastifyInstance,
	schema?: Record<string, unknown>,
) {
	if (!schema) return undefined;
	const keys = [
		"headers",
		"body",
		"query",
		"querystring",
		"params",
		"response",
	] as const;

	return Object.fromEntries(
		keys
			.filter((k) => k in schema && schema[k])
			.map((k) => {
				const val = schema[k];
				if (k === "response" && val && typeof val === "object") {
					return [
						"response",
						Object.fromEntries(
							Object.entries(val as Record<string, JSONOrZodSchema>).map(
								([code, sch]) => [
									code,
									isZodSchema(sch) ? fastify.asSchema(sch) : sch,
								],
							),
						),
					];
				}
				const key = k === "query" ? "querystring" : k;
				return [key, isZodSchema(val) ? fastify.asSchema(val) : val];
			}),
	);
}

function createRoute<
	TBody extends JSONOrZodSchema | undefined = undefined,
	TQuery extends JSONOrZodSchema | undefined = undefined,
	TParams extends JSONOrZodSchema | undefined = undefined,
	THeaders extends JSONOrZodSchema | undefined = undefined,
	TRes extends Record<number, JSONOrZodSchema> = Record<
		number,
		JSONOrZodSchema
	>,
>(
	fastify: FastifyInstance,
	opts: CreateRouteOptions<TBody, TQuery, TParams, THeaders, TRes>,
) {
	const { method, url, config, schema, handler } = opts;

	return fastify.route({
		method,
		url,
		config,
		schema: buildSchema(fastify, schema as Record<string, unknown>),
		handler,
	});
}

// ---------------------------------------------
// 🔥 Router type (shared by all helpers)
type RouterFn = <
	TBody extends JSONOrZodSchema | undefined = undefined,
	TQuery extends JSONOrZodSchema | undefined = undefined,
	TParams extends JSONOrZodSchema | undefined = undefined,
	THeaders extends JSONOrZodSchema | undefined = undefined,
	TRes extends Record<number, JSONOrZodSchema> = Record<
		number,
		JSONOrZodSchema
	>,
>(
	opts: CreateRouteOptions<TBody, TQuery, TParams, THeaders, TRes>,
) => void;
type RouterMethod = <
	TBody extends JSONOrZodSchema | undefined = undefined,
	TQuery extends JSONOrZodSchema | undefined = undefined,
	TParams extends JSONOrZodSchema | undefined = undefined,
	THeaders extends JSONOrZodSchema | undefined = undefined,
	TRes extends Record<number, JSONOrZodSchema> = Record<
		number,
		JSONOrZodSchema
	>,
>(
	url: string,
	opts: Omit<
		CreateRouteOptions<TBody, TQuery, TParams, THeaders, TRes>,
		"method" | "url"
	>,
) => void;

export function createRoutes(
	define: (
		r: {
			route: RouterFn;
			get: RouterMethod;
			post: RouterMethod;
			put: RouterMethod;
			delete: RouterMethod;
		},
		fastify: FastifyInstance,
	) => void,
) {
	return (fastify: FastifyInstance) => {
		const router: RouterFn = (opts) => createRoute(fastify, opts);

		const makeMethod =
			(method: Method): RouterMethod =>
			(url, opts) =>
				createRoute(fastify, { ...opts, url, method });

		const r = Object.assign(router, {
			route: router,
			get: makeMethod("GET"),
			post: makeMethod("POST"),
			put: makeMethod("PUT"),
			delete: makeMethod("DELETE"),
		});

		define(r, fastify);
	};
}
