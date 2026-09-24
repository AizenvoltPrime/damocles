import type * as vscode from 'vscode';
import { log } from '../logger';
import { CompassService, type CompassWorkerFactory, type WorkerProgressEvent } from './index';
import type { IndexStatus } from './types';
import type { FolderTarget } from '../workspace-folders/folder-registry';

export interface CompassRegistryOptions {
	damoclesDir: string;
	extensionPath: string;
	workerFactory?: CompassWorkerFactory;
}

type StatusListener = (folderKey: string, status: IndexStatus) => void;
type ProgressListener = (folderKey: string, event: WorkerProgressEvent) => void;

/**
 * One `CompassService` per workspace folder, keyed by folder key. A service holds no worker until
 * `start` runs for its folder, and a started worker lives until the folder leaves the workspace.
 */
export class CompassRegistry {
	private readonly services = new Map<string, { service: CompassService; subscriptions: vscode.Disposable[] }>();
	private readonly statusListeners = new Set<StatusListener>();
	private readonly progressListeners = new Set<ProgressListener>();
	private readonly changeListeners = new Set<() => void>();
	private readonly options: CompassRegistryOptions;
	private disposed = false;

	constructor(options: CompassRegistryOptions) {
		this.options = options;
	}

	get(folderKey: string): CompassService | undefined {
		return this.services.get(folderKey)?.service;
	}

	keys(): string[] {
		return [...this.services.keys()];
	}

	/**
	 * The folder's service, created without a worker when missing. Only a project folder has an index,
	 * so the home target of a window with no folder open gets none.
	 */
	acquire(target: FolderTarget): CompassService | null {
		if (this.disposed || !target.projectScope) return null;
		const existing = this.services.get(target.key);
		if (existing) return existing.service;
		// `fsPath` is passed raw: the worker hashes it into the index directory name.
		const service = new CompassService(target.fsPath, this.options.damoclesDir, this.options.extensionPath, this.options.workerFactory);
		const key = target.key;
		const subscriptions = [
			service.onStatusChange((status) => { for (const cb of [...this.statusListeners]) cb(key, status); }),
			service.onProgress((event) => { for (const cb of [...this.progressListeners]) cb(key, event); }),
		];
		this.services.set(key, { service, subscriptions });
		this.emitChange();
		return service;
	}

	/**
	 * Acquires the folder's service and requests its start: the worker runs now when Compass is enabled
	 * in a trusted window, or on a later trust grant.
	 */
	start(target: FolderTarget): CompassService | null {
		const service = this.acquire(target);
		service?.ensureInitialized().catch((err) => log('[CompassRegistry] Compass init failed for %s: %O', target.fsPath, err));
		return service;
	}

	/** Disposes the folder's service and its worker. A no-op for a folder with none. */
	async release(folderKey: string): Promise<void> {
		const entry = this.services.get(folderKey);
		if (!entry) return;
		this.services.delete(folderKey);
		for (const s of entry.subscriptions) s.dispose();
		this.emitChange();
		await entry.service.dispose();
	}

	onStatusChange(listener: StatusListener): vscode.Disposable {
		this.statusListeners.add(listener);
		return { dispose: () => { this.statusListeners.delete(listener); } };
	}

	onProgress(listener: ProgressListener): vscode.Disposable {
		this.progressListeners.add(listener);
		return { dispose: () => { this.progressListeners.delete(listener); } };
	}

	/** Fires after a service is created or released. */
	onDidChangeServices(listener: () => void): vscode.Disposable {
		this.changeListeners.add(listener);
		return { dispose: () => { this.changeListeners.delete(listener); } };
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const keys = this.keys();
		await Promise.allSettled(keys.map((key) => this.release(key)));
		this.statusListeners.clear();
		this.progressListeners.clear();
		this.changeListeners.clear();
	}

	private emitChange(): void {
		for (const cb of [...this.changeListeners]) {
			try {
				cb();
			} catch (err) {
				log('[CompassRegistry] change listener failed: %O', err);
			}
		}
	}
}
