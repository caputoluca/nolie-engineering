/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 *
 * Left out of this folder:
 * - createPublishEvent: checks the payload against the event's shape, then
 *   publishes it to the channel `<prefix>:<id>`, here `listing:<listingId>`.
 * The events are offer-events.ts here. Everything else is plumbing.
 */

import {
	offerAcceptedEvent,
	offerCounteredEvent,
	offerCreatedEvent,
	offerWithdrawnEvent,
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
	withdrawn: createPublishEvent({
		...offerWithdrawnEvent,
		getChannelId: (data) => data.listingId,
	}),
};
