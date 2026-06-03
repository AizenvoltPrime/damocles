import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { Worker } from 'worker_threads';
import { log } from '../logger';
import type { ICompassService, IndexStatus, CompassConfig } from './types';
import { CODE_EXTENSIONS } from './types';
import type { WorkerEvent, WorkerProgressEvent } from './worker-protocol';
import { TIMEOUTS, TIMEOUTS_BY_TYPE } from './worker-protocol';

export type { WorkerProgressEvent } from './worker-protocol';
import { CompassTreeProvider, BlastRadiusTreeProvider, CompassStatusBar, registerBlastRadiusCommand } from './tree-provider';
import { BlastRadiusDecorations } from './editor-decorations';

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class CompassService implements ICompassService {
	private _config: CompassConfig;
	private _initPromise: Promise<void> | null = null;
	private _worker: Worker | null = null;
	private _nextRequestId = 1;
	private _pendingRequests = new Map<number, PendingRequest>();
	private _cachedStatus: IndexStatus = {
		state: 'idle', fileCount: 0, nodeCount: 0, edgeCount: 0,
		communityCount: 0, flowCount: 0, lastIndexedAt: null,
	};
	private _statusChangeCallbacks: Array<(status: IndexStatus) => void> = [];
	private _progressCallbacks: Array<(event: WorkerProgressEvent) => void> = [];
	private _workspacePath: string;
	private _extensionPath: string;
	private _mcpModules: {
		createSdkMcpServer: typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
		tool: typeof import('@anthropic-ai/claude-agent-sdk').tool;
		z: typeof import('zod').z;
	} | null = null;
	private _watcher: vscode.FileSystemWatcher | null = null;
	private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _treeProvider: CompassTreeProvider | null = null;
	private _blastRadiusProvider: BlastRadiusTreeProvider | null = null;
	private _statusBar: CompassStatusBar | null = null;
	private _decorations: BlastRadiusDecorations | null = null;
	private _viewDisposables: vscode.Disposable[] = [];

	constructor(workspacePath: string, _damoclesDir: string, extensionPath: string) {
		this._workspacePath = workspacePath;
		this._extensionPath = extensionPath;
		const config = vscode.workspace.getConfiguration('damocles.compass');
		this._config = {
			excludePatterns: config.get<string[]>('excludePatterns', []),
			autoReindex: config.get<boolean>('autoReindex', true),
		};
	}

	get isEnabled(): boolean {
		return vscode.workspace.getConfiguration('damocles.compass').get<boolean>('enabled', false);
	}

	get config(): CompassConfig {
		return this._config;
	}

	onStatusChange(callback: (status: IndexStatus) => void): void {
		this._statusChangeCallbacks.push(callback);
	}

	onProgress(callback: (event: WorkerProgressEvent) => void): void {
		this._progressCallbacks.push(callback);
	}

	private _emitStatus(): void {
		const status = this._cachedStatus;
		for (const cb of this._statusChangeCallbacks) cb(status);
	}

	async ensureInitialized(): Promise<void> {
		if (!this.isEnabled) return;
		if (this._workspacePath === os.homedir()) return;
		if (this._cachedStatus.state === 'ready' && this._worker) return;
		if (!this._initPromise) {
			const { error: _unused, ...rest } = this._cachedStatus;
			this._cachedStatus = { ...rest, state: 'idle' };
			this._initPromise = this._doInit().catch(err => {
				this._initPromise = null;
				this._cachedStatus = {
					...this._cachedStatus,
					state: 'error',
					error: err instanceof Error ? err.message : String(err),
				};
				this._emitStatus();
				log('[CompassService] Init failure: %O', err);
				throw err;
			});
		}
		return this._initPromise;
	}

	private async _doInit(): Promise<void> {
		this._cachedStatus = { ...this._cachedStatus, state: 'indexing' };
		this._emitStatus();

		const workerPath = path.join(this._extensionPath, 'dist', 'compass-worker.js');
		this._worker = new Worker(workerPath);
		this._worker.on('message', (msg: WorkerEvent) => this._onWorkerMessage(msg));
		this._worker.on('error', (err: Error) => this._onWorkerError(err));
		this._worker.on('exit', (code: number) => this._onWorkerExit(code));

		await this._sendRequest<IndexStatus>({
			type: 'init',
			workspacePath: this._workspacePath,
			extensionPath: this._extensionPath,
			config: this._config,
		}, TIMEOUTS.init);

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
		}
	}

	private _onWorkerError(err: Error): void {
		if (!this._worker) return;
		log('[CompassService] Worker error: %O', err);
		this._cachedStatus = {
			...this._cachedStatus,
			state: 'error',
			error: err.message,
		};
		this._emitStatus();
		this._rejectAllPending(err);
		this._worker = null;
		this._initPromise = null;
	}

	private _onWorkerExit(code: number): void {
		if (!this._worker) return;
		if (code !== 0) {
			log('[CompassService] Worker exited with code %d', code);
			this._cachedStatus = {
				...this._cachedStatus,
				state: 'error',
				error: `Worker exited with code ${code}`,
			};
			this._emitStatus();
			this._rejectAllPending(new Error(`Worker exited with code ${code}`));
			this._worker = null;
			this._initPromise = null;
		}
	}

	private _rejectAllPending(err: Error): void {
		for (const [id, pending] of this._pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(err);
			this._pendingRequests.delete(id);
		}
	}

	private _sendRequest<T>(msg: Record<string, unknown>, timeoutMs?: number): Promise<T> {
		if (!this._worker) return Promise.reject(new Error('Worker not initialized'));
		const resolvedTimeout = timeoutMs ?? TIMEOUTS_BY_TYPE[msg['type'] as keyof typeof TIMEOUTS_BY_TYPE] ?? TIMEOUTS.query;
		const id = this._nextRequestId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pendingRequests.delete(id);
				reject(new Error(`Compass worker request timeout (${msg['type']}, ${resolvedTimeout}ms)`));
			}, resolvedTimeout);
			this._pendingRequests.set(id, {
				resolve: (data) => resolve(data as T),
				reject: (err) => reject(err),
				timer,
			});
			this._worker!.postMessage({ ...msg, id });
		});
	}

	private _setupWatcher(): void {
		const extensions = [...CODE_EXTENSIONS].map(e => e.slice(1)).join(',');
		this._watcher = vscode.workspace.createFileSystemWatcher(`**/*.{${extensions}}`);
		this._watcher.onDidChange(uri => this._onFileChange(uri));
		this._watcher.onDidCreate(uri => this._onFileChange(uri));
		this._watcher.onDidDelete(uri => this._onFileChange(uri));
	}

	private _onFileChange(_uri: vscode.Uri): void {
		if (!this._config.autoReindex) return;
		if (this._debounceTimer) clearTimeout(this._debounceTimer);
		this._debounceTimer = setTimeout(() => {
			this._handleRebuild();
		}, 500);
	}

	private _handleRebuild(): void {
		this._sendRequest({ type: 'incrementalUpdate' }, TIMEOUTS.incrementalUpdate).catch(err => {
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

	getMcpServerConfig(_getSessionId: () => string, _workspace: string): unknown {
		if (!this.isEnabled) return null;

		try {
			if (!this._mcpModules) {
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const sdk = require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk');
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const zod = require('zod') as typeof import('zod');
				this._mcpModules = { createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool, z: zod.z };
			}
			const { createSdkMcpServer, tool, z } = this._mcpModules;
			const { createCompassMcpServer } = require('./mcp-server') as typeof import('./mcp-server');
			return createCompassMcpServer(
				this, createSdkMcpServer, tool, z, _getSessionId, _workspace,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log(`[CompassService] Failed to create MCP server: ${message}`);
			return null;
		}
	}

	async triggerReindex(): Promise<void> {
		await this.ensureInitialized();
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

	registerViews(context: vscode.ExtensionContext): void {
		if (!this.isEnabled) return;

		this._treeProvider = new CompassTreeProvider(this, this._workspacePath);
		this._blastRadiusProvider = new BlastRadiusTreeProvider();
		this._statusBar = new CompassStatusBar();
		this._decorations = new BlastRadiusDecorations();

		this._viewDisposables.push(
			vscode.window.registerTreeDataProvider('damocles.compass.explorer', this._treeProvider),
			vscode.window.registerTreeDataProvider('damocles.compass.blastRadius', this._blastRadiusProvider),
			this._statusBar,
			this._decorations,
		);

		this._viewDisposables.push(
			vscode.commands.registerCommand('damocles.compass.rebuild', () => {
				this.triggerReindex();
			}),
			vscode.commands.registerCommand('damocles.compass.search', async () => {
				if (this._cachedStatus.state !== 'ready') {
					vscode.window.showWarningMessage('Compass: Graph not built yet.');
					return;
				}
				const pick = vscode.window.createQuickPick();
				pick.placeholder = 'Search for functions, classes, files, types…';
				pick.matchOnDescription = true;
				let timer: ReturnType<typeof setTimeout> | undefined;
				pick.onDidChangeValue(value => {
					if (timer) clearTimeout(timer);
					if (!value) { pick.items = []; return; }
					timer = setTimeout(async () => {
						const results = await this.webviewSearch(value, undefined, 20) as Array<{ node: { name: string; kind: string; file_path: string; line_start: number }; score: number }>;
						pick.items = results.map(r => ({
							label: `$(${r.node.kind === 'Function' ? 'symbol-method' : r.node.kind === 'Class' ? 'symbol-class' : r.node.kind === 'Type' ? 'symbol-interface' : r.node.kind === 'Test' ? 'beaker' : 'file'}) ${r.node.name}`,
							description: r.node.kind,
							detail: `${r.node.file_path}:${r.node.line_start}`,
							node: r.node,
						} as vscode.QuickPickItem & { node: typeof r.node }));
					}, 100);
				});
				pick.onDidAccept(() => {
					const selected = pick.selectedItems[0] as (vscode.QuickPickItem & { node?: { file_path: string; line_start: number } }) | undefined;
					pick.dispose();
					if (selected?.node) {
						const line = Math.max(0, selected.node.line_start - 1);
						vscode.window.showTextDocument(vscode.Uri.file(selected.node.file_path), {
							selection: new vscode.Range(line, 0, line, 0),
						});
					}
				});
				pick.onDidHide(() => { if (timer) clearTimeout(timer); pick.dispose(); });
				pick.show();
			}),
		);

		registerBlastRadiusCommand(context, this, this._blastRadiusProvider);

		this.onStatusChange(() => {
			this._treeProvider?.refresh();
			this._statusBar?.update(this._cachedStatus);
		});

		this._statusBar.show();
		for (const d of this._viewDisposables) context.subscriptions.push(d);
	}

	async dispose(): Promise<void> {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = null;
		}
		this._watcher?.dispose();
		this._watcher = null;
		this._decorations?.dispose();
		this._decorations = null;
		this._statusBar?.dispose();
		this._statusBar = null;
		this._treeProvider?.dispose();
		this._treeProvider = null;
		this._blastRadiusProvider?.dispose();
		this._blastRadiusProvider = null;

		if (this._worker) {
			try {
				await this._sendRequest({ type: 'dispose' }, TIMEOUTS.dispose);
			} catch (err) {
				log('[CompassService] Failed to dispose worker gracefully: %O', err);
			}
			this._worker.terminate();
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
