import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { log } from '../logger';
import type { ICompassService, IndexStatus, IndexState, CompassConfig } from './types';
import { CODE_EXTENSIONS } from './types';
import { setGrammarDir, clearParsers } from './parser-manager';
import { GraphStore } from './database';
import { searchNodes, expandGraphTerms } from './search';
import { fullBuild, incrementalUpdate } from './incremental';
import { traceFlows, storeFlows } from './flows';
import { detectCommunities, storeCommunities } from './communities';
import { CompassTreeProvider, BlastRadiusTreeProvider, CompassStatusBar, registerBlastRadiusCommand } from './tree-provider';
import { BlastRadiusDecorations } from './editor-decorations';

export class CompassService implements ICompassService {
	private _config: CompassConfig;
	private _initPromise: Promise<void> | null = null;
	private _state: IndexState = 'idle';
	private _fileCount = 0;
	private _lastIndexedAt: number | null = null;
	private _error: string | undefined;
	private _isRebuildInProgress = false;
	private _pendingRebuild = false;
	private _watcher: vscode.FileSystemWatcher | null = null;
	private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _statusChangeCallbacks: Array<(status: IndexStatus) => void> = [];
	private _workspacePath: string;
	private _extensionPath: string;
	private _store: GraphStore | null = null;
	private _mcpModules: {
		createSdkMcpServer: typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
		tool: typeof import('@anthropic-ai/claude-agent-sdk').tool;
		z: typeof import('zod').z;
	} | null = null;
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
			maxFiles: config.get<number>('maxFiles', 5000),
			maxNodes: config.get<number>('maxNodes', 20000),
			autoReindex: config.get<boolean>('autoReindex', true),
		};
	}

	get isEnabled(): boolean {
		return vscode.workspace.getConfiguration('damocles.compass').get<boolean>('enabled', false);
	}

	get store(): GraphStore {
		if (!this._store || !this._store.isOpen) throw new Error('GraphStore not initialized');
		return this._store;
	}

	get config(): CompassConfig {
		return this._config;
	}

	onStatusChange(callback: (status: IndexStatus) => void): void {
		this._statusChangeCallbacks.push(callback);
	}

	private _emitStatus(): void {
		const status = this.getStatus();
		for (const cb of this._statusChangeCallbacks) cb(status);
	}

	async ensureInitialized(): Promise<void> {
		if (!this.isEnabled) return;
		if (this._state === 'ready') return;
		if (!this._initPromise) {
			this._state = 'idle';
			this._error = undefined;
			this._initPromise = this._doInit().catch(err => {
				this._initPromise = null;
				this._state = 'error';
				this._error = err instanceof Error ? err.message : String(err);
				this._emitStatus();
				log('[CompassService] Init failure: %O', err);
				throw err;
			});
		}
		return this._initPromise;
	}

	private async _doInit(): Promise<void> {
		this._state = 'indexing';
		this._emitStatus();
		setGrammarDir(path.join(this._extensionPath, 'resources', 'grammars'));

		const hash = crypto.createHash('sha256').update(this._workspacePath).digest('hex').slice(0, 12);
		const dbPath = path.join(os.homedir(), '.damocles', 'compass', hash, 'graph.db');
		this._store = new GraphStore(dbPath);
		await this._store.open(this._extensionPath);

		const oldCacheDir = path.join(os.homedir(), '.damocles', 'compass-cache');
		fs.promises.rm(oldCacheDir, { recursive: true, force: true }).catch(() => {});

		await this._buildIndex();

		if (this._config.autoReindex) {
			this._setupWatcher();
		}
	}

	private async _buildIndex(): Promise<void> {
		if (!this._store?.isOpen) return;
		const result = await fullBuild(this._store, this._workspacePath, this._config);
		this._fileCount = result.filesParsed;
		log('[CompassService] Build: %d files, %d nodes, %d edges, %d errors',
			result.filesParsed, result.totalNodes, result.totalEdges, result.errors.length);

		await this.runPostProcess({ flows: true, communities: true });

		this._state = 'ready';
		this._lastIndexedAt = Date.now();
		this._emitStatus();
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

	private async _handleRebuild(): Promise<void> {
		if (this._isRebuildInProgress) {
			this._pendingRebuild = true;
			return;
		}

		this._isRebuildInProgress = true;
		this._state = 'indexing';
		this._emitStatus();

		try {
			if (this._store?.isOpen) {
				await incrementalUpdate(this._store, this._workspacePath);
				await this.runPostProcess({ flows: true, communities: true });
				await this._store.serialize();
			}
			this._state = 'ready';
			this._lastIndexedAt = Date.now();
			this._emitStatus();
		} catch (err) {
			this._state = 'error';
			this._error = err instanceof Error ? err.message : String(err);
			this._emitStatus();
			log('[CompassService] Rebuild error: %O', err);
		} finally {
			this._isRebuildInProgress = false;
			if (this._pendingRebuild) {
				this._pendingRebuild = false;
				this._handleRebuild().catch(err => {
					log('[CompassService] Queued rebuild error: %O', err);
				});
			}
		}
	}

	getStatus(): IndexStatus {
		const storeOpen = this._store?.isOpen ?? false;
		return {
			state: this._state,
			fileCount: this._fileCount,
			nodeCount: storeOpen ? this._store!.getNodeCount() : 0,
			edgeCount: storeOpen ? this._store!.getEdgeCount() : 0,
			communityCount: storeOpen ? this._store!.getCommunityCount() : 0,
			flowCount: storeOpen ? this._store!.getFlowCount() : 0,
			lastIndexedAt: this._lastIndexedAt,
			...(this._error ? { error: this._error } : {}),
		};
	}

	getGraphTerms(queryTerms: string[]): string[] {
		if (!this._store?.isOpen) return [];
		return expandGraphTerms(this._store, queryTerms);
	}

	async runPostProcess(options: { flows?: boolean; communities?: boolean; fts?: boolean }): Promise<void> {
		if (!this._store?.isOpen) return;
		if (options.flows) {
			const flows = traceFlows(this._store);
			storeFlows(this._store, flows);
		}
		if (options.communities) {
			const communities = detectCommunities(this._store);
			storeCommunities(this._store, communities);
		}
		if (options.fts) {
			this._store.execRaw("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
		}
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
		await this._handleRebuild();
	}

	registerViews(context: vscode.ExtensionContext): void {
		if (!this.isEnabled) return;

		const getStore = () => this._store?.isOpen ? this._store : undefined;

		this._treeProvider = new CompassTreeProvider(getStore, this._workspacePath);
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
				if (!this._store?.isOpen) {
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
					timer = setTimeout(() => {
						const results = searchNodes(this._store!, value, { limit: 20 });
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

		registerBlastRadiusCommand(context, getStore, this._blastRadiusProvider);

		this.onStatusChange(() => {
			this._treeProvider?.refresh();
			this._statusBar?.update(getStore());
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
		if (this._store?.isOpen) {
			try {
				await this._store.serialize();
			} catch (err) {
				log('[CompassService] Failed to serialize graph on dispose: %O', err);
			}
			this._store.close();
		}
		this._store = null;
		this._initPromise = null;
		this._state = 'idle';
		this._statusChangeCallbacks = [];
		clearParsers();
	}
}
