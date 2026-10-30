import {
	OfferEventSchema,
	OfferRemovedEventSchema,
} from "@nolie/schemas/offer/realtime";

const CHANNEL_PREFIX = "listing";

// Public anonymized events on `listing:{listingId}` — feed the listing-page
// activity rail. Declined / expired / cancel-by-bin / cancel-by-sibling are
// NOT broadcast publicly (no signal value, manipulation surface — see
// make-offer.md "Anti-shilling layers"). Withdraw is a deliberate
// exception: the original `created` event was already public, so we need
// a removal signal so the rail can drop the row. Payload is intentionally
// minimal (id-only) — see `OfferRemovedEventSchema`.

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

export const offerWithdrawnEvent = {
	channelPrefix: CHANNEL_PREFIX,
	eventName: "offer.withdrawn",
	schema: OfferRemovedEventSchema,
};
