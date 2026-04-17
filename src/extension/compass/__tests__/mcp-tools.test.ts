import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import {
	handleContext, handleSearch, handleQuery, handleStats,
	handleBlastRadius, handleReviewContext,
} from '../mcp-handlers';
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

function seedGraph(store: GraphStore): void {
	store.upsertNode(makeNode({ kind: 'File', name: 'a.ts', file_path: '/src/a.ts', line_start: 1, line_end: 100 }));
	store.upsertNode(makeNode({ name: 'authenticate', file_path: '/src/a.ts', line_start: 5, line_end: 25 }));
	store.upsertNode(makeNode({ name: 'helperA', file_path: '/src/a.ts', line_start: 30, line_end: 45 }));

	store.upsertNode(makeNode({ kind: 'File', name: 'b.ts', file_path: '/src/b.ts', line_start: 1, line_end: 80 }));
	store.upsertNode(makeNode({ name: 'processData', file_path: '/src/b.ts', line_start: 5, line_end: 30 }));
	store.upsertNode(makeNode({ kind: 'Class', name: 'DataService', file_path: '/src/b.ts', line_start: 35, line_end: 75 }));

	store.upsertNode(makeNode({ kind: 'File', name: 'c.ts', file_path: '/src/c.ts', line_start: 1, line_end: 60 }));
	store.upsertNode(makeNode({ kind: 'Test', name: 'test_authenticate', file_path: '/src/c.ts', line_start: 5, line_end: 20, is_test: true }));

	store.upsertEdge(makeEdge({ source: '/src/b.ts::processData', target: '/src/a.ts::authenticate', file_path: '/src/b.ts', line: 10 }));
	store.upsertEdge(makeEdge({ source: '/src/a.ts::authenticate', target: '/src/a.ts::helperA', file_path: '/src/a.ts', line: 15 }));
	store.upsertEdge(makeEdge({ kind: 'IMPORTS_FROM', source: '/src/b.ts::processData', target: '/src/a.ts::a.ts', file_path: '/src/b.ts', line: 1 }));
	store.upsertEdge(makeEdge({ kind: 'CONTAINS', source: '/src/b.ts::b.ts', target: '/src/b.ts::DataService', file_path: '/src/b.ts' }));
	store.upsertEdge(makeEdge({ kind: 'TESTED_BY', source: '/src/c.ts::test_authenticate', target: '/src/a.ts::authenticate', file_path: '/src/c.ts' }));
	store.upsertEdge(makeEdge({ kind: 'INHERITS', source: '/src/b.ts::DataService', target: '/src/a.ts::a.ts', file_path: '/src/b.ts' }));
}

describe('compass_context', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('returns graph stats', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleContext(store, '/workspace', {});
		expect(result).toContain('nodes');
		expect(result).toContain('edges');
	});

	it('includes risk assessment when changed_files provided', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleContext(store, '/workspace', { changed_files: ['/src/a.ts'] });
		expect(result).toContain('Changes');
	});

	it('suggests review tools for review task', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleContext(store, '/workspace', { task: 'review PR' });
		expect(result).toContain('compass_blast_radius');
	});

	it('suggests debug tools for debug task', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleContext(store, '/workspace', { task: 'debug auth bug' });
		expect(result).toContain('compass_search');
	});

	it('suggests default tools when no task', () => {
		store = createTestStore(engine);
		const result = handleContext(store, '/workspace', {});
		expect(result).toContain('compass_search');
	});
});

describe('compass_search', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('finds entities by name', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleSearch(store, { query: 'authenticate' });
		expect(result).toContain('authenticate');
	});

	it('returns no results for unknown query', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleSearch(store, { query: 'nonexistentxyz' });
		expect(result).toContain('No results');
	});

	it('filters by kind', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleSearch(store, { query: 'DataService', kind: 'Class' });
		expect(result).toContain('DataService');
	});

	it('respects limit', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleSearch(store, { query: 'a', limit: 1 });
		const lines = result.split('\n').filter(l => l.includes('—') || l.includes('('));
		expect(lines.length).toBeLessThanOrEqual(2);
	});

	it('supports minimal detail level', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleSearch(store, { query: 'authenticate', detail_level: 'minimal' });
		expect(result).toContain('authenticate');
		expect(result).not.toContain('—');
	});

	it('supports full detail level', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleSearch(store, { query: 'authenticate', detail_level: 'full' });
		expect(result).toContain('authenticate');
	});
});

describe('compass_query', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('callers_of returns callers', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'callers_of', target: '/src/a.ts::authenticate' });
		expect(result).toContain('processData');
	});

	it('callees_of returns callees', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'callees_of', target: '/src/a.ts::authenticate' });
		expect(result).toContain('helperA');
	});

	it('imports_of returns imports', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'imports_of', target: '/src/b.ts::processData' });
		expect(result).toContain('a.ts');
	});

	it('importers_of returns importers', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'importers_of', target: '/src/a.ts::a.ts' });
		expect(result).toContain('processData');
	});

	it('children_of returns contained entities', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'children_of', target: '/src/b.ts::b.ts' });
		expect(result).toContain('DataService');
	});

	it('tests_for returns test nodes', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'tests_for', target: '/src/a.ts::authenticate' });
		expect(result).toContain('test_authenticate');
	});

	it('inheritors_of returns inheriting entities', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'inheritors_of', target: '/src/a.ts::a.ts' });
		expect(result).toContain('DataService');
	});

	it('file_summary returns all entities in file', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'file_summary', target: '/src/a.ts' });
		expect(result).toContain('authenticate');
		expect(result).toContain('helperA');
	});

	it('file_summary works with suffix matching', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'file_summary', target: 'src/a.ts' });
		expect(result).toContain('authenticate');
	});

	it('resolves target via FTS when not a qualified name', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'callers_of', target: 'authenticate' });
		expect(result).toContain('processData');
	});

	it('returns not found for unknown target', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'callers_of', target: 'nonexistentxyz' });
		expect(result).toContain('No entity found');
	});

	it('returns none for pattern with no results', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'callers_of', target: '/src/b.ts::processData' });
		expect(result).toContain('none');
	});

	it('rejects unknown pattern', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'invalid_pattern' as any, target: 'authenticate' });
		expect(result).toContain('Unknown pattern');
	});

	it('supports detail levels', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const minimal = handleQuery(store, { pattern: 'callers_of', target: '/src/a.ts::authenticate', detail_level: 'minimal' });
		expect(minimal).not.toContain('—');
		const full = handleQuery(store, { pattern: 'callers_of', target: '/src/a.ts::authenticate', detail_level: 'full' });
		expect(full).toContain('—');
	});
});

describe('compass_stats', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('returns node and edge counts', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleStats(store);
		expect(result).toContain('Nodes:');
		expect(result).toContain('Edges:');
	});

	it('includes kind breakdown', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleStats(store);
		expect(result).toContain('Function');
		expect(result).toContain('CALLS');
	});

	it('reports communities and flows', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleStats(store);
		expect(result).toContain('Communities:');
		expect(result).toContain('Flows:');
	});

	it('works on empty graph', () => {
		store = createTestStore(engine);
		const result = handleStats(store);
		expect(result).toContain('Nodes: 0');
		expect(result).toContain('Edges: 0');
	});

	it('renders Last Updated in local timezone with explicit UTC offset', () => {
		store = createTestStore(engine);
		store.setMetadata('last_updated', '2026-04-16T22:48:15.115Z');
		const result = handleStats(store);
		expect(result).toMatch(/Last Updated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)/);
		expect(result).not.toContain('2026-04-16T22:48:15.115Z');
	});
});

describe('compass_blast_radius', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('returns impact for changed files', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleBlastRadius(store, { changed_files: ['/src/a.ts'] });
		expect(result).toContain('Changed:');
		expect(result).toContain('Impacted:');
	});

	it('returns no impact for unknown files', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleBlastRadius(store, { changed_files: ['/nonexistent.ts'] });
		expect(result).toContain('No impact');
	});

	it('shows impacted files in summary mode', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleBlastRadius(store, { changed_files: ['/src/a.ts'], detail_level: 'summary' });
		expect(result).toContain('Impacted Files');
	});

	it('shows full node details in full mode', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleBlastRadius(store, { changed_files: ['/src/a.ts'], detail_level: 'full' });
		expect(result).toContain('Changed Nodes');
		expect(result).toContain('Impacted Nodes');
	});

	it('minimal mode excludes file list', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleBlastRadius(store, { changed_files: ['/src/a.ts'], detail_level: 'minimal' });
		expect(result).not.toContain('Impacted Files');
	});
});

describe('compass_review_context', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('returns comprehensive review context', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleReviewContext(store, '/workspace', { changed_files: ['/src/a.ts'] });
		expect(result).toContain('Review Context');
		expect(result).toContain('Risk:');
		expect(result).toContain('Blast Radius:');
	});

	it('includes risk breakdown', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleReviewContext(store, '/workspace', { changed_files: ['/src/a.ts'] });
		expect(result).toMatch(/HIGH|MEDIUM|LOW/);
	});

	it('includes impacted files section', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleReviewContext(store, '/workspace', { changed_files: ['/src/a.ts'] });
		expect(result).toContain('Impacted Files');
	});

	it('handles empty changed files', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleReviewContext(store, '/workspace', { changed_files: [] });
		expect(result).toContain('Review Context');
		expect(result).toContain('Changed Files: 0');
	});
});

