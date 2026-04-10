import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { CompassService } from '../index';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import { searchNodes } from '../search';
import { computeBlastRadius } from '../impact';
import { analyzeChanges, mapChangesToNodes, computeRiskScore } from '../changes';
import { detectEntryPoints, traceFlows, storeFlows, getFlows, getFlowById, getAffectedFlows } from '../flows';
import { detectCommunities, storeCommunities, getCommunities, getCommunityById, getArchitectureOverview } from '../communities';
import {
	handleContext, handleSearch, handleQuery, handleStats,
	handleBlastRadius, handleListFlows, handleGetFlow,
	handleListCommunities, handleGetCommunity, handleArchitecture,
	handlePostprocess,
} from '../mcp-server';
import { getSqlEngine, createTestStore } from './sql-test-helper';

let engine: SqlJsStatic;

beforeAll(async () => {
	engine = await getSqlEngine();
});

function makeNode(overrides: Partial<NodeInfo> & { name: string; file_path: string }): NodeInfo {
	return { kind: 'Function', line_start: 1, line_end: 10, ...overrides };
}

function makeEdge(overrides: Partial<EdgeInfo> & { source: string; target: string; file_path: string }): EdgeInfo {
	return { kind: 'CALLS', ...overrides };
}

// ---------------------------------------------------------------------------
// Realistic multi-file graph simulating a small auth + API app.
//
// Files:
//   /src/auth/service.ts     — AuthService class with login, validateToken, hashPassword
//   /src/auth/middleware.ts   — AuthMiddleware class with authenticate()
//   /src/api/handler.ts      — UserHandler class with getUser, updateUser
//   /src/api/routes.ts       — setupRoutes() entry point
//   /src/tests/auth.test.ts  — test_login test node
//
// This topology produces: entry points, multi-hop flows, cross-community edges,
// security-sensitive nodes, test coverage gaps, and blast radius propagation.
// ---------------------------------------------------------------------------
function seedRealisticGraph(store: GraphStore): void {
	// --- File nodes ---
	store.upsertNode(makeNode({ kind: 'File', name: 'service.ts', file_path: '/src/auth/service.ts', line_start: 1, line_end: 100, language: 'typescript' }));
	store.upsertNode(makeNode({ kind: 'File', name: 'middleware.ts', file_path: '/src/auth/middleware.ts', line_start: 1, line_end: 50, language: 'typescript' }));
	store.upsertNode(makeNode({ kind: 'File', name: 'handler.ts', file_path: '/src/api/handler.ts', line_start: 1, line_end: 80, language: 'typescript' }));
	store.upsertNode(makeNode({ kind: 'File', name: 'routes.ts', file_path: '/src/api/routes.ts', line_start: 1, line_end: 40, language: 'typescript' }));
	store.upsertNode(makeNode({ kind: 'File', name: 'auth.test.ts', file_path: '/src/tests/auth.test.ts', line_start: 1, line_end: 30, language: 'typescript' }));

	// --- auth/service.ts ---
	store.upsertNode(makeNode({ kind: 'Class', name: 'AuthService', file_path: '/src/auth/service.ts', line_start: 5, line_end: 95, language: 'typescript' }));
	store.upsertNode(makeNode({ name: 'login', file_path: '/src/auth/service.ts', parent_name: 'AuthService', line_start: 10, line_end: 30, language: 'typescript', params: '(username: string, password: string)', return_type: 'Promise<Token>', signature: 'login(username: string, password: string): Promise<Token>' }));
	store.upsertNode(makeNode({ name: 'validateToken', file_path: '/src/auth/service.ts', parent_name: 'AuthService', line_start: 35, line_end: 55, language: 'typescript', params: '(token: string)', return_type: 'boolean' }));
	store.upsertNode(makeNode({ name: 'hashPassword', file_path: '/src/auth/service.ts', parent_name: 'AuthService', line_start: 60, line_end: 80, language: 'typescript', params: '(password: string)', return_type: 'string' }));

	// --- auth/middleware.ts ---
	store.upsertNode(makeNode({ kind: 'Class', name: 'AuthMiddleware', file_path: '/src/auth/middleware.ts', line_start: 5, line_end: 45, language: 'typescript' }));
	store.upsertNode(makeNode({ name: 'authenticate', file_path: '/src/auth/middleware.ts', parent_name: 'AuthMiddleware', line_start: 10, line_end: 40, language: 'typescript' }));

	// --- api/handler.ts ---
	store.upsertNode(makeNode({ kind: 'Class', name: 'UserHandler', file_path: '/src/api/handler.ts', line_start: 5, line_end: 75, language: 'typescript' }));
	store.upsertNode(makeNode({ name: 'getUser', file_path: '/src/api/handler.ts', parent_name: 'UserHandler', line_start: 10, line_end: 35, language: 'typescript' }));
	store.upsertNode(makeNode({ name: 'updateUser', file_path: '/src/api/handler.ts', parent_name: 'UserHandler', line_start: 40, line_end: 70, language: 'typescript' }));

	// --- api/routes.ts ---
	store.upsertNode(makeNode({ name: 'setupRoutes', file_path: '/src/api/routes.ts', line_start: 5, line_end: 35, language: 'typescript' }));

	// --- tests/auth.test.ts ---
	store.upsertNode(makeNode({ kind: 'Test', name: 'test_login', file_path: '/src/tests/auth.test.ts', line_start: 5, line_end: 25, language: 'typescript', is_test: true }));

	// --- CALLS edges ---
	store.upsertEdge(makeEdge({ source: '/src/auth/service.ts::AuthService::login', target: '/src/auth/service.ts::AuthService::hashPassword', file_path: '/src/auth/service.ts', line: 20 }));
	store.upsertEdge(makeEdge({ source: '/src/auth/middleware.ts::AuthMiddleware::authenticate', target: '/src/auth/service.ts::AuthService::validateToken', file_path: '/src/auth/middleware.ts', line: 15 }));
	store.upsertEdge(makeEdge({ source: '/src/api/handler.ts::UserHandler::getUser', target: '/src/auth/service.ts::AuthService::validateToken', file_path: '/src/api/handler.ts', line: 15 }));
	store.upsertEdge(makeEdge({ source: '/src/api/handler.ts::UserHandler::updateUser', target: '/src/auth/service.ts::AuthService::login', file_path: '/src/api/handler.ts', line: 50 }));
	store.upsertEdge(makeEdge({ source: '/src/api/routes.ts::setupRoutes', target: '/src/api/handler.ts::UserHandler::getUser', file_path: '/src/api/routes.ts', line: 10 }));
	store.upsertEdge(makeEdge({ source: '/src/api/routes.ts::setupRoutes', target: '/src/api/handler.ts::UserHandler::updateUser', file_path: '/src/api/routes.ts', line: 15 }));

	// --- TESTED_BY edge ---
	store.upsertEdge(makeEdge({ kind: 'TESTED_BY', source: '/src/tests/auth.test.ts::test_login', target: '/src/auth/service.ts::AuthService::login', file_path: '/src/tests/auth.test.ts' }));

	// --- IMPORTS_FROM edges ---
	store.upsertEdge(makeEdge({ kind: 'IMPORTS_FROM', source: '/src/auth/middleware.ts::middleware.ts', target: '/src/auth/service.ts::service.ts', file_path: '/src/auth/middleware.ts', line: 1 }));
	store.upsertEdge(makeEdge({ kind: 'IMPORTS_FROM', source: '/src/api/handler.ts::handler.ts', target: '/src/auth/service.ts::service.ts', file_path: '/src/api/handler.ts', line: 1 }));

	// --- CONTAINS edges ---
	store.upsertEdge(makeEdge({ kind: 'CONTAINS', source: '/src/auth/service.ts::service.ts', target: '/src/auth/service.ts::AuthService', file_path: '/src/auth/service.ts' }));
	store.upsertEdge(makeEdge({ kind: 'CONTAINS', source: '/src/auth/service.ts::AuthService', target: '/src/auth/service.ts::AuthService::login', file_path: '/src/auth/service.ts' }));
	store.upsertEdge(makeEdge({ kind: 'CONTAINS', source: '/src/auth/service.ts::AuthService', target: '/src/auth/service.ts::AuthService::validateToken', file_path: '/src/auth/service.ts' }));
	store.upsertEdge(makeEdge({ kind: 'CONTAINS', source: '/src/auth/service.ts::AuthService', target: '/src/auth/service.ts::AuthService::hashPassword', file_path: '/src/auth/service.ts' }));
	store.upsertEdge(makeEdge({ kind: 'CONTAINS', source: '/src/auth/middleware.ts::middleware.ts', target: '/src/auth/middleware.ts::AuthMiddleware', file_path: '/src/auth/middleware.ts' }));
	store.upsertEdge(makeEdge({ kind: 'CONTAINS', source: '/src/auth/middleware.ts::AuthMiddleware', target: '/src/auth/middleware.ts::AuthMiddleware::authenticate', file_path: '/src/auth/middleware.ts' }));
	store.upsertEdge(makeEdge({ kind: 'CONTAINS', source: '/src/api/handler.ts::handler.ts', target: '/src/api/handler.ts::UserHandler', file_path: '/src/api/handler.ts' }));
	store.upsertEdge(makeEdge({ kind: 'CONTAINS', source: '/src/api/handler.ts::UserHandler', target: '/src/api/handler.ts::UserHandler::getUser', file_path: '/src/api/handler.ts' }));
	store.upsertEdge(makeEdge({ kind: 'CONTAINS', source: '/src/api/handler.ts::UserHandler', target: '/src/api/handler.ts::UserHandler::updateUser', file_path: '/src/api/handler.ts' }));
}

// ============================================================
// Part 1: CompassService unit tests (constructor, config, status)
// ============================================================
describe('CompassService', () => {
	it('constructor reads config without error', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		expect(service).toBeTruthy();
	});

	it('isEnabled returns false by default', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		expect(service.isEnabled).toBeFalsy();
	});

	it('getStatus returns idle state initially', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		const status = service.getStatus();
		expect(status.state).toBe('idle');
		expect(status.fileCount).toBe(0);
		expect(status.nodeCount).toBe(0);
		expect(status.edgeCount).toBe(0);
		expect(status.communityCount).toBe(0);
		expect(status.flowCount).toBe(0);
		expect(status.lastIndexedAt).toBeNull();
	});

	it('getGraphTerms returns empty array when not initialized', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		expect(service.getGraphTerms(['test'])).toEqual([]);
	});

	it('dispose cleans up without error', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		expect(() => service.dispose()).not.toThrow();
		expect(service.getStatus().state).toBe('idle');
	});

	it('store getter throws when not initialized', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		expect(() => service.store).toThrow('GraphStore not initialized');
	});

	it('config getter returns config object', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		const config = service.config;
		expect(config).toHaveProperty('maxFiles');
		expect(config).toHaveProperty('maxNodes');
		expect(config).toHaveProperty('excludePatterns');
		expect(config).toHaveProperty('autoReindex');
	});

	it('runPostProcess does not throw when not initialized', async () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		await expect(service.runPostProcess({ flows: true })).resolves.toBeUndefined();
	});

	it('onStatusChange registers callback', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		let callCount = 0;
		service.onStatusChange(() => { callCount++; });
		expect(callCount).toBe(0);
	});

	it('getMcpServerConfig returns null when disabled', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		const result = service.getMcpServerConfig(() => 'session', '/workspace');
		expect(result).toBeNull();
	});
});

// ============================================================
// Part 2: Full pipeline integration
// ============================================================
describe('Full pipeline integration', () => {
	let store: GraphStore;

	beforeEach(() => {
		store = createTestStore(engine);
		seedRealisticGraph(store);
	});

	afterEach(() => store?.close());

	describe('graph topology verification', () => {
		it('has correct node count across all files', () => {
			const stats = store.getStats();
			expect(stats.total_nodes).toBe(16);
			expect(stats.nodes_by_kind['File']).toBe(5);
			expect(stats.nodes_by_kind['Class']).toBe(3);
			expect(stats.nodes_by_kind['Function']).toBe(7);
			expect(stats.nodes_by_kind['Test']).toBe(1);
		});

		it('has correct edge count across all kinds', () => {
			const stats = store.getStats();
			expect(stats.edges_by_kind['CALLS']).toBe(6);
			expect(stats.edges_by_kind['TESTED_BY']).toBe(1);
			expect(stats.edges_by_kind['IMPORTS_FROM']).toBe(2);
			expect(stats.edges_by_kind['CONTAINS']).toBe(9);
		});

		it('all files indexed', () => {
			const files = store.getAllFiles();
			expect(files).toHaveLength(5);
			expect(files).toContain('/src/auth/service.ts');
			expect(files).toContain('/src/api/routes.ts');
			expect(files).toContain('/src/tests/auth.test.ts');
		});

		it('qualified names resolve correctly', () => {
			const login = store.getNode('/src/auth/service.ts::AuthService::login');
			expect(login).toBeDefined();
			expect(login!.name).toBe('login');
			expect(login!.parent_name).toBe('AuthService');
			expect(login!.kind).toBe('Function');
			expect(login!.line_start).toBe(10);
			expect(login!.line_end).toBe(30);
		});

		it('name_tokens computed from identifier splitting', () => {
			const node = store.getNode('/src/auth/service.ts::AuthService');
			expect(node).toBeDefined();
			expect(node!.name_tokens).toBe('auth service');
		});
	});

	describe('FTS5 search across full graph', () => {
		it('finds function by exact name', () => {
			const results = searchNodes(store, 'login');
			expect(results.length).toBeGreaterThanOrEqual(1);
			const names = results.map(r => r.node.name);
			expect(names).toContain('login');
		});

		it('finds class by camelCase partial match', () => {
			const results = searchNodes(store, 'Auth');
			expect(results.length).toBeGreaterThanOrEqual(1);
			const names = results.map(r => r.node.name);
			expect(names.some(n => n.includes('Auth'))).toBe(true);
		});

		it('filters by kind', () => {
			const results = searchNodes(store, 'Auth', { kind: 'Class' });
			for (const r of results) {
				expect(r.node.kind).toBe('Class');
			}
		});

		it('respects limit parameter', () => {
			const results = searchNodes(store, 'service', { limit: 2 });
			expect(results.length).toBeLessThanOrEqual(2);
		});

		it('empty query returns empty', () => {
			const results = searchNodes(store, '');
			expect(results).toHaveLength(0);
		});

		it('returns BM25 scores', () => {
			const results = searchNodes(store, 'authenticate');
			expect(results.length).toBeGreaterThanOrEqual(1);
			for (const r of results) {
				expect(r.score).toBeGreaterThan(0);
			}
		});
	});

	describe('blast radius from auth/service.ts', () => {
		it('includes all nodes from the changed file', () => {
			const impact = computeBlastRadius(store, ['/src/auth/service.ts']);
			const changedNames = impact.changed_nodes.map(n => n.name);
			expect(changedNames).toContain('login');
			expect(changedNames).toContain('validateToken');
			expect(changedNames).toContain('hashPassword');
			expect(changedNames).toContain('AuthService');
		});

		it('propagates impact to middleware and handler', () => {
			const impact = computeBlastRadius(store, ['/src/auth/service.ts']);
			const impactedFiles = impact.impacted_files;
			expect(impactedFiles).toContain('/src/auth/middleware.ts');
			expect(impactedFiles).toContain('/src/api/handler.ts');
		});

		it('propagates to test file via TESTED_BY edge', () => {
			const impact = computeBlastRadius(store, ['/src/auth/service.ts']);
			const allQns = [
				...impact.changed_nodes.map(n => n.qualified_name),
				...impact.impacted_nodes.map(n => n.qualified_name),
			];
			expect(allQns.some(qn => qn.includes('test_login'))).toBe(true);
		});

		it('returns edges among impacted set', () => {
			const impact = computeBlastRadius(store, ['/src/auth/service.ts']);
			expect(impact.edges.length).toBeGreaterThan(0);
		});

		it('depth=1 limits propagation', () => {
			const depth1 = computeBlastRadius(store, ['/src/auth/service.ts'], 1);
			const depth2 = computeBlastRadius(store, ['/src/auth/service.ts'], 2);
			expect(depth1.impacted_nodes.length).toBeLessThanOrEqual(depth2.impacted_nodes.length);
		});

		it('empty file list returns empty result', () => {
			const impact = computeBlastRadius(store, []);
			expect(impact.changed_nodes).toHaveLength(0);
			expect(impact.impacted_nodes).toHaveLength(0);
		});
	});

	describe('execution flows', () => {
		it('detects setupRoutes as entry point (no incoming CALLS)', () => {
			const entryPoints = detectEntryPoints(store);
			const names = entryPoints.map(ep => ep.name);
			expect(names).toContain('setupRoutes');
		});

		it('traces flow from setupRoutes through handler to auth', () => {
			const flows = traceFlows(store);
			const setupFlow = flows.find(f => f.name === 'setupRoutes');
			expect(setupFlow).toBeDefined();
			expect(setupFlow!.nodeCount).toBeGreaterThanOrEqual(3);
			expect(setupFlow!.fileCount).toBeGreaterThanOrEqual(2);
		});

		it('stores and retrieves flows', () => {
			const flows = traceFlows(store);
			const count = storeFlows(store, flows);
			expect(count).toBeGreaterThan(0);

			const retrieved = getFlows(store);
			expect(retrieved.length).toBe(count);
		});

		it('getFlowById returns nodes in call path order', () => {
			const flows = traceFlows(store);
			storeFlows(store, flows);
			const stored = getFlows(store);
			const setupFlow = stored.find(f => f.name === 'setupRoutes');
			expect(setupFlow).toBeDefined();

			const info = getFlowById(store, setupFlow!.id);
			expect(info).not.toBeNull();
			expect(info!.nodes[0]!.name).toBe('setupRoutes');
			expect(info!.nodes.length).toBeGreaterThanOrEqual(2);
		});

		it('criticality scoring reflects cross-file spread', () => {
			const flows = traceFlows(store);
			const setupFlow = flows.find(f => f.name === 'setupRoutes');
			expect(setupFlow).toBeDefined();
			expect(setupFlow!.criticality).toBeGreaterThan(0);
		});

		it('affected flows detects flows containing changed files', () => {
			const flows = traceFlows(store);
			storeFlows(store, flows);

			const affected = getAffectedFlows(store, ['/src/auth/service.ts']);
			expect(affected.total).toBeGreaterThan(0);
		});
	});

	describe('community detection', () => {
		it('detects at least one community', () => {
			const communities = detectCommunities(store);
			expect(communities.length).toBeGreaterThan(0);
		});

		it('stores communities and assigns community_id to nodes', () => {
			const communities = detectCommunities(store);
			const count = storeCommunities(store, communities);
			expect(count).toBeGreaterThan(0);

			const login = store.getNode('/src/auth/service.ts::AuthService::login');
			expect(login!.community_id).not.toBeNull();
		});

		it('getCommunities sorted by size', () => {
			const comms = detectCommunities(store);
			storeCommunities(store, comms);

			const sorted = getCommunities(store, 'size');
			for (let i = 1; i < sorted.length; i++) {
				expect(sorted[i - 1]!.size).toBeGreaterThanOrEqual(sorted[i]!.size);
			}
		});

		it('getCommunityById returns members', () => {
			const comms = detectCommunities(store);
			storeCommunities(store, comms);
			const stored = getCommunities(store);
			expect(stored.length).toBeGreaterThan(0);

			const info = getCommunityById(store, stored[0]!.id);
			expect(info).not.toBeNull();
			expect(info!.members.length).toBeGreaterThan(0);
		});

		it('architecture overview shows cross-community edges', () => {
			const comms = detectCommunities(store);
			storeCommunities(store, comms);

			const arch = getArchitectureOverview(store);
			expect(arch.communities.length).toBeGreaterThan(0);
		});
	});

	describe('risk analysis', () => {
		it('login() has security sensitivity due to "password" in params', () => {
			const login = store.getNode('/src/auth/service.ts::AuthService::login')!;
			const score = computeRiskScore(store, login);
			expect(score).toBeGreaterThan(0);
		});

		it('hashPassword() flagged as security-sensitive', () => {
			const hp = store.getNode('/src/auth/service.ts::AuthService::hashPassword')!;
			const score = computeRiskScore(store, hp);
			expect(score).toBeGreaterThan(0);
		});

		it('validateToken() has no test coverage (test gap)', () => {
			const vt = store.getNode('/src/auth/service.ts::AuthService::validateToken')!;
			const score = computeRiskScore(store, vt);
			expect(score).toBeGreaterThanOrEqual(0.30);
		});

		it('login() has test coverage (lower no-test penalty)', () => {
			const login = store.getNode('/src/auth/service.ts::AuthService::login')!;
			const score = computeRiskScore(store, login);
			const vt = store.getNode('/src/auth/service.ts::AuthService::validateToken')!;
			const vtScore = computeRiskScore(store, vt);
			expect(score).toBeLessThan(vtScore + 0.30);
		});

		it('analyzeChanges returns sorted risks with test gaps', () => {
			const analysis = analyzeChanges(store, ['/src/auth/service.ts']);
			expect(analysis.risks.length).toBeGreaterThan(0);
			expect(analysis.test_gaps.length).toBeGreaterThan(0);

			for (let i = 1; i < analysis.risks.length; i++) {
				expect(analysis.risks[i - 1]!.risk_score).toBeGreaterThanOrEqual(analysis.risks[i]!.risk_score);
			}
		});

		it('mapChangesToNodes finds overlapping line ranges', () => {
			const ranges = new Map<string, Array<[number, number]>>();
			ranges.set('/src/auth/service.ts', [[15, 25]]);
			const nodes = mapChangesToNodes(store, ranges);
			expect(nodes.length).toBeGreaterThanOrEqual(1);
			const names = nodes.map(n => n.name);
			expect(names).toContain('login');
		});
	});

	describe('MCP tool handlers on seeded graph', () => {
		it('handleContext produces compact overview', () => {
			const result = handleContext(store, '/workspace', {});
			expect(result).toContain('nodes');
			expect(result).toContain('edges');
		});

		it('handleContext with changed_files shows risk', () => {
			const result = handleContext(store, '/workspace', { changed_files: ['/src/auth/service.ts'] });
			expect(result).toContain('Changes');
		});

		it('handleSearch finds entities', () => {
			const result = handleSearch(store, { query: 'login' });
			expect(result).toContain('login');
		});

		it('handleSearch no results returns message', () => {
			const result = handleSearch(store, { query: 'zzznonexistent' });
			expect(result).toContain('No results');
		});

		it('handleQuery callers_of returns callers', () => {
			const result = handleQuery(store, { pattern: 'callers_of', target: 'login' });
			expect(result).toContain('Callers of');
		});

		it('handleQuery callees_of returns callees', () => {
			const result = handleQuery(store, { pattern: 'callees_of', target: 'login' });
			expect(result).toContain('Callees of');
		});

		it('handleQuery file_summary returns file entities', () => {
			const result = handleQuery(store, { pattern: 'file_summary', target: '/src/auth/service.ts' });
			expect(result).toContain('login');
			expect(result).toContain('AuthService');
		});

		it('handleQuery unknown pattern returns error', () => {
			const result = handleQuery(store, { pattern: 'bad_pattern', target: 'login' });
			expect(result).toContain('Unknown pattern');
		});

		it('handleStats returns breakdown', () => {
			const result = handleStats(store);
			expect(result).toContain('Nodes:');
			expect(result).toContain('Edges:');
			expect(result).toContain('Function:');
			expect(result).toContain('CALLS:');
		});

		it('handleBlastRadius returns impact', () => {
			const result = handleBlastRadius(store, { changed_files: ['/src/auth/service.ts'] });
			expect(result).toContain('Changed:');
			expect(result).toContain('Impacted:');
		});

		it('handleBlastRadius minimal is shorter than full', () => {
			const minimal = handleBlastRadius(store, { changed_files: ['/src/auth/service.ts'], detail_level: 'minimal' });
			const full = handleBlastRadius(store, { changed_files: ['/src/auth/service.ts'], detail_level: 'full' });
			expect(minimal.length).toBeLessThan(full.length);
		});

		it('handlePostprocess with flows produces flow count', () => {
			const result = handlePostprocess(store, { flows: true });
			expect(result).toContain('Flows:');
			expect(result).toContain('traced');
		});

		it('handlePostprocess with communities produces community count', () => {
			const result = handlePostprocess(store, { communities: true });
			expect(result).toContain('Communities:');
			expect(result).toContain('detected');
		});

		it('handlePostprocess with fts rebuilds index', () => {
			const result = handlePostprocess(store, { fts: true });
			expect(result).toContain('FTS: index rebuilt');
		});

		it('handlePostprocess with no flags returns message', () => {
			const result = handlePostprocess(store, {});
			expect(result).toContain('No steps selected');
		});

		it('handleListFlows after post-processing returns flows', () => {
			handlePostprocess(store, { flows: true });
			const result = handleListFlows(store, {});
			expect(result).toContain('Flows');
		});

		it('handleGetFlow retrieves specific flow', () => {
			handlePostprocess(store, { flows: true });
			const flows = getFlows(store);
			if (flows.length > 0) {
				const result = handleGetFlow(store, { flow_id: flows[0]!.id });
				expect(result).toContain('Flow:');
				expect(result).toContain('Call path:');
			}
		});

		it('handleGetFlow not found returns message', () => {
			const result = handleGetFlow(store, { flow_id: 99999 });
			expect(result).toContain('Flow not found');
		});

		it('handleListCommunities after post-processing returns communities', () => {
			handlePostprocess(store, { communities: true });
			const result = handleListCommunities(store, {});
			expect(result).toContain('Communities');
		});

		it('handleGetCommunity retrieves specific community', () => {
			handlePostprocess(store, { communities: true });
			const comms = getCommunities(store);
			if (comms.length > 0) {
				const result = handleGetCommunity(store, { community_id: comms[0]!.id });
				expect(result).toContain('Community:');
				expect(result).toContain('Members');
			}
		});

		it('handleGetCommunity not found returns message', () => {
			const result = handleGetCommunity(store, { community_id: 99999 });
			expect(result).toContain('Community not found');
		});

		it('handleArchitecture after post-processing returns overview', () => {
			handlePostprocess(store, { communities: true });
			const result = handleArchitecture(store, {});
			expect(result).toContain('Architecture');
		});
	});

	describe('getGraphTerms — Recall integration', () => {
		it('expands query terms via FTS5 + neighbor tokens', () => {
			const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
			(service as unknown as { _store: GraphStore })._store = store;
			(service as unknown as { _state: string })._state = 'ready';

			const expanded = service.getGraphTerms(['login']);
			expect(expanded.length).toBeGreaterThan(0);
		});

		it('removes input terms from expansion', () => {
			const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
			(service as unknown as { _store: GraphStore })._store = store;
			(service as unknown as { _state: string })._state = 'ready';

			const expanded = service.getGraphTerms(['login']);
			expect(expanded).not.toContain('login');
		});

		it('caps expansion at 20 terms', () => {
			const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
			(service as unknown as { _store: GraphStore })._store = store;
			(service as unknown as { _state: string })._state = 'ready';

			const expanded = service.getGraphTerms(['service']);
			expect(expanded.length).toBeLessThanOrEqual(20);
		});
	});

	describe('full pipeline: post-process → query → verify', () => {
		it('flows + communities → architecture → blast radius → review context', () => {
			const flows = traceFlows(store);
			storeFlows(store, flows);
			const comms = detectCommunities(store);
			storeCommunities(store, comms);

			const arch = getArchitectureOverview(store);
			expect(arch.communities.length).toBeGreaterThan(0);

			const impact = computeBlastRadius(store, ['/src/auth/service.ts']);
			expect(impact.changed_nodes.length).toBeGreaterThan(0);
			expect(impact.impacted_nodes.length).toBeGreaterThan(0);

			const analysis = analyzeChanges(store, ['/src/auth/service.ts']);
			expect(analysis.risks.length).toBeGreaterThan(0);

			const affected = getAffectedFlows(store, ['/src/auth/service.ts']);
			expect(affected.total).toBeGreaterThan(0);
		});

		it('file removal cleans up nodes and edges', () => {
			const beforeCount = store.getNodeCount();
			store.removeFileData('/src/auth/middleware.ts');
			const afterCount = store.getNodeCount();
			expect(afterCount).toBeLessThan(beforeCount);

			const middleware = store.getNode('/src/auth/middleware.ts::AuthMiddleware::authenticate');
			expect(middleware).toBeUndefined();
		});

		it('store export/import round-trips data', () => {
			const data = store.exportData();
			expect(data.length).toBeGreaterThan(0);

			const store2 = new GraphStore('/tmp/round-trip.db');
			store2.openFromEngine(engine, data);
			const stats2 = store2.getStats();
			expect(stats2.total_nodes).toBe(store.getStats().total_nodes);
			expect(stats2.total_edges).toBe(store.getStats().total_edges);
			store2.close();
		});
	});
});
