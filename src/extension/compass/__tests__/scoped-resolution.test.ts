import { describe, it, expect, afterEach } from 'vitest';
import { GraphStore } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import { handleQuery } from '../mcp-handlers';
import { createTestStore } from './sql-test-helper';


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

describe('resolveExternalEdges scoped-target narrowing (US-005)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	function seedTwoParentsWithSameMethod(): void {
		store.upsertNode(makeNode({ kind: 'Class', name: 'Foo', file_path: '/src/a.ts' }));
		store.upsertNode(makeNode({ name: 'bar', file_path: '/src/a.ts', parent_name: 'Foo' }));
		store.upsertNode(makeNode({ kind: 'Class', name: 'Baz', file_path: '/src/c.ts' }));
		store.upsertNode(makeNode({ name: 'bar', file_path: '/src/c.ts', parent_name: 'Baz' }));
		store.upsertNode(makeNode({ name: 'caller', file_path: '/src/b.ts' }));
	}

	it('resolves Scope::method to the method under the matching parent', () => {
		store = createTestStore();
		seedTwoParentsWithSameMethod();
		store.upsertEdge(makeEdge({ source: '/src/b.ts::caller', target: 'Foo::bar', file_path: '/src/b.ts', line: 3 }));

		store.resolveExternalEdges();

		const calls = store.getEdgesBySource('/src/b.ts::caller').filter(e => e.kind === 'CALLS');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.target_qualified).toBe('/src/a.ts::Foo::bar');
	});

	it('matches the parent scope case-insensitively', () => {
		store = createTestStore();
		seedTwoParentsWithSameMethod();
		store.upsertEdge(makeEdge({ source: '/src/b.ts::caller', target: 'baz::bar', file_path: '/src/b.ts', line: 3 }));

		store.resolveExternalEdges();

		const calls = store.getEdgesBySource('/src/b.ts::caller').filter(e => e.kind === 'CALLS');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.target_qualified).toBe('/src/c.ts::Baz::bar');
	});

	it('strips a residual php namespace prefix from the scope before matching', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ kind: 'Class', name: 'Foo', file_path: '/app/Foo.php' }));
		store.upsertNode(makeNode({ name: 'bar', file_path: '/app/Foo.php', parent_name: 'Foo' }));
		store.upsertNode(makeNode({ kind: 'Class', name: 'Other', file_path: '/app/Other.php' }));
		store.upsertNode(makeNode({ name: 'bar', file_path: '/app/Other.php', parent_name: 'Other' }));
		store.upsertNode(makeNode({ name: 'caller', file_path: '/app/Caller.php' }));
		store.upsertEdge(makeEdge({ source: '/app/Caller.php::caller', target: 'App\\Services\\Foo::bar', file_path: '/app/Caller.php', line: 3 }));

		store.resolveExternalEdges();

		const calls = store.getEdgesBySource('/app/Caller.php::caller').filter(e => e.kind === 'CALLS');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.target_qualified).toBe('/app/Foo.php::Foo::bar');
	});

	it('deletes an ambiguous scoped target (two same-name parents each owning the method)', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ kind: 'Class', name: 'Foo', file_path: '/src/a.ts' }));
		store.upsertNode(makeNode({ name: 'bar', file_path: '/src/a.ts', parent_name: 'Foo' }));
		store.upsertNode(makeNode({ kind: 'Class', name: 'Foo', file_path: '/src/c.ts' }));
		store.upsertNode(makeNode({ name: 'bar', file_path: '/src/c.ts', parent_name: 'Foo' }));
		store.upsertNode(makeNode({ name: 'caller', file_path: '/src/b.ts' }));
		store.upsertEdge(makeEdge({ source: '/src/b.ts::caller', target: 'Foo::bar', file_path: '/src/b.ts', line: 3 }));

		store.resolveExternalEdges();

		const calls = store.getEdgesBySource('/src/b.ts::caller').filter(e => e.kind === 'CALLS');
		expect(calls).toHaveLength(0);
	});

	it('falls through to the unique-global step when the scope matches no parent', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'uniqueThing', file_path: '/src/a.ts' }));
		store.upsertNode(makeNode({ name: 'caller', file_path: '/src/b.ts' }));
		store.upsertEdge(makeEdge({ source: '/src/b.ts::caller', target: 'Unknown::uniqueThing', file_path: '/src/b.ts', line: 3 }));

		store.resolveExternalEdges();

		const calls = store.getEdgesBySource('/src/b.ts::caller').filter(e => e.kind === 'CALLS');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.target_qualified).toBe('/src/a.ts::uniqueThing');
	});
});

describe('buildTestedByEdges name fallback (US-005)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('links a DI-heavy test class to its subject with no CALLS edge present', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ kind: 'Class', name: 'FiwareTenantService', file_path: '/app/Services/FiwareTenantService.php' }));
		store.upsertNode(makeNode({
			kind: 'Test', name: 'testCreatesTenant', file_path: '/tests/Unit/FiwareTenantServiceTest.php',
			parent_name: 'FiwareTenantServiceTest', is_test: true,
		}));
		store.upsertNode(makeNode({
			kind: 'Test', name: 'testDeletesTenant', file_path: '/tests/Unit/FiwareTenantServiceTest.php',
			parent_name: 'FiwareTenantServiceTest', is_test: true,
		}));

		store.buildTestedByEdges();

		const testedBy = store.getEdgesByTarget('/app/Services/FiwareTenantService.php::FiwareTenantService')
			.filter(e => e.kind === 'TESTED_BY');
		const sources = testedBy.map(e => e.source_qualified).sort();
		expect(sources).toEqual([
			'/tests/Unit/FiwareTenantServiceTest.php::FiwareTenantServiceTest::testCreatesTenant',
			'/tests/Unit/FiwareTenantServiceTest.php::FiwareTenantServiceTest::testDeletesTenant',
		]);
		for (const e of testedBy) {
			expect(JSON.parse(e.extra)).toEqual({ derived: 'name' });
		}
	});

	it('produces no fallback edge when two production classes share the subject name', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ kind: 'Class', name: 'FooService', file_path: '/app/A/FooService.php' }));
		store.upsertNode(makeNode({ kind: 'Class', name: 'FooService', file_path: '/app/B/FooService.php' }));
		store.upsertNode(makeNode({
			kind: 'Test', name: 'testDoesThing', file_path: '/tests/FooServiceTest.php',
			parent_name: 'FooServiceTest', is_test: true,
		}));

		const count = store.buildTestedByEdges();

		expect(count).toBe(0);
	});

	it('uses the file stem when the Test node has no parent', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'foo', file_path: '/src/foo.ts' }));
		store.upsertNode(makeNode({ kind: 'Test', name: 'rendersWidget', file_path: '/tests/foo.test.ts', is_test: true }));

		store.buildTestedByEdges();

		const testedBy = store.getEdgesByTarget('/src/foo.ts::foo').filter(e => e.kind === 'TESTED_BY');
		expect(testedBy).toHaveLength(1);
		expect(testedBy[0]!.source_qualified).toBe('/tests/foo.test.ts::rendersWidget');
	});

	it('keeps the CALLS-derived edge when the name fallback collides with it', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ kind: 'Class', name: 'FooService', file_path: '/app/FooService.php' }));
		store.upsertNode(makeNode({
			kind: 'Test', name: 'testDoesThing', file_path: '/tests/FooServiceTest.php',
			parent_name: 'FooServiceTest', is_test: true,
		}));
		store.upsertEdge(makeEdge({
			source: '/tests/FooServiceTest.php::FooServiceTest::testDoesThing',
			target: '/app/FooService.php::FooService',
			file_path: '/tests/FooServiceTest.php', line: 7,
		}));

		store.buildTestedByEdges();

		const testedBy = store.getEdgesByTarget('/app/FooService.php::FooService').filter(e => e.kind === 'TESTED_BY');
		expect(testedBy).toHaveLength(1);
		expect(testedBy[0]!.extra).toBe('{}');
	});

	it('derives nothing from REFERENCES edges', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ kind: 'Class', name: 'Widget', file_path: '/src/widget.ts' }));
		store.upsertNode(makeNode({
			kind: 'Test', name: 'testHelper', file_path: '/tests/ZebraHelperTest.php',
			parent_name: 'ZebraHelperTest', is_test: true,
		}));
		store.upsertEdge(makeEdge({
			kind: 'REFERENCES',
			source: '/tests/ZebraHelperTest.php::ZebraHelperTest::testHelper',
			target: '/src/widget.ts::Widget',
			file_path: '/tests/ZebraHelperTest.php', line: 4,
		}));

		const count = store.buildTestedByEdges();

		expect(count).toBe(0);
	});

	it('returns the same count when rebuilt twice', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ kind: 'Class', name: 'FooService', file_path: '/app/FooService.php' }));
		store.upsertNode(makeNode({
			kind: 'Test', name: 'testDoesThing', file_path: '/tests/FooServiceTest.php',
			parent_name: 'FooServiceTest', is_test: true,
		}));

		const first = store.buildTestedByEdges();
		const second = store.buildTestedByEdges();

		expect(first).toBe(second);
	});
});

describe('getEdgesByTargetName with scoped targets (US-005)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('finds a Foo::bar CALLS edge when querying by bare method name', () => {
		store = createTestStore();
		store.upsertEdge(makeEdge({ source: '/src/b.ts::caller', target: 'Foo::bar', file_path: '/src/b.ts', line: 3 }));

		const edges = store.getEdgesByTargetName('bar', ['CALLS']);

		expect(edges.map(e => e.target_qualified)).toEqual(['Foo::bar']);
	});

	it('callers_of bare-name fallback surfaces the caller behind an unresolved scoped edge', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ kind: 'Class', name: 'Foo', file_path: '/src/a.ts' }));
		store.upsertNode(makeNode({ name: 'bar', file_path: '/src/a.ts', parent_name: 'Foo' }));
		store.upsertNode(makeNode({ name: 'caller', file_path: '/src/b.ts' }));
		store.upsertEdge(makeEdge({ source: '/src/b.ts::caller', target: 'Foo::bar', file_path: '/src/b.ts', line: 3 }));

		const result = handleQuery(store, { pattern: 'callers_of', target: 'bar' });

		expect(result).toContain('caller');
	});
});
