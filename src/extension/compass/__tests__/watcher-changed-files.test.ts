import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { CompassService, MAX_WATCHED_CHANGED_FILES, WORKER_RETRY_BASE_DELAY_MS } from '../index';
import type { CompassWorkerLike } from '../index';
import { TIMEOUTS } from '../worker-protocol';
import type { IndexStatus } from '../types';

interface PostedMessage {
	type: string;
	id: number;
	changedFiles?: string[];
}

class FakeWorker extends EventEmitter implements CompassWorkerLike {
	posted: PostedMessage[] = [];
	terminated = false;

	postMessage(message: unknown): void {
		this.posted.push(message as PostedMessage);
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

type WatcherHandler = (uri: vscode.Uri) => void;

describe('CompassService watcher changedFiles accumulation', () => {
	let workers: FakeWorker[];
	let service: CompassService;
	let fireCreate: WatcherHandler;
	let fireDelete: WatcherHandler;
	let watcherInstances: Array<{ dispose: ReturnType<typeof vi.fn> }>;

	function incrementalUpdates(worker: FakeWorker): PostedMessage[] {
		return worker.posted.filter(m => m.type === 'incrementalUpdate');
	}

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
			get: (key: string, defaultValue?: unknown) => {
				if (key === 'enabled') return true;
				if (key === 'autoReindex') return true;
				if (key === 'excludePatterns') return ['src/generated/'];
				return defaultValue;
			},
			update: () => Promise.resolve(),
		} as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);
		watcherInstances = [];
		vi.spyOn(vscode.workspace, 'createFileSystemWatcher').mockImplementation(() => {
			const instance = {
				onDidChange: (_handler: WatcherHandler) => ({ dispose: () => {} }),
				onDidCreate: (handler: WatcherHandler) => { fireCreate = handler; return { dispose: () => {} }; },
				onDidDelete: (handler: WatcherHandler) => { fireDelete = handler; return { dispose: () => {} }; },
				dispose: vi.fn(),
			};
			watcherInstances.push(instance);
			return instance as unknown as vscode.FileSystemWatcher;
		});
		workers = [];
		service = new CompassService('/test/workspace', '/test/damocles', '/test/extension', () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		});
		const initPromise = service.ensureInitialized();
		completeInit(workers[0]!);
		await initPromise;
	});

	afterEach(async () => {
		const disposing = service.dispose();
		await vi.advanceTimersByTimeAsync(TIMEOUTS.dispose + 1);
		await disposing;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('sends a newly created untracked file as changedFiles after the debounce', async () => {
		fireCreate(vscode.Uri.file('/test/workspace/src/new-file.ts'));
		await vi.advanceTimersByTimeAsync(500);

		const updates = incrementalUpdates(workers[0]!);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.changedFiles).toEqual(['/test/workspace/src/new-file.ts']);
	});

	it('coalesces multiple changes within the debounce window into one message', async () => {
		fireCreate(vscode.Uri.file('/test/workspace/src/a.ts'));
		await vi.advanceTimersByTimeAsync(100);
		fireCreate(vscode.Uri.file('/test/workspace/src/b.ts'));
		await vi.advanceTimersByTimeAsync(500);

		const updates = incrementalUpdates(workers[0]!);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.changedFiles).toEqual(['/test/workspace/src/a.ts', '/test/workspace/src/b.ts']);
	});

	it('includes deleted files even though they no longer exist', async () => {
		fireDelete(vscode.Uri.file('/test/workspace/src/removed.ts'));
		await vi.advanceTimersByTimeAsync(500);

		const updates = incrementalUpdates(workers[0]!);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.changedFiles).toEqual(['/test/workspace/src/removed.ts']);
	});

	it('drops build-output URIs that the collection walk would never visit (H1)', async () => {
		fireCreate(vscode.Uri.file('/test/workspace/dist/bundle.js'));
		fireCreate(vscode.Uri.file('/test/workspace/node_modules/dep/index.ts'));
		fireCreate(vscode.Uri.file('/test/workspace/coverage/report.ts'));
		fireCreate(vscode.Uri.file('/test/workspace/src/real.ts'));
		await vi.advanceTimersByTimeAsync(500);

		const updates = incrementalUpdates(workers[0]!);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.changedFiles).toEqual(['/test/workspace/src/real.ts']);
	});

	it('drops excluded, sensitive, and non-code URIs before sending', async () => {
		fireCreate(vscode.Uri.file('/test/workspace/src/generated/skip.ts'));
		fireCreate(vscode.Uri.file('/test/workspace/README.md'));
		fireCreate(vscode.Uri.file('/test/workspace/id_ed25519'));
		fireCreate(vscode.Uri.file('/test/workspace/src/keep.ts'));
		await vi.advanceTimersByTimeAsync(500);

		const updates = incrementalUpdates(workers[0]!);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.changedFiles).toEqual(['/test/workspace/src/keep.ts']);
	});

	it('skips the worker round-trip when every accumulated URI is filtered out', async () => {
		fireCreate(vscode.Uri.file('/test/workspace/src/generated/skip.ts'));
		fireCreate(vscode.Uri.file('/test/workspace/README.md'));
		await vi.advanceTimersByTimeAsync(500);

		expect(incrementalUpdates(workers[0]!)).toHaveLength(0);
	});

	it('clears the accumulated set after each flush', async () => {
		fireCreate(vscode.Uri.file('/test/workspace/src/first.ts'));
		await vi.advanceTimersByTimeAsync(500);
		fireCreate(vscode.Uri.file('/test/workspace/src/second.ts'));
		await vi.advanceTimersByTimeAsync(500);

		const updates = incrementalUpdates(workers[0]!);
		expect(updates).toHaveLength(2);
		expect(updates[0]!.changedFiles).toEqual(['/test/workspace/src/first.ts']);
		expect(updates[1]!.changedFiles).toEqual(['/test/workspace/src/second.ts']);
	});

	it('falls back to the git-diff path when the burst exceeds the cap', async () => {
		for (let i = 0; i <= MAX_WATCHED_CHANGED_FILES; i++) {
			fireCreate(vscode.Uri.file(`/test/workspace/src/file-${i}.ts`));
		}
		await vi.advanceTimersByTimeAsync(500);

		const updates = incrementalUpdates(workers[0]!);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.changedFiles).toBeUndefined();
	});

	it('manual triggerReindex keeps the git-based path without changedFiles', async () => {
		await service.triggerReindex();

		const updates = incrementalUpdates(workers[0]!);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.changedFiles).toBeUndefined();
	});

	it('disposes the previous FileSystemWatcher when init re-runs after a crash', async () => {
		expect(watcherInstances).toHaveLength(1);

		workers[0]!.emit('error', new Error('crash'));
		await vi.advanceTimersByTimeAsync(WORKER_RETRY_BASE_DELAY_MS);
		expect(workers.length).toBe(2);
		completeInit(workers[1]!);
		await vi.advanceTimersByTimeAsync(0);

		expect(watcherInstances).toHaveLength(2);
		expect(watcherInstances[0]!.dispose).toHaveBeenCalledTimes(1);
		expect(watcherInstances[1]!.dispose).not.toHaveBeenCalled();
	});
});
