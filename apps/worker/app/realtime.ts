import { RestClient } from "@nolie/realtime/server";
import { config } from "./config.js";
import { logger } from "./logger.js";

let realtimeInstance: RestClient | null = null;

/**
 * Initialize the realtime REST client.
 * Safe to call multiple times - will only connect once.
 */
export async function initializeRealtime(): Promise<void> {
	if (realtimeInstance?.connected) {
		logger.debug("Realtime client already connected");
		return;
	}

	try {
		if (!realtimeInstance) {
			realtimeInstance = new RestClient();
		}

		await realtimeInstance.connect({ key: config.ably_publish_key });
		logger.info("✅ Realtime client connected");
	} catch (err) {
		logger.error({ err }, "❌ Failed to connect realtime client");
		// Don't throw - realtime is not critical for core functionality
		// The worker can still function without it
	}
}

/**
 * Disconnect the realtime REST client.
 */
export function disconnectRealtime(): void {
	if (realtimeInstance?.connected) {
		realtimeInstance.disconnect();
		logger.info("Realtime client disconnected");
	}
	realtimeInstance = null;
}

/**
 * Get the realtime client instance.
 * Returns null if not initialized or not connected.
 */
export function getRealtime(): RestClient | null {
	return realtimeInstance?.connected ? realtimeInstance : null;
}
