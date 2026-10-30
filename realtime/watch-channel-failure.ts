/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 * The client it watches is browser.ts here. Nothing else is left out.
 */

import type { ChannelStateChange } from "ably";
import type { RealtimeClient } from "./index.js";

interface WatchChannelFailureOptions {
	/**
	 * Forces a fresh token. Awaited before re-attaching. The implementation
	 * is expected not to throw — `RealtimeProvider.reauthorize` already
	 * catches and reports its own errors.
	 */
	reauthorize: () => Promise<unknown>;
	/**
	 * Fires once if recovery doesn't succeed. Use to report.
	 */
	onExhausted?: (stateChange: ChannelStateChange) => void;
}

/**
 * Wires Ably's documented recovery for a channel that may enter the FAILED
 * state (typically Ably error 40160 — capability denied because the active
 * token doesn't grant this channel).
 *
 * Per Ably's docs, the canonical recovery is `authorize()` then `attach()`
 * on the same channel object — no need to release the channel or re-register
 * subscribers. Listeners persist across state transitions, so once the
 * channel is ATTACHED again, existing subscribers receive messages.
 *
 * One-shot per watcher lifetime: if recovery fails, `onExhausted` fires and
 * the watcher stops. A re-mount of the caller (e.g. component navigation)
 * sets up a fresh watcher with a fresh budget.
 *
 * Returns an idempotent dispose. Calling it during an in-flight
 * reauthorize/attach prevents the attach from running.
 */
export function watchChannelFailure(
	client: RealtimeClient,
	channelName: string,
	opts: WatchChannelFailureOptions,
): () => void {
	let triggered = false;
	let disposed = false;
	let removeListener: (() => void) | null = null;

	removeListener = client.onChannelFailed(channelName, async (stateChange) => {
		if (disposed || triggered) return;
		triggered = true;
		removeListener?.();
		removeListener = null;

		try {
			await opts.reauthorize();
			if (disposed) return;
			await client.attachChannel(channelName);
		} catch {
			if (!disposed) opts.onExhausted?.(stateChange);
		}
	});

	return () => {
		if (disposed) return;
		disposed = true;
		removeListener?.();
		removeListener = null;
	};
}
