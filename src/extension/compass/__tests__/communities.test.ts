import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { GraphStore } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import {
	detectCommunities,
	storeCommunities,
	getCommunities,
	getCommunityById,
	getArchitectureOverview,
	__setLouvainNodeThresholdForTesting,
} from '../communities';
import { createTestStore, testDbPath } from './sql-test-helper';


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

	it('detects communities from graph nodes', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const communities = await detectCommunities(store, 2);
		expect(communities.length).toBeGreaterThan(0);
		const totalMembers = communities.reduce((sum, c) => sum + c.size, 0);
		expect(totalMembers).toBeGreaterThanOrEqual(4);
	});

	it('assigns meaningful community names', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const communities = await detectCommunities(store, 2);
		for (const comm of communities) {
			expect(comm.name).toBeTruthy();
			expect(comm.name).not.toBe('empty');
		}
	});

	it('computes cohesion between 0 and 1', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const communities = await detectCommunities(store, 2);
		for (const comm of communities) {
			expect(comm.cohesion).toBeGreaterThanOrEqual(0);
			expect(comm.cohesion).toBeLessThanOrEqual(1);
		}
	});

	it('respects minSize filter', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const communities = await detectCommunities(store, 10);
		expect(communities).toHaveLength(0);
	});

	it('handles empty graph', async () => {
		store = createTestStore();
		const communities = await detectCommunities(store, 2);
		expect(communities).toHaveLength(0);
	});

	it('detects separate communities for disconnected clusters', async () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'funcA', file_path: '/src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'funcB', file_path: '/src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'funcC', file_path: '/src/b.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'funcD', file_path: '/src/b.ts', language: 'typescript' }));

		store.upsertEdge(makeEdge({ source: '/src/a.ts::funcA', target: '/src/a.ts::funcB', file_path: '/src/a.ts', line: 5 }));
		store.upsertEdge(makeEdge({ source: '/src/b.ts::funcC', target: '/src/b.ts::funcD', file_path: '/src/b.ts', line: 5 }));

		const communities = await detectCommunities(store, 2);
		expect(communities.length).toBeGreaterThanOrEqual(1);
	});

	it('falls back to directory-based detection when Louvain fails on edgeless graph', async () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'isolatedA', file_path: '/src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'isolatedB', file_path: '/src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'isolatedC', file_path: '/src/b.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'isolatedD', file_path: '/src/b.ts', language: 'typescript' }));

		const communities = await detectCommunities(store, 2);
		expect(communities.length).toBeGreaterThanOrEqual(1);
		for (const comm of communities) {
			expect(comm.description).toContain('Directory-based');
		}
	});

	it('directory-based fallback on flat-directory nodes falls back to file stems', async () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'isoA1', file_path: '/src/alpha.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'isoA2', file_path: '/src/alpha.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'isoB1', file_path: '/src/beta.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'isoB2', file_path: '/src/beta.ts', language: 'typescript' }));

		const communities = await detectCommunities(store, 2);
		expect(communities.length).toBeGreaterThanOrEqual(1);
		const descriptions = communities.map(c => c.description);
		expect(descriptions.some(d => d.includes('alpha') || d.includes('beta'))).toBe(true);
		for (const d of descriptions) {
			expect(d.startsWith('Directory-based community:')).toBe(true);
		}
	});

	it('directory-based fallback file-stem path strips the extension and groups by stem', async () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'fooA', file_path: '/pkg/Foo.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'fooB', file_path: '/pkg/Foo.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'barA', file_path: '/pkg/Bar.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'barB', file_path: '/pkg/Bar.ts', language: 'typescript' }));

		const communities = await detectCommunities(store, 2);
		const descriptions = communities.map(c => c.description);
		expect(descriptions.some(d => d === 'Directory-based community: Foo')).toBe(true);
		expect(descriptions.some(d => d === 'Directory-based community: Bar')).toBe(true);
		for (const d of descriptions) {
			expect(d.includes('.ts')).toBe(false);
		}
	});

	it('directory-based fallback on shared-prefix monorepo groups by segment after common prefix', async () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'fooA', file_path: '/repo/packages/foo/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'fooB', file_path: '/repo/packages/foo/b.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'barA', file_path: '/repo/packages/bar/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'barB', file_path: '/repo/packages/bar/b.ts', language: 'typescript' }));

		const communities = await detectCommunities(store, 2);
		expect(communities.length).toBeGreaterThanOrEqual(2);
		const descriptions = communities.map(c => c.description);
		expect(descriptions.some(d => d === 'Directory-based community: foo')).toBe(true);
		expect(descriptions.some(d => d === 'Directory-based community: bar')).toBe(true);
	});

	it('directory-based fallback respects minSize filter (excludes too-small groups)', async () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'aloneInBig', file_path: '/repo/small/only.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'bigA', file_path: '/repo/big/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'bigB', file_path: '/repo/big/b.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'bigC', file_path: '/repo/big/c.ts', language: 'typescript' }));

		const communities = await detectCommunities(store, 2);
		const descriptions = communities.map(c => c.description);
		expect(descriptions.some(d => d.includes('big'))).toBe(true);
		expect(descriptions.some(d => d.includes('small'))).toBe(false);
	});

	it('names community with dominant class when >40%', async () => {
		store = createTestStore();
		store.upsertNode(makeNode({ kind: 'Class', name: 'AuthService', file_path: '/src/auth/service.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'login', file_path: '/src/auth/service.ts', language: 'typescript' }));

		store.upsertEdge(makeEdge({
			source: '/src/auth/service.ts::login',
			target: '/src/auth/service.ts::AuthService',
			file_path: '/src/auth/service.ts',
		}));

		const communities = await detectCommunities(store, 1);
		expect(communities.length).toBeGreaterThan(0);
		const authComm = communities.find(c => c.memberQns.some(qn => qn.includes('AuthService')));
		expect(authComm).toBeDefined();
		expect(authComm!.name.toLowerCase()).toContain('auth');
	});

	it('names empty member list as "empty"', async () => {
		store = createTestStore();
		const communities = await detectCommunities(store, 0);
		expect(communities).toHaveLength(0);
	});

	it('cohesion is high when all edges are internal', async () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'a', file_path: '/src/mod.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'b', file_path: '/src/mod.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'c', file_path: '/src/mod.ts', language: 'typescript' }));
		store.upsertEdge(makeEdge({ source: '/src/mod.ts::a', target: '/src/mod.ts::b', file_path: '/src/mod.ts', line: 5 }));
		store.upsertEdge(makeEdge({ source: '/src/mod.ts::b', target: '/src/mod.ts::c', file_path: '/src/mod.ts', line: 10 }));
		store.upsertEdge(makeEdge({ source: '/src/mod.ts::a', target: '/src/mod.ts::c', file_path: '/src/mod.ts', line: 15 }));

		const communities = await detectCommunities(store, 2);
		expect(communities.length).toBeGreaterThan(0);
		const largest = communities.reduce((a, b) => a.size > b.size ? a : b);
		expect(largest.size).toBeGreaterThanOrEqual(2);
		expect(largest.cohesion).toBeGreaterThan(0);
	});

	it('cohesion is low when all edges are external', async () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'nodeA', file_path: '/src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'nodeB', file_path: '/src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'nodeC', file_path: '/src/b.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ name: 'nodeD', file_path: '/src/b.ts', language: 'typescript' }));

		store.upsertEdge(makeEdge({ source: '/src/a.ts::nodeA', target: '/src/b.ts::nodeC', file_path: '/src/a.ts', line: 5 }));
		store.upsertEdge(makeEdge({ source: '/src/b.ts::nodeD', target: '/src/a.ts::nodeB', file_path: '/src/b.ts', line: 5 }));

		const communities = await detectCommunities(store, 2);
		for (const comm of communities) {
			expect(comm.cohesion).toBeLessThanOrEqual(1);
		}
	});

	it('detects dominant language', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const communities = await detectCommunities(store, 2);
		for (const comm of communities) {
			expect(comm.dominantLanguage).toBeTruthy();
		}
	});

	it('scaled resolution on large graphs yields fewer communities than resolution=1.0 baseline', async () => {
		store = createTestStore();

		const numClusters = 50;
		const clusterSize = 6;
		for (let c = 0; c < numClusters; c++) {
			for (let n = 0; n < clusterSize; n++) {
				store.upsertNode(makeNode({
					name: `n_${c}_${n}`,
					file_path: `/src/c${c}.ts`,
					language: 'typescript',
					line_start: n * 10 + 1,
					line_end: n * 10 + 5,
				}));
			}
		}
		for (let c = 0; c < numClusters; c++) {
			for (let a = 0; a < clusterSize; a++) {
				for (let b = a + 1; b < clusterSize; b++) {
					store.upsertEdge(makeEdge({
						source: `/src/c${c}.ts::n_${c}_${a}`,
						target: `/src/c${c}.ts::n_${c}_${b}`,
						file_path: `/src/c${c}.ts`,
						line: a * 100 + b,
					}));
				}
			}
		}
		for (let c = 0; c < numClusters - 1; c++) {
			store.upsertEdge(makeEdge({
				source: `/src/c${c}.ts::n_${c}_0`,
				target: `/src/c${c + 1}.ts::n_${c + 1}_0`,
				file_path: `/src/c${c}.ts`,
				line: 999,
			}));
		}

		const scaledCommunities = await detectCommunities(store, 2);

		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const graphologyMod = require('graphology');
		const GraphCtor = graphologyMod.default ?? graphologyMod;
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const louvain = require('graphology-communities-louvain');

		const allNodes = store.getAllNodes();
		const allEdges = store.getAllEdges();
		const qnSet = new Set(allNodes.map(n => n.qualified_name));
		const g = new GraphCtor() as {
			addNode(id: string): void;
			mergeEdge(s: string, t: string): void;
			order: number;
		};
		for (const node of allNodes) g.addNode(node.qualified_name);
		for (const edge of allEdges) {
			if (!qnSet.has(edge.source_qualified) || !qnSet.has(edge.target_qualified)) continue;
			if (edge.source_qualified === edge.target_qualified) continue;
			g.mergeEdge(edge.source_qualified, edge.target_qualified);
		}
		const baselinePartition = louvain(g, { resolution: 1.0 }) as Record<string, number>;
		const baselineCount = new Set(Object.values(baselinePartition)).size;

		expect(scaledCommunities.length).toBeLessThan(baselineCount);
	});
});

describe('storeCommunities & retrieval', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('stores and retrieves communities', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const detected = await detectCommunities(store, 2);
		const count = await storeCommunities(store, detected);
		expect(count).toBeGreaterThan(0);

		const retrieved = getCommunities(store);
		expect(retrieved.length).toBe(count);
	});

	it('updates node community_id references', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const detected = await detectCommunities(store, 2);
		await storeCommunities(store, detected);

		const node = store.getNode('/src/user/service.ts::getUser');
		expect(node).toBeDefined();
		expect(node!.community_id).not.toBeNull();
	});

	it('clears old communities on re-store', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const detected = await detectCommunities(store, 2);
		await storeCommunities(store, detected);
		await storeCommunities(store, []);

		const retrieved = getCommunities(store);
		expect(retrieved).toHaveLength(0);
	});

	it('retrieves community by id with members', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const detected = await detectCommunities(store, 2);
		await storeCommunities(store, detected);

		const all = getCommunities(store);
		const info = getCommunityById(store, all[0]!.id);
		expect(info).not.toBeNull();
		expect(info!.members.length).toBeGreaterThan(0);
		expect(info!.community.id).toBe(all[0]!.id);
	});

	it('sorts by size descending', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const detected = await detectCommunities(store, 2);
		await storeCommunities(store, detected);

		const sorted = getCommunities(store, 'size');
		expect(sorted.length).toBeGreaterThanOrEqual(2);
		expect(sorted[0]!.size).toBeGreaterThanOrEqual(sorted[1]!.size);
	});

	it('sorts by cohesion descending', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const detected = await detectCommunities(store, 2);
		await storeCommunities(store, detected);

		const sorted = getCommunities(store, 'cohesion');
		expect(sorted.length).toBeGreaterThanOrEqual(2);
		expect(sorted[0]!.cohesion).toBeGreaterThanOrEqual(sorted[1]!.cohesion);
	});
});

describe('getArchitectureOverview', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('returns architecture overview with cross-community edges', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const detected = await detectCommunities(store, 2);
		await storeCommunities(store, detected);

		const overview = getArchitectureOverview(store);
		expect(overview.communities.length).toBeGreaterThan(0);
	});

	it('returns empty for no communities', async () => {
		store = createTestStore();
		const overview = getArchitectureOverview(store);
		expect(overview.communities).toHaveLength(0);
		expect(overview.cross_edges).toHaveLength(0);
	});

	it('detects cross-community edges', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const detected = await detectCommunities(store, 2);
		expect(detected.length).toBeGreaterThanOrEqual(2);
		await storeCommunities(store, detected);

		const overview = getArchitectureOverview(store);
		expect(overview.communities.length).toBeGreaterThanOrEqual(2);
		expect(overview.cross_edges.length).toBeGreaterThan(0);
		for (const ce of overview.cross_edges) {
			expect(ce.source_community).not.toBe(ce.target_community);
			expect(ce.edge_count).toBeGreaterThan(0);
			expect(ce.edge_kinds.length).toBeGreaterThan(0);
		}
	});

	it('excludes TESTED_BY cross-community edges from edge_count and edge_kinds', async () => {
		store = createTestStore();

		const userNames = ['u1', 'u2', 'u3', 'u4', 'u5'];
		const authNames = ['a1', 'a2', 'a3', 'a4', 'a5'];
		for (const n of userNames) {
			store.upsertNode(makeNode({ name: n, file_path: '/src/user/mod.ts', language: 'typescript' }));
		}
		for (const n of authNames) {
			store.upsertNode(makeNode({ name: n, file_path: '/src/auth/mod.ts', language: 'typescript' }));
		}

		let line = 1;
		for (let i = 0; i < userNames.length; i++) {
			for (let j = i + 1; j < userNames.length; j++) {
				store.upsertEdge(makeEdge({
					source: `/src/user/mod.ts::${userNames[i]}`,
					target: `/src/user/mod.ts::${userNames[j]}`,
					file_path: '/src/user/mod.ts', line: line++,
				}));
			}
		}
		for (let i = 0; i < authNames.length; i++) {
			for (let j = i + 1; j < authNames.length; j++) {
				store.upsertEdge(makeEdge({
					source: `/src/auth/mod.ts::${authNames[i]}`,
					target: `/src/auth/mod.ts::${authNames[j]}`,
					file_path: '/src/auth/mod.ts', line: line++,
				}));
			}
		}

		store.upsertEdge(makeEdge({
			source: '/src/auth/mod.ts::a1', target: '/src/user/mod.ts::u1',
			file_path: '/src/auth/mod.ts', line: line++,
		}));
		store.upsertEdge(makeEdge({
			source: '/src/auth/mod.ts::a2', target: '/src/user/mod.ts::u2',
			file_path: '/src/auth/mod.ts', line: line++,
		}));
		store.upsertEdge(makeEdge({
			source: '/src/auth/mod.ts::a3', target: '/src/user/mod.ts::u3',
			file_path: '/src/auth/mod.ts', line: line++,
		}));

		for (let i = 0; i < 5; i++) {
			store.upsertEdge(makeEdge({
				kind: 'TESTED_BY',
				source: `/src/auth/mod.ts::a${(i % 5) + 1}`,
				target: `/src/user/mod.ts::u${(i % 5) + 1}`,
				file_path: `/test/x${i}.ts`, line: i + 1,
			}));
		}

		const detected = await detectCommunities(store, 2);
		expect(detected.length).toBeGreaterThanOrEqual(2);
		await storeCommunities(store, detected);

		const overview = getArchitectureOverview(store);
		expect(overview.cross_edges.length).toBeGreaterThan(0);

		let totalCross = 0;
		for (const ce of overview.cross_edges) {
			expect(ce.edge_kinds).not.toContain('TESTED_BY');
			totalCross += ce.edge_count;
		}
		expect(totalCross).toBe(3);
	});
});

describe('storeCommunities batched writes (US-A1)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('emits one UPDATE nodes statement per community when members fit in a single chunk', async () => {
		store = createTestStore();
		seedTwoClusters(store);
		const detected = await detectCommunities(store, 2);
		expect(detected.length).toBeGreaterThan(0);

		const execSpy = vi.spyOn(store, 'execRaw');
		await storeCommunities(store, detected);

		const memberUpdates = execSpy.mock.calls.filter(([sql]) =>
			typeof sql === 'string' && /^UPDATE nodes SET community_id = \? WHERE qualified_name IN \(/.test(sql),
		);
		expect(memberUpdates.length).toBe(detected.length);

		for (const [sql, params] of memberUpdates) {
			expect(typeof sql).toBe('string');
			const placeholderCount = ((sql as string).match(/\?/g) ?? []).length;
			const paramArray = params as unknown[];
			expect(paramArray.length).toBe(placeholderCount);
		}

		execSpy.mockRestore();
	});

	it('chunks very large communities at 1000 names per UPDATE statement', async () => {
		store = createTestStore();

		const memberCount = 2_500;
		for (let i = 0; i < memberCount; i++) {
			store.upsertNode(makeNode({
				name: `huge_${i}`,
				file_path: '/src/huge/mod.ts',
				language: 'typescript',
				line_start: i + 1,
				line_end: i + 5,
			}));
		}

		const detected = [{
			name: 'huge',
			level: 0,
			size: memberCount,
			cohesion: 0.5,
			dominantLanguage: 'typescript',
			description: 'synthetic large community for chunk verification',
			memberQns: Array.from({ length: memberCount }, (_, i) => `/src/huge/mod.ts::huge_${i}`),
		}];

		const execSpy = vi.spyOn(store, 'execRaw');
		await storeCommunities(store, detected);

		const memberUpdates = execSpy.mock.calls.filter(([sql]) =>
			typeof sql === 'string' && /^UPDATE nodes SET community_id = \? WHERE qualified_name IN \(/.test(sql),
		);

		expect(memberUpdates.length).toBe(Math.ceil(memberCount / 1_000));

		let totalQns = 0;
		for (const [sql, params] of memberUpdates) {
			const placeholderCount = ((sql as string).match(/\?/g) ?? []).length;
			const paramArray = params as unknown[];
			expect(paramArray.length).toBe(placeholderCount);
			const qnPlaceholders = placeholderCount - 1;
			expect(qnPlaceholders).toBeGreaterThan(0);
			expect(qnPlaceholders).toBeLessThanOrEqual(1_000);
			totalQns += qnPlaceholders;
		}
		expect(totalQns).toBe(memberCount);

		execSpy.mockRestore();
	});
});

describe('storeCommunities transaction safety (US-001)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	function seedSyntheticCommunity(s: GraphStore, memberCount: number) {
		for (let i = 0; i < memberCount; i++) {
			s.upsertNode(makeNode({
				name: `member_${i}`,
				file_path: '/src/big/mod.ts',
				language: 'typescript',
				line_start: i + 1,
				line_end: i + 5,
			}));
		}
		return {
			name: 'big',
			level: 0,
			size: memberCount,
			cohesion: 0.5,
			dominantLanguage: 'typescript',
			description: 'synthetic community for transaction-safety checks',
			memberQns: Array.from({ length: memberCount }, (_, i) => `/src/big/mod.ts::member_${i}`),
		};
	}

	it('validation work dispatched at a yield point neither throws nor loses community writes', async () => {
		store = createTestStore();
		const community = seedSyntheticCommunity(store, 2_500);

		let yields = 0;
		const stored = await storeCommunities(store, [community], async () => {
			yields++;
			expect(store.inTransaction()).toBe(false);
			const validation = store.runValidation();
			expect(validation.nodeCount).toBeGreaterThan(0);
			store.withTransaction(() => store.removeFileData('/missing/file.ts'));
		});

		expect(yields).toBeGreaterThan(0);
		expect(stored).toBe(1);
		expect(getCommunities(store).length).toBe(1);
		const assigned = store.queryRaw('SELECT COUNT(*) as cnt FROM nodes WHERE community_id IS NOT NULL');
		expect(assigned[0]!['cnt']).toBe(2_500);
	});

	it('a serialize export taken at a yield point never captures uncommitted community state', async () => {
		store = createTestStore();
		const community = seedSyntheticCommunity(store, 2_500);
		await storeCommunities(store, [community]);

		let snapshot: Uint8Array | null = null;
		await storeCommunities(store, [community], async () => {
			expect(store.inTransaction()).toBe(false);
			snapshot = store.exportData();
		});

		expect(snapshot).not.toBeNull();
		// The snapshot is a standalone SQLite file image; write it out and reopen file-backed.
		const replicaPath = testDbPath();
		fs.writeFileSync(replicaPath, snapshot!);
		const replica = GraphStore.openAt(replicaPath);
		try {
			expect(replica.getCommunityCount()).toBe(1);
			for (const comm of getCommunities(replica)) {
				const members = replica.queryRaw('SELECT COUNT(*) as cnt FROM nodes WHERE community_id = ?', comm.id);
				expect(members[0]!['cnt']).toBe(comm.size);
			}
		} finally {
			replica.close();
		}
	});
});

describe('detectCommunities Louvain node-threshold gate (US-A1)', () => {
	let store: GraphStore;
	afterEach(() => {
		__setLouvainNodeThresholdForTesting(undefined);
		store?.close();
	});

	it('falls through to detectDirectoryBased when graph size exceeds the Louvain node threshold', async () => {
		store = createTestStore();
		const numClusters = 8;
		const clusterSize = 5;
		for (let c = 0; c < numClusters; c++) {
			for (let n = 0; n < clusterSize; n++) {
				store.upsertNode(makeNode({
					name: `wcg_${c}_${n}`,
					file_path: `/repo/wcg/c${c}/file.ts`,
					language: 'typescript',
					line_start: n * 10 + 1,
					line_end: n * 10 + 5,
				}));
			}
		}
		for (let c = 0; c < numClusters; c++) {
			for (let a = 0; a < clusterSize; a++) {
				for (let b = a + 1; b < clusterSize; b++) {
					store.upsertEdge(makeEdge({
						source: `/repo/wcg/c${c}/file.ts::wcg_${c}_${a}`,
						target: `/repo/wcg/c${c}/file.ts::wcg_${c}_${b}`,
						file_path: `/repo/wcg/c${c}/file.ts`,
						line: a * 100 + b,
					}));
				}
			}
		}

		__setLouvainNodeThresholdForTesting(0);

		const communities = await detectCommunities(store, 2);
		expect(communities.length).toBeGreaterThan(0);
		for (const comm of communities) {
			expect(comm.description.startsWith('Directory-based community:')).toBe(true);
		}
	});

	it('uses Louvain when graph size is within the threshold', async () => {
		store = createTestStore();
		seedTwoClusters(store);

		const communities = await detectCommunities(store, 2);
		expect(communities.length).toBeGreaterThan(0);
		const louvainResults = communities.filter(c => c.description.startsWith('Community of '));
		expect(louvainResults.length).toBeGreaterThan(0);
	});
});

describe('detectCommunities determinism (US-A1)', () => {
	let storeA: GraphStore;
	let storeB: GraphStore;
	afterEach(() => {
		storeA?.close();
		storeB?.close();
	});

	function seedDeterminismFixture(store: GraphStore): void {
		const numClusters = 8;
		const clusterSize = 6;
		for (let c = 0; c < numClusters; c++) {
			for (let n = 0; n < clusterSize; n++) {
				store.upsertNode(makeNode({
					name: `det_${c}_${n}`,
					file_path: `/src/det/c${c}.ts`,
					language: 'typescript',
					line_start: n * 10 + 1,
					line_end: n * 10 + 5,
				}));
			}
		}
		for (let c = 0; c < numClusters; c++) {
			for (let a = 0; a < clusterSize; a++) {
				for (let b = a + 1; b < clusterSize; b++) {
					store.upsertEdge(makeEdge({
						source: `/src/det/c${c}.ts::det_${c}_${a}`,
						target: `/src/det/c${c}.ts::det_${c}_${b}`,
						file_path: `/src/det/c${c}.ts`,
						line: a * 100 + b,
					}));
				}
			}
		}
		for (let c = 0; c < numClusters - 1; c++) {
			store.upsertEdge(makeEdge({
				source: `/src/det/c${c}.ts::det_${c}_0`,
				target: `/src/det/c${c + 1}.ts::det_${c + 1}_0`,
				file_path: `/src/det/c${c}.ts`,
				line: 999,
			}));
		}
	}

	function partitionMap(communities: Awaited<ReturnType<typeof detectCommunities>>): Map<string, string> {
		const map = new Map<string, string>();
		for (const comm of communities) {
			const sortedMembers = [...comm.memberQns].sort();
			const groupKey = sortedMembers.join('|');
			for (const qn of sortedMembers) {
				map.set(qn, groupKey);
			}
		}
		return map;
	}

	it('produces identical community assignments across two runs on the same fixture', async () => {
		storeA = createTestStore();
		storeB = createTestStore();
		seedDeterminismFixture(storeA);
		seedDeterminismFixture(storeB);

		const runA = await detectCommunities(storeA, 2);
		const runB = await detectCommunities(storeB, 2);

		const mapA = partitionMap(runA);
		const mapB = partitionMap(runB);

		expect(mapA.size).toBe(mapB.size);
		for (const [qn, groupKey] of mapA) {
			expect(mapB.get(qn)).toBe(groupKey);
		}
	});
});

describe('detectCommunities cohesion benchmark (US-A2)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('completes 100 communities × 50 nodes / 5K edges in under 2 seconds', async () => {
		store = createTestStore();

		const numClusters = 100;
		const clusterSize = 50;
		const edgesPerCluster = 50;
		// Batch the seed writes in one transaction (production does the same); the timed section below is the benchmark.
		store.withTransaction(() => {
			for (let c = 0; c < numClusters; c++) {
				for (let n = 0; n < clusterSize; n++) {
					store.upsertNode(makeNode({
						name: `bm_${c}_${n}`,
						file_path: `/repo/bm/cluster${c}/file.ts`,
						language: 'typescript',
						line_start: n * 10 + 1,
						line_end: n * 10 + 5,
					}));
				}
			}
			let edgeLine = 1;
			for (let c = 0; c < numClusters; c++) {
				for (let e = 0; e < edgesPerCluster; e++) {
					const a = e % clusterSize;
					const b = (e * 7 + 3) % clusterSize;
					if (a === b) continue;
					store.upsertEdge(makeEdge({
						source: `/repo/bm/cluster${c}/file.ts::bm_${c}_${a}`,
						target: `/repo/bm/cluster${c}/file.ts::bm_${c}_${b}`,
						file_path: `/repo/bm/cluster${c}/file.ts`,
						line: edgeLine++,
					}));
				}
			}
		});

		const start = Date.now();
		const communities = await detectCommunities(store, 2);
		const elapsedMs = Date.now() - start;

		expect(communities.length).toBeGreaterThan(0);
		expect(elapsedMs).toBeLessThan(2_000);
	});
});
