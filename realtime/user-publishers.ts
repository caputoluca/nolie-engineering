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
