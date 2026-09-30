import * as path from 'path';
import * as os from 'os';
import { Worker } from 'worker_threads';
import { log } from '../logger';
import type { ICompassService, IndexStatus, CompassConfig } from './types';
import { CODE_EXTENSIONS } from './types';
import { createWatcherFileFilter } from './detect';
import { folderKey } from '../workspace-folders/folder-key';
import { notifySchemaAhead } from '../schema-skew';
import { t } from '../l10n';
import type { WorkerEvent, WorkerProgressEvent } from './worker-protocol';
import { LIGHT_REQUEST_TYPES, TIMEOUTS, TIMEOUTS_BY_TYPE } from './worker-protocol';
import type { Disposable } from '../../platform/disposable';
import type { SettingsStore } from '../../platform/settings-store';
import type { TrustService } from '../../platform/trust-service';
import type { FileWatcher, FileWatcherFactory } from '../../platform/file-watcher';
import type { AppPaths } from '../../platform/app-paths';
import type { NotificationService } from '../../platform/notification-service';

export type { WorkerProgressEvent } from './worker-protocol';

interface PendingRequest {
	type: string;
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface CompassWorkerLike {
	on(event: 'message', listener: (msg: WorkerEvent) => void): void;
	on(event: 'error', listener: (err: Error) => void): void;
	on(event: 'exit', listener: (code: number) => void): void;
	postMessage(message: unknown): void;
	terminate(): Promise<number> | void;
}

export type CompassWorkerFactory = (workerPath: string) => CompassWorkerLike;

export const MAX_CONSECUTIVE_WORKER_FAILURES = 3;
export const WORKER_RETRY_BASE_DELAY_MS = 1_000;
export const MAX_WATCHED_CHANGED_FILES = 500;

const defaultWorkerFactory: CompassWorkerFactory = (workerPath) => new Worker(workerPath);

/** The host services a CompassService uses. */
export interface CompassPlatform {
	readonly settings: SettingsStore;
	readonly trust: TrustService;
	readonly fileWatchers: FileWatcherFactory;
	readonly paths: AppPaths;
	readonly notifications: NotificationService;
}

/**
 * The single Compass gate, read by tool eligibility, the system prompt block, the webview handlers,
 * the views and indexing itself. Trust belongs here rather than at those call sites because Compass
 * walks and reads the whole workspace tree and runs git inside it, so an untrusted workspace must not
 * reach the point of being read at all.
 */
export function isCompassEnabled(platform: Pick<CompassPlatform, 'settings' | 'trust'>, folderPath: string): boolean {
	if (!platform.trust.isTrusted(folderPath)) return false;
	return platform.settings.get<boolean>('damocles.compass.enabled', false);
}

export class CompassService implements ICompassService {
	private _config: CompassConfig;
	private _initPromise: Promise<void> | null = null;
	private _worker: CompassWorkerLike | null = null;
	private _workerFactory: CompassWorkerFactory;
	private _consecutiveFailures = 0;
	private _retryTimer: ReturnType<typeof setTimeout> | null = null;
	private _disposed = false;
	private _nextRequestId = 1;
	private _pendingRequests = new Map<number, PendingRequest>();
	private _cachedStatus: IndexStatus = {
		state: 'idle', fileCount: 0, nodeCount: 0, edgeCount: 0,
		communityCount: 0, flowCount: 0, lastIndexedAt: null,
	};
	private _statusChangeCallbacks: Array<(status: IndexStatus) => void> = [];
	private _progressCallbacks: Array<(event: WorkerProgressEvent) => void> = [];
	private _workspacePath: string;
	private readonly _platform: CompassPlatform;
	private _watcher: FileWatcher | null = null;
	private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _pendingChangedFiles = new Set<string>();
	private _isIndexableFile: (filePath: string) => boolean;
	private _trustListener: Disposable | null = null;
	/** Set by the first `ensureInitialized`; a trust grant starts only a service something asked to start. */
	private _startRequested = false;

	constructor(workspacePath: string, platform: CompassPlatform, workerFactory: CompassWorkerFactory = defaultWorkerFactory) {
		this._workspacePath = workspacePath;
		this._platform = platform;
		this._workerFactory = workerFactory;
		this._config = {
			excludePatterns: platform.settings.get<string[]>('damocles.compass.excludePatterns', []),
			autoReindex: platform.settings.get<boolean>('damocles.compass.autoReindex', true),
		};
		this._isIndexableFile = createWatcherFileFilter(workspacePath, this._config.excludePatterns);
		// Trust can only be granted, never revoked in place, so this only ever starts Compass.
		this._trustListener = platform.trust.onDidGrantTrust((folderPaths) => {
			const key = folderKey(this._workspacePath);
			if (folderPaths.some(p => folderKey(p) === key)) this._onWorkspaceTrustGranted();
		});
	}

	get isEnabled(): boolean {
		return isCompassEnabled(this._platform, this._workspacePath);
	}

	get config(): CompassConfig {
		return this._config;
	}

	/** The raw folder path the index is keyed on. */
	get workspacePath(): string {
		return this._workspacePath;
	}

	onStatusChange(callback: (status: IndexStatus) => void): Disposable {
		this._statusChangeCallbacks.push(callback);
		return { dispose: () => { this._statusChangeCallbacks = this._statusChangeCallbacks.filter(cb => cb !== callback); } };
	}

	onProgress(callback: (event: WorkerProgressEvent) => void): Disposable {
		this._progressCallbacks.push(callback);
		return { dispose: () => { this._progressCallbacks = this._progressCallbacks.filter(cb => cb !== callback); } };
	}

	private _emitStatus(): void {
		const status = this._cachedStatus;
		for (const cb of this._statusChangeCallbacks) cb(status);
	}

	async ensureInitialized(): Promise<void> {
		if (this._disposed) return;
		this._startRequested = true;
		if (!this.isEnabled) return;
		if (this._workspacePath === os.homedir()) return;
		if (this._cachedStatus.state === 'failed') return;
		if (this._retryTimer) return;
		if (this._cachedStatus.state === 'ready' && this._worker) return;
		if (!this._initPromise) {
			const { error: _unused, ...rest } = this._cachedStatus;
			this._cachedStatus = { ...rest, state: 'idle' };
			this._initPromise = this._doInit().catch(err => {
				this._initPromise = null;
				const failure = err instanceof Error ? err : new Error(String(err));
				if (this._worker) {
					this._worker.terminate();
					this._worker = null;
					this._handleWorkerFailure(failure);
				} else if (this._cachedStatus.state !== 'error' && this._cachedStatus.state !== 'failed') {
					this._cachedStatus = { ...this._cachedStatus, state: 'error', error: failure.message };
					this._emitStatus();
				}
				log('[CompassService] Init failure: %O', err);
				throw err;
			});
		}
		return this._initPromise;
	}

	private async _doInit(): Promise<void> {
		this._cachedStatus = { ...this._cachedStatus, state: 'indexing' };
		this._emitStatus();

		const worker = this._workerFactory(this._platform.paths.workerEntry('compass'));
		this._worker = worker;
		worker.on('message', (msg: WorkerEvent) => { if (this._worker === worker) this._onWorkerMessage(msg); });
		worker.on('error', (err: Error) => { if (this._worker === worker) this._onWorkerError(err); });
		worker.on('exit', (code: number) => { if (this._worker === worker) this._onWorkerExit(code); });

		await this._sendRequest<IndexStatus>({
			type: 'init',
			workspacePath: this._workspacePath,
			grammarDir: path.join(this._platform.paths.unpackedRoot, 'resources', 'grammars'),
			config: this._config,
		}, TIMEOUTS.init);
		if (this._disposed) return;

		this._consecutiveFailures = 0;

		if (this._config.autoReindex) {
			this._setupWatcher();
		}
	}

	private _onWorkerMessage(msg: WorkerEvent): void {
		if (msg.type === 'response') {
			const pending = this._pendingRequests.get(msg.id);
			if (!pending) return;
			this._pendingRequests.delete(msg.id);
			clearTimeout(pending.timer);
			if (msg.ok) {
				pending.resolve(msg.data);
			} else {
				pending.reject(new Error(msg.error));
			}
		} else if (msg.type === 'status') {
			this._cachedStatus = msg.status;
			this._emitStatus();
		} else if (msg.type === 'log') {
			log(msg.message);
		} else if (msg.type === 'progress') {
			for (const cb of this._progressCallbacks) cb(msg);
		} else if (msg.type === 'schemaAhead') {
			notifySchemaAhead(this._platform.notifications, { kind: 'compass', folder: this._workspacePath });
			if (!this._cachedStatus.readOnly) {
				this._cachedStatus = { ...this._cachedStatus, readOnly: true };
				this._emitStatus();
			}
		}
	}

	private _onWorkerError(err: Error): void {
		log('[CompassService] Worker error: %O', err);
		this._worker = null;
		this._initPromise = null;
		this._rejectAllPending(err);
		this._handleWorkerFailure(err);
	}

	private _onWorkerExit(code: number): void {
		this._worker = null;
		this._initPromise = null;
		if (code === 0) {
			this._rejectAllPending(new Error('Worker exited cleanly with pending requests'));
			return;
		}
		log('[CompassService] Worker exited with code %d', code);
		const err = new Error(`Worker exited with code ${code}`);
		this._rejectAllPending(err);
		this._handleWorkerFailure(err);
	}

	private _handleWorkerFailure(err: Error): void {
		if (this._disposed) return;
		this._consecutiveFailures++;
		if (this._consecutiveFailures >= MAX_CONSECUTIVE_WORKER_FAILURES) {
			log('[CompassService] %d consecutive worker failures — halting auto-retry until manual rebuild', this._consecutiveFailures);
			this._cachedStatus = { ...this._cachedStatus, state: 'failed', error: err.message };
			this._emitStatus();
			return;
		}
		this._cachedStatus = { ...this._cachedStatus, state: 'error', error: err.message };
		this._emitStatus();
		const delayMs = WORKER_RETRY_BASE_DELAY_MS * 2 ** (this._consecutiveFailures - 1);
		log('[CompassService] Scheduling worker restart in %dms (failure %d of %d)', delayMs, this._consecutiveFailures, MAX_CONSECUTIVE_WORKER_FAILURES);
		this._retryTimer = setTimeout(() => {
			this._retryTimer = null;
			this.ensureInitialized().catch(() => {});
		}, delayMs);
	}

	private _heavyRequestInFlight(): boolean {
		for (const pending of this._pendingRequests.values()) {
			if (!LIGHT_REQUEST_TYPES.has(pending.type)) return true;
		}
		return false;
	}

	private _rejectAllPending(err: Error): void {
		for (const [id, pending] of this._pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(err);
			this._pendingRequests.delete(id);
		}
	}

	private _sendRequest<T>(msg: Record<string, unknown>, timeoutMs?: number): Promise<T> {
		if (!this._worker) {
			return Promise.reject(new Error(this._cachedStatus.state === 'failed'
				? 'Compass failed — run Rebuild to retry'
				: 'Worker not initialized'));
		}
		const resolvedTimeout = timeoutMs ?? TIMEOUTS_BY_TYPE[msg['type'] as keyof typeof TIMEOUTS_BY_TYPE] ?? TIMEOUTS.query;
		const id = this._nextRequestId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pendingRequests.delete(id);
				reject(new Error(`Compass worker request timeout (${msg['type']}, ${resolvedTimeout}ms)`));
			}, resolvedTimeout);
			this._pendingRequests.set(id, {
				type: String(msg['type']),
				resolve: (data) => resolve(data as T),
				reject: (err) => reject(err),
				timer,
			});
			this._worker!.postMessage({ ...msg, id });
		});
	}

	private _setupWatcher(): void {
		this._watcher?.dispose();
		const extensions = [...CODE_EXTENSIONS].map(e => e.slice(1)).join(',');
		// Anchored to this folder, so another folder's edits never reach this index.
		this._watcher = this._platform.fileWatchers.watch(this._workspacePath, `**/*.{${extensions}}`);
		this._watcher.onDidChange(fsPath => this._onFileChange(fsPath));
		this._watcher.onDidCreate(fsPath => this._onFileChange(fsPath));
		this._watcher.onDidDelete(fsPath => this._onFileChange(fsPath));
	}

	private _onFileChange(fsPath: string): void {
		if (!this._config.autoReindex) return;
		this._pendingChangedFiles.add(fsPath);
		if (this._debounceTimer) clearTimeout(this._debounceTimer);
		this._debounceTimer = setTimeout(() => {
			this._handleRebuild(this._drainPendingChangedFiles());
		}, 500);
	}

	private _drainPendingChangedFiles(): string[] | undefined {
		const pending = [...this._pendingChangedFiles];
		this._pendingChangedFiles.clear();
		if (pending.length > MAX_WATCHED_CHANGED_FILES) return undefined;
		return pending.filter(this._isIndexableFile);
	}

	private _handleRebuild(changedFiles?: string[]): void {
		if (changedFiles?.length === 0) return;
		const request = changedFiles
			? { type: 'incrementalUpdate', changedFiles }
			: { type: 'incrementalUpdate' };
		this._sendRequest(request, TIMEOUTS.incrementalUpdate).catch(err => {
			log('[CompassService] Rebuild error: %O', err);
		});
	}

	getStatus(): IndexStatus {
		return this._cachedStatus;
	}

	async getGraphTerms(queryTerms: string[]): Promise<string[]> {
		if (!this._worker || this._cachedStatus.state !== 'ready') return [];
		return this._sendRequest<string[]>({ type: 'getGraphTerms', queryTerms });
	}

	async runPostProcess(options: { flows?: boolean; communities?: boolean; fts?: boolean }): Promise<void> {
		if (!this._worker) return;
		await this._sendRequest({ type: 'postprocess', ...options }, TIMEOUTS.postprocess);
	}

	async triggerReindex(): Promise<void> {
		if (this._retryTimer) {
			clearTimeout(this._retryTimer);
			this._retryTimer = null;
		}
		this._consecutiveFailures = 0;
		if (this._cachedStatus.state === 'failed') {
			this._cachedStatus = { ...this._cachedStatus, state: 'idle' };
			this._emitStatus();
		}
		await this.ensureInitialized();
		if (this._cachedStatus.readOnly) {
			this._platform.notifications
				.warn(t('The Compass index of {0} is read only: another Damocles app has updated it to a newer version. Update this Damocles to rebuild it.', this._workspacePath))
				.catch((err: unknown) => log('[CompassService] Read-only rebuild notice failed: %O', err));
			return;
		}
		this._handleRebuild();
	}

	// --- MCP proxy methods ---

	async mcpContext(input: Record<string, unknown>): Promise<string> {
		return this._sendRequest<string>({ type: 'mcp:context', input });
	}

	async mcpSearch(input: Record<string, unknown>): Promise<string> {
		return this._sendRequest<string>({ type: 'mcp:search', input });
	}

	async mcpQuery(input: Record<string, unknown>): Promise<string> {
		return this._sendRequest<string>({ type: 'mcp:query', input });
	}

	async mcpStats(): Promise<string> {
		return this._sendRequest<string>({ type: 'mcp:stats' });
	}

	async mcpBlastRadius(input: Record<string, unknown>): Promise<string> {
		return this._sendRequest<string>({ type: 'mcp:blastRadius', input });
	}

	async mcpReviewContext(input: Record<string, unknown>): Promise<string> {
		return this._sendRequest<string>({ type: 'mcp:reviewContext', input });
	}

	async mcpBuild(input: Record<string, unknown>): Promise<string> {
		return this._sendRequest<string>({ type: 'mcp:build', input }, TIMEOUTS.fullBuild);
	}

	async mcpDeadCode(input: Record<string, unknown>): Promise<string> {
		return this._sendRequest<string>({ type: 'mcp:deadCode', input });
	}

	// --- Webview proxy methods ---

	async webviewSearch(query: string, kind?: string, limit?: number): Promise<unknown[]> {
		return this._sendRequest<unknown[]>({ type: 'webview:search', query, kind, limit });
	}

	async webviewGraph(maxNodes?: number, communityId?: number): Promise<unknown> {
		return this._sendRequest({ type: 'webview:graph', maxNodes, communityId });
	}

	async webviewBlastRadius(filePath: string, depth?: number): Promise<unknown> {
		return this._sendRequest({ type: 'webview:blastRadius', filePath, depth });
	}

	async webviewValidation(): Promise<unknown> {
		return this._sendRequest({ type: 'webview:validation' });
	}

	// --- Tree proxy methods ---

	async treeGetFiles(): Promise<string[]> {
		return this._sendRequest<string[]>({ type: 'tree:files' });
	}

	async treeGetNodesByFile(filePath: string): Promise<unknown[]> {
		return this._sendRequest<unknown[]>({ type: 'tree:nodesByFile', filePath });
	}

	async treeGetEdgesForSymbol(qualifiedName: string): Promise<unknown> {
		return this._sendRequest({ type: 'tree:edgesForSymbol', qualifiedName });
	}

	/** Deferred startup: the index was withheld while the workspace was untrusted. */
	private _onWorkspaceTrustGranted(): void {
		if (this._disposed || !this._startRequested) return;
		if (!this.isEnabled) return;
		this.ensureInitialized().catch(err => {
			log('[CompassService] Init after trust grant failed: %O', err);
		});
	}

	async dispose(): Promise<void> {
		this._disposed = true;
		this._trustListener?.dispose();
		this._trustListener = null;
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = null;
		}
		this._pendingChangedFiles.clear();
		if (this._retryTimer) {
			clearTimeout(this._retryTimer);
			this._retryTimer = null;
		}
		this._consecutiveFailures = 0;
		this._watcher?.dispose();
		this._watcher = null;

		const worker = this._worker;
		if (worker) {
			// A dispose request queues behind heavy work until it times out, and the WAL store already
			// holds every committed write, so a busy worker is terminated at once.
			if (!this._heavyRequestInFlight()) {
				try {
					await this._sendRequest({ type: 'dispose' }, TIMEOUTS.dispose);
				} catch (err) {
					log('[CompassService] Failed to dispose worker gracefully: %O', err);
				}
			}
			worker.terminate();
			this._worker = null;
		}

		this._rejectAllPending(new Error('CompassService disposed'));
		this._initPromise = null;
		this._cachedStatus = {
			state: 'idle', fileCount: 0, nodeCount: 0, edgeCount: 0,
			communityCount: 0, flowCount: 0, lastIndexedAt: null,
		};
		this._statusChangeCallbacks = [];
		this._progressCallbacks = [];
	}
}
