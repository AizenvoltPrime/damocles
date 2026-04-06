import * as vscode from 'vscode';
import * as path from 'path';
import { log } from '../logger';
import type { CompassGraph, CompassConfig, CommunityMap, IndexStatus, IndexState, ExtractionResult, QueryResult } from './types';
import { CODE_EXTENSIONS } from './types';
import { collectFiles } from './detect';
import { checkCache, saveCachedWithHash, getCacheDir } from './cache';
import { buildGraph } from './build';
import { cluster } from './cluster';
import { godNodes } from './analyze';
import * as query from './query';
import { resolveCrossFileImports } from './cross-file-resolver';
import { createCompassMcpServer } from './mcp-server';
import { clearParsers, setGrammarDir } from './parser-manager';

export class CompassService {
	private _config: CompassConfig;
	private _initPromise: Promise<void> | null = null;
	private _graph: CompassGraph | null = null;
	private _communities: CommunityMap = {};
	private _communityLabels: Record<number, string> = {};
	private _state: IndexState = 'idle';
	private _fileCount = 0;
	private _lastIndexedAt: number | null = null;
	private _error: string | undefined;
	private _isRebuildInProgress = false;
	private _pendingRebuild = false;
	private _watcher: vscode.FileSystemWatcher | null = null;
	private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _statusChangeCallback: ((status: IndexStatus) => void) | null = null;
	private _workspacePath: string;
	private _damoclesDir: string;
	private _extensionPath: string;
	private _mcpModules: {
		createSdkMcpServer: typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
		tool: typeof import('@anthropic-ai/claude-agent-sdk').tool;
		z: typeof import('zod').z;
	} | null = null;

	constructor(workspacePath: string, damoclesDir: string, extensionPath: string) {
		this._workspacePath = workspacePath;
		this._damoclesDir = damoclesDir;
		this._extensionPath = extensionPath;
		const config = vscode.workspace.getConfiguration('damocles.compass');
		this._config = {
			excludePatterns: config.get<string[]>('excludePatterns', []),
			maxFiles: config.get<number>('maxFiles', 5000),
			autoReindex: config.get<boolean>('autoReindex', true),
		};
	}

	get isEnabled(): boolean {
		return vscode.workspace.getConfiguration('damocles.compass').get<boolean>('enabled', false);
	}

	onStatusChange(callback: (status: IndexStatus) => void): void {
		this._statusChangeCallback = callback;
	}

	private _emitStatus(): void {
		this._statusChangeCallback?.(this.getStatus());
	}

	async ensureInitialized(): Promise<void> {
		if (!this.isEnabled) return;
		if (this._graph) return;
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
		await this._buildIndex();

		if (this._config.autoReindex) {
			this._setupWatcher();
		}
	}

	private async _buildIndex(): Promise<void> {
		const files = collectFiles(
			this._workspacePath,
			this._config.excludePatterns,
			this._config.maxFiles,
		);

		this._fileCount = files.length;

		if (files.length === 0) {
			this._state = 'ready';
			this._lastIndexedAt = Date.now();
			this._emitStatus();
			return;
		}

		if (files.length >= this._config.maxFiles) {
			log(`[CompassService] Warning: file count (${files.length}) hit maxFiles cap (${this._config.maxFiles})`);
		}

		const cacheDir = getCacheDir(this._damoclesDir, this._workspacePath);
		const { cached, uncached } = checkCache(files, cacheDir);

		const extractions: ExtractionResult[] = [...cached];

		if (uncached.length > 0) {
			const { extractFile } = await import('./extractors/index');
			for (const { filePath, hash } of uncached) {
				try {
					const result = await extractFile(filePath, this._workspacePath);
					if (result.nodes.length > 0) {
						extractions.push(result);
						saveCachedWithHash(hash, result, cacheDir);
					}
				} catch (err) {
					log(`[CompassService] Extraction error for ${filePath}: %O`, err);
				}
			}
		}

		const resolved = resolveCrossFileImports(extractions);
		this._graph = buildGraph(resolved);
		this._communities = cluster(this._graph);

		for (const [cidStr, nodes] of Object.entries(this._communities)) {
			const cid = Number(cidStr);
			const topLabels = nodes.slice(0, 3).map((n: string) =>
				this._graph!.getNodeAttribute(n, 'label') ?? n
			);
			this._communityLabels[cid] = topLabels.join(', ');
		}

		this._state = 'ready';
		this._lastIndexedAt = Date.now();
		this._emitStatus();
		log(`[CompassService] Indexed: ${this._graph.order} nodes, ${this._graph.size} edges, ${Object.keys(this._communities).length} communities`);
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
			await this._buildIndex();
		} catch (err) {
			this._state = 'error';
			this._error = err instanceof Error ? err.message : String(err);
			this._emitStatus();
			log('[CompassService] Rebuild error: %O', err);
		} finally {
			this._isRebuildInProgress = false;
			if (this._pendingRebuild) {
				this._pendingRebuild = false;
				this._handleRebuild();
			}
		}
	}

	getStatus(): IndexStatus {
		return {
			state: this._state,
			fileCount: this._fileCount,
			nodeCount: this._graph?.order ?? 0,
			edgeCount: this._graph?.size ?? 0,
			communityCount: Object.keys(this._communities).length,
			lastIndexedAt: this._lastIndexedAt,
			...(this._error ? { error: this._error } : {}),
		};
	}

	queryGraph(
		question: string,
		mode: 'bfs' | 'dfs' = 'bfs',
		depth = 3,
		tokenBudget = 2000,
	): QueryResult | null {
		if (!this._graph) return null;
		return query.queryGraph(this._graph, question, mode, depth, tokenBudget);
	}

	getNode(label: string): string | null {
		if (!this._graph) return null;
		return query.getNodeInfo(this._graph, label);
	}

	getNeighbors(label: string, relationFilter?: string): string | null {
		if (!this._graph) return null;
		return query.getNeighbors(this._graph, label, relationFilter);
	}

	shortestPath(source: string, target: string, maxHops = 8): string | null {
		if (!this._graph) return null;
		const result = query.shortestPath(this._graph, source, target, maxHops);
		return typeof result === 'string' ? result : result.text;
	}

	getGodNodes(topN = 10): string | null {
		if (!this._graph) return null;
		const nodes = godNodes(this._graph, topN);
		const lines = ['God nodes (most connected):'];
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			if (node) lines.push(`  ${i + 1}. ${node.label} - ${node.edges} edges`);
		}
		return lines.join('\n');
	}

	getCommunity(communityId: number): string | null {
		if (!this._graph) return null;
		return query.getCommunityInfo(this._graph, this._communities, communityId);
	}

	getGraphStats(): string | null {
		if (!this._graph) return null;
		return query.getGraphStats(this._graph, this._communities);
	}

	triggerReindex(): void {
		this._handleRebuild();
	}

	searchNodes(terms: string[]): string[] {
		if (!this._graph) return [];
		const scored = query.scoreNodes(this._graph, terms);
		return scored.slice(0, 20).map(([, nid]) => {
			const label = this._graph!.getNodeAttribute(nid, 'label') ?? nid;
			return label;
		});
	}

	getGraphTerms(queryTerms: string[]): string[] {
		if (!this._graph) return [];
		const scored = query.scoreNodes(this._graph, queryTerms);
		const terms = new Set<string>();

		for (const [, nid] of scored.slice(0, 5)) {
			const label = this._graph.getNodeAttribute(nid, 'label') ?? '';
			if (label) {
				const parts = label.replace(/[()]/g, '').replace(/\./g, ' ').split(/\s+/);
				for (const p of parts) {
					if (p.length > 2) terms.add(p.toLowerCase());
				}
			}
			this._graph.forEachNeighbor(nid, neighbor => {
				const nLabel = this._graph!.getNodeAttribute(neighbor, 'label') ?? '';
				if (nLabel) {
					const parts = nLabel.replace(/[()]/g, '').replace(/\./g, ' ').split(/\s+/);
					for (const p of parts) {
						if (p.length > 2) terms.add(p.toLowerCase());
					}
				}
			});
		}

		return [...terms].slice(0, 20);
	}

	getMcpServerConfig(getSessionId: () => string, workspace: string): unknown {
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
			return createCompassMcpServer(
				this, createSdkMcpServer, tool, z, getSessionId, workspace,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log(`[CompassService] Failed to create MCP server: ${message}`);
			return null;
		}
	}

	dispose(): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = null;
		}
		this._watcher?.dispose();
		this._watcher = null;
		this._graph = null;
		this._communities = {};
		this._communityLabels = {};
		this._initPromise = null;
		this._state = 'idle';
		this._statusChangeCallback = null;
		clearParsers();
	}
}
