import type { HandlerRegistry } from "../types";

export function createCompassHandlers(): Partial<HandlerRegistry> {
	return {
		compassStatusUpdate: (msg, ctx) => {
			ctx.stores.compassStore.updateStatus(msg.status);
			if (msg.status.state === 'ready') {
				ctx.stores.compassStore.buildProgress = null;
			}
		},
		compassBuildProgress: (msg, ctx) => {
			ctx.stores.compassStore.buildProgress = {
				current: msg.current,
				total: msg.total,
				phase: msg.phase,
				...(msg.label ? { label: msg.label } : {}),
			};
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
		compassValidationResult: (msg, ctx) => {
			ctx.stores.compassStore.setValidationResult(msg.data);
		},
	};
}
