import { Realtime, type TokenRequest } from "ably";

export interface RealtimeClientOptions {
	authUrl: string;
}

export async function createRealtimeClient(opts: RealtimeClientOptions) {
	const client = new Realtime({
		authCallback: async (_tokenParams, callback) => {
			try {
				const response = await fetch(opts.authUrl, {
					method: "GET",
					credentials: "include", // Include cookies for session auth
				});

				if (!response.ok) {
					callback(`Auth request failed: ${response.status}`, null);
					return;
				}

				const tokenRequest = (await response.json()) as TokenRequest;
				callback(null, tokenRequest);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Auth request failed";
				callback(message, null);
			}
		},
	});
	await client.connection.once("connected");
	return client;
}
