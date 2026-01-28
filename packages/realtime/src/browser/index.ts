import { initializeClient } from "../client/init.js";
import { cache } from "./cache.js";
import { createRealtimeClient, type RealtimeClientOptions } from "./client.js";
import { auctionSubscribers } from "./subscribers/auction.js";
import { userBidSubscribers } from "./subscribers/user.js";

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

	reauthorize() {
		const client = cache.peek();
		if (!client) {
			throw new Error("Client not initialized");
		}
		return client.auth.authorize();
	}

	/**
	 * Detach a channel by name if it's attached. This is needed when cleaning up
	 * subscriptions before token capabilities change (e.g., logout) to prevent
	 * the channel from entering a FAILED state.
	 *
	 * Only detaches if the channel is in 'attached' state to avoid race conditions.
	 */
	detachChannel(channelName: string): void {
		const client = cache.peek();
		if (!client) {
			return;
		}
		const channel = client.channels.get(channelName);
		// Only detach if actually attached - avoids race condition errors
		// when trying to detach while still attaching (e.g., on page refresh)
		if (channel.state === "attached") {
			channel.detach().catch(() => {
				// Ignore detach errors - channel state will be cleaned up anyway
			});
		}
	}

	auction = auctionSubscribers;
	bid = userBidSubscribers;
}
