import type { HandlerDependencies, HandlerRegistry } from "../types";

export function createCompassHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
	const { compassService } = deps;

	return {
		requestCompassReindex: () => {
			if (!compassService) return;
			compassService.triggerReindex();
		},
	};
}
