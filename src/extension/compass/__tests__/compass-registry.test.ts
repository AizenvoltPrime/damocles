import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CompassRegistry } from '../compass-registry';
import type { CompassWorkerLike } from '../index';
import { compassIndexPath } from '../util';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import type { IndexStatus } from '../types';

const { __setTrusted, __trustEmitter, __watchers } = vscode as unknown as {
	__setTrusted: (v: boolean) => void;
	__trustEmitter: { clear: () => void };
	__watchers: unknown[];
};

interface FakeWorker extends CompassWorkerLike {
	messages: Array<Record<string, unknown>>;
	emit(msg: unknown): void;
	terminated: boolean;
	/** Answers a held `init`, as the worker does once its index build finishes. */
	finishInit(): void;
}

/**
 * Answers every request, so `ensureInitialized` and queries resolve; `mcp:search` echoes the folder it
 * was initialized with. With `holdInit`, `init` stays pending until `finishInit`, like a running build.
 */
function makeWorker(holdInit = false): FakeWorker {
	let onMessage: ((msg: unknown) => void) | undefined;
	let workspacePath = '';
	let heldInitId: unknown;
	const worker: FakeWorker = {
		messages: [],
		terminated: false,
		on(event: string, listener: (arg: never) => void) {
			if (event === 'message') onMessage = listener as (msg: unknown) => void;
		},
		finishInit() { onMessage?.({ type: 'response', id: heldInitId, ok: true, data: { state: 'ready' } }); },
		postMessage(message: unknown) {
			const msg = message as Record<string, unknown>;
			worker.messages.push(msg);
			if (msg['type'] === 'init') workspacePath = msg['workspacePath'] as string;
			if (msg['type'] === 'init' && holdInit) { heldInitId = msg['id']; return; }
			const data = msg['type'] === 'mcp:search' ? `symbols in ${workspacePath}` : { state: 'ready' };
			onMessage?.({ type: 'response', id: msg['id'], ok: true, data });
		},
		terminate() { worker.terminated = true; },
		emit(msg: unknown) { onMessage?.(msg); },
	} as FakeWorker;
	return worker;
}

function target(fsPath: string, projectScope = true): FolderTarget {
	return { key: fsPath.toLowerCase(), fsPath, name: path.basename(fsPath), label: path.basename(fsPath), projectScope };
}

function setCompassEnabled(enabled: boolean): void {
	vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
		get: (key: string, defaultValue?: unknown) => (key === 'enabled' ? enabled : defaultValue),
		update: () => Promise.resolve(),
	} as never);
}

const A = target('/work/A');
const B = target('/work/B');

let workers: FakeWorker[];
let registry: CompassRegistry;
let holdInit: boolean;

beforeEach(() => {
	workers = [];
	holdInit = false;
	__watchers.length = 0;
	__setTrusted(true);
	setCompassEnabled(true);
	registry = new CompassRegistry({
		damoclesDir: '/damocles',
		extensionPath: '/ext',
		workerFactory: () => { const w = makeWorker(holdInit); workers.push(w); return w; },
	});
});

afterEach(async () => {
	await registry.dispose();
	__trustEmitter.clear();
	__setTrusted(true);
	vi.restoreAllMocks();
});

describe('CompassRegistry', () => {
	it('gives each folder its own service, indexed at its own path', async () => {
		const a = registry.start(A)!;
		const b = registry.start(B)!;
		await a.ensureInitialized();
		await b.ensureInitialized();

		expect(a).not.toBe(b);
		expect(workers).toHaveLength(2);
		expect(workers.map(w => w.messages[0]!['workspacePath'])).toEqual(['/work/A', '/work/B']);
		expect(compassIndexPath('/work/A')).not.toBe(compassIndexPath('/work/B'));
	});

	it('answers a search from the folder that asked, never the other one', async () => {
		const a = registry.start(A)!;
		const b = registry.start(B)!;
		await a.ensureInitialized();
		await b.ensureInitialized();

		expect(await registry.get(B.key)!.mcpSearch({ query: 'x' })).toBe('symbols in /work/B');
		expect(await registry.get(A.key)!.mcpSearch({ query: 'x' })).toBe('symbols in /work/A');
	});

	it('keeps the index path of a folder keyed on its raw path', () => {
		const raw = 'C:\\Work\\Mixed Case';
		const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);

		expect(compassIndexPath(raw)).toBe(path.join(os.homedir(), '.damocles', 'compass', hash, 'graph.db'));
	});

	it('returns the same service for a folder on every acquire', () => {
		expect(registry.acquire(A)).toBe(registry.acquire(A));
	});

	it('creates no service for the home target of a window with no folder open', () => {
		expect(registry.acquire(target('/home/user', false))).toBeNull();
		expect(registry.keys()).toHaveLength(0);
	});

	it('starts no worker on acquire alone, so a folder no panel targets never indexes', async () => {
		registry.acquire(A);
		await Promise.resolve();

		expect(workers).toHaveLength(0);
	});

	it('starts no worker while Compass is disabled', async () => {
		vi.restoreAllMocks();
		setCompassEnabled(false);

		const service = registry.start(A);
		await Promise.resolve();

		expect(service).not.toBeNull();
		expect(workers).toHaveLength(0);
	});

	it('starts no worker in an untrusted window', async () => {
		__setTrusted(false);

		registry.start(A);
		await Promise.resolve();

		expect(workers).toHaveLength(0);
	});

	it('reports status and progress with the folder they came from', async () => {
		const statuses: Array<[string, IndexStatus['state']]> = [];
		const progress: string[] = [];
		registry.onStatusChange((key, status) => statuses.push([key, status.state]));
		registry.onProgress((key) => progress.push(key));
		await registry.start(A)!.ensureInitialized();
		await registry.start(B)!.ensureInitialized();
		statuses.length = 0;

		workers[1]!.emit({ type: 'status', status: { state: 'ready', fileCount: 0, nodeCount: 0, edgeCount: 0, communityCount: 0, flowCount: 0, lastIndexedAt: null } });
		workers[0]!.emit({ type: 'progress', current: 1, total: 2, phase: 'parse' });

		expect(statuses).toEqual([[B.key, 'ready']]);
		expect(progress).toEqual([A.key]);
	});

	it('disposes a released folder\'s service and worker, leaving the others running', async () => {
		await registry.start(A)!.ensureInitialized();
		await registry.start(B)!.ensureInitialized();
		const changes = vi.fn();
		registry.onDidChangeServices(changes);

		await registry.release(A.key);

		expect(registry.get(A.key)).toBeUndefined();
		expect(registry.get(B.key)).toBeDefined();
		expect(workers[0]!.terminated).toBe(true);
		expect(workers[1]!.terminated).toBe(false);
		expect(changes).toHaveBeenCalledTimes(1);
	});

	it('stops forwarding a released folder\'s status', async () => {
		const service = registry.start(A)!;
		await service.ensureInitialized();
		const worker = workers[0]!;
		const statuses: string[] = [];
		registry.onStatusChange((key) => statuses.push(key));

		await registry.release(A.key);
		worker.emit({ type: 'status', status: { state: 'ready' } });

		expect(statuses).toEqual([]);
	});

	it('terminates a worker at once when its folder is released during the index build', async () => {
		holdInit = true;
		registry.start(A);
		await vi.waitFor(() => expect(workers).toHaveLength(1));

		await registry.release(A.key);

		expect(workers[0]!.terminated).toBe(true);
		expect(workers[0]!.messages.map(m => m['type'])).toEqual(['init']);
		expect(__watchers).toHaveLength(0);
	});

	it('sets up no file watcher when the folder is released as its index build finishes', async () => {
		holdInit = true;
		registry.start(A);
		await vi.waitFor(() => expect(workers).toHaveLength(1));

		workers[0]!.finishInit();
		const released = registry.release(A.key);
		await released;

		expect(workers[0]!.terminated).toBe(true);
		expect(__watchers).toHaveLength(0);
	});

	it('treats releasing a folder with no service as a no-op', async () => {
		await expect(registry.release('/never')).resolves.toBeUndefined();
	});

	it('creates nothing once disposed', async () => {
		await registry.dispose();

		expect(registry.acquire(A)).toBeNull();
	});
});
