import { calleeFunction } from './sample_crossfile_barrel';

export function barrelCaller(): void {
	calleeFunction('seed');
}
