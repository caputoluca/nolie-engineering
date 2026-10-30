/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 *
 * Left out of this folder:
 * - createPublishEvent: checks the payload against the event's shape, then
 *   publishes it to the channel `<prefix>:<id>`, here `user:<userId>`.
 * - The events: each one's name and shape on a user's own channel.
 * Everything else is plumbing.
 */

import {
	bidResultEvent,
	offerAcceptedEvent,
	offerCanceledEvent,
	offerCounteredEvent,
	offerDeclinedEvent,
	offerExpiredEvent,
	offerPaymentFailedEvent,
	offerReceivedEvent,
	offerWithdrawnEvent,
	pickupConfirmedEvent,
} from "../../events/user.js";
import { createPublishEvent } from "./create.js";

export const userBidPublishers = {
	result: createPublishEvent({
		...bidResultEvent,
		getChannelId: (data) => data.userId,
	}),
};

export const userPickupPublishers = {
	confirmed: createPublishEvent({
		...pickupConfirmedEvent,
		getChannelId: (data) => data.userId,
	}),
};

export const offerUpdatePublishers = {
	received: createPublishEvent({
		...offerReceivedEvent,
		getChannelId: (data) => data.userId,
	}),
	accepted: createPublishEvent({
		...offerAcceptedEvent,
		getChannelId: (data) => data.userId,
	}),
	declined: createPublishEvent({
		...offerDeclinedEvent,
		getChannelId: (data) => data.userId,
	}),
	countered: createPublishEvent({
		...offerCounteredEvent,
		getChannelId: (data) => data.userId,
	}),
	expired: createPublishEvent({
		...offerExpiredEvent,
		getChannelId: (data) => data.userId,
	}),
	withdrawn: createPublishEvent({
		...offerWithdrawnEvent,
		getChannelId: (data) => data.userId,
	}),
	canceled: createPublishEvent({
		...offerCanceledEvent,
		getChannelId: (data) => data.userId,
	}),
	paymentFailed: createPublishEvent({
		...offerPaymentFailedEvent,
		getChannelId: (data) => data.userId,
	}),
};
