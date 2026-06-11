import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import {
	handleContext, handleSearch, handleQuery, handleStats,
	handleBlastRadius, handleReviewContext, resolveTarget,
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
	store.upsertEdge(makeEdge({ source: '/src/c.ts::test_authenticate', target: '/src/a.ts::authenticate', file_path: '/src/c.ts', line: 10 }));
	store.upsertEdge(makeEdge({ kind: 'INHERITS', source: '/src/b.ts::DataService', target: '/src/a.ts::a.ts', file_path: '/src/b.ts' }));

	// TESTED_BY is derived from CALLS edges whose source is a Test node (US-002),
	// not seeded manually — exercises the real producer.
	store.buildTestedByEdges();
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

	it('dedups callers with multiple call sites into a single entry', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'caller', file_path: '/src/x.ts' }));
		store.upsertNode(makeNode({ name: 'callee', file_path: '/src/x.ts' }));
		store.upsertEdge(makeEdge({ source: '/src/x.ts::caller', target: '/src/x.ts::callee', file_path: '/src/x.ts', line: 1 }));
		store.upsertEdge(makeEdge({ source: '/src/x.ts::caller', target: '/src/x.ts::callee', file_path: '/src/x.ts', line: 2 }));
		const result = handleQuery(store, { pattern: 'callers_of', target: '/src/x.ts::callee' });
		expect((result.match(/caller/g) ?? []).length).toBe(1);
		expect(result).toContain('Callers of callee (1)');
	});

	it('surfaces an unresolved external callee but filters known builtins', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'caller', file_path: '/src/x.ts' }));
		store.upsertNode(makeNode({ name: 'localCallee', file_path: '/src/x.ts' }));
		store.upsertEdge(makeEdge({ source: '/src/x.ts::caller', target: '/src/x.ts::localCallee', file_path: '/src/x.ts', line: 1 }));
		// Unresolved, no '::', not a known external module spec → surfaced.
		store.upsertEdge(makeEdge({ source: '/src/x.ts::caller', target: 'ExternalLib/render', file_path: '/src/x.ts', line: 2 }));
		// Node builtin → filtered out as noise.
		store.upsertEdge(makeEdge({ source: '/src/x.ts::caller', target: 'fs', file_path: '/src/x.ts', line: 3 }));

		const result = handleQuery(store, { pattern: 'callees_of', target: '/src/x.ts::caller' });
		expect(result).toContain('localCallee');
		expect(result).toContain('ExternalLib/render');
		expect(result).toContain('external');
		expect(result).not.toContain('fs (external');
	});
});

describe('resolveTarget segment-anchored resolution', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	function seedValidators(s: GraphStore): void {
		s.upsertNode(makeNode({ kind: 'File', name: 'QueryValidator.ts', file_path: '/src/mcp/QueryValidator.ts', line_start: 1, line_end: 400 }));
		s.upsertNode(makeNode({ kind: 'Class', name: 'QueryValidator', file_path: '/src/mcp/QueryValidator.ts', line_start: 13, line_end: 352 }));
		s.upsertNode(makeNode({ name: 'validate', file_path: '/src/mcp/QueryValidator.ts', parent_name: 'QueryValidator', line_start: 39, line_end: 61 }));
		s.upsertNode(makeNode({ name: 'validateComplexity', file_path: '/src/mcp/QueryValidator.ts', parent_name: 'QueryValidator', line_start: 261, line_end: 325 }));
		s.upsertNode(makeNode({ name: 'applyFilterToQuery', file_path: '/src/mcp/QueryValidator.ts', parent_name: 'QueryValidator', line_start: 100, line_end: 160 }));
		s.upsertNode(makeNode({ kind: 'Class', name: 'OtherValidator', file_path: '/src/other/OtherValidator.ts', line_start: 1, line_end: 50 }));
		s.upsertNode(makeNode({ name: 'validate', file_path: '/src/other/OtherValidator.ts', parent_name: 'OtherValidator', line_start: 5, line_end: 20 }));
	}

	it('resolves Class::method to the exact method, not an FTS-ranked sibling', () => {
		store = createTestStore(engine);
		seedValidators(store);
		const n = resolveTarget(store, 'QueryValidator::validate');
		expect(n).toBeDefined();
		expect(n!.name).toBe('validate');
		expect(n!.parent_name).toBe('QueryValidator');
	});

	it('does not match a longer same-prefix sibling (validate vs validateComplexity)', () => {
		store = createTestStore(engine);
		seedValidators(store);
		const n = resolveTarget(store, 'QueryValidator::validateComplexity');
		expect(n!.name).toBe('validateComplexity');
	});

	it('resolves a unique bare method name via the qn suffix', () => {
		store = createTestStore(engine);
		seedValidators(store);
		const n = resolveTarget(store, 'applyFilterToQuery');
		expect(n!.name).toBe('applyFilterToQuery');
	});

	it('resolves an ambiguous bare name to a genuine match, never an unrelated entity', () => {
		store = createTestStore(engine);
		seedValidators(store);
		const n = resolveTarget(store, 'validate');
		expect(n!.name).toBe('validate');
		expect(['QueryValidator', 'OtherValidator']).toContain(n!.parent_name);
	});

	it('resolves a bare class name to the class node', () => {
		store = createTestStore(engine);
		seedValidators(store);
		const n = resolveTarget(store, 'QueryValidator');
		expect(n).toBeDefined();
		expect(n!.name).toBe('QueryValidator');
		expect(n!.kind).toBe('Class');
	});
});

describe('TESTED_BY derivation (US-002)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('derives TESTED_BY with source=Test, target=production from a test CALLS edge', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const incoming = store.getEdgesByTarget('/src/a.ts::authenticate').filter(e => e.kind === 'TESTED_BY');
		expect(incoming).toHaveLength(1);
		expect(incoming[0]!.source_qualified).toBe('/src/c.ts::test_authenticate');
		expect(incoming[0]!.target_qualified).toBe('/src/a.ts::authenticate');
	});

	it('tests_for lists the deriving test', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleQuery(store, { pattern: 'tests_for', target: '/src/a.ts::authenticate' });
		expect(result).toContain('test_authenticate');
	});

	it('does not create reverse TESTED_BY edges out of the production node', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const fromProduction = store.getEdgesBySource('/src/a.ts::authenticate').filter(e => e.kind === 'TESTED_BY');
		expect(fromProduction).toHaveLength(0);
		// callers_of the test must not be polluted by the derived edge.
		const callersOfTest = handleQuery(store, { pattern: 'callers_of', target: '/src/c.ts::test_authenticate' });
		expect(callersOfTest).toContain('none');
	});

	it('rebuilds idempotently (no duplicate edges on repeated calls)', () => {
		store = createTestStore(engine);
		seedGraph(store);
		store.buildTestedByEdges();
		store.buildTestedByEdges();
		const all = store.getEdgesByTarget('/src/a.ts::authenticate').filter(e => e.kind === 'TESTED_BY');
		expect(all).toHaveLength(1);
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

	it('surfaces truncation when changed functions exceed the analysis cap (US-012)', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ kind: 'File', name: 'big.ts', file_path: '/src/big.ts', line_start: 1, line_end: 5200 }));
		for (let i = 0; i < 510; i++) {
			store.upsertNode(makeNode({ name: `func${String(i).padStart(3, '0')}`, file_path: '/src/big.ts', line_start: i * 10 + 1, line_end: i * 10 + 5 }));
		}

		const result = handleReviewContext(store, '/workspace', { changed_files: ['/src/big.ts'] });
		expect(result).toContain('analyzed 500 of 510 changed functions');
	});

	it('omits the truncation line below the cap', () => {
		store = createTestStore(engine);
		seedGraph(store);
		const result = handleReviewContext(store, '/workspace', { changed_files: ['/src/a.ts'] });
		expect(result).not.toContain('changed functions');
	});
});

