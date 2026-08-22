import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CompassService, type CompassWorkerFactory, type CompassWorkerLike } from '../index';

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

function fakeContext(): vscode.ExtensionContext {
	return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

let created: Array<ReturnType<typeof makeWorker>>;
let factory: CompassWorkerFactory;
let service: CompassService | null;

beforeEach(() => {
	created = [];
	factory = () => {
		const w = makeWorker();
		created.push(w);
		return w;
	};
	service = null;
	__watchers.length = 0;
	__setTrusted(true);
	enableCompassSetting();
});

afterEach(async () => {
	await service?.dispose();
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
		const registerTree = vi.spyOn(vscode.window, 'registerTreeDataProvider');
		const registerCommand = vi.spyOn(vscode.commands, 'registerCommand');
		service = new CompassService('/ws', '/damocles', '/ext', factory);

		const context = fakeContext();
		service.registerViews(context);

		expect(registerTree).not.toHaveBeenCalled();
		expect(registerCommand).not.toHaveBeenCalled();
		expect(context.subscriptions).toHaveLength(0);
	});

	it('starts indexing when trust is granted, with no window reload', async () => {
		__setTrusted(false);
		service = new CompassService('/ws', '/damocles', '/ext', factory);
		await service.ensureInitialized();
		expect(created).toHaveLength(0);

		__setTrusted(true);
		__trustEmitter.fire();
		await vi.waitFor(() => expect(created).toHaveLength(1));

		expect(created[0]!.messages[0]).toMatchObject({ type: 'init', workspacePath: '/ws' });
	});

	it('registers the views deferred by the untrusted start when trust is granted', async () => {
		__setTrusted(false);
		service = new CompassService('/ws', '/damocles', '/ext', factory);
		const context = fakeContext();
		service.registerViews(context);
		expect(context.subscriptions).toHaveLength(0);

		const registerCommand = vi.spyOn(vscode.commands, 'registerCommand');
		__setTrusted(true);
		__trustEmitter.fire();
		await vi.waitFor(() => expect(created).toHaveLength(1));

		expect(context.subscriptions.length).toBeGreaterThan(0);
		expect(registerCommand.mock.calls.map(c => c[0])).toContain('damocles.compass.rebuild');
	});

	it('registers the views once when trust is granted after a trusted start', () => {
		service = new CompassService('/ws', '/damocles', '/ext', factory);
		const context = fakeContext();
		service.registerViews(context);
		const afterFirst = context.subscriptions.length;
		expect(afterFirst).toBeGreaterThan(0);

		__trustEmitter.fire();

		expect(context.subscriptions).toHaveLength(afterFirst);
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
