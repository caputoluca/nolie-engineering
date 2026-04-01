import type { TokenRequestType } from "@nolie/schemas/realtime-auth";
import type { ChannelStateChange } from "ably";
import { initializeClient } from "../client/init.js";
import { cache } from "./cache.js";
import { createRealtimeClient, type RealtimeClientOptions } from "./client.js";
import { auctionSubscribers } from "./subscribers/auction.js";
import { userBidSubscribers } from "./subscribers/user.js";
import type { ConnectionState, ConnectionStateListener } from "./types.js";

export type {
	ConnectionErrorReason,
	ConnectionState,
	ConnectionStateChange,
	ConnectionStateListener,
} from "./types.js";

export class RealtimeClient {
	connected = false;

	private currentState: ConnectionState = "connecting";
	private connectionStateListener: ConnectionStateListener | null = null;
	private visibilityHandler: (() => void) | null = null;
	private _needsReauth = false;
	private _authorizedUserId: string | null = null;

	connect(opts: RealtimeClientOptions) {
		const client = initializeClient(cache, () => createRealtimeClient(opts));

		// Listen for future state changes
		client.connection.on((stateChange) => {
			this.currentState = stateChange.current as ConnectionState;
			this.connected = stateChange.current === "connected";
			this.connectionStateListener?.({
				current: stateChange.current as ConnectionState,
				previous: stateChange.previous as ConnectionState,
				reason: stateChange.reason
					? {
							code: stateChange.reason.code,
							message: stateChange.reason.message,
						}
					: undefined,
				retryIn: stateChange.retryIn,
			});
		});

		// Seed initial state in case Ably connected before listener was attached
		this.currentState = client.connection.state as ConnectionState;
		this.connected = client.connection.state === "connected";

		// Force immediate reconnect when tab becomes visible
		if (typeof document !== "undefined") {
			this.visibilityHandler = () => {
				if (
					document.visibilityState === "visible" &&
					client.connection.state !== "connected"
				) {
					client.connection.connect();
				}
			};
			document.addEventListener("visibilitychange", this.visibilityHandler);
		}
	}

	/**
	 * Get the current connection state.
	 */
	get connectionState(): ConnectionState {
		return this.currentState;
	}

	/**
	 * Set a listener for connection state changes.
	 * Only one listener is supported - setting a new one replaces the previous.
	 */
	onConnectionStateChange(listener: ConnectionStateListener | null): void {
		this.connectionStateListener = listener;
	}

	disconnect(): void {
		if (this.visibilityHandler) {
			document.removeEventListener("visibilitychange", this.visibilityHandler);
			this.visibilityHandler = null;
		}
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
	 * Prime a token for the next reauthorize call. The authCallback will
	 * use this token instead of fetching from /realtime/auth.
	 * Also sets `needsReauth` so the provider knows to trigger reauthorize
	 * even if the user ID hasn't changed.
	 */
	primeToken(token: TokenRequestType) {
		const client = cache.peek();
		if (client) {
			client.primeToken(token);
			this._needsReauth = true;
		}
	}

	/**
	 * Whether a primed token is waiting to be consumed via reauthorize.
	 */
	get needsReauth() {
		return this._needsReauth;
	}

	clearNeedsReauth() {
		this._needsReauth = false;
	}

	/**
	 * The user ID the client was last authorized for.
	 * Used by RealtimeProvider to detect user changes across navigations
	 * (the singleton persists but per-component refs reset on remount).
	 */
	get authorizedUserId(): string | null {
		return this._authorizedUserId;
	}

	setAuthorizedUserId(userId: string | null): void {
		this._authorizedUserId = userId;
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

	/**
	 * Release a channel, removing it entirely from the client so the next
	 * `channels.get()` returns a fresh INITIALIZED channel. Use this to
	 * recover from FAILED channel state.
	 */
	releaseChannel(channelName: string): void {
		const client = cache.peek();
		if (!client) {
			return;
		}
		client.channels.release(channelName);
	}

	/**
	 * Listen for a channel entering the FAILED state.
	 * Returns a cleanup function to remove the listener.
	 */
	onChannelFailed(
		channelName: string,
		listener: (e: ChannelStateChange) => void,
	): () => void {
		const client = cache.peek();
		if (!client) {
			return () => {};
		}
		const channel = client.channels.get(channelName);
		channel.on("failed", listener);
		return () => {
			channel.off("failed", listener);
		};
	}

	auction = auctionSubscribers;
	bid = userBidSubscribers;
}
