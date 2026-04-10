import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import { parseUnifiedDiff } from '../changes';
import { findDependents } from '../incremental';
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

function seedDependencyChain(store: GraphStore): void {
	store.upsertNode(makeNode({ kind: 'File', name: 'lib.ts', file_path: '/src/lib.ts', line_start: 1, line_end: 50 }));
	store.upsertNode(makeNode({ name: 'utilFunc', file_path: '/src/lib.ts', line_start: 5, line_end: 15 }));

	store.upsertNode(makeNode({ kind: 'File', name: 'service.ts', file_path: '/src/service.ts', line_start: 1, line_end: 40 }));
	store.upsertNode(makeNode({ name: 'doWork', file_path: '/src/service.ts', line_start: 3, line_end: 20 }));

	store.upsertNode(makeNode({ kind: 'File', name: 'handler.ts', file_path: '/src/handler.ts', line_start: 1, line_end: 30 }));
	store.upsertNode(makeNode({ name: 'handleReq', file_path: '/src/handler.ts', line_start: 2, line_end: 25 }));

	store.upsertNode(makeNode({ kind: 'File', name: 'unrelated.ts', file_path: '/src/unrelated.ts', line_start: 1, line_end: 20 }));
	store.upsertNode(makeNode({ name: 'other', file_path: '/src/unrelated.ts', line_start: 1, line_end: 18 }));

	store.upsertEdge(makeEdge({ kind: 'IMPORTS_FROM', source: '/src/service.ts::service.ts', target: '/src/lib.ts', file_path: '/src/service.ts', line: 1 }));
	store.upsertEdge(makeEdge({ source: '/src/service.ts::doWork', target: '/src/lib.ts::utilFunc', file_path: '/src/service.ts', line: 10 }));

	store.upsertEdge(makeEdge({ kind: 'IMPORTS_FROM', source: '/src/handler.ts::handler.ts', target: '/src/service.ts', file_path: '/src/handler.ts', line: 1 }));
	store.upsertEdge(makeEdge({ source: '/src/handler.ts::handleReq', target: '/src/service.ts::doWork', file_path: '/src/handler.ts', line: 10 }));
}

describe('findDependents', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('finds direct dependents (1 hop)', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const deps = findDependents(store, '/src/lib.ts', 1);
		expect(deps).toContain('/src/service.ts');
		expect(deps).not.toContain('/src/handler.ts');
	});

	it('finds transitive dependents (2 hops)', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const deps = findDependents(store, '/src/lib.ts', 2);
		expect(deps).toContain('/src/service.ts');
		expect(deps).toContain('/src/handler.ts');
	});

	it('does not include the source file itself', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const deps = findDependents(store, '/src/lib.ts', 2);
		expect(deps).not.toContain('/src/lib.ts');
	});

	it('does not include unrelated files', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const deps = findDependents(store, '/src/lib.ts', 2);
		expect(deps).not.toContain('/src/unrelated.ts');
	});

	it('returns empty for leaf files', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const deps = findDependents(store, '/src/handler.ts', 2);
		expect(deps).toHaveLength(0);
	});

	it('handles non-existent files', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const deps = findDependents(store, '/src/nonexistent.ts', 2);
		expect(deps).toHaveLength(0);
	});

	it('caps dependent files at MAX_DEPENDENT_FILES', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ kind: 'File', name: 'core.ts', file_path: '/src/core.ts', line_start: 1, line_end: 10 }));
		store.upsertNode(makeNode({ name: 'coreFunc', file_path: '/src/core.ts' }));

		for (let i = 0; i < 600; i++) {
			const fp = `/src/dep${i}.ts`;
			store.upsertNode(makeNode({ kind: 'File', name: `dep${i}.ts`, file_path: fp, line_start: 1, line_end: 10 }));
			store.upsertNode(makeNode({ name: `depFunc${i}`, file_path: fp }));
			store.upsertEdge(makeEdge({
				kind: 'IMPORTS_FROM',
				source: `${fp}::dep${i}.ts`,
				target: '/src/core.ts',
				file_path: fp,
				line: 1,
			}));
		}

		const deps = findDependents(store, '/src/core.ts', 1);
		expect(deps.length).toBeLessThanOrEqual(500);
	});

	it('stops early when no more frontiers', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const deps1 = findDependents(store, '/src/lib.ts', 2);
		const deps10 = findDependents(store, '/src/lib.ts', 10);
		expect(deps1.sort()).toEqual(deps10.sort());
	});
});

describe('diff parsing + dependency integration', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('diff ranges identify changed files for dependency expansion', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const diff = [
			'+++ b/src/lib.ts',
			'@@ -5,3 +5,5 @@',
		].join('\n');

		const ranges = parseUnifiedDiff(diff);
		expect(ranges.has('src/lib.ts')).toBe(true);

		const deps = findDependents(store, '/src/lib.ts', 2);
		expect(deps.length).toBeGreaterThan(0);
	});
});

describe('GraphStore helper methods', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('getAllEdges returns all edges in insertion order', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const edges = store.getAllEdges();
		expect(edges.length).toBeGreaterThan(0);

		for (let i = 1; i < edges.length; i++) {
			expect(edges[i]!.id).toBeGreaterThan(edges[i - 1]!.id);
		}
	});

	it('getAllNodes returns all nodes', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const nodes = store.getAllNodes();
		expect(nodes.length).toBe(8);
	});

	it('getNodesByKinds filters by multiple kinds', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const funcs = store.getNodesByKinds(['Function', 'Test']);
		expect(funcs.every(n => n.kind === 'Function' || n.kind === 'Test')).toBe(true);
	});

	it('getAllCallTargets returns call target qualified names', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const targets = store.getAllCallTargets();
		expect(targets.has('/src/lib.ts::utilFunc')).toBe(true);
		expect(targets.has('/src/service.ts::doWork')).toBe(true);
	});

	it('getFilesMatchingSuffix matches path suffixes', () => {
		store = createTestStore(engine);
		seedDependencyChain(store);

		const files = store.getFilesMatchingSuffix('src/lib.ts');
		expect(files).toContain('/src/lib.ts');
	});

	it('getCommunityCount and getFlowCount return 0 initially', () => {
		store = createTestStore(engine);
		expect(store.getCommunityCount()).toBe(0);
		expect(store.getFlowCount()).toBe(0);
	});

	it('beginTransaction/commitTransaction works', () => {
		store = createTestStore(engine);
		store.beginTransaction();
		store.upsertNode(makeNode({ name: 'txnTest', file_path: '/test.ts' }));
		store.commitTransaction();

		expect(store.getNode('/test.ts::txnTest')).toBeDefined();
	});

	it('rollbackTransaction undoes changes', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'existing', file_path: '/test.ts' }));

		store.beginTransaction();
		store.removeFileData('/test.ts');
		store.rollbackTransaction();

		expect(store.getNode('/test.ts::existing')).toBeDefined();
	});
});
