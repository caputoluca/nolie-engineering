import { Realtime, type TokenRequest } from "ably";

export interface RealtimeClientOptions {
	authUrl: string;
	disconnectedRetryTimeoutMs?: number;
}

export function createRealtimeClient(opts: RealtimeClientOptions) {
	return new Realtime({
		disconnectedRetryTimeout: opts.disconnectedRetryTimeoutMs ?? 5000,
		suspendedRetryTimeout: 10000,
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
}
