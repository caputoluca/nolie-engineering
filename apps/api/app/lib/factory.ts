import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteHandler, RouteOptions } from "fastify/types/route.js";
import type { z } from "zod";
import type { auth } from "../lib/auth.js";
import type { AuthConfig } from "../plugins/protect.js";

type JSONOrZodSchema = z.ZodTypeAny | Record<string, unknown>;

// Session type from the auth system
type SessionType = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

interface CreateRouteAuth<
	TPublic extends boolean = false,
	TOptional extends boolean = false,
> extends AuthConfig {
	public?: TPublic;
	optional?: TOptional;
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

type _HandlerRequest<TBody, TQuery, TParams, THeaders> = FastifyRequest<{
	Body: TBody extends z.ZodTypeAny ? z.infer<TBody> : unknown;
	Querystring: TQuery extends z.ZodTypeAny ? z.infer<TQuery> : unknown;
	Params: TParams extends z.ZodTypeAny ? z.infer<TParams> : unknown;
	Headers: THeaders extends z.ZodTypeAny ? z.infer<THeaders> : unknown;
}>;

interface CreateRouteOptions<
	TBody extends JSONOrZodSchema | undefined = undefined,
	TQuery extends JSONOrZodSchema | undefined = undefined,
	TParams extends JSONOrZodSchema | undefined = undefined,
	THeaders extends JSONOrZodSchema | undefined = undefined,
	TRes extends Record<number, JSONOrZodSchema> = Record<
		number,
		JSONOrZodSchema
	>,
	TPublic extends boolean = false,
	TOptional extends boolean = false,
> extends Omit<RouteOptions, "handler"> {
	auth?: CreateRouteAuth<TPublic, TOptional>;
	config?: Omit<RouteOptions["config"], "auth">;
	schema?: CreateRouteSchema<TBody, TQuery, TParams, THeaders, TRes>;
	handler: (
		request: FastifyRequest<{
			Body: TBody extends z.ZodTypeAny
				? z.infer<TBody>
				: Record<string, unknown>;
			Querystring: TQuery extends z.ZodTypeAny
				? z.infer<TQuery>
				: Record<string, unknown>;
			Params: TParams extends z.ZodTypeAny
				? z.infer<TParams>
				: Record<string, unknown>;
			Headers: THeaders extends z.ZodTypeAny
				? z.infer<THeaders>
				: Record<string, unknown>;
		}> &
			(TPublic extends true
				? { session: SessionType | null }
				: TOptional extends true
					? { session: SessionType | null }
					: { session: SessionType }),
		reply: FastifyReply<{
			Reply: TRes extends Record<number, z.ZodTypeAny>
				? z.infer<TRes[keyof TRes]>
				: unknown;
		}>,
	) =>
		| Promise<
				TRes extends Record<number, z.ZodTypeAny>
					? z.infer<TRes[keyof TRes]>
					: unknown
		  >
		| (TRes extends Record<number, z.ZodTypeAny>
				? z.infer<TRes[keyof TRes]>
				: unknown);
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
	TPublic extends boolean = false,
	TOptional extends boolean = false,
>(
	fastify: FastifyInstance,
	opts: CreateRouteOptions<
		TBody,
		TQuery,
		TParams,
		THeaders,
		TRes,
		TPublic,
		TOptional
	>,
) {
	const { schema, handler, auth, config, ...rest } = opts;

	return fastify.route({
		schema: buildSchema(fastify, schema as Record<string, unknown>),
		config: { ...(config ?? {}), auth },
		handler: handler as RouteHandler,
		...rest,
	});
}

// ---------------------------------------------
// Router type (shared by all helpers)
type RouterFn = <
	TBody extends JSONOrZodSchema | undefined = undefined,
	TQuery extends JSONOrZodSchema | undefined = undefined,
	TParams extends JSONOrZodSchema | undefined = undefined,
	THeaders extends JSONOrZodSchema | undefined = undefined,
	TRes extends Record<number, JSONOrZodSchema> = Record<
		number,
		JSONOrZodSchema
	>,
	TPublic extends boolean = false,
	TOptional extends boolean = false,
>(
	opts: CreateRouteOptions<
		TBody,
		TQuery,
		TParams,
		THeaders,
		TRes,
		TPublic,
		TOptional
	>,
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
	TPublic extends boolean = false,
	TOptional extends boolean = false,
>(
	url: string,
	opts: Omit<
		CreateRouteOptions<
			TBody,
			TQuery,
			TParams,
			THeaders,
			TRes,
			TPublic,
			TOptional
		>,
		"method" | "url"
	>,
) => void;

function createRouter(fastify: FastifyInstance) {
	const router: RouterFn = (opts) => createRoute(fastify, opts);

	const makeMethod =
		(method: RouteOptions["method"]): RouterMethod =>
		(url, opts) =>
			createRoute(fastify, { ...opts, url, method });
	return Object.assign(router, {
		route: router,
		get: makeMethod("GET"),
		post: makeMethod("POST"),
		put: makeMethod("PUT"),
		delete: makeMethod("DELETE"),
		patch: makeMethod("PATCH"),
	});
}

export type RouteCreator = ReturnType<typeof createRouter>;

export function createRoutes(
	define: (r: RouteCreator, fastify: FastifyInstance) => void,
) {
	return (fastify: FastifyInstance) => {
		const r = createRouter(fastify);
		define(r, fastify);
	};
}
