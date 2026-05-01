import {
	offerAcceptedEvent,
	offerCounteredEvent,
	offerCreatedEvent,
} from "../../events/offer.js";
import { createPublishEvent } from "./create.js";

// Public anonymized listing-channel events — feed the listing-page activity
// rail. Channel resolved from the payload's listingId.
export const offerActivityPublishers = {
	created: createPublishEvent({
		...offerCreatedEvent,
		getChannelId: (data) => data.listingId,
	}),
	countered: createPublishEvent({
		...offerCounteredEvent,
		getChannelId: (data) => data.listingId,
	}),
	accepted: createPublishEvent({
		...offerAcceptedEvent,
		getChannelId: (data) => data.listingId,
	}),
};
