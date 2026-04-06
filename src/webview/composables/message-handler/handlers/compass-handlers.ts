import type { HandlerRegistry } from "../types";

export function createCompassHandlers(): Partial<HandlerRegistry> {
	return {
		compassStatusUpdate: (msg, ctx) => {
			ctx.stores.compassStore.updateStatus(msg.status);
		},
	};
}
