import { calleeFunction, CalleeClass, SharedType } from './sample_crossfile_a';

export class IifeHolder {
	build(): Record<string, unknown> {
		return {
			systemPrompt: (() => {
				const parts: string[] = [];
				const result: SharedType = calleeFunction('iife');
				parts.push(result.label);
				return parts.join('\n');
			})(),
			onEvent: (data: string) => {
				calleeFunction(data);
			},
			items: [1, 2, 3].map((i) => calleeFunction(String(i))),
			registry: [CalleeClass],
		};
	}
}
