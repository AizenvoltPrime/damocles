import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CompassService, type CompassWorkerFactory, type CompassWorkerLike } from '../index';
import { CompassViews } from '../compass-views';
import { CompassRegistry } from '../compass-registry';
import type { FolderTarget } from '../../workspace-folders/folder-registry';

const { __setTrusted, __trustEmitter, __watchers } = vscode as unknown as {
	__setTrusted: (v: boolean) => void;
	__trustEmitter: { cbs: unknown[]; fire: () => void; clear: () => void };
	__watchers: Array<{ disposed: boolean }>;
};

/** A worker that answers `init` so `ensureInitialized` resolves, and records every message sent to it. */
function makeWorker(): CompassWorkerLike & { messages: unknown[] } {
	const listeners = new Map<string, (arg: never) => void>();
	const worker = {
		messages: [] as unknown[],
		on(event: string, listener: (arg: never) => void) {
			listeners.set(event, listener);
		},
		postMessage(message: unknown) {
			worker.messages.push(message);
			const id = (message as { id: number }).id;
			const reply = listeners.get('message') as ((msg: unknown) => void) | undefined;
			reply?.({ type: 'response', id, ok: true, data: { state: 'ready' } });
		},
		terminate() {},
	};
	return worker as CompassWorkerLike & { messages: unknown[] };
}

function enableCompassSetting(): void {
	vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
		get: (key: string, defaultValue?: unknown) => (key === 'enabled' ? true : defaultValue),
		update: () => Promise.resolve(),
	} as never);
}

let created: Array<ReturnType<typeof makeWorker>>;
let factory: CompassWorkerFactory;
let service: CompassService | null;
let views: CompassViews | null;
let registry: CompassRegistry | null;

function target(fsPath: string): FolderTarget {
	return { key: fsPath, fsPath, name: fsPath, label: fsPath, projectScope: true };
}

beforeEach(() => {
	created = [];
	factory = () => {
		const w = makeWorker();
		created.push(w);
		return w;
	};
	service = null;
	views = null;
	registry = null;
	__watchers.length = 0;
	__setTrusted(true);
	enableCompassSetting();
});

afterEach(async () => {
	await service?.dispose();
	views?.dispose();
	await registry?.dispose();
	__trustEmitter.clear();
	__setTrusted(true);
	vi.restoreAllMocks();
});

describe('CompassService workspace trust', () => {
	it('reports disabled in an untrusted workspace even with the setting on', () => {
		__setTrusted(false);
		service = new CompassService('/ws', '/damocles', '/ext', factory);

		expect(service.isEnabled).toBe(false);
	});

	it('reports enabled once the workspace is trusted', () => {
		service = new CompassService('/ws', '/damocles', '/ext', factory);

		expect(service.isEnabled).toBe(true);
	});

	it('starts no worker in an untrusted workspace, so nothing in the tree is read', async () => {
		__setTrusted(false);
		service = new CompassService('/ws', '/damocles', '/ext', factory);

		await service.ensureInitialized();

		expect(created).toHaveLength(0);
		expect(service.getStatus().state).toBe('idle');
	});

	it('creates no file watcher in an untrusted workspace', async () => {
		__setTrusted(false);
		service = new CompassService('/ws', '/damocles', '/ext', factory);

		await service.ensureInitialized();

		expect(__watchers).toHaveLength(0);
	});

	it('indexes on an explicit rebuild only when trusted', async () => {
		__setTrusted(false);
		service = new CompassService('/ws', '/damocles', '/ext', factory);

		await service.triggerReindex();

		expect(created).toHaveLength(0);
	});

	it('registers no views, status bar, or commands in an untrusted workspace', () => {
		__setTrusted(false);
		const createTree = vi.spyOn(vscode.window, 'createTreeView');
		const registerCommand = vi.spyOn(vscode.commands, 'registerCommand');
		const createStatusBar = vi.spyOn(vscode.window, 'createStatusBarItem');

		views = new CompassViews();
		views.register();

		expect(createTree).not.toHaveBeenCalled();
		expect(registerCommand).not.toHaveBeenCalled();
		expect(createStatusBar).not.toHaveBeenCalled();
	});

	it('registers the views deferred by the untrusted start when trust is granted', () => {
		__setTrusted(false);
		views = new CompassViews();
		views.register();

		const registerCommand = vi.spyOn(vscode.commands, 'registerCommand');
		__setTrusted(true);
		__trustEmitter.fire();

		expect(registerCommand.mock.calls.map(c => c[0])).toContain('damocles.compass.rebuild');
	});

	it('registers the views once when trust is granted after a trusted start', () => {
		const registerCommand = vi.spyOn(vscode.commands, 'registerCommand');
		views = new CompassViews();
		views.register();
		const afterFirst = registerCommand.mock.calls.length;
		expect(afterFirst).toBeGreaterThan(0);

		__trustEmitter.fire();

		expect(registerCommand.mock.calls).toHaveLength(afterFirst);
	});

	it('starts no worker for a registry folder in an untrusted workspace, then indexes it once trust is granted', async () => {
		__setTrusted(false);
		registry = new CompassRegistry({ damoclesDir: '/damocles', extensionPath: '/ext', workerFactory: factory });

		registry.start(target('/ws-a'));
		await Promise.resolve();
		expect(created).toHaveLength(0);

		__setTrusted(true);
		__trustEmitter.fire();
		await vi.waitFor(() => expect(created).toHaveLength(1));

		expect(created[0]!.messages[0]).toMatchObject({ type: 'init', workspacePath: '/ws-a' });
	});

	it('starts no worker on a trust grant for a folder whose start was never requested', async () => {
		__setTrusted(false);
		registry = new CompassRegistry({ damoclesDir: '/damocles', extensionPath: '/ext', workerFactory: factory });

		registry.acquire(target('/ws-a'));
		registry.start(target('/ws-b'));
		__setTrusted(true);
		__trustEmitter.fire();
		await vi.waitFor(() => expect(created).toHaveLength(1));
		await new Promise(resolve => setTimeout(resolve, 10));

		expect(created).toHaveLength(1);
		expect(created[0]!.messages[0]).toMatchObject({ type: 'init', workspacePath: '/ws-b' });
	});

	it('unsubscribes from trust grants on dispose', async () => {
		__setTrusted(false);
		service = new CompassService('/ws', '/damocles', '/ext', factory);
		expect(__trustEmitter.cbs).toHaveLength(1);

		await service.dispose();
		service = null;

		expect(__trustEmitter.cbs).toHaveLength(0);
		__setTrusted(true);
		__trustEmitter.fire();
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(created).toHaveLength(0);
	});
});

describe('compass manifest contributions', () => {
	it('hides the Compass views in a restricted window, where the service registers no provider', () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf-8'),
		) as { contributes: { views: Record<string, Array<{ id: string; when?: string }>> } };
		const views = Object.values(manifest.contributes.views).flat().filter(v => v.id.startsWith('damocles.compass.'));

		expect(views.length).toBeGreaterThan(0);
		for (const view of views) {
			expect(view.when).toContain('isWorkspaceTrusted');
		}
	});

	it('keeps damocles.compass.enabled a restricted configuration, so a repository cannot set it', () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf-8'),
		) as { capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } } };

		expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain('damocles.compass.enabled');
	});
});
