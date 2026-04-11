import type { TokenRequestType } from "@nolie/schemas/realtime-auth";
import { Realtime, type TokenRequest } from "ably";

export interface RealtimeClientOptions {
	authUrl: string;
	disconnectedRetryTimeoutMs?: number;
	initialTokenRequest?: TokenRequestType | null;
}

export interface RealtimeAblyClient extends Realtime {
	/** Set a token to be used by the next reauthorize call instead of fetching. */
	primeToken: (token: TokenRequestType) => void;
}

export function createRealtimeClient(
	opts: RealtimeClientOptions,
): RealtimeAblyClient {
	let primedTokenRequest: TokenRequestType | null =
		opts.initialTokenRequest ?? null;
	const client = new Realtime({
		disconnectedRetryTimeout: opts.disconnectedRetryTimeoutMs ?? 5000,
		suspendedRetryTimeout: 10000,
		authCallback: async (_tokenParams, callback) => {
			if (primedTokenRequest) {
				const tr = primedTokenRequest;
				primedTokenRequest = null;
				callback(null, tr);
				return;
			}
			try {
				const response = await fetch(opts.authUrl, {
					method: "GET",
					credentials: "include",
					cache: "no-store",
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
	}) as RealtimeAblyClient;

	client.primeToken = (token: TokenRequestType) => {
		primedTokenRequest = token;
	};

	return client;
}
