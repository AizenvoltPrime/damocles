import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo } from '../types';
import { searchNodes } from '../search';
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

function seedGraph(store: GraphStore): void {
	store.upsertNode(makeNode({
		kind: 'Class',
		name: 'CompassService',
		file_path: 'src/extension/compass/index.ts',
		language: 'typescript',
		signature: 'class CompassService implements ICompassService',
	}));
	store.upsertNode(makeNode({
		kind: 'Function',
		name: 'getStatus',
		file_path: 'src/extension/compass/index.ts',
		parent_name: 'CompassService',
		params: '()',
		return_type: 'IndexStatus',
	}));
	store.upsertNode(makeNode({
		kind: 'Function',
		name: 'ensureInitialized',
		file_path: 'src/extension/compass/index.ts',
		parent_name: 'CompassService',
		params: '()',
		return_type: 'Promise<void>',
	}));
	store.upsertNode(makeNode({
		kind: 'Class',
		name: 'GraphStore',
		file_path: 'src/extension/compass/database.ts',
		language: 'typescript',
	}));
	store.upsertNode(makeNode({
		kind: 'Function',
		name: 'upsert_node',
		file_path: 'src/extension/compass/database.ts',
		parent_name: 'GraphStore',
	}));
	store.upsertNode(makeNode({
		kind: 'Type',
		name: 'NodeInfo',
		file_path: 'src/extension/compass/types.ts',
		language: 'typescript',
	}));
	store.upsertNode(makeNode({
		kind: 'Type',
		name: 'EdgeInfo',
		file_path: 'src/extension/compass/types.ts',
		language: 'typescript',
	}));
	store.upsertNode(makeNode({
		kind: 'File',
		name: 'index.ts',
		file_path: 'src/extension/compass/index.ts',
		language: 'typescript',
	}));
	store.upsertNode(makeNode({
		kind: 'Function',
		name: 'openGraphStore',
		file_path: 'src/extension/compass/database.ts',
	}));
	store.upsertNode(makeNode({
		kind: 'Function',
		name: 'split_identifier',
		file_path: 'src/extension/compass/schema.ts',
	}));
	store.upsertNode(makeNode({
		kind: 'Function',
		name: 'sanitizeFtsQuery',
		file_path: 'src/extension/compass/schema.ts',
	}));
}

describe('searchNodes', () => {
	let store: GraphStore;

	beforeEach(() => {
		store = createTestStore(engine);
		seedGraph(store);
	});
	afterEach(() => store?.close());

	it('finds CompassService by searching "compass"', () => {
		const results = searchNodes(store, 'compass');
		expect(results.length).toBeGreaterThan(0);
		const names = results.map(r => r.node.name);
		expect(names).toContain('CompassService');
	});

	it('finds CompassService by exact name', () => {
		const results = searchNodes(store, 'CompassService');
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.node.name).toBe('CompassService');
	});

	it('finds functions by snake_case partial', () => {
		const results = searchNodes(store, 'split_identifier');
		expect(results.length).toBeGreaterThan(0);
		expect(results.some(r => r.node.name === 'split_identifier')).toBe(true);
	});

	it('returns results ranked by BM25 score (positive, higher is better)', () => {
		const results = searchNodes(store, 'compass');
		for (const r of results) {
			expect(r.score).toBeGreaterThan(0);
		}
		for (let i = 0; i < results.length - 1; i++) {
			expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
		}
	});

	it('PascalCase query boosts Class/Type results', () => {
		const results = searchNodes(store, 'GraphStore');
		expect(results.length).toBeGreaterThan(0);
		const classResult = results.find(r => r.node.kind === 'Class');
		const funcResult = results.find(r => r.node.kind === 'Function');
		expect(classResult).toBeDefined();
		expect(funcResult).toBeDefined();
		expect(classResult!.score).toBeGreaterThan(funcResult!.score);
	});

	it('snake_case query boosts Function results', () => {
		const results = searchNodes(store, 'upsert_node');
		expect(results.length).toBeGreaterThan(0);
		const first = results[0]!;
		expect(first.node.kind).toBe('Function');
	});

	it('filters by kind', () => {
		const results = searchNodes(store, 'compass', { kind: 'Class' });
		for (const r of results) {
			expect(r.node.kind).toBe('Class');
		}
		expect(results.length).toBeGreaterThan(0);
	});

	it('respects limit parameter', () => {
		const results = searchNodes(store, 'compass', { limit: 2 });
		expect(results.length).toBeLessThanOrEqual(2);
	});

	it('returns empty array for empty query', () => {
		const results = searchNodes(store, '');
		expect(results).toEqual([]);
	});

	it('returns empty array for metacharacter-only query', () => {
		const results = searchNodes(store, '***');
		expect(results).toEqual([]);
	});

	it('handles multi-word query', () => {
		const results = searchNodes(store, 'compass service');
		expect(results.length).toBeGreaterThan(0);
		expect(results.some(r => r.node.name === 'CompassService')).toBe(true);
	});

	it('finds by file path tokens', () => {
		const results = searchNodes(store, 'database');
		expect(results.length).toBeGreaterThan(0);
		expect(results.some(r => r.node.file_path.includes('database'))).toBe(true);
	});

	it('sanitizes FTS5 metacharacters in query', () => {
		expect(() => searchNodes(store, 'test*(something)')).not.toThrow();
		expect(() => searchNodes(store, 'foo AND bar OR baz')).not.toThrow();
	});

	it('finds by qualified name tokens', () => {
		const results = searchNodes(store, 'schema');
		expect(results.length).toBeGreaterThan(0);
		expect(results.some(r => r.node.file_path.includes('schema'))).toBe(true);
	});
});

describe('FTS5 content-sync triggers', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('FTS index updates on node insert', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({
			kind: 'Class',
			name: 'FreshEntity',
			file_path: 'src/fresh.ts',
		}));
		const results = searchNodes(store, 'fresh');
		expect(results.some(r => r.node.name === 'FreshEntity')).toBe(true);
	});

	it('FTS index updates on node delete', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({
			kind: 'Class',
			name: 'DeleteMe',
			file_path: 'src/del.ts',
		}));
		expect(searchNodes(store, 'DeleteMe').length).toBeGreaterThan(0);

		store.removeFileData('src/del.ts');
		expect(searchNodes(store, 'DeleteMe')).toHaveLength(0);
	});

	it('FTS index updates on node update (upsert)', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({
			kind: 'Function',
			name: 'ObsoleteZephyr',
			file_path: 'src/a.ts',
		}));

		store.storeFileNodesEdges('src/a.ts', [
			makeNode({ kind: 'Function', name: 'ReplacedQuasar', file_path: 'src/a.ts' }),
		], []);

		expect(searchNodes(store, 'ObsoleteZephyr')).toHaveLength(0);
		expect(searchNodes(store, 'ReplacedQuasar').length).toBeGreaterThan(0);
	});
});
