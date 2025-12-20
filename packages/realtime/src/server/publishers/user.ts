import { bidResultEvent } from "../../events/user.js";
import { createPublishEvent } from "./create.js";

export const userBidPublishers = {
	result: createPublishEvent({
		...bidResultEvent,
		getChannelId: (data) => data.userId,
	}),
};
