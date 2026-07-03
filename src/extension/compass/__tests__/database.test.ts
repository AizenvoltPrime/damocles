import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { GraphStore } from '../database';
import { createWrapper } from '../db-wrapper';
import type { NodeInfo, EdgeInfo } from '../types';
import {
	getSchemaVersion,
	getExtractionFormatVersion,
	runMigrations,
	CURRENT_SCHEMA_VERSION,
	CURRENT_EXTRACTION_FORMAT_VERSION,
} from '../migrations';
import { storeFlows } from '../flows';
import { createTestStore, testDbPath } from './sql-test-helper';


function makeNode(overrides: Partial<NodeInfo> & { name: string; file_path: string }): NodeInfo {
	return {
		kind: 'Function',
		line_start: 1,
		line_end: 10,
		...overrides,
	};
}

function makeEdge(overrides: Partial<EdgeInfo> & { source: string; target: string; file_path: string }): EdgeInfo {
	return {
		kind: 'CALLS',
		...overrides,
	};
}

describe('GraphStore CRUD', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('opens and reports isOpen', () => {
		store = createTestStore();
		expect(store.isOpen).toBe(true);
	});

	it('throws when accessing db before open', () => {
		store = new GraphStore('/tmp/unused.db');
		expect(() => store.db).toThrow('GraphStore not open');
	});

	it('inserts and retrieves a node by qualified name', () => {
		store = createTestStore();
		const id = store.upsertNode(makeNode({
			kind: 'Function',
			name: 'myFunc',
			file_path: 'src/test.ts',
			line_start: 5,
			line_end: 20,
			language: 'typescript',
			params: '(x: number)',
			return_type: 'void',
		}));
		expect(id).toBeGreaterThan(0);

		const node = store.getNode('src/test.ts::myFunc');
		expect(node).toBeDefined();
		expect(node!.name).toBe('myFunc');
		expect(node!.kind).toBe('Function');
		expect(node!.file_path).toBe('src/test.ts');
		expect(node!.line_start).toBe(5);
		expect(node!.line_end).toBe(20);
		expect(node!.language).toBe('typescript');
		expect(node!.params).toBe('(x: number)');
		expect(node!.return_type).toBe('void');
	});

	it('computes name_tokens via splitIdentifier', () => {
		store = createTestStore();
		store.upsertNode(makeNode({
			kind: 'Class',
			name: 'CompassService',
			file_path: 'src/index.ts',
		}));
		const node = store.getNode('src/index.ts::CompassService');
		expect(node!.name_tokens).toBe('compass service');
	});

	it('computes qualified_name with parent', () => {
		store = createTestStore();
		store.upsertNode(makeNode({
			name: 'getStatus',
			file_path: 'src/index.ts',
			parent_name: 'CompassService',
		}));
		const node = store.getNode('src/index.ts::CompassService::getStatus');
		expect(node).toBeDefined();
		expect(node!.parent_name).toBe('CompassService');
	});

	it('upserts existing node (update on conflict)', () => {
		store = createTestStore();
		store.upsertNode(makeNode({
			name: 'myFunc',
			file_path: 'src/test.ts',
			line_start: 1,
			line_end: 10,
		}));
		store.upsertNode(makeNode({
			name: 'myFunc',
			file_path: 'src/test.ts',
			line_start: 5,
			line_end: 25,
			language: 'typescript',
		}));

		const node = store.getNode('src/test.ts::myFunc');
		expect(node!.line_start).toBe(5);
		expect(node!.line_end).toBe(25);
		expect(node!.language).toBe('typescript');
		expect(store.getNodeCount()).toBe(1);
	});

	it('retrieves node by id', () => {
		store = createTestStore();
		const id = store.upsertNode(makeNode({
			name: 'foo',
			file_path: 'src/a.ts',
		}));
		const node = store.getNodeById(id);
		expect(node).toBeDefined();
		expect(node!.name).toBe('foo');
	});

	it('retrieves nodes by file', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'a', file_path: 'src/a.ts' }));
		store.upsertNode(makeNode({ name: 'b', file_path: 'src/a.ts' }));
		store.upsertNode(makeNode({ name: 'c', file_path: 'src/b.ts' }));

		const nodes = store.getNodesByFile('src/a.ts');
		expect(nodes).toHaveLength(2);
		expect(nodes.map(n => n.name).sort()).toEqual(['a', 'b']);
	});

	it('retrieves nodes by kind', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ kind: 'Class', name: 'MyClass', file_path: 'a.ts' }));
		store.upsertNode(makeNode({ kind: 'Function', name: 'myFunc', file_path: 'a.ts' }));
		store.upsertNode(makeNode({ kind: 'Class', name: 'Other', file_path: 'b.ts' }));

		expect(store.getNodesByKind('Class')).toHaveLength(2);
		expect(store.getNodesByKind('Function')).toHaveLength(1);
	});

	it('handles is_test flag', () => {
		store = createTestStore();
		store.upsertNode(makeNode({
			name: 'testFoo',
			file_path: 'test.ts',
			is_test: true,
		}));
		const node = store.getNode('test.ts::testFoo');
		expect(node!.is_test).toBe(1);
	});

	it('stores and retrieves extra JSON', () => {
		store = createTestStore();
		store.upsertNode(makeNode({
			name: 'decorated',
			file_path: 'src/a.ts',
			extra: { decorators: ['@Test'] },
		}));
		const node = store.getNode('src/a.ts::decorated');
		expect(JSON.parse(node!.extra)).toEqual({ decorators: ['@Test'] });
	});
});

describe('GraphStore edges', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('inserts and retrieves an edge', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'caller', file_path: 'a.ts' }));
		store.upsertNode(makeNode({ name: 'callee', file_path: 'a.ts' }));

		const id = store.upsertEdge(makeEdge({
			kind: 'CALLS',
			source: 'a.ts::caller',
			target: 'a.ts::callee',
			file_path: 'a.ts',
			line: 5,
		}));
		expect(id).toBeGreaterThan(0);

		const bySource = store.getEdgesBySource('a.ts::caller');
		expect(bySource).toHaveLength(1);
		expect(bySource[0]!.target_qualified).toBe('a.ts::callee');

		const byTarget = store.getEdgesByTarget('a.ts::callee');
		expect(byTarget).toHaveLength(1);
		expect(byTarget[0]!.source_qualified).toBe('a.ts::caller');
	});

	it('upserts existing edge (same kind+source+target+file+line)', () => {
		store = createTestStore();
		const id1 = store.upsertEdge(makeEdge({
			source: 'a::x',
			target: 'a::y',
			file_path: 'a.ts',
			line: 10,
		}));
		const id2 = store.upsertEdge(makeEdge({
			source: 'a::x',
			target: 'a::y',
			file_path: 'a.ts',
			line: 10,
			extra: { updated: true },
		}));

		expect(id2).toBe(id1);
		expect(store.getEdgeCount()).toBe(1);
	});

	it('preserves distinct call sites (different lines)', () => {
		store = createTestStore();
		store.upsertEdge(makeEdge({
			source: 'a::x',
			target: 'a::y',
			file_path: 'a.ts',
			line: 10,
		}));
		store.upsertEdge(makeEdge({
			source: 'a::x',
			target: 'a::y',
			file_path: 'a.ts',
			line: 20,
		}));

		expect(store.getEdgeCount()).toBe(2);
	});

	it('getEdgesByTargetName anchors on the :: boundary (no bare-suffix over-match)', () => {
		store = createTestStore();
		store.upsertEdge(makeEdge({ source: 'x.ts::c1', target: 'f.ts::save', file_path: 'x.ts' }));
		store.upsertEdge(makeEdge({ source: 'x.ts::c2', target: 'f.ts::unsave', file_path: 'x.ts' }));
		store.upsertEdge(makeEdge({ source: 'x.ts::c3', target: 'save', file_path: 'x.ts' }));

		const targets = store.getEdgesByTargetName('save', ['CALLS']).map(e => e.target_qualified).sort();
		expect(targets).toEqual(['f.ts::save', 'save']);
	});

	it('getEdgesByKinds returns all edges of the requested kinds', () => {
		store = createTestStore();
		store.upsertEdge(makeEdge({ kind: 'CALLS', source: 'a::x', target: 'a::y', file_path: 'a.ts' }));
		store.upsertEdge(makeEdge({ kind: 'IMPORTS_FROM', source: 'a::x', target: 'lib', file_path: 'a.ts' }));
		store.upsertEdge(makeEdge({ kind: 'REFERENCES', source: 'a::y', target: 'a::z', file_path: 'a.ts' }));

		expect(store.getEdgesByKinds(['CALLS', 'REFERENCES'])).toHaveLength(2);
		expect(store.getEdgesByKinds([])).toHaveLength(0);
	});

	it('getEdgesAmong returns connecting edges', () => {
		store = createTestStore();
		store.upsertEdge(makeEdge({ source: 'a::x', target: 'a::y', file_path: 'a.ts' }));
		store.upsertEdge(makeEdge({ source: 'a::y', target: 'a::z', file_path: 'a.ts' }));
		store.upsertEdge(makeEdge({ source: 'b::w', target: 'b::v', file_path: 'b.ts' }));

		const edges = store.getEdgesAmong(new Set(['a::x', 'a::y', 'a::z']));
		expect(edges).toHaveLength(2);
	});
});

describe('GraphStore file operations', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('removeFileData clears all nodes and edges for a file', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'a', file_path: 'src/target.ts' }));
		store.upsertNode(makeNode({ name: 'b', file_path: 'src/target.ts' }));
		store.upsertNode(makeNode({ name: 'c', file_path: 'src/other.ts' }));
		store.upsertEdge(makeEdge({ source: 'src/target.ts::a', target: 'src/target.ts::b', file_path: 'src/target.ts' }));
		store.upsertEdge(makeEdge({ source: 'src/other.ts::c', target: 'src/target.ts::a', file_path: 'src/other.ts' }));

		store.removeFileData('src/target.ts');

		expect(store.getNodesByFile('src/target.ts')).toHaveLength(0);
		expect(store.getNodesByFile('src/other.ts')).toHaveLength(1);
		expect(store.getEdgeCount()).toBe(1);
	});

	it('storeFileNodesEdges atomically replaces file data', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'old', file_path: 'src/a.ts', line_start: 1, line_end: 5 }));

		store.storeFileNodesEdges('src/a.ts', [
			makeNode({ name: 'new1', file_path: 'src/a.ts', line_start: 1, line_end: 10 }),
			makeNode({ name: 'new2', file_path: 'src/a.ts', line_start: 11, line_end: 20 }),
		], [
			makeEdge({ source: 'src/a.ts::new1', target: 'src/a.ts::new2', file_path: 'src/a.ts' }),
		]);

		expect(store.getNodesByFile('src/a.ts')).toHaveLength(2);
		expect(store.getNode('src/a.ts::old')).toBeUndefined();
		expect(store.getNode('src/a.ts::new1')).toBeDefined();
		expect(store.getEdgeCount()).toBe(1);
	});

	it('storeFileNodesEdges stores file hash', () => {
		store = createTestStore();
		store.storeFileNodesEdges('src/a.ts', [
			makeNode({ kind: 'File', name: 'a.ts', file_path: 'src/a.ts' }),
		], [], 'abc123');

		const node = store.getNode('src/a.ts::a.ts');
		expect(node!.file_hash).toBe('abc123');
	});

	it('getAllFiles returns distinct File-kind paths', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ kind: 'File', name: 'a.ts', file_path: 'src/a.ts' }));
		store.upsertNode(makeNode({ kind: 'Function', name: 'foo', file_path: 'src/a.ts' }));
		store.upsertNode(makeNode({ kind: 'File', name: 'b.ts', file_path: 'src/b.ts' }));

		const files = store.getAllFiles();
		expect(files.sort()).toEqual(['src/a.ts', 'src/b.ts']);
	});
});

describe('GraphStore stats', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('returns correct counts and breakdowns', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ kind: 'File', name: 'a.ts', file_path: 'src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ kind: 'Class', name: 'MyClass', file_path: 'src/a.ts', language: 'typescript' }));
		store.upsertNode(makeNode({ kind: 'Function', name: 'myFunc', file_path: 'src/a.ts', language: 'typescript' }));
		store.upsertEdge(makeEdge({ kind: 'CALLS', source: 'src/a.ts::myFunc', target: 'src/a.ts::MyClass', file_path: 'src/a.ts' }));
		store.upsertEdge(makeEdge({ kind: 'CONTAINS', source: 'src/a.ts::a.ts', target: 'src/a.ts::MyClass', file_path: 'src/a.ts' }));

		const stats = store.getStats();
		expect(stats.total_nodes).toBe(3);
		expect(stats.total_edges).toBe(2);
		expect(stats.nodes_by_kind['Class']).toBe(1);
		expect(stats.nodes_by_kind['Function']).toBe(1);
		expect(stats.nodes_by_kind['File']).toBe(1);
		expect(stats.edges_by_kind['CALLS']).toBe(1);
		expect(stats.edges_by_kind['CONTAINS']).toBe(1);
		expect(stats.languages).toContain('typescript');
		expect(stats.files_count).toBe(1);
	});
});

describe('GraphStore metadata', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('sets and gets metadata', () => {
		store = createTestStore();
		store.setMetadata('last_updated', '2026-01-01T00:00:00Z');
		expect(store.getMetadata('last_updated')).toBe('2026-01-01T00:00:00Z');
	});

	it('returns undefined for missing key', () => {
		store = createTestStore();
		expect(store.getMetadata('nonexistent')).toBeUndefined();
	});

	it('overwrites metadata on duplicate key', () => {
		store = createTestStore();
		store.setMetadata('key', 'value1');
		store.setMetadata('key', 'value2');
		expect(store.getMetadata('key')).toBe('value2');
	});
});

describe('GraphStore persistence', () => {
	let store: GraphStore;

	it('serialize persists to the db file and survives reopen', async () => {
		const dir = path.join(os.tmpdir(), `compass-test-${Date.now()}`);
		const dbPath = path.join(dir, 'graph.db');

		store = GraphStore.openAt(dbPath);
		store.upsertNode(makeNode({ name: 'persist', file_path: 'src/a.ts' }));

		await store.serialize();

		expect(fs.existsSync(dbPath)).toBe(true);
		store.close();

		const store2 = GraphStore.openAt(dbPath);
		const node = store2.getNode('src/a.ts::persist');
		expect(node).toBeDefined();
		expect(node!.name).toBe('persist');
		store2.close();

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('exportData returns the db file bytes with a valid SQLite header', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'exported', file_path: 'src/a.ts' }));

		const data = store.exportData();
		expect(Buffer.from(data.subarray(0, 16)).toString('utf8')).toBe('SQLite format 3\0');
		store.close();
	});
});

describe('Migration re-entrancy', () => {
	it('running migrations twice is safe', () => {
		const store = createTestStore();
		const dbPath = store.dbPath;
		expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(getExtractionFormatVersion(store.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);
		store.close();

		// Reopen the same file → migrations run again against an already-migrated DB.
		const store2 = GraphStore.openAt(dbPath);
		expect(getSchemaVersion(store2.db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(getExtractionFormatVersion(store2.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);
		store2.close();
	});

	it('fresh database has current schema and extraction-format versions', () => {
		const store = createTestStore();
		expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(getExtractionFormatVersion(store.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);
		store.close();
	});

	it('treats legacy schema_version=2 as extraction_format_version=1 (no duplicate wipe)', () => {
		const store = createTestStore();
		store.db.prepare(
			'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
		).run('schema_version', '2');
		store.db.prepare('DELETE FROM metadata WHERE key = ?').run('extraction_format_version');

		expect(getExtractionFormatVersion(store.db)).toBe(1);
		store.close();
	});

	it('runValidation excludes test fixture paths from unresolvedInternalRefs', () => {
		const store = createTestStore();
		try {
			store.upsertNode(makeNode({ name: 'ProdModule', kind: 'File', file_path: '/repo/src/prod/module.ts' }));
			store.upsertNode(makeNode({ name: 'FixtureModule', kind: 'File', file_path: '/repo/src/extension/compass/__tests__/fixtures/sample_barrel.ts' }));
			store.upsertNode(makeNode({ name: 'AltFixture', kind: 'File', file_path: '/repo/tests/fixtures/data.ts' }));
			store.upsertNode(makeNode({ name: 'UnderscoreFix', kind: 'File', file_path: '/repo/src/__fixtures__/blob.ts' }));

			store.upsertEdge(makeEdge({
				kind: 'IMPORTS_FROM',
				source: '/repo/src/prod/module.ts::ProdModule',
				target: './missing-prod-file',
				file_path: '/repo/src/prod/module.ts',
				line: 1,
			}));
			store.upsertEdge(makeEdge({
				kind: 'IMPORTS_FROM',
				source: '/repo/src/extension/compass/__tests__/fixtures/sample_barrel.ts::FixtureModule',
				target: './UserService',
				file_path: '/repo/src/extension/compass/__tests__/fixtures/sample_barrel.ts',
				line: 1,
			}));
			store.upsertEdge(makeEdge({
				kind: 'IMPORTS_FROM',
				source: '/repo/tests/fixtures/data.ts::AltFixture',
				target: './alt-missing',
				file_path: '/repo/tests/fixtures/data.ts',
				line: 1,
			}));
			store.upsertEdge(makeEdge({
				kind: 'IMPORTS_FROM',
				source: '/repo/src/__fixtures__/blob.ts::UnderscoreFix',
				target: './underscore-missing',
				file_path: '/repo/src/__fixtures__/blob.ts',
				line: 1,
			}));

			const v = store.runValidation();
			const unresolvedTargets = v.unresolvedInternalRefs.entities.join(' | ');

			expect(unresolvedTargets).toContain('./missing-prod-file');
			expect(unresolvedTargets).not.toContain('./UserService');
			expect(unresolvedTargets).not.toContain('./alt-missing');
			expect(unresolvedTargets).not.toContain('./underscore-missing');
			expect(v.unresolvedInternalRefs.count).toBe(1);
		} finally {
			store.close();
		}
	});

	it('getFlowCriticalitiesForNode returns criticalities for all flows a node participates in', () => {
		const store = createTestStore();
		try {
			store.upsertNode(makeNode({ name: 'multiFlow', file_path: '/src/a.ts' }));
			const node = store.getNode('/src/a.ts::multiFlow')!;

			expect(store.getFlowCriticalitiesForNode(node.id)).toEqual([]);

			const crits = [0.1, 0.4, 0.25];
			for (const c of crits) {
				store.execRaw(
					"INSERT INTO flows (name, entry_point_id, depth, node_count, file_count, criticality, path_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
					[`f_${c}`, node.id, 1, 1, 1, c, JSON.stringify([node.id])],
				);
				const r = store.queryRaw('SELECT last_insert_rowid() as id');
				const fid = (r[0]?.['id'] ?? 0) as number;
				store.execRaw(
					'INSERT INTO flow_memberships (flow_id, node_id, position) VALUES (?, ?, ?)',
					[fid, node.id, 0],
				);
			}

			const result = store.getFlowCriticalitiesForNode(node.id);
			expect(result).toHaveLength(3);
			expect([...result].sort((a, b) => a - b)).toEqual([0.1, 0.25, 0.4]);
		} finally {
			store.close();
		}
	});

	it('migrates v1 → v2 by creating compound edge indexes', () => {
		const store = createTestStore();
		try {
			store.db.exec('DROP INDEX IF EXISTS idx_edges_target_kind');
			store.db.exec('DROP INDEX IF EXISTS idx_edges_source_kind');
			store.db.exec('DROP INDEX IF EXISTS idx_edges_composite');
			store.db.prepare(
				'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
			).run('schema_version', '1');

			expect(getSchemaVersion(store.db)).toBe(1);
			const beforeRows = store.db.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edges'",
			).all() as { name: string }[];
			const beforeNames = new Set(beforeRows.map(r => r.name));
			expect(beforeNames.has('idx_edges_target_kind')).toBe(false);
			expect(beforeNames.has('idx_edges_source_kind')).toBe(false);
			expect(beforeNames.has('idx_edges_composite')).toBe(false);

			runMigrations(store.db);

			expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
			const afterRows = store.db.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edges'",
			).all() as { name: string }[];
			const afterNames = new Set(afterRows.map(r => r.name));
			expect(afterNames.has('idx_edges_target_kind')).toBe(true);
			expect(afterNames.has('idx_edges_source_kind')).toBe(true);
			expect(afterNames.has('idx_edges_composite')).toBe(true);

			runMigrations(store.db);
			expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
		} finally {
			store.close();
		}
	});

	it('migrates extraction-format v1 → v2 by clearing seeded graph data and bumping version', () => {
		const store = createTestStore();
		try {
			store.upsertNode(makeNode({ kind: 'File', name: 'a.ts', file_path: 'src/a.ts' }));
			store.upsertNode(makeNode({ kind: 'Function', name: 'foo', file_path: 'src/a.ts' }));
			store.upsertEdge(makeEdge({ source: 'src/a.ts::a.ts', target: 'src/a.ts::foo', file_path: 'src/a.ts' }));
			store.execRaw(
				"INSERT INTO communities (name, level, parent_id, cohesion, size) VALUES (?, ?, ?, ?, ?)",
				['cluster-1', 0, null, 0.5, 2],
			);
			const fooId = store.getNode('src/a.ts::foo')!.id;
			store.execRaw(
				"INSERT INTO flows (name, entry_point_id, depth, node_count, file_count, criticality, path_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
				['flow-1', fooId, 0, 1, 1, 0.1, JSON.stringify([fooId])],
			);
			const flowRow = store.queryRaw('SELECT last_insert_rowid() as id');
			const flowId = (flowRow[0]?.['id'] ?? 0) as number;
			store.execRaw(
				'INSERT INTO flow_memberships (flow_id, node_id, position) VALUES (?, ?, ?)',
				[flowId, fooId, 0],
			);

			store.db.prepare(
				'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
			).run('extraction_format_version', '1');

			expect(store.getNodeCount()).toBe(2);
			expect(store.getEdgeCount()).toBe(1);
			expect(store.getCommunityCount()).toBe(1);
			expect(store.getFlowCount()).toBe(1);
			expect(getExtractionFormatVersion(store.db)).toBe(1);

			runMigrations(store.db);

			expect(getExtractionFormatVersion(store.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);
			expect(store.getNodeCount()).toBe(0);
			expect(store.getEdgeCount()).toBe(0);
			expect(store.getCommunityCount()).toBe(0);
			expect(store.getFlowCount()).toBe(0);
			const flowMembershipCount = (store.db.prepare(
				'SELECT COUNT(*) as cnt FROM flow_memberships',
			).get() as { cnt: number }).cnt;
			expect(flowMembershipCount).toBe(0);
			expect(store.getMetadata('extraction_format_version')).toBe(String(CURRENT_EXTRACTION_FORMAT_VERSION));
		} finally {
			store.close();
		}
	});

	it('extraction-format v2 migration is a no-op on a freshly re-extracted graph', () => {
		const store = createTestStore();
		try {
			expect(getExtractionFormatVersion(store.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);

			store.upsertNode(makeNode({ kind: 'File', name: 'b.ts', file_path: 'src/b.ts' }));
			store.upsertNode(makeNode({ kind: 'Function', name: 'bar', file_path: 'src/b.ts' }));
			store.upsertEdge(makeEdge({ source: 'src/b.ts::b.ts', target: 'src/b.ts::bar', file_path: 'src/b.ts' }));

			const nodesBefore = store.getNodeCount();
			const edgesBefore = store.getEdgeCount();
			expect(nodesBefore).toBe(2);
			expect(edgesBefore).toBe(1);

			runMigrations(store.db);

			expect(getExtractionFormatVersion(store.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);
			expect(store.getNodeCount()).toBe(nodesBefore);
			expect(store.getEdgeCount()).toBe(edgesBefore);
			expect(store.getNode('src/b.ts::bar')).toBeDefined();
		} finally {
			store.close();
		}
	});

	it('getSchemaVersion returns 0 when metadata table does not exist', () => {
		const dbPath = testDbPath();
		const raw = new DatabaseSync(dbPath);
		const wrapper = createWrapper(raw, dbPath);
		expect(getSchemaVersion(wrapper)).toBe(0);
		wrapper.close();
	});

	it('bounds the prepared-statement cache under many distinct IN-list shapes and stays correct (M)', () => {
		const dbPath = testDbPath();
		const raw = new DatabaseSync(dbPath);
		const wrapper = createWrapper(raw, dbPath);
		try {
			wrapper.exec('CREATE TABLE t (x INTEGER)');
			for (let i = 1; i <= 50; i++) wrapper.prepare('INSERT INTO t (x) VALUES (?)').run(i);

			// 400 distinct placeholder shapes (> the 256 cap) — an unbounded cache would keep all 400.
			for (let n = 1; n <= 400; n++) {
				const placeholders = Array.from({ length: n }, () => '?').join(',');
				const ids = Array.from({ length: n }, (_, i) => (i % 50) + 1);
				wrapper.prepare(`SELECT COUNT(*) AS c FROM t WHERE x IN (${placeholders})`).all(...ids);
			}

			// A re-prepared (evicted) small shape still returns correct results.
			const row = wrapper.prepare('SELECT COUNT(*) AS c FROM t WHERE x IN (?,?)').get(1, 2) as { c: number };
			expect(row.c).toBe(2);
		} finally {
			wrapper.close();
		}
	});
});

describe('resolveGraphFilePaths (US-004)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	function seedFiles(s: GraphStore): void {
		s.upsertNode(makeNode({ kind: 'File', name: 'foo.ts', file_path: '/repo/src/foo.ts' }));
		s.upsertNode(makeNode({ kind: 'File', name: 'foo.ts', file_path: '/repo/othersrc/foo.ts' }));
		s.upsertNode(makeNode({ kind: 'File', name: 'bar.ts', file_path: '/repo/src/util/bar.ts' }));
	}

	it('matches an exact absolute path', () => {
		store = createTestStore();
		seedFiles(store);
		expect(store.resolveGraphFilePaths(['/repo/src/foo.ts'])).toEqual(['/repo/src/foo.ts']);
	});

	it('matches a backslash relative path via segment-anchored suffix', () => {
		store = createTestStore();
		seedFiles(store);
		expect(store.resolveGraphFilePaths(['src\\util\\bar.ts'])).toEqual(['/repo/src/util/bar.ts']);
	});

	it('does not match a non-segment-aligned suffix (src/foo.ts must not match othersrc/foo.ts)', () => {
		store = createTestStore();
		seedFiles(store);
		const resolved = store.resolveGraphFilePaths(['src/foo.ts']);
		expect(resolved).toContain('/repo/src/foo.ts');
		expect(resolved).not.toContain('/repo/othersrc/foo.ts');
	});

	it('resolves a workspace-relative path against stored absolute paths', () => {
		store = createTestStore();
		seedFiles(store);
		expect(store.resolveGraphFilePaths(['src/util/bar.ts'], '/repo')).toContain('/repo/src/util/bar.ts');
	});

	it('grouped resolver returns matches keyed by each input path (single scan)', () => {
		store = createTestStore();
		seedFiles(store);
		const grouped = store.resolveGraphFilePathsGrouped(['/repo/src/foo.ts', 'src\\util\\bar.ts', 'missing/x.ts']);
		expect(grouped.get('/repo/src/foo.ts')).toEqual(['/repo/src/foo.ts']);
		expect(grouped.get('src\\util\\bar.ts')).toEqual(['/repo/src/util/bar.ts']);
		expect(grouped.get('missing/x.ts')).toEqual([]);
	});

	it.skipIf(process.platform !== 'win32')('matches case-insensitively on win32', () => {
		store = createTestStore();
		seedFiles(store);
		expect(store.resolveGraphFilePaths(['SRC/UTIL/BAR.TS'])).toContain('/repo/src/util/bar.ts');
	});
});

describe('schema v3 / extraction-format v4 migrations (US-010)', () => {
	it('fresh schema includes the search_aux column', () => {
		const store = createTestStore();
		try {
			const cols = store.queryRaw("SELECT name FROM pragma_table_info('nodes')") as { name: string }[];
			expect(cols.some(c => c.name === 'search_aux')).toBe(true);
		} finally {
			store.close();
		}
	});

	it('migrates schema v2 → v3 and keeps the search_aux column queryable', () => {
		const store = createTestStore();
		try {
			store.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('schema_version', '2');
			expect(getSchemaVersion(store.db)).toBe(2);

			runMigrations(store.db);

			expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
			const cols = store.queryRaw("SELECT name FROM pragma_table_info('nodes')") as { name: string }[];
			expect(cols.some(c => c.name === 'search_aux')).toBe(true);

			store.upsertNode(makeNode({ kind: 'Class', name: 'OrderManager', file_path: 'src/orders.ts' }));
			store.upsertNode(makeNode({ name: 'submit', file_path: 'src/orders.ts', parent_name: 'OrderManager' }));
			const hits = store.searchFts('order', undefined, 10) as { name: string }[];
			expect(hits.some(h => h.name === 'submit')).toBe(true);
		} finally {
			store.close();
		}
	});

	it('repopulates FTS on a schema-only v2 → v3 migration (no extraction reset)', () => {
		const store = createTestStore();
		try {
			store.upsertNode(makeNode({ name: 'PersistentSymbol', file_path: 'src/p.ts' }));
			expect(store.searchFts('PersistentSymbol', undefined, 5)).toHaveLength(1);

			// Installed DB sitting at schema v2 but already at the current extraction format,
			// so the extraction-format migration does NOT wipe + re-extract.
			store.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('schema_version', '2');
			expect(getSchemaVersion(store.db)).toBe(2);

			runMigrations(store.db);

			expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
			const hits = store.searchFts('PersistentSymbol', undefined, 5) as { name: string }[];
			expect(hits).toHaveLength(1);
			expect(hits[0]!.name).toBe('PersistentSymbol');
		} finally {
			store.close();
		}
	});

	it('migrates extraction-format v3 → v4 by clearing the graph', () => {
		const store = createTestStore();
		try {
			store.upsertNode(makeNode({ kind: 'File', name: 'a.ts', file_path: 'src/a.ts' }));
			store.upsertNode(makeNode({ name: 'foo', file_path: 'src/a.ts' }));
			store.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('extraction_format_version', '3');
			expect(getExtractionFormatVersion(store.db)).toBe(3);

			runMigrations(store.db);

			expect(getExtractionFormatVersion(store.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);
			expect(store.getNodeCount()).toBe(0);
		} finally {
			store.close();
		}
	});
});

describe('FTS5 sync and rebuild', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	function getFtsRowCount(s: GraphStore): number {
		return (s.db.prepare('SELECT COUNT(*) as cnt FROM nodes_fts_docsize').get() as { cnt: number }).cnt;
	}

	it('rebuildFtsIndex restores the shadow index when drift exists', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'searchableAlpha', file_path: 'src/alpha.ts' }));
		expect(store.searchFts('searchableAlpha', undefined, 5)).toHaveLength(1);

		store.db.exec('DROP TRIGGER IF EXISTS nodes_fts_ai');
		store.upsertNode(makeNode({ name: 'searchableBeta', file_path: 'src/beta.ts' }));
		expect(store.searchFts('searchableBeta', undefined, 5)).toHaveLength(0);
		expect(getFtsRowCount(store)).not.toBe(store.getNodeCount());

		store.rebuildFtsIndex();

		const beta = store.searchFts('searchableBeta', undefined, 5);
		expect(beta).toHaveLength(1);
		expect((beta[0] as { name: string }).name).toBe('searchableBeta');
		expect(store.searchFts('searchableAlpha', undefined, 5)).toHaveLength(1);
		expect(getFtsRowCount(store)).toBe(store.getNodeCount());
	});

	it('runValidation auto-rebuilds FTS when row count diverges from nodes', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'driftedNode', file_path: 'src/d.ts' }));

		store.db.exec('DROP TRIGGER IF EXISTS nodes_fts_ai');
		store.upsertNode(makeNode({ name: 'survivor', file_path: 'src/s.ts' }));
		expect(getFtsRowCount(store)).not.toBe(store.getNodeCount());

		const validation = store.runValidation();

		expect(validation.ftsRowCount).toBe(validation.nodeCount);
		expect(getFtsRowCount(store)).toBe(store.getNodeCount());
		expect(store.searchFts('driftedNode', undefined, 5)).toHaveLength(1);
		expect(store.searchFts('survivor', undefined, 5)).toHaveLength(1);
	});

	it('inTransaction reflects current transaction state', () => {
		store = createTestStore();
		expect(store.inTransaction()).toBe(false);
		store.withTransaction(() => {
			expect(store.inTransaction()).toBe(true);
		});
		expect(store.inTransaction()).toBe(false);
	});

	it('withTransaction nests safely without issuing a new BEGIN', () => {
		store = createTestStore();
		store.withTransaction(() => {
			store.withTransaction(() => {
				store.upsertNode(makeNode({ name: 'nested', file_path: 'src/n.ts' }));
			});
			expect(store.inTransaction()).toBe(true);
		});
		expect(store.inTransaction()).toBe(false);
		expect(store.getNode('src/n.ts::nested')).toBeDefined();
	});

	it('exposes no public transaction-starting API besides withTransaction', () => {
		store = createTestStore();
		const api = store as unknown as Record<string, unknown>;
		expect(api['beginTransaction']).toBeUndefined();
		expect(api['commitTransaction']).toBeUndefined();
		expect(api['rollbackTransaction']).toBeUndefined();
		expect(typeof api['withTransaction']).toBe('function');
	});

	it('trigger DDL inside a transaction does not corrupt depth tracking', () => {
		store = createTestStore();
		store.withTransaction(() => {
			store.execRaw('CREATE TRIGGER IF NOT EXISTS depth_probe AFTER INSERT ON metadata BEGIN DELETE FROM metadata WHERE 0; END;');
			expect(store.inTransaction()).toBe(true);
			store.upsertNode(makeNode({ name: 'inTriggerTxn', file_path: 'src/t.ts' }));
		});
		expect(store.inTransaction()).toBe(false);
		expect(store.getNode('src/t.ts::inTriggerTxn')).toBeDefined();
		store.execRaw('DROP TRIGGER IF EXISTS depth_probe');
	});
});

describe('GraphStore.open corrupt-DB recovery', () => {
	it('discards a corrupt DB file and rebuilds fresh', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-corrupt-'));
		const dbPath = path.join(dir, 'graph.db');
		fs.writeFileSync(dbPath, 'this is definitely not a sqlite database file');
		const recovered = new GraphStore(dbPath);
		try {
			await recovered.open(process.cwd());
			expect(recovered.isOpen).toBe(true);
			expect(recovered.getNodeCount()).toBe(0);
			// The corrupt bytes are discarded and a fresh valid SQLite file replaces them in place.
			expect(fs.readFileSync(dbPath).subarray(0, 16).toString('utf8')).toBe('SQLite format 3\0');

			recovered.upsertNode(makeNode({ name: 'reborn', file_path: 'src/r.ts' }));
			await recovered.serialize();
			expect(recovered.getNode('src/r.ts::reborn')).toBeDefined();
		} finally {
			recovered.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it('surfaces a transient BUSY/LOCKED error WITHOUT discarding the shared DB (H1)', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-busy-'));
		const dbPath = path.join(dir, 'graph.db');
		// A valid, populated DB stands in for a sibling window's live file.
		const seed = new GraphStore(dbPath);
		await seed.open(process.cwd());
		seed.upsertNode(makeNode({ name: 'keepme', file_path: 'src/k.ts' }));
		await seed.serialize();
		seed.close();
		const sizeBefore = fs.statSync(dbPath).size;

		const store = new GraphStore(dbPath);
		// Force the first open to fail as SQLITE_BUSY (errcode 5), the exact transient a lock produces.
		const spy = vi.spyOn(store as unknown as { _openFileBacked: (p: string) => void }, '_openFileBacked')
			.mockImplementationOnce(() => {
				throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
			});
		try {
			await expect(store.open(process.cwd())).rejects.toThrow(/locked/i);
			// The shared file was never deleted — the sibling's data survives.
			expect(fs.existsSync(dbPath)).toBe(true);
			expect(fs.statSync(dbPath).size).toBe(sizeBefore);
		} finally {
			spy.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it('treats an extended corruption code (CORRUPT_VTAB 267) as corruption and rebuilds', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-vtab-'));
		const dbPath = path.join(dir, 'graph.db');
		fs.writeFileSync(dbPath, 'seed bytes to make the file non-empty');
		const store = new GraphStore(dbPath);
		// node:sqlite reports extended result codes; 267 = CORRUPT_VTAB. It must classify as corruption
		// (mask & 0xff === 11) and route to discard-and-rebuild, not be treated as a transient fault.
		const spy = vi.spyOn(store as unknown as { _openFileBacked: (p: string) => void }, '_openFileBacked')
			.mockImplementationOnce(() => {
				throw Object.assign(new Error('database disk image is malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 267 });
			});
		try {
			await store.open(process.cwd());
			expect(store.isOpen).toBe(true);
			expect(store.getNodeCount()).toBe(0);
			expect(fs.readFileSync(dbPath).subarray(0, 16).toString('utf8')).toBe('SQLite format 3\0');
		} finally {
			spy.mockRestore();
			store.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe('flows.storeFlows transaction safety', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	function seedNode(s: GraphStore, name: string): number {
		return s.upsertNode(makeNode({ name, file_path: `src/${name}.ts` }));
	}

	it('rolls back DELETE-and-rewrite batch when an insert fails mid-flow', () => {
		store = createTestStore();
		const epId = seedNode(store, 'entry');
		const stepId = seedNode(store, 'step');

		const initialFlows = [{
			name: 'baseline',
			entryPointId: epId,
			pathIds: [epId, stepId],
			depth: 1,
			nodeCount: 2,
			fileCount: 2,
			files: ['src/entry.ts', 'src/step.ts'],
			criticality: 0.5,
		}];
		storeFlows(store, initialFlows);

		expect(store.getFlowCount()).toBe(1);
		expect(store.countFlowMemberships(stepId)).toBe(1);

		const corruptFlows = [{
			name: 'corrupt',
			entryPointId: epId,
			pathIds: [epId],
			depth: 0,
			nodeCount: 1,
			fileCount: 1,
			files: ['src/entry.ts'],
			criticality: NaN as unknown as number,
		}];

		const realExec = store.execRaw.bind(store);
		let insertAttempted = false;
		store.execRaw = (sql: string, params?: unknown[]) => {
			if (sql.startsWith('INSERT INTO flows')) {
				insertAttempted = true;
				throw new Error('synthetic mid-batch failure');
			}
			realExec(sql, params);
		};

		expect(() => storeFlows(store, corruptFlows)).toThrow('synthetic mid-batch failure');
		expect(insertAttempted).toBe(true);

		store.execRaw = realExec;

		expect(store.inTransaction()).toBe(false);
		expect(store.getFlowCount()).toBe(1);
		expect(store.countFlowMemberships(stepId)).toBe(1);
		const survivors = store.queryRaw('SELECT name FROM flows') as { name: string }[];
		expect(survivors.map(r => r.name)).toEqual(['baseline']);
	});
});
