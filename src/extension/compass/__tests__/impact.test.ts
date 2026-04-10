import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import { computeBlastRadius } from '../impact';
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

function seedLinearGraph(store: GraphStore): void {
	store.upsertNode(makeNode({ kind: 'File', name: 'a.ts', file_path: '/src/a.ts', line_start: 1, line_end: 50 }));
	store.upsertNode(makeNode({ name: 'funcA', file_path: '/src/a.ts', line_start: 5, line_end: 15 }));
	store.upsertNode(makeNode({ kind: 'File', name: 'b.ts', file_path: '/src/b.ts', line_start: 1, line_end: 40 }));
	store.upsertNode(makeNode({ name: 'funcB', file_path: '/src/b.ts', line_start: 3, line_end: 20 }));
	store.upsertNode(makeNode({ kind: 'File', name: 'c.ts', file_path: '/src/c.ts', line_start: 1, line_end: 30 }));
	store.upsertNode(makeNode({ name: 'funcC', file_path: '/src/c.ts', line_start: 2, line_end: 25 }));
	store.upsertNode(makeNode({ kind: 'File', name: 'd.ts', file_path: '/src/d.ts', line_start: 1, line_end: 20 }));
	store.upsertNode(makeNode({ name: 'funcD', file_path: '/src/d.ts', line_start: 1, line_end: 18 }));

	store.upsertEdge(makeEdge({ kind: 'CALLS', source: '/src/a.ts::funcA', target: '/src/b.ts::funcB', file_path: '/src/a.ts', line: 10 }));
	store.upsertEdge(makeEdge({ kind: 'CALLS', source: '/src/b.ts::funcB', target: '/src/c.ts::funcC', file_path: '/src/b.ts', line: 15 }));
	store.upsertEdge(makeEdge({ kind: 'CALLS', source: '/src/c.ts::funcC', target: '/src/d.ts::funcD', file_path: '/src/c.ts', line: 10 }));
}

describe('Impact Analysis (Blast Radius)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('returns empty for empty changed files', () => {
		store = createTestStore(engine);
		const result = computeBlastRadius(store, []);
		expect(result.changed_nodes).toHaveLength(0);
		expect(result.impacted_nodes).toHaveLength(0);
		expect(result.truncated).toBe(false);
	});

	it('returns empty for files not in graph', () => {
		store = createTestStore(engine);
		seedLinearGraph(store);
		const result = computeBlastRadius(store, ['/src/nonexistent.ts']);
		expect(result.changed_nodes).toHaveLength(0);
		expect(result.impacted_nodes).toHaveLength(0);
	});

	it('finds direct callers and callees at depth=1', () => {
		store = createTestStore(engine);
		seedLinearGraph(store);
		const result = computeBlastRadius(store, ['/src/b.ts'], 1);
		const changedQns = new Set(result.changed_nodes.map(n => n.qualified_name));
		expect(changedQns.has('/src/b.ts::b.ts')).toBe(true);
		expect(changedQns.has('/src/b.ts::funcB')).toBe(true);

		const impactedQns = new Set(result.impacted_nodes.map(n => n.qualified_name));
		expect(impactedQns.has('/src/a.ts::funcA')).toBe(true);
		expect(impactedQns.has('/src/c.ts::funcC')).toBe(true);
	});

	it('traverses multi-hop at depth=2', () => {
		store = createTestStore(engine);
		seedLinearGraph(store);
		const result = computeBlastRadius(store, ['/src/a.ts'], 2);
		const impactedQns = new Set(result.impacted_nodes.map(n => n.qualified_name));
		expect(impactedQns.has('/src/b.ts::funcB')).toBe(true);
		expect(impactedQns.has('/src/c.ts::funcC')).toBe(true);
	});

	it('does not include depth=3 nodes at max_depth=2', () => {
		store = createTestStore(engine);
		seedLinearGraph(store);
		const result = computeBlastRadius(store, ['/src/a.ts'], 2);
		const impactedQns = new Set(result.impacted_nodes.map(n => n.qualified_name));
		expect(impactedQns.has('/src/d.ts::funcD')).toBe(false);
	});

	it('traverses bidirectionally', () => {
		store = createTestStore(engine);
		seedLinearGraph(store);
		const result = computeBlastRadius(store, ['/src/c.ts'], 1);
		const impactedQns = new Set(result.impacted_nodes.map(n => n.qualified_name));
		expect(impactedQns.has('/src/b.ts::funcB')).toBe(true);
		expect(impactedQns.has('/src/d.ts::funcD')).toBe(true);
	});

	it('returns impacted files', () => {
		store = createTestStore(engine);
		seedLinearGraph(store);
		const result = computeBlastRadius(store, ['/src/b.ts'], 1);
		expect(result.impacted_files.length).toBeGreaterThan(0);
	});

	it('returns edges among impacted nodes', () => {
		store = createTestStore(engine);
		seedLinearGraph(store);
		const result = computeBlastRadius(store, ['/src/b.ts'], 1);
		expect(result.edges.length).toBeGreaterThan(0);
		expect(result.edges.some(e => e.kind === 'CALLS')).toBe(true);
	});

	it('respects max_results truncation', () => {
		store = createTestStore(engine);
		seedLinearGraph(store);
		const fullResult = computeBlastRadius(store, ['/src/b.ts'], 10, 500);
		const totalImpacted = fullResult.impacted_nodes.length;

		if (totalImpacted > 1) {
			const limitedResult = computeBlastRadius(store, ['/src/b.ts'], 10, 1);
			expect(limitedResult.truncated).toBe(true);
			expect(limitedResult.impacted_nodes.length).toBeLessThanOrEqual(1);
		} else {
			expect(fullResult.truncated).toBe(false);
		}
	});

	it('handles suffix-based file matching', () => {
		store = createTestStore(engine);
		seedLinearGraph(store);
		const result = computeBlastRadius(store, ['src/a.ts'], 1);
		expect(result.changed_nodes.length).toBeGreaterThan(0);
	});
});
