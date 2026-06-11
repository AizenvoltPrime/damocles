import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import type { WorkerRequest, WorkerEvent } from './worker-protocol';
import { VALIDATION_BUSY_MESSAGE } from './worker-protocol';
import type { IndexStatus, CompassConfig } from './types';
import { setGrammarDir, clearParsers } from './parser-manager';
import { GraphStore } from './database';
import { searchNodes, expandGraphTerms } from './search';
import { fullBuild, incrementalUpdate } from './incremental';
import { runPostProcess as runSharedPostProcess } from './post-process';
import { computeBlastRadius } from './impact';
import { collectFiles } from './detect';
import { getCommunities } from './communities';
import {
	handleContext, handleSearch, handleQuery, handleStats,
	handleBlastRadius, handleReviewContext,
	handleBuild, handleDeadCode,
} from './mcp-handlers';
import { mapWithConcurrency } from './util';
import { createWorkerCore } from './worker-core';

if (!parentPort) throw new Error('compass-worker must run as a worker thread');

const port = parentPort;

let store: GraphStore | null = null;
let workspacePath = '';
let config: CompassConfig = { excludePatterns: [], autoReindex: true };

const LIGHT_TYPES: Set<WorkerRequest['type']> = new Set([
	'getStatus',
	'getGraphTerms',
	'mcp:context',
	'mcp:search',
	'mcp:query',
	'mcp:stats',
	'mcp:blastRadius',
	'mcp:reviewContext',
	'mcp:deadCode',
	'webview:search',
	'webview:graph',
	'webview:blastRadius',
	'tree:files',
	'tree:nodesByFile',
	'tree:edgesForSymbol',
	'serialize',
]);

let indexingInProgress = false;

async function withIndexingFlag<T>(work: () => Promise<T>): Promise<T> {
	indexingInProgress = true;
	try {
		return await work();
	} finally {
		indexingInProgress = false;
	}
}

const core = createWorkerCore({
	dispatch: msg => dispatch(msg),
	send: msg => send(msg),
	isInTransaction: () => store !== null && store.isOpen && store.inTransaction(),
	makeErrorStatus: error => ({ type: 'status', status: makeStatus('error', { error }) }),
});

function enqueueDeferredSerialize(): void {
	core.enqueueLight({ type: 'serialize', id: -1 });
}

function send(msg: WorkerEvent): void {
	port.postMessage(msg);
}

function emitStatus(status: IndexStatus): void {
	send({ type: 'status', status });
}

function emitProgress(phase: 'build' | 'postprocess' | 'serialize', current: number, total: number, label?: string): void {
	send({ type: 'progress', phase, current, total, ...(label ? { label } : {}) });
}

function workerLog(message: string): void {
	send({ type: 'log', message });
}

function makeStatus(state: IndexStatus['state'], extra?: Partial<IndexStatus>): IndexStatus {
	const storeOpen = store?.isOpen ?? false;
	return {
		state,
		fileCount: storeOpen ? (store!.getStats().files_count) : 0,
		nodeCount: storeOpen ? store!.getNodeCount() : 0,
		edgeCount: storeOpen ? store!.getEdgeCount() : 0,
		communityCount: storeOpen ? store!.getCommunityCount() : 0,
		flowCount: storeOpen ? store!.getFlowCount() : 0,
		lastIndexedAt: null,
		...extra,
	};
}

async function handleInit(msg: Extract<WorkerRequest, { type: 'init' }>): Promise<IndexStatus> {
	workspacePath = msg.workspacePath;
	config = msg.config;

	setGrammarDir(path.join(msg.extensionPath, 'resources', 'grammars'));

	try {
		const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
		const dbPath = path.join(os.homedir(), '.damocles', 'compass', hash, 'graph.db');
		const openStore = new GraphStore(dbPath);
		store = openStore;
		await openStore.open(msg.extensionPath);

		return await withIndexingFlag(async () => {
			emitStatus(makeStatus('indexing'));

			const result = await fullBuild(openStore, workspacePath, config, async (current, total) => {
				emitProgress('build', current, total);
				await scheduler.yield();
			});
			workerLog(`[Worker] Build: ${result.filesParsed} files, ${result.totalNodes} nodes, ${result.totalEdges} edges, ${result.errors.length} errors`);

			emitProgress('postprocess', 0, 1);
			await scheduler.yield();
			await runPostProcess({ flows: true, communities: true });

			emitProgress('serialize', 0, 1);
			await scheduler.yield();
			await openStore.serialize();

			const status = makeStatus('ready', { lastIndexedAt: Date.now() });
			emitStatus(status);
			return status;
		});
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		emitStatus(makeStatus('error', { error }));
		throw err;
	}
}

async function runPostProcess(options: { flows?: boolean; communities?: boolean; fts?: boolean }): Promise<void> {
	if (!store?.isOpen) return;
	await runSharedPostProcess(store, options, () => scheduler.yield());
}

async function handleIncrementalUpdate(msg: Extract<WorkerRequest, { type: 'incrementalUpdate' }>): Promise<IndexStatus> {
	return withIndexingFlag(async () => {
		emitStatus(makeStatus('indexing'));
		try {
			if (store?.isOpen) {
				await incrementalUpdate(store, workspacePath, msg.base, msg.changedFiles, async (current, total) => {
					emitProgress('build', current, total);
					await scheduler.yield();
				});

				emitProgress('postprocess', 0, 1);
				await scheduler.yield();
				await runPostProcess({ flows: true, communities: true });

				emitProgress('serialize', 0, 1);
				await scheduler.yield();
				await store.serialize();
			}
			const status = makeStatus('ready', { lastIndexedAt: Date.now() });
			emitStatus(status);
			return status;
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			const status = makeStatus('error', { error });
			emitStatus(status);
			throw err;
		}
	});
}

function handleWebviewSearch(query: string, kind?: string, limit?: number) {
	if (!store?.isOpen) return [];
	const results = searchNodes(store, query, {
		kind: kind as import('./types').NodeKind | undefined,
		limit: limit ?? 30,
	});
	return results.map(r => ({
		node: {
			id: r.node.id,
			kind: r.node.kind,
			name: r.node.name,
			qualified_name: r.node.qualified_name,
			file_path: r.node.file_path,
			line_start: r.node.line_start,
			line_end: r.node.line_end,
			language: r.node.language,
			community_id: r.node.community_id,
		},
		score: r.score,
	}));
}

function handleWebviewGraph(maxNodes?: number, communityId?: number) {
	if (!store?.isOpen) return { nodes: [], edges: [], communities: [] };
	const limit = maxNodes ?? 500;
	const nodes = store.getNodesLimited(limit, communityId);
	const qnSet = new Set(nodes.map(n => n.qualified_name));
	const edges = store.getEdgesAmong(qnSet);
	const comms = getCommunities(store);

	return {
		nodes: nodes.map(n => ({
			id: n.id, kind: n.kind, name: n.name,
			qualified_name: n.qualified_name, file_path: n.file_path,
			line_start: n.line_start, line_end: n.line_end,
			language: n.language, community_id: n.community_id,
		})),
		edges: edges.map(e => ({
			id: e.id, kind: e.kind,
			source_qualified: e.source_qualified, target_qualified: e.target_qualified,
			file_path: e.file_path,
		})),
		communities: comms.map(c => ({
			id: c.id, name: c.name, size: c.size,
			cohesion: c.cohesion, dominant_language: c.dominant_language,
			description: c.description,
		})),
	};
}

function handleWebviewBlastRadius(filePath: string, depth?: number) {
	if (!store?.isOpen) return { changed_nodes: [], impacted_nodes: [], impacted_files: [], edges: [], total_impacted: 0, truncated: false };
	const d = depth ?? 2;
	const impact = computeBlastRadius(store, [filePath], d, undefined, workspacePath);
	return {
		changed_files: [filePath],
		changed_nodes: impact.changed_nodes.map(n => ({
			id: n.id, kind: n.kind, name: n.name,
			qualified_name: n.qualified_name, file_path: n.file_path,
			line_start: n.line_start, line_end: n.line_end,
			language: n.language, community_id: n.community_id,
		})),
		impacted_nodes: impact.impacted_nodes.map(n => ({
			id: n.id, kind: n.kind, name: n.name,
			qualified_name: n.qualified_name, file_path: n.file_path,
			line_start: n.line_start, line_end: n.line_end,
			language: n.language, community_id: n.community_id,
		})),
		impacted_files: impact.impacted_files,
		edges: impact.edges.map(e => ({
			id: e.id, kind: e.kind,
			source_qualified: e.source_qualified, target_qualified: e.target_qualified,
			file_path: e.file_path,
		})),
		total_impacted: impact.total_impacted,
		truncated: impact.truncated,
	};
}

async function handleWebviewValidation() {
	if (!store?.isOpen) throw new Error('Store not initialized');

	const allFiles = store.getAllFiles();
	const staleFilesRemoved: string[] = [];
	const existChecks = await mapWithConcurrency(allFiles, 64, fp =>
		fs.promises.access(fp).then(() => true, () => false),
	);
	for (let i = 0; i < allFiles.length; i++) {
		if (!existChecks[i]) staleFilesRemoved.push(allFiles[i]!);
	}
	if (staleFilesRemoved.length > 0) {
		const openStore = store;
		openStore.withTransaction(() => {
			for (const fp of staleFilesRemoved) {
				openStore.removeFileData(fp);
			}
		});
	}

	const validation = store.runValidation();
	const wsFiles = collectFiles(workspacePath, config.excludePatterns);
	const result = { validation, workspaceFileCount: wsFiles.length, workspaceFiles: wsFiles, staleFilesRemoved };
	if (staleFilesRemoved.length > 0) {
		enqueueDeferredSerialize();
	}
	return result;
}

async function dispatch(msg: WorkerRequest): Promise<unknown> {
	switch (msg.type) {
		case 'init':
			return handleInit(msg);
		case 'fullBuild': {
			if (!store?.isOpen) throw new Error('Store not initialized');
			const openStore = store;
			return withIndexingFlag(async () => {
				emitStatus(makeStatus('indexing'));
				await fullBuild(openStore, workspacePath, config, async (current, total) => {
					emitProgress('build', current, total);
					await scheduler.yield();
				});

				emitProgress('postprocess', 0, 1);
				await scheduler.yield();
				await runPostProcess({ flows: true, communities: true });

				emitProgress('serialize', 0, 1);
				await scheduler.yield();
				await openStore.serialize();

				const status = makeStatus('ready', { lastIndexedAt: Date.now() });
				emitStatus(status);
				return status;
			});
		}
		case 'incrementalUpdate':
			return handleIncrementalUpdate(msg);
		case 'postprocess': {
			if (!store?.isOpen) throw new Error('Store not initialized');
			return withIndexingFlag(async () => {
				await runPostProcess({ ...(msg.flows ? { flows: msg.flows } : {}), ...(msg.communities ? { communities: msg.communities } : {}), ...(msg.fts ? { fts: msg.fts } : {}) });
				return makeStatus('ready', { lastIndexedAt: Date.now() });
			});
		}
		case 'serialize':
			if (store?.isOpen) await store.serialize();
			return null;
		case 'dispose':
			if (store?.isOpen) {
				await store.serialize();
				store.close();
			}
			store = null;
			clearParsers();
			return null;
		case 'getStatus':
			return makeStatus(store?.isOpen ? 'ready' : 'idle');
		case 'getGraphTerms':
			if (!store?.isOpen) return [];
			return expandGraphTerms(store, msg.queryTerms);

		case 'mcp:context':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleContext(store, workspacePath, msg.input);
		case 'mcp:search':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleSearch(store, msg.input);
		case 'mcp:query':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleQuery(store, msg.input, workspacePath);
		case 'mcp:stats':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleStats(store);
		case 'mcp:blastRadius':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleBlastRadius(store, msg.input, workspacePath);
		case 'mcp:deadCode':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleDeadCode(store, msg.input);
		case 'mcp:reviewContext':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleReviewContext(store, workspacePath, msg.input);
		case 'mcp:build': {
			if (!store?.isOpen) throw new Error('Store not initialized');
			const openStore = store;
			return withIndexingFlag(async () => {
				const buildResult = await handleBuild(openStore, workspacePath, config, msg.input);
				await openStore.serialize();
				return buildResult;
			});
		}
		case 'webview:search':
			return handleWebviewSearch(msg.query, msg.kind, msg.limit);
		case 'webview:graph':
			return handleWebviewGraph(msg.maxNodes, msg.communityId);
		case 'webview:blastRadius':
			return handleWebviewBlastRadius(msg.filePath, msg.depth);
		case 'webview:validation':
			return handleWebviewValidation();

		case 'tree:files':
			if (!store?.isOpen) return [];
			return store.getAllFiles();
		case 'tree:nodesByFile':
			if (!store?.isOpen) return [];
			return store.getNodesByFile(msg.filePath);
		case 'tree:edgesForSymbol': {
			if (!store?.isOpen) return { outgoing: [], incoming: [] };
			const outgoing = store.getEdgesBySource(msg.qualifiedName);
			const incoming = store.getEdgesByTarget(msg.qualifiedName);
			const resolveNode = (qn: string) => {
				const n = store!.getNode(qn);
				return n ? {
					id: n.id, kind: n.kind, name: n.name,
					qualified_name: n.qualified_name, file_path: n.file_path,
					line_start: n.line_start, line_end: n.line_end,
				} : null;
			};
			return {
				outgoing: outgoing.map(e => ({ edge: e, target: resolveNode(e.target_qualified) })),
				incoming: incoming.map(e => ({ edge: e, source: resolveNode(e.source_qualified) })),
			};
		}

		default:
			throw new Error(`Unknown message type: ${(msg as { type: string }).type}`);
	}
}

export const scheduler: { yield: () => Promise<void> } = { yield: () => core.schedulerYield() };

const BUILD_REQUEST_TYPES: ReadonlySet<string> = new Set(['init', 'fullBuild', 'incrementalUpdate', 'mcp:build', 'postprocess']);

port.on('message', (msg: WorkerRequest) => {
	if (msg.type === 'webview:validation' && (indexingInProgress || core.hasQueuedHeavy(BUILD_REQUEST_TYPES))) {
		send({ type: 'response', id: msg.id, ok: true, data: { busy: true, message: VALIDATION_BUSY_MESSAGE } });
		return;
	}
	if (LIGHT_TYPES.has(msg.type)) {
		core.enqueueLight(msg);
	} else {
		core.enqueueHeavy(msg);
	}
});

core.runLoop().catch(err => {
	try {
		const error = err instanceof Error ? err.message : String(err);
		workerLog(`[Worker] Scheduler loop crashed: ${error}`);
	} finally {
		process.exit(1);
	}
});
