import type { GraphStore } from './database';
import { traceFlows, storeFlows } from './flows';
import { detectCommunities, storeCommunities } from './communities';

export interface PostProcessOptions {
	flows?: boolean;
	communities?: boolean;
	fts?: boolean;
}

export interface PostProcessResult {
	flowCount: number;
	communityCount: number;
}

const NOOP_YIELD = (): Promise<void> => Promise.resolve();

export async function runPostProcess(
	store: GraphStore,
	options: PostProcessOptions,
	yieldFn: () => Promise<void> = NOOP_YIELD,
): Promise<PostProcessResult> {
	let flowCount = 0;
	let communityCount = 0;
	if (options.flows) {
		const flows = traceFlows(store);
		storeFlows(store, flows);
		flowCount = flows.length;
	}
	if (options.communities) {
		const comms = await detectCommunities(store, 2, yieldFn);
		await storeCommunities(store, comms, yieldFn);
		communityCount = comms.length;
	}
	if (options.fts) {
		store.rebuildFtsIndex();
	}
	return { flowCount, communityCount };
}
