import { RestClient } from "@nolie/realtime/server";
import { config } from "./config.js";
import { reportError } from "./lib/observability/sentry/report.js";
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
		reportError(err, {
			level: "warning",
			tags: { operation: "connect_realtime" },
		});
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
 * Helper for creating no-op publishers that log but don't throw.
 * Used when realtime connection is not available.
 */
function noOpPublisher(channel: string) {
	return {
		publish: (data: unknown) => {
			logger.debug(
				{ channel, data, connected: false },
				`Realtime publish skipped - not connected: ${channel}`,
			);
			return Promise.resolve();
		},
	};
}

/**
 * No-op realtime client for when connection is unavailable.
 * Logs publish attempts for debugging without throwing errors.
 *
 * NOTE: Must be kept in sync with RestClient publisher structure.
 * TypeScript will enforce this at compile time.
 */
const noOpRealtimeClient: RestClient = {
	connected: false,

	connect: async () => {
		throw new Error("Cannot connect through no-op client");
	},

	disconnect: () => {
		// No-op
	},

	auction: {
		bids: noOpPublisher("auction.bids"),
		extensions: noOpPublisher("auction.extensions"),
		ended: noOpPublisher("auction.ended"),
	},

	bid: {
		result: noOpPublisher("bid.result"),
	},

	pickup: {
		confirmed: noOpPublisher("pickup.confirmed"),
	},

	offer: {
		activity: {
			created: noOpPublisher("offer.activity.created"),
			countered: noOpPublisher("offer.activity.countered"),
			accepted: noOpPublisher("offer.activity.accepted"),
		},
		update: {
			received: noOpPublisher("offer.update.received"),
			accepted: noOpPublisher("offer.update.accepted"),
			declined: noOpPublisher("offer.update.declined"),
			countered: noOpPublisher("offer.update.countered"),
			expired: noOpPublisher("offer.update.expired"),
			withdrawn: noOpPublisher("offer.update.withdrawn"),
			canceled: noOpPublisher("offer.update.canceled"),
			paymentFailed: noOpPublisher("offer.update.payment_failed"),
		},
	},
};

/**
 * Get realtime client for publishing.
 * Returns connected client if available, otherwise returns a no-op client
 * that logs attempts but doesn't throw errors.
 *
 * This eliminates the need for verbose null checks throughout the codebase.
 *
 * Usage:
 *   realtime().auction.bids.publish({ ... });  // Always safe, never throws
 */
export function realtime(): RestClient {
	return realtimeInstance?.connected ? realtimeInstance : noOpRealtimeClient;
}

/**
 * Get the realtime client instance.
 * Returns null if not initialized or not connected.
 *
 * @deprecated Use realtime() instead for cleaner code without null checks.
 */
export function getRealtime(): RestClient | null {
	return realtimeInstance?.connected ? realtimeInstance : null;
}
