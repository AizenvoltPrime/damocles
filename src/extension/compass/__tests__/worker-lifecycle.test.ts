import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { CompassService, WORKER_RETRY_BASE_DELAY_MS } from '../index';
import type { CompassWorkerLike } from '../index';
import { CompassStatusBar } from '../tree-provider';
import { TIMEOUTS } from '../worker-protocol';
import type { IndexStatus } from '../types';

class FakeWorker extends EventEmitter implements CompassWorkerLike {
	posted: Array<{ type: string; id: number }> = [];
	terminated = false;

	postMessage(message: unknown): void {
		this.posted.push(message as { type: string; id: number });
	}

	terminate(): void {
		this.terminated = true;
	}
}

function readyStatus(): IndexStatus {
	return { state: 'ready', fileCount: 1, nodeCount: 2, edgeCount: 3, communityCount: 0, flowCount: 0, lastIndexedAt: Date.now() };
}

function completeInit(worker: FakeWorker): void {
	const init = worker.posted.find(m => m.type === 'init');
	if (!init) throw new Error('init request was not sent to the worker');
	worker.emit('message', { type: 'status', status: readyStatus() });
	worker.emit('message', { type: 'response', id: init.id, ok: true, data: readyStatus() });
}

describe('CompassService worker lifecycle', () => {
	let workers: FakeWorker[];
	let service: CompassService;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
			get: (key: string, defaultValue?: unknown) => {
				if (key === 'enabled') return true;
				if (key === 'autoReindex') return false;
				return defaultValue;
			},
			update: () => Promise.resolve(),
		} as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);
		workers = [];
		service = new CompassService('/test/workspace', '/test/damocles', '/test/extension', () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		});
	});

	afterEach(async () => {
		const disposing = service.dispose();
		await vi.advanceTimersByTimeAsync(TIMEOUTS.dispose + 1);
		await disposing;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function driveToFailedState(): Promise<void> {
		const initPromise = service.ensureInitialized();
		workers[0]!.emit('error', new Error('crash-1'));
		await expect(initPromise).rejects.toThrow('crash-1');
		await vi.advanceTimersByTimeAsync(WORKER_RETRY_BASE_DELAY_MS);
		expect(workers.length).toBe(2);
		workers[1]!.emit('error', new Error('crash-2'));
		await vi.advanceTimersByTimeAsync(2 * WORKER_RETRY_BASE_DELAY_MS);
		expect(workers.length).toBe(3);
		workers[2]!.emit('error', new Error('crash-3'));
		await vi.advanceTimersByTimeAsync(0);
	}

	it('worker crash sets error status and retries with exponential backoff', async () => {
		const initPromise = service.ensureInitialized();
		expect(workers.length).toBe(1);

		workers[0]!.emit('error', new Error('boom'));
		await expect(initPromise).rejects.toThrow('boom');
		expect(service.getStatus().state).toBe('error');
		expect(service.getStatus().error).toBe('boom');

		await vi.advanceTimersByTimeAsync(WORKER_RETRY_BASE_DELAY_MS - 1);
		expect(workers.length).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(workers.length).toBe(2);

		workers[1]!.emit('error', new Error('boom-2'));
		await vi.advanceTimersByTimeAsync(2 * WORKER_RETRY_BASE_DELAY_MS - 1);
		expect(workers.length).toBe(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(workers.length).toBe(3);
	});

	it('reaches terminal failed state after 3 consecutive failures and stops auto-retrying', async () => {
		await driveToFailedState();

		expect(service.getStatus().state).toBe('failed');
		expect(service.getStatus().error).toBe('crash-3');

		await vi.advanceTimersByTimeAsync(600_000);
		expect(workers.length).toBe(3);

		await service.ensureInitialized();
		expect(workers.length).toBe(3);
	});

	it('manual rebuild resets the failure counter and retries from the failed state', async () => {
		await driveToFailedState();
		expect(service.getStatus().state).toBe('failed');

		const rebuild = service.triggerReindex();
		expect(workers.length).toBe(4);
		completeInit(workers[3]!);
		await rebuild;

		expect(service.getStatus().state).toBe('ready');
	});

	it('successful init resets the consecutive failure counter', async () => {
		const initPromise = service.ensureInitialized();
		workers[0]!.emit('error', new Error('crash'));
		await expect(initPromise).rejects.toThrow('crash');

		await vi.advanceTimersByTimeAsync(WORKER_RETRY_BASE_DELAY_MS);
		expect(workers.length).toBe(2);
		completeInit(workers[1]!);
		await vi.advanceTimersByTimeAsync(0);
		expect(service.getStatus().state).toBe('ready');

		workers[1]!.emit('error', new Error('crash-after-recovery'));
		await vi.advanceTimersByTimeAsync(0);
		expect(service.getStatus().state).toBe('error');

		await vi.advanceTimersByTimeAsync(WORKER_RETRY_BASE_DELAY_MS - 1);
		expect(workers.length).toBe(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(workers.length).toBe(3);
	});

	it('rejects pending requests when the worker errors', async () => {
		const initPromise = service.ensureInitialized();
		completeInit(workers[0]!);
		await initPromise;

		const stats = service.mcpStats();
		workers[0]!.emit('error', new Error('dead'));
		await expect(stats).rejects.toThrow('dead');
	});

	it('clean exit (code 0) rejects pending requests immediately and does not count as a failure', async () => {
		const initPromise = service.ensureInitialized();
		completeInit(workers[0]!);
		await initPromise;

		const stats = service.mcpStats();
		workers[0]!.emit('exit', 0);
		await expect(stats).rejects.toThrow('exited cleanly');

		const reinit = service.ensureInitialized();
		expect(workers.length).toBe(2);
		completeInit(workers[1]!);
		await reinit;
		expect(service.getStatus().state).toBe('ready');
	});

	it('init failure response terminates the worker and schedules a backoff retry', async () => {
		const initPromise = service.ensureInitialized();
		const init = workers[0]!.posted.find(m => m.type === 'init')!;
		workers[0]!.emit('message', { type: 'response', id: init.id, ok: false, error: 'corrupt db' });

		await expect(initPromise).rejects.toThrow('corrupt db');
		expect(workers[0]!.terminated).toBe(true);
		expect(service.getStatus().state).toBe('error');

		await vi.advanceTimersByTimeAsync(WORKER_RETRY_BASE_DELAY_MS);
		expect(workers.length).toBe(2);
	});

	it('requests sent in the failed state reject with a rebuild hint', async () => {
		await driveToFailedState();
		await expect(service.mcpStats()).rejects.toThrow('Compass failed — run Rebuild to retry');
	});

	it('worker crash during graceful dispose neither throws nor respawns (M1)', async () => {
		const initPromise = service.ensureInitialized();
		completeInit(workers[0]!);
		await initPromise;

		const disposing = service.dispose();
		workers[0]!.emit('error', new Error('died mid-dispose'));
		await disposing;

		expect(workers[0]!.terminated).toBe(true);
		expect(service.getStatus().state).toBe('idle');

		await vi.advanceTimersByTimeAsync(600_000);
		expect(workers.length).toBe(1);

		await service.ensureInitialized();
		expect(workers.length).toBe(1);
	});
});

describe('CompassStatusBar failed state', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('surfaces the terminal failed state with a rebuild hint', () => {
		const item = { text: '', tooltip: '', command: '', show: vi.fn(), hide: vi.fn(), dispose: vi.fn() };
		vi.spyOn(vscode.window, 'createStatusBarItem').mockReturnValue(item as unknown as ReturnType<typeof vscode.window.createStatusBarItem>);

		const bar = new CompassStatusBar();
		bar.update({ state: 'failed', fileCount: 0, nodeCount: 0, edgeCount: 0, communityCount: 0, flowCount: 0, lastIndexedAt: null, error: 'boom' });

		expect(item.text).toContain('Failed');
		expect(item.tooltip).toContain('Compass failed — run Rebuild to retry');
		expect(item.tooltip).toContain('boom');
		expect(item.command).toBe('damocles.compass.rebuild');
	});
});
