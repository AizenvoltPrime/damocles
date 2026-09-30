import { calleeFunction, CalleeClass, SharedType } from './sample_crossfile_a';

export function callerFunction(seed: string): SharedType {
	const result = calleeFunction(seed);
	const registry = [CalleeClass];
	void registry;
	return result;
}
