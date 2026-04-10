import type { HandlerRegistry } from "../types";

export function createCompassHandlers(): Partial<HandlerRegistry> {
	return {
		compassStatusUpdate: (msg, ctx) => {
			ctx.stores.compassStore.updateStatus(msg.status);
		},
		compassSearchResults: (msg, ctx) => {
			ctx.stores.compassStore.setSearchResults(msg.results);
		},
		compassGraphData: (msg, ctx) => {
			ctx.stores.compassStore.setGraphData(msg.data);
		},
		compassBlastRadiusData: (msg, ctx) => {
			ctx.stores.compassStore.setBlastRadius(msg.data);
		},
		compassBlastRadiusDismissed: (_msg, ctx) => {
			ctx.stores.compassStore.dismissBlastRadius();
		},
	};
}
