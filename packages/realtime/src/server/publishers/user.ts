import { bidResultEvent, pickupConfirmedEvent } from "../../events/user.js";
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
