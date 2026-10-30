import type { FastifyInstance } from "fastify";
import type { Session } from "./authentication/types.js";

export async function getRealtimeTokenDetails(
	session: Session | null,
	tokenAuthorizer: FastifyInstance["realtimeTokenAuthorizer"],
) {
	const capabilities: Record<string, "subscribe"[]> = {
		"auction:*": ["subscribe"],
		"listing:*": ["subscribe"],
	};
	if (session?.user) {
		capabilities[`user:${session.user.id}`] = ["subscribe"];
	}

	const res = await tokenAuthorizer.auth.createTokenRequest({
		capability: capabilities,
	});

	return res;
}
