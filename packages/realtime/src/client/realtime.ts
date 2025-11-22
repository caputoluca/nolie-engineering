import { Realtime } from "ably";

export interface RealtimeClientOptions {
	authUrl: string;
}

export async function createRealtimeClient(opts: RealtimeClientOptions) {
	const client = new Realtime({
		authUrl: opts.authUrl,
	});
	await client.connection.once("connected");
	return client;
}
