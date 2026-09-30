export interface SharedType {
	value: number;
	label: string;
}

export function calleeFunction(input: string): SharedType {
	return { value: input.length, label: input };
}

export class CalleeClass {
	run(): void {
		// no-op
	}
}
