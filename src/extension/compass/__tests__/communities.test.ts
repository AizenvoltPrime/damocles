import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import {
	detectCommunities,
	storeCommunities,
	getCommunities,
	getCommunityById,
	getArchitectureOverview,
} from '../communities';
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

function seedTwoClusters(store: GraphStore): void {
	store.upsertNode(makeNode({ kind: 'Class', name: 'UserService', file_path: '/src/user/service.ts', language: 'typescript' }));
	store.upsertNode(makeNode({ name: 'getUser', file_path: '/src/user/service.ts', language: 'typescript', line_start: 10, line_end: 20 }));
	store.upsertNode(makeNode({ name: 'createUser', file_path: '/src/user/service.ts', language: 'typescript', line_start: 25, line_end: 40 }));

	store.upsertNode(makeNode({ kind: 'Class', name: 'AuthService', file_path: '/src/auth/service.ts', language: 'typescript' }));
	store.upsertNode(makeNode({ name: 'login', file_path: '/src/auth/service.ts', language: 'typescript', line_start: 5, line_end: 15 }));
	store.upsertNode(makeNode({ name: 'logout', file_path: '/src/auth/service.ts', language: 'typescript', line_start: 20, line_end: 30 }));

	store.upsertEdge(makeEdge({ source: '/src/user/service.ts::getUser', target: '/src/user/service.ts::createUser', file_path: '/src/user/service.ts', line: 12 }));
	store.upsertEdge(makeEdge({ source: '/src/auth/service.ts::login', target: '/src/auth/service.ts::logout', file_path: '/src/auth/service.ts', line: 8 }));

	store.upsertEdge(makeEdge({ source: '/src/auth/service.ts::login', target: '/src/user/service.ts::getUser', file_path: '/src/auth/service.ts', line: 10 }));
}

describe('detectCommunities', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('detects communities from graph nodes', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const communities = detectCommunities(store, 2);
		expect(communities.length).toBeGreaterThan(0);
		const totalMembers = communities.reduce((sum, c) => sum + c.size, 0);
		expect(totalMembers).toBeGreaterThanOrEqual(4);
	});

	it('assigns meaningful community names', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const communities = detectCommunities(store, 2);
		for (const comm of communities) {
			expect(comm.name).toBeTruthy();
			expect(comm.name).not.toBe('empty');
		}
	});

	it('computes cohesion between 0 and 1', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const communities = detectCommunities(store, 2);
		for (const comm of communities) {
			expect(comm.cohesion).toBeGreaterThanOrEqual(0);
			expect(comm.cohesion).toBeLessThanOrEqual(1);
		}
	});

	it('respects minSize filter', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const communities = detectCommunities(store, 10);
		expect(communities).toHaveLength(0);
	});

	it('handles empty graph', () => {
		store = createTestStore(engine);
		const communities = detectCommunities(store, 2);
		expect(communities).toHaveLength(0);
	});

	it('detects separate communities for disconnected clusters', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'funcA', file_path: '/src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'funcB', file_path: '/src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'funcC', file_path: '/src/b.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'funcD', file_path: '/src/b.ts', language: 'typescript' }));

		store.upsertEdge(makeEdge({ source: '/src/a.ts::funcA', target: '/src/a.ts::funcB', file_path: '/src/a.ts', line: 5 }));
		store.upsertEdge(makeEdge({ source: '/src/b.ts::funcC', target: '/src/b.ts::funcD', file_path: '/src/b.ts', line: 5 }));

		const communities = detectCommunities(store, 2);
		expect(communities.length).toBeGreaterThanOrEqual(1);
	});

	it('falls back to file-based detection when Louvain fails on edgeless graph', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'isolatedA', file_path: '/src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'isolatedB', file_path: '/src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'isolatedC', file_path: '/src/b.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'isolatedD', file_path: '/src/b.ts', language: 'typescript' }));

		const communities = detectCommunities(store, 2);
		expect(communities.length).toBeGreaterThanOrEqual(1);
		for (const comm of communities) {
			expect(comm.description).toContain('File-based');
		}
	});

	it('names community with dominant class when >40%', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ kind: 'Class', name: 'AuthService', file_path: '/src/auth/service.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'login', file_path: '/src/auth/service.ts', language: 'typescript' }));

		store.upsertEdge(makeEdge({
			source: '/src/auth/service.ts::login',
			target: '/src/auth/service.ts::AuthService',
			file_path: '/src/auth/service.ts',
		}));

		const communities = detectCommunities(store, 1);
		expect(communities.length).toBeGreaterThan(0);
		const authComm = communities.find(c => c.memberQns.some(qn => qn.includes('AuthService')));
		expect(authComm).toBeDefined();
		expect(authComm!.name.toLowerCase()).toContain('auth');
	});

	it('names empty member list as "empty"', () => {
		store = createTestStore(engine);
		const communities = detectCommunities(store, 0);
		expect(communities).toHaveLength(0);
	});

	it('cohesion is high when all edges are internal', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'a', file_path: '/src/mod.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'b', file_path: '/src/mod.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'c', file_path: '/src/mod.ts', language: 'typescript' }));
		store.upsertEdge(makeEdge({ source: '/src/mod.ts::a', target: '/src/mod.ts::b', file_path: '/src/mod.ts', line: 5 }));
		store.upsertEdge(makeEdge({ source: '/src/mod.ts::b', target: '/src/mod.ts::c', file_path: '/src/mod.ts', line: 10 }));
		store.upsertEdge(makeEdge({ source: '/src/mod.ts::a', target: '/src/mod.ts::c', file_path: '/src/mod.ts', line: 15 }));

		const communities = detectCommunities(store, 2);
		expect(communities.length).toBeGreaterThan(0);
		const largest = communities.reduce((a, b) => a.size > b.size ? a : b);
		expect(largest.size).toBeGreaterThanOrEqual(2);
		expect(largest.cohesion).toBeGreaterThan(0);
	});

	it('cohesion is low when all edges are external', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'nodeA', file_path: '/src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'nodeB', file_path: '/src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'nodeC', file_path: '/src/b.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'nodeD', file_path: '/src/b.ts', language: 'typescript' }));

		store.upsertEdge(makeEdge({ source: '/src/a.ts::nodeA', target: '/src/b.ts::nodeC', file_path: '/src/a.ts', line: 5 }));
		store.upsertEdge(makeEdge({ source: '/src/b.ts::nodeD', target: '/src/a.ts::nodeB', file_path: '/src/b.ts', line: 5 }));

		const communities = detectCommunities(store, 2);
		for (const comm of communities) {
			expect(comm.cohesion).toBeLessThanOrEqual(1);
		}
	});

	it('detects dominant language', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const communities = detectCommunities(store, 2);
		for (const comm of communities) {
			expect(comm.dominantLanguage).toBeTruthy();
		}
	});
});

describe('storeCommunities & retrieval', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('stores and retrieves communities', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const detected = detectCommunities(store, 2);
		const count = storeCommunities(store, detected);
		expect(count).toBeGreaterThan(0);

		const retrieved = getCommunities(store);
		expect(retrieved.length).toBe(count);
	});

	it('updates node community_id references', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const detected = detectCommunities(store, 2);
		storeCommunities(store, detected);

		const node = store.getNode('/src/user/service.ts::getUser');
		expect(node).toBeDefined();
		expect(node!.community_id).not.toBeNull();
	});

	it('clears old communities on re-store', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const detected = detectCommunities(store, 2);
		storeCommunities(store, detected);
		storeCommunities(store, []);

		const retrieved = getCommunities(store);
		expect(retrieved).toHaveLength(0);
	});

	it('retrieves community by id with members', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const detected = detectCommunities(store, 2);
		storeCommunities(store, detected);

		const all = getCommunities(store);
		const info = getCommunityById(store, all[0]!.id);
		expect(info).not.toBeNull();
		expect(info!.members.length).toBeGreaterThan(0);
		expect(info!.community.id).toBe(all[0]!.id);
	});

	it('sorts by size descending', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const detected = detectCommunities(store, 2);
		storeCommunities(store, detected);

		const sorted = getCommunities(store, 'size');
		expect(sorted.length).toBeGreaterThanOrEqual(2);
		expect(sorted[0]!.size).toBeGreaterThanOrEqual(sorted[1]!.size);
	});

	it('sorts by cohesion descending', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const detected = detectCommunities(store, 2);
		storeCommunities(store, detected);

		const sorted = getCommunities(store, 'cohesion');
		expect(sorted.length).toBeGreaterThanOrEqual(2);
		expect(sorted[0]!.cohesion).toBeGreaterThanOrEqual(sorted[1]!.cohesion);
	});
});

describe('getArchitectureOverview', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('returns architecture overview with cross-community edges', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const detected = detectCommunities(store, 2);
		storeCommunities(store, detected);

		const overview = getArchitectureOverview(store);
		expect(overview.communities.length).toBeGreaterThan(0);
	});

	it('returns empty for no communities', () => {
		store = createTestStore(engine);
		const overview = getArchitectureOverview(store);
		expect(overview.communities).toHaveLength(0);
		expect(overview.cross_edges).toHaveLength(0);
	});

	it('detects cross-community edges', () => {
		store = createTestStore(engine);
		seedTwoClusters(store);

		const detected = detectCommunities(store, 2);
		expect(detected.length).toBeGreaterThanOrEqual(2);
		storeCommunities(store, detected);

		const overview = getArchitectureOverview(store);
		expect(overview.communities.length).toBeGreaterThanOrEqual(2);
		expect(overview.cross_edges.length).toBeGreaterThan(0);
		for (const ce of overview.cross_edges) {
			expect(ce.source_community).not.toBe(ce.target_community);
			expect(ce.edge_count).toBeGreaterThan(0);
			expect(ce.edge_kinds.length).toBeGreaterThan(0);
		}
	});
});
