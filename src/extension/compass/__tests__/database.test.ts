import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import {
	getSchemaVersion,
	getExtractionFormatVersion,
	runMigrations,
	CURRENT_SCHEMA_VERSION,
	CURRENT_EXTRACTION_FORMAT_VERSION,
} from '../migrations';
import { getSqlEngine, createTestStore } from './sql-test-helper';

let engine: SqlJsStatic;

beforeAll(async () => {
	engine = await getSqlEngine();
});

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
		store = createTestStore(engine);
		expect(store.isOpen).toBe(true);
	});

	it('throws when accessing db before open', () => {
		store = new GraphStore('/tmp/unused.db');
		expect(() => store.db).toThrow('GraphStore not open');
	});

	it('inserts and retrieves a node by qualified name', () => {
		store = createTestStore(engine);
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
		store = createTestStore(engine);
		store.upsertNode(makeNode({
			kind: 'Class',
			name: 'CompassService',
			file_path: 'src/index.ts',
		}));
		const node = store.getNode('src/index.ts::CompassService');
		expect(node!.name_tokens).toBe('compass service');
	});

	it('computes qualified_name with parent', () => {
		store = createTestStore(engine);
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
		store = createTestStore(engine);
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
		store = createTestStore(engine);
		const id = store.upsertNode(makeNode({
			name: 'foo',
			file_path: 'src/a.ts',
		}));
		const node = store.getNodeById(id);
		expect(node).toBeDefined();
		expect(node!.name).toBe('foo');
	});

	it('retrieves nodes by file', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'a', file_path: 'src/a.ts' }));
		store.upsertNode(makeNode({ name: 'b', file_path: 'src/a.ts' }));
		store.upsertNode(makeNode({ name: 'c', file_path: 'src/b.ts' }));

		const nodes = store.getNodesByFile('src/a.ts');
		expect(nodes).toHaveLength(2);
		expect(nodes.map(n => n.name).sort()).toEqual(['a', 'b']);
	});

	it('retrieves nodes by kind', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ kind: 'Class', name: 'MyClass', file_path: 'a.ts' }));
		store.upsertNode(makeNode({ kind: 'Function', name: 'myFunc', file_path: 'a.ts' }));
		store.upsertNode(makeNode({ kind: 'Class', name: 'Other', file_path: 'b.ts' }));

		expect(store.getNodesByKind('Class')).toHaveLength(2);
		expect(store.getNodesByKind('Function')).toHaveLength(1);
	});

	it('handles is_test flag', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({
			name: 'testFoo',
			file_path: 'test.ts',
			is_test: true,
		}));
		const node = store.getNode('test.ts::testFoo');
		expect(node!.is_test).toBe(1);
	});

	it('stores and retrieves extra JSON', () => {
		store = createTestStore(engine);
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
		store = createTestStore(engine);
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
		store = createTestStore(engine);
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
		store = createTestStore(engine);
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

	it('getEdgesAmong returns connecting edges', () => {
		store = createTestStore(engine);
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
		store = createTestStore(engine);
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
		store = createTestStore(engine);
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
		store = createTestStore(engine);
		store.storeFileNodesEdges('src/a.ts', [
			makeNode({ kind: 'File', name: 'a.ts', file_path: 'src/a.ts' }),
		], [], 'abc123');

		const node = store.getNode('src/a.ts::a.ts');
		expect(node!.file_hash).toBe('abc123');
	});

	it('getAllFiles returns distinct File-kind paths', () => {
		store = createTestStore(engine);
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
		store = createTestStore(engine);
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
		store = createTestStore(engine);
		store.setMetadata('last_updated', '2026-01-01T00:00:00Z');
		expect(store.getMetadata('last_updated')).toBe('2026-01-01T00:00:00Z');
	});

	it('returns undefined for missing key', () => {
		store = createTestStore(engine);
		expect(store.getMetadata('nonexistent')).toBeUndefined();
	});

	it('overwrites metadata on duplicate key', () => {
		store = createTestStore(engine);
		store.setMetadata('key', 'value1');
		store.setMetadata('key', 'value2');
		expect(store.getMetadata('key')).toBe('value2');
	});
});

describe('GraphStore persistence', () => {
	let store: GraphStore;

	it('serialize writes to disk via atomic rename', async () => {
		const dir = path.join(os.tmpdir(), `compass-test-${Date.now()}`);
		const dbPath = path.join(dir, 'graph.db');

		store = new GraphStore(dbPath);
		store.openFromEngine(engine);
		store.upsertNode(makeNode({ name: 'persist', file_path: 'src/a.ts' }));

		await store.serialize();

		expect(fs.existsSync(dbPath)).toBe(true);
		expect(fs.existsSync(dbPath + '.tmp')).toBe(false);

		store.close();

		const store2 = new GraphStore(dbPath);
		const data = fs.readFileSync(dbPath);
		store2.openFromEngine(engine, new Uint8Array(data));
		const node = store2.getNode('src/a.ts::persist');
		expect(node).toBeDefined();
		expect(node!.name).toBe('persist');
		store2.close();

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('exportData returns valid Uint8Array that can reload', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'exported', file_path: 'src/a.ts' }));

		const data = store.exportData();
		store.close();

		const store2 = new GraphStore('/tmp/unused.db');
		store2.openFromEngine(engine, data);
		expect(store2.getNode('src/a.ts::exported')).toBeDefined();
		store2.close();
	});
});

describe('Migration re-entrancy', () => {
	it('running migrations twice is safe', () => {
		const store = createTestStore(engine);
		expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(getExtractionFormatVersion(store.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);

		const store2 = new GraphStore('/tmp/unused.db');
		const data = store.exportData();
		store.close();

		store2.openFromEngine(engine, data);
		expect(getSchemaVersion(store2.db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(getExtractionFormatVersion(store2.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);
		store2.close();
	});

	it('fresh database has current schema and extraction-format versions', () => {
		const store = createTestStore(engine);
		expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(getExtractionFormatVersion(store.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);
		store.close();
	});

	it('treats legacy schema_version=2 as extraction_format_version=1 (no duplicate wipe)', () => {
		const store = createTestStore(engine);
		store.db.prepare(
			'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
		).run('schema_version', '2');
		store.db.prepare('DELETE FROM metadata WHERE key = ?').run('extraction_format_version');

		expect(getExtractionFormatVersion(store.db)).toBe(1);
		store.close();
	});

	it('runValidation excludes test fixture paths from unresolvedInternalRefs', () => {
		const store = createTestStore(engine);
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
		const store = createTestStore(engine);
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
		const store = createTestStore(engine);
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

			expect(getSchemaVersion(store.db)).toBe(2);
			const afterRows = store.db.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edges'",
			).all() as { name: string }[];
			const afterNames = new Set(afterRows.map(r => r.name));
			expect(afterNames.has('idx_edges_target_kind')).toBe(true);
			expect(afterNames.has('idx_edges_source_kind')).toBe(true);
			expect(afterNames.has('idx_edges_composite')).toBe(true);

			runMigrations(store.db);
			expect(getSchemaVersion(store.db)).toBe(2);
		} finally {
			store.close();
		}
	});

	it('getSchemaVersion returns 0 when metadata table does not exist', () => {
		const sqlDb = new engine.Database();
		const wrapper = {
			prepare(sql: string) {
				return {
					get(...params: unknown[]) {
						const stmt = sqlDb.prepare(sql);
						try {
							if (params.length) stmt.bind(params);
							if (stmt.step()) return stmt.getAsObject();
							return undefined;
						} finally { stmt.free(); }
					},
					run() { return { changes: 0 }; },
				};
			},
			exec(sql: string) { sqlDb.exec(sql); },
			pragma() { return undefined; },
			export() { return sqlDb.export(); },
			close() { sqlDb.close(); },
		};
		const version = getSchemaVersion(wrapper as unknown as import('../database').DbWrapper);
		expect(version).toBe(0);
		sqlDb.close();
	});
});
