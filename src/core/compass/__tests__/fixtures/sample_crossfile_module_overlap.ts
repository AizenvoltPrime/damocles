import { calleeFunction } from './sample_crossfile_a';

calleeFunction('top-level');

export function main(): void {
	calleeFunction('inside-main');
}
