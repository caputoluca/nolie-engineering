import { initializeClient } from "../client/init.js";
import { cache } from "./cache.js";
import { createRealtimeClient, type RealtimeClientOptions } from "./client.js";
import { auctionSubscribers } from "./subscribers/auction.js";

export class RealtimeClient {
	connected = false;

	async connect(opts: RealtimeClientOptions) {
		this.connected = true;
		await initializeClient(cache, () => createRealtimeClient(opts));
	}

	disconnect(): void {
		const client = cache.peek();
		if (client) {
			client.close();
		}
	}

	auction = auctionSubscribers;
}
