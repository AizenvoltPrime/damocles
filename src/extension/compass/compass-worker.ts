import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import type { WorkerRequest, WorkerEvent } from './worker-protocol';
import type { IndexStatus, CompassConfig } from './types';
import { setGrammarDir, clearParsers } from './parser-manager';
import { GraphStore } from './database';
import { searchNodes, expandGraphTerms } from './search';
import { fullBuild, incrementalUpdate } from './incremental';
import { traceFlows, storeFlows } from './flows';
import { detectCommunities, storeCommunities } from './communities';
import { computeBlastRadius } from './impact';
import { collectFiles } from './detect';
import { getCommunities } from './communities';
import {
	handleContext, handleSearch, handleQuery, handleStats,
	handleBlastRadius, handleDetectChanges, handleReviewContext,
	handleListFlows, handleGetFlow,
	handleListCommunities, handleGetCommunity, handleArchitecture,
	handleBuild, handlePostprocess,
} from './mcp-handlers';

if (!parentPort) throw new Error('compass-worker must run as a worker thread');

const port = parentPort;

let store: GraphStore | null = null;
let workspacePath = '';
let config: CompassConfig = { excludePatterns: [], autoReindex: true };
let isRebuildInProgress = false;
let pendingRebuild: { base: string | undefined; changedFiles: string[] | undefined } | null = null;

function send(msg: WorkerEvent): void {
	port.postMessage(msg);
}

function emitStatus(status: IndexStatus): void {
	send({ type: 'status', status });
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

	const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
	const dbPath = path.join(os.homedir(), '.damocles', 'compass', hash, 'graph.db');
	store = new GraphStore(dbPath);
	await store.open(msg.extensionPath);

	emitStatus(makeStatus('indexing'));

	const result = await fullBuild(store, workspacePath, config);
	workerLog(`[Worker] Build: ${result.filesParsed} files, ${result.totalNodes} nodes, ${result.totalEdges} edges, ${result.errors.length} errors`);

	await runPostProcess({ flows: true, communities: true });
	await store.serialize();

	const status = makeStatus('ready', { lastIndexedAt: Date.now() });
	emitStatus(status);
	return status;
}

async function runPostProcess(options: { flows?: boolean; communities?: boolean; fts?: boolean }): Promise<void> {
	if (!store?.isOpen) return;
	if (options.flows) {
		const flows = traceFlows(store);
		storeFlows(store, flows);
	}
	if (options.communities) {
		const comms = detectCommunities(store);
		storeCommunities(store, comms);
	}
	if (options.fts) {
		store.execRaw("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
	}
}

async function handleIncrementalUpdate(msg: Extract<WorkerRequest, { type: 'incrementalUpdate' }>): Promise<IndexStatus> {
	if (isRebuildInProgress) {
		pendingRebuild = { base: msg.base, changedFiles: msg.changedFiles };
		return makeStatus('indexing');
	}

	isRebuildInProgress = true;
	emitStatus(makeStatus('indexing'));

	try {
		if (store?.isOpen) {
			await incrementalUpdate(store, workspacePath, msg.base, msg.changedFiles);
			await runPostProcess({ flows: true, communities: true });
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
	} finally {
		isRebuildInProgress = false;
		if (pendingRebuild) {
			const pending = pendingRebuild;
			pendingRebuild = null;
			setImmediate(() => {
				const req = { type: 'incrementalUpdate' as const, id: -1, ...(pending.base !== undefined ? { base: pending.base } : {}), ...(pending.changedFiles !== undefined ? { changedFiles: pending.changedFiles } : {}) };
				handleIncrementalUpdate(req).catch(e => workerLog(`[Worker] Queued rebuild error: ${e}`));
			});
		}
	}
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
	const impact = computeBlastRadius(store, [filePath], d);
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
	const existChecks = await Promise.all(
		allFiles.map(fp => fs.promises.access(fp).then(() => true, () => false)),
	);
	for (let i = 0; i < allFiles.length; i++) {
		if (!existChecks[i]) staleFilesRemoved.push(allFiles[i]!);
	}
	if (staleFilesRemoved.length > 0) {
		store.beginTransaction();
		try {
			for (const fp of staleFilesRemoved) {
				store.removeFileData(fp);
			}
			store.commitTransaction();
		} catch (err) {
			store.rollbackTransaction();
			throw err;
		}
		await store.serialize();
	}

	const validation = store.runValidation();
	const wsFiles = collectFiles(workspacePath, config.excludePatterns);
	return { validation, workspaceFileCount: wsFiles.length, workspaceFiles: wsFiles, staleFilesRemoved };
}

async function dispatch(msg: WorkerRequest): Promise<unknown> {
	switch (msg.type) {
		case 'init':
			return handleInit(msg);
		case 'fullBuild': {
			if (!store?.isOpen) throw new Error('Store not initialized');
			emitStatus(makeStatus('indexing'));
			await fullBuild(store, workspacePath, config);
			await runPostProcess({ flows: true, communities: true });
			await store.serialize();
			const status = makeStatus('ready', { lastIndexedAt: Date.now() });
			emitStatus(status);
			return status;
		}
		case 'incrementalUpdate':
			return handleIncrementalUpdate(msg);
		case 'postprocess': {
			if (!store?.isOpen) throw new Error('Store not initialized');
			await runPostProcess({ ...(msg.flows ? { flows: msg.flows } : {}), ...(msg.communities ? { communities: msg.communities } : {}), ...(msg.fts ? { fts: msg.fts } : {}) });
			return makeStatus('ready', { lastIndexedAt: Date.now() });
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
			return handleQuery(store, msg.input);
		case 'mcp:stats':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleStats(store);
		case 'mcp:blastRadius':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleBlastRadius(store, msg.input);
		case 'mcp:detectChanges':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleDetectChanges(store, workspacePath, msg.input);
		case 'mcp:reviewContext':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleReviewContext(store, workspacePath, msg.input);
		case 'mcp:listFlows':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleListFlows(store, msg.input);
		case 'mcp:getFlow':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleGetFlow(store, msg.input, workspacePath);
		case 'mcp:listCommunities':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleListCommunities(store, msg.input);
		case 'mcp:getCommunity':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleGetCommunity(store, msg.input);
		case 'mcp:architecture':
			if (!store?.isOpen) throw new Error('Store not initialized');
			return handleArchitecture(store, msg.input);
		case 'mcp:build': {
			if (!store?.isOpen) throw new Error('Store not initialized');
			const buildResult = await handleBuild(store, workspacePath, config, msg.input);
			await store.serialize();
			return buildResult;
		}
		case 'mcp:postprocess': {
			if (!store?.isOpen) throw new Error('Store not initialized');
			const ppResult = handlePostprocess(store, msg.input);
			await store.serialize();
			return ppResult;
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

let queue = Promise.resolve();
port.on('message', (msg: WorkerRequest) => {
	queue = queue.then(async () => {
		try {
			const result = await dispatch(msg);
			send({ type: 'response', id: msg.id, ok: true, data: result });
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			send({ type: 'response', id: msg.id, ok: false, error });
		}
	});
});
