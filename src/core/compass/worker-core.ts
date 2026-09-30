import type { WorkerRequest, WorkerEvent } from './worker-protocol';

export const MAX_LIGHT_DRAIN_PER_YIELD = 8;

export interface WorkerCoreDeps {
	dispatch(msg: WorkerRequest): Promise<unknown>;
	send(msg: WorkerEvent): void;
	isInTransaction(): boolean;
	makeErrorStatus(error: string): WorkerEvent;
}

export interface WorkerCore {
	enqueueLight(msg: WorkerRequest): void;
	enqueueHeavy(msg: WorkerRequest): void;
	hasQueuedHeavy(types: ReadonlySet<string>): boolean;
	schedulerYield(): Promise<void>;
	runLoop(): Promise<void>;
}

export function createWorkerCore(deps: WorkerCoreDeps): WorkerCore {
	const lightQueue: WorkerRequest[] = [];
	const heavyQueue: WorkerRequest[] = [];
	let wake: (() => void) | null = null;

	function signal(): void {
		if (wake) {
			const w = wake;
			wake = null;
			w();
		}
	}

	function waitForWork(): Promise<void> {
		if (lightQueue.length || heavyQueue.length) return Promise.resolve();
		return new Promise<void>(r => { wake = r; });
	}

	async function runOne(msg: WorkerRequest): Promise<void> {
		try {
			const result = await deps.dispatch(msg);
			if (msg.id < 0) return;
			deps.send({ type: 'response', id: msg.id, ok: true, data: result });
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			if (msg.id < 0) {
				deps.send({ type: 'log', message: `[Worker] Deferred task '${msg.type}' failed: ${error}` });
				deps.send(deps.makeErrorStatus(`Deferred ${msg.type}: ${error}`));
				return;
			}
			deps.send({ type: 'response', id: msg.id, ok: false, error });
		}
	}

	async function schedulerYield(): Promise<void> {
		await new Promise(r => setImmediate(r));
		if (deps.isInTransaction()) {
			deps.send({ type: 'log', message: '[Worker] ERROR: invariant violation — scheduler yield reached with an open transaction; skipping light-request drain' });
			return;
		}
		let drained = 0;
		while (lightQueue.length > 0 && drained < MAX_LIGHT_DRAIN_PER_YIELD) {
			const msg = lightQueue.shift()!;
			await runOne(msg);
			drained++;
		}
	}

	async function runLoop(): Promise<void> {
		for (;;) {
			await waitForWork();
			while (lightQueue.length > 0) {
				const msg = lightQueue.shift()!;
				await runOne(msg);
			}
			if (heavyQueue.length > 0) {
				const msg = heavyQueue.shift()!;
				await runOne(msg);
			}
		}
	}

	return {
		enqueueLight(msg: WorkerRequest): void {
			lightQueue.push(msg);
			signal();
		},
		enqueueHeavy(msg: WorkerRequest): void {
			heavyQueue.push(msg);
			signal();
		},
		hasQueuedHeavy(types: ReadonlySet<string>): boolean {
			return heavyQueue.some(msg => types.has(msg.type));
		},
		schedulerYield,
		runLoop,
	};
}
