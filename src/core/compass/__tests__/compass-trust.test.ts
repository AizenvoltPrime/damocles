import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CompassService, type CompassWorkerFactory, type CompassWorkerLike } from '../index';
import { CompassRegistry } from '../compass-registry';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';

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

let created: Array<ReturnType<typeof makeWorker>>;
let factory: CompassWorkerFactory;
let service: CompassService | null;
let registry: CompassRegistry | null;
let fake: FakePlatform;

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
	registry = null;
	fake = createFakePlatform({
		settings: { user: { 'damocles.compass.enabled': true } },
		folders: ['/ws', '/ws-a', '/ws-b'].map(fsPath => ({ fsPath, name: fsPath })),
	});
});

afterEach(async () => {
	await service?.dispose();
	await registry?.dispose();
	vi.restoreAllMocks();
});

describe('CompassService workspace trust', () => {
	it('reports disabled in an untrusted workspace even with the setting on', () => {
		fake.trust.setTrusted(false);
		service = new CompassService('/ws', fake, factory);

		expect(service.isEnabled).toBe(false);
	});

	it('reports enabled once the workspace is trusted', () => {
		service = new CompassService('/ws', fake, factory);

		expect(service.isEnabled).toBe(true);
	});

	it('starts no worker in an untrusted workspace, so nothing in the tree is read', async () => {
		fake.trust.setTrusted(false);
		service = new CompassService('/ws', fake, factory);

		await service.ensureInitialized();

		expect(created).toHaveLength(0);
		expect(service.getStatus().state).toBe('idle');
	});

	it('creates no file watcher in an untrusted workspace', async () => {
		fake.trust.setTrusted(false);
		service = new CompassService('/ws', fake, factory);

		await service.ensureInitialized();

		expect(fake.fileWatchers.watchers).toHaveLength(0);
	});

	it('indexes on an explicit rebuild only when trusted', async () => {
		fake.trust.setTrusted(false);
		service = new CompassService('/ws', fake, factory);

		await service.triggerReindex();

		expect(created).toHaveLength(0);
	});

	it('starts no worker for a registry folder in an untrusted workspace, then indexes it once trust is granted', async () => {
		fake.trust.setTrusted(false);
		registry = new CompassRegistry({ platform: fake, workerFactory: factory });

		registry.start(target('/ws-a'));
		await Promise.resolve();
		expect(created).toHaveLength(0);

		fake.trust.grantTrust();
		await vi.waitFor(() => expect(created).toHaveLength(1));

		expect(created[0]!.messages[0]).toMatchObject({ type: 'init', workspacePath: '/ws-a' });
	});

	it('starts no worker on a trust grant for a folder whose start was never requested', async () => {
		fake.trust.setTrusted(false);
		registry = new CompassRegistry({ platform: fake, workerFactory: factory });

		registry.acquire(target('/ws-a'));
		registry.start(target('/ws-b'));
		fake.trust.grantTrust();
		await vi.waitFor(() => expect(created).toHaveLength(1));
		await new Promise(resolve => setTimeout(resolve, 10));

		expect(created).toHaveLength(1);
		expect(created[0]!.messages[0]).toMatchObject({ type: 'init', workspacePath: '/ws-b' });
	});

	it('unsubscribes from trust grants on dispose', async () => {
		fake.trust.setTrusted(false);
		service = new CompassService('/ws', fake, factory);
		await service.ensureInitialized();

		await service.dispose();
		service = null;

		fake.trust.grantTrust();
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(created).toHaveLength(0);
	});

	it('starts only once its own folder is trusted, whatever folders the change names', async () => {
		const trusted = new Set<string>();
		vi.spyOn(fake.trust, 'isTrusted').mockImplementation(folder => trusted.has(folder));
		service = new CompassService('/ws', fake, factory);
		await service.ensureInitialized();

		trusted.add('/ws-a');
		fake.trust.grantTrust(['/ws-a']);
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(created).toHaveLength(0);

		// a remote client's attach can trust a folder with a change that names none
		trusted.add('/ws');
		fake.trust.grantTrust([]);
		await vi.waitFor(() => expect(created).toHaveLength(1));
	});

	it('stops a running service when its workspace loses trust, and starts it again on a later grant', async () => {
		service = new CompassService('/ws', fake, factory);
		const statuses: string[] = [];
		service.onStatusChange(status => statuses.push(status.state));
		await service.ensureInitialized();
		expect(created).toHaveLength(1);
		const terminate = vi.spyOn(created[0]!, 'terminate');
		expect(fake.fileWatchers.watchers.some(w => !w.disposed)).toBe(true);

		fake.trust.revokeTrust(['/ws']);

		expect(terminate).toHaveBeenCalledOnce();
		expect(fake.fileWatchers.watchers.every(w => w.disposed)).toBe(true);
		expect(service.getStatus().state).toBe('idle');
		expect(statuses.at(-1)).toBe('idle');

		fake.trust.grantTrust(['/ws']);
		await vi.waitFor(() => expect(created).toHaveLength(2));
	});

	it('leaves a start that a revoke cut short idle, with no watcher and no error', async () => {
		const silent: CompassWorkerFactory = () => {
			const w = makeWorker();
			w.postMessage = (message: unknown) => { w.messages.push(message); };
			created.push(w);
			return w;
		};
		service = new CompassService('/ws', fake, silent);
		const starting = service.ensureInitialized();

		fake.trust.revokeTrust(['/ws']);

		await expect(starting).rejects.toThrow('the workspace is no longer trusted');
		expect(service.getStatus().state).toBe('idle');
		expect(service.getStatus().error).toBeUndefined();
		expect(fake.fileWatchers.watchers).toHaveLength(0);
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
