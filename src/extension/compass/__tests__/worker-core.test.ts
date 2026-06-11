import { describe, it, expect } from 'vitest';
import { createWorkerCore, MAX_LIGHT_DRAIN_PER_YIELD } from '../worker-core';
import type { WorkerCore, WorkerCoreDeps } from '../worker-core';
import type { WorkerRequest, WorkerEvent, WorkerResponse, WorkerLogEvent, WorkerStatusEvent } from '../worker-protocol';

function tick(): Promise<void> {
	return new Promise(r => setImmediate(r));
}

async function waitUntil(condition: () => boolean): Promise<void> {
	while (!condition()) await tick();
}

function lightRequest(id: number): WorkerRequest {
	return { type: 'getStatus', id };
}

function heavyRequest(id: number): WorkerRequest {
	return { type: 'fullBuild', id };
}

function deferredSerialize(): WorkerRequest {
	return { type: 'serialize', id: -1 };
}

interface Harness {
	core: WorkerCore;
	events: string[];
	responses: () => WorkerResponse[];
	logs: () => WorkerLogEvent[];
	statuses: () => WorkerStatusEvent[];
	releaseHeavy: () => void;
	setInTransaction: (value: boolean) => void;
	setFailType: (type: WorkerRequest['type'] | null) => void;
}

function createHarness(): Harness {
	const events: string[] = [];
	const sent: WorkerEvent[] = [];
	let heavyReleased = false;
	let inTransaction = false;
	let failType: WorkerRequest['type'] | null = null;

	const deps: WorkerCoreDeps = {
		dispatch: async (msg: WorkerRequest) => {
			if (failType === msg.type) {
				events.push(`fail:${msg.type}:${msg.id}`);
				throw new Error('dispatch boom');
			}
			if (msg.type === 'fullBuild') {
				events.push(`heavy-start:${msg.id}`);
				while (!heavyReleased) await core.schedulerYield();
				events.push(`heavy-end:${msg.id}`);
				return 'heavy-result';
			}
			events.push(`light:${msg.id}`);
			return 'light-result';
		},
		send: (msg: WorkerEvent) => { sent.push(msg); },
		isInTransaction: () => inTransaction,
		makeErrorStatus: error => ({
			type: 'status',
			status: { state: 'error', fileCount: 0, nodeCount: 0, edgeCount: 0, communityCount: 0, flowCount: 0, lastIndexedAt: null, error },
		}),
	};

	const core = createWorkerCore(deps);

	return {
		core,
		events,
		responses: () => sent.filter((m): m is WorkerResponse => m.type === 'response'),
		logs: () => sent.filter((m): m is WorkerLogEvent => m.type === 'log'),
		statuses: () => sent.filter((m): m is WorkerStatusEvent => m.type === 'status'),
		releaseHeavy: () => { heavyReleased = true; },
		setInTransaction: (value: boolean) => { inTransaction = value; },
		setFailType: (type: WorkerRequest['type'] | null) => { failType = type; },
	};
}

describe('worker-core scheduler', () => {
	it('drains light requests at scheduler yields while a heavy request is in flight', async () => {
		const h = createHarness();
		void h.core.runLoop();

		h.core.enqueueHeavy(heavyRequest(1));
		await waitUntil(() => h.events.includes('heavy-start:1'));

		h.core.enqueueLight(lightRequest(2));
		await waitUntil(() => h.events.includes('light:2'));

		expect(h.events).not.toContain('heavy-end:1');

		h.releaseHeavy();
		await waitUntil(() => h.events.includes('heavy-end:1'));

		expect(h.events).toEqual(['heavy-start:1', 'light:2', 'heavy-end:1']);
		expect(h.responses().map(r => r.id)).toEqual([2, 1]);
	});

	it('drains at most MAX_LIGHT_DRAIN_PER_YIELD light requests per yield', async () => {
		const h = createHarness();
		const total = MAX_LIGHT_DRAIN_PER_YIELD + 3;
		for (let id = 1; id <= total; id++) {
			h.core.enqueueLight(lightRequest(id));
		}

		await h.core.schedulerYield();
		expect(h.events).toHaveLength(MAX_LIGHT_DRAIN_PER_YIELD);

		await h.core.schedulerYield();
		expect(h.events).toHaveLength(total);
		expect(h.responses().map(r => r.id)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
	});

	it('fully drains the light queue before starting the next heavy request', async () => {
		const h = createHarness();
		h.releaseHeavy();
		void h.core.runLoop();

		h.core.enqueueLight(lightRequest(1));
		h.core.enqueueHeavy(heavyRequest(2));
		h.core.enqueueLight(lightRequest(3));
		h.core.enqueueHeavy(heavyRequest(4));

		await waitUntil(() => h.events.includes('heavy-end:4'));

		expect(h.events).toEqual([
			'light:1',
			'light:3',
			'heavy-start:2',
			'heavy-end:2',
			'heavy-start:4',
			'heavy-end:4',
		]);
	});

	it('sends no response for deferred (id: -1) requests that succeed', async () => {
		const h = createHarness();
		h.core.enqueueLight(deferredSerialize());

		await h.core.schedulerYield();

		expect(h.events).toEqual(['light:-1']);
		expect(h.responses()).toHaveLength(0);
	});

	it('emits a log and error status, but no response, when a deferred request fails', async () => {
		const h = createHarness();
		h.setFailType('serialize');
		h.core.enqueueLight(deferredSerialize());

		await h.core.schedulerYield();

		expect(h.responses()).toHaveLength(0);
		expect(h.logs()).toHaveLength(1);
		expect(h.logs()[0]!.message).toBe("[Worker] Deferred task 'serialize' failed: dispatch boom");
		expect(h.statuses()).toHaveLength(1);
		expect(h.statuses()[0]!.status.state).toBe('error');
		expect(h.statuses()[0]!.status.error).toBe('Deferred serialize: dispatch boom');
	});

	it('sends an error response for non-deferred requests that fail', async () => {
		const h = createHarness();
		h.setFailType('getStatus');
		h.core.enqueueLight(lightRequest(7));

		await h.core.schedulerYield();

		expect(h.responses()).toEqual([{ type: 'response', id: 7, ok: false, error: 'dispatch boom' }]);
		expect(h.statuses()).toHaveLength(0);
	});

	it('suppresses the light drain with an error log while a transaction is open', async () => {
		const h = createHarness();
		h.setInTransaction(true);
		h.core.enqueueLight(lightRequest(1));
		h.core.enqueueLight(lightRequest(2));

		await h.core.schedulerYield();

		expect(h.events).toHaveLength(0);
		expect(h.logs()).toHaveLength(1);
		expect(h.logs()[0]!.message).toContain('invariant violation');

		h.setInTransaction(false);
		await h.core.schedulerYield();
		expect(h.events).toEqual(['light:1', 'light:2']);
	});

	it('hasQueuedHeavy reports queued build-type requests until they are drained', async () => {
		const h = createHarness();
		const buildTypes: ReadonlySet<string> = new Set(['fullBuild', 'incrementalUpdate']);

		expect(h.core.hasQueuedHeavy(buildTypes)).toBe(false);

		h.core.enqueueHeavy(heavyRequest(1));
		expect(h.core.hasQueuedHeavy(buildTypes)).toBe(true);
		expect(h.core.hasQueuedHeavy(new Set(['mcp:build']))).toBe(false);

		h.releaseHeavy();
		void h.core.runLoop();
		await waitUntil(() => h.events.includes('heavy-end:1'));

		expect(h.core.hasQueuedHeavy(buildTypes)).toBe(false);
	});
});
