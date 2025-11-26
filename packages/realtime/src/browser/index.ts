import { initializeClient } from "../client/init.js";
import { cache } from "./cache.js";
import { createRealtimeClient, type RealtimeClientOptions } from "./client.js";
import { auctionSubscribers } from "./subscribers/auction.js";

export class RealtimeClient {
	connected = false;

	async connect(opts: RealtimeClientOptions) {
		try {
			await initializeClient(cache, () => createRealtimeClient(opts));
			this.connected = true;
		} catch (error) {
			this.connected = false;
			throw error;
		}
	}

	disconnect(): void {
		const client = cache.peek();
		if (client) {
			client.close();
		}
		cache.clear();
		this.connected = false;
	}

	auction = auctionSubscribers;
}
