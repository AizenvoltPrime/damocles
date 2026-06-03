import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import { findDeadCode } from '../refactor';
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

describe('findDeadCode (US-008)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('reports an unreferenced helper and excludes called symbols, constructors, and entry points', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ kind: 'File', name: 'a.ts', file_path: '/src/a.ts', line_start: 1, line_end: 100 }));
		store.upsertNode(makeNode({ name: 'deadHelper', file_path: '/src/a.ts', line_start: 5, line_end: 10 }));
		store.upsertNode(makeNode({ name: 'calledFn', file_path: '/src/a.ts', line_start: 15, line_end: 20 }));
		store.upsertNode(makeNode({ name: 'invoker', file_path: '/src/a.ts', line_start: 25, line_end: 30 }));
		store.upsertNode(makeNode({ name: 'constructor', file_path: '/src/a.ts', parent_name: 'Widget', line_start: 35, line_end: 40 }));
		store.upsertNode(makeNode({ name: 'main', file_path: '/src/a.ts', line_start: 45, line_end: 50 }));
		store.upsertEdge(makeEdge({ source: '/src/a.ts::invoker', target: '/src/a.ts::calledFn', file_path: '/src/a.ts', line: 26 }));

		const names = findDeadCode(store).map(d => d.name);
		expect(names).toContain('deadHelper');
		expect(names).not.toContain('calledFn');
		expect(names).not.toContain('constructor');
		expect(names).not.toContain('main');
	});

	it('excludes a function covered only by a test (TESTED_BY counts as alive)', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'onlyTested', file_path: '/src/a.ts' }));
		store.upsertNode(makeNode({ kind: 'Test', name: 'test_onlyTested', file_path: '/test/a.test.ts', is_test: true }));
		store.upsertEdge(makeEdge({ source: '/test/a.test.ts::test_onlyTested', target: '/src/a.ts::onlyTested', file_path: '/test/a.test.ts' }));
		store.buildTestedByEdges();

		const names = findDeadCode(store).map(d => d.name);
		expect(names).not.toContain('onlyTested');
	});

	it('does not treat a function as referenced when only a same-suffix sibling is called (anchoring)', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'save', file_path: '/src/a.ts', line_start: 1, line_end: 5 }));
		store.upsertNode(makeNode({ name: 'unsave', file_path: '/src/a.ts', line_start: 10, line_end: 15 }));
		store.upsertNode(makeNode({ name: 'caller', file_path: '/src/a.ts', line_start: 20, line_end: 25 }));
		store.upsertEdge(makeEdge({ source: '/src/a.ts::caller', target: '/src/a.ts::unsave', file_path: '/src/a.ts', line: 21 }));

		const names = findDeadCode(store).map(d => d.name);
		expect(names).toContain('save');
		expect(names).not.toContain('unsave');
	});

	it('excludes framework-managed classes (known base via INHERITS)', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ kind: 'Class', name: 'HomeController', file_path: '/src/c.ts', line_start: 1, line_end: 20 }));
		store.upsertNode(makeNode({ kind: 'Class', name: 'PlainHelperClass', file_path: '/src/c.ts', line_start: 25, line_end: 40 }));
		store.upsertEdge(makeEdge({ kind: 'INHERITS', source: '/src/c.ts::HomeController', target: 'Controller', file_path: '/src/c.ts', line: 1 }));

		const names = findDeadCode(store, { kind: 'Class' }).map(d => d.name);
		expect(names).toContain('PlainHelperClass');
		expect(names).not.toContain('HomeController');
	});

	it('honors a file pattern filter', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'inApi', file_path: '/src/api/x.ts' }));
		store.upsertNode(makeNode({ name: 'inUi', file_path: '/src/ui/y.ts' }));

		const names = findDeadCode(store, { filePattern: '/api/' }).map(d => d.name);
		expect(names).toContain('inApi');
		expect(names).not.toContain('inUi');
	});
});
