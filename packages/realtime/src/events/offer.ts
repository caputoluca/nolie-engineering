import { OfferEventSchema } from "@nolie/schemas/offer/realtime";

const CHANNEL_PREFIX = "listing";

// Public anonymized events on `listing:{listingId}` — feed the listing-page
// activity rail. We deliberately do NOT publish withdrawn / declined /
// expired / canceled publicly; they have no signal value and create
// manipulation surface (see make-offer.md "Anti-shilling layers").

export const offerCreatedEvent = {
	channelPrefix: CHANNEL_PREFIX,
	eventName: "offer.created",
	schema: OfferEventSchema,
};

export const offerCounteredEvent = {
	channelPrefix: CHANNEL_PREFIX,
	eventName: "offer.countered",
	schema: OfferEventSchema,
};

export const offerAcceptedEvent = {
	channelPrefix: CHANNEL_PREFIX,
	eventName: "offer.accepted",
	schema: OfferEventSchema,
};
