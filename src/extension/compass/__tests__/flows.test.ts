import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import {
	detectEntryPoints,
	traceFlows,
	computeCriticality,
	storeFlows,
	getFlows,
	getFlowById,
	getAffectedFlows,
} from '../flows';
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

function seedCallChain(store: GraphStore): void {
	store.upsertNode(makeNode({ name: 'main', file_path: '/src/a.ts', line_start: 1, line_end: 10 }));
	store.upsertNode(makeNode({ name: 'process', file_path: '/src/b.ts', line_start: 1, line_end: 15 }));
	store.upsertNode(makeNode({ name: 'save', file_path: '/src/c.ts', line_start: 1, line_end: 20 }));

	store.upsertEdge(makeEdge({ source: '/src/a.ts::main', target: '/src/b.ts::process', file_path: '/src/a.ts', line: 5 }));
	store.upsertEdge(makeEdge({ source: '/src/b.ts::process', target: '/src/c.ts::save', file_path: '/src/b.ts', line: 8 }));
}

describe('detectEntryPoints', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('detects functions with no incoming CALLS as entry points', () => {
		store = createTestStore(engine);
		seedCallChain(store);

		const eps = detectEntryPoints(store);
		const names = eps.map(ep => ep.name);
		expect(names).toContain('main');
	});

	it('detects conventional entry point names', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'handle_request', file_path: '/src/handler.ts' }));
		store.upsertNode(makeNode({ name: 'setup', file_path: '/src/setup.ts' }));

		const eps = detectEntryPoints(store);
		const names = eps.map(ep => ep.name);
		expect(names).toContain('handle_request');
		expect(names).toContain('setup');
	});

	it('detects test_ and Test prefix names', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'test_login', file_path: '/test/auth.ts', kind: 'Test' }));
		store.upsertNode(makeNode({ name: 'TestAuth', file_path: '/test/auth2.ts', kind: 'Test' }));

		const eps = detectEntryPoints(store);
		const names = eps.map(ep => ep.name);
		expect(names).toContain('test_login');
		expect(names).toContain('TestAuth');
	});

	it('detects framework decorator patterns as entry points', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({
			name: 'getUsers',
			file_path: '/src/routes.ts',
			extra: { decorators: ['app.get'] },
		}));
		store.upsertNode(makeNode({ name: 'caller', file_path: '/src/a.ts' }));
		store.upsertEdge(makeEdge({
			source: '/src/a.ts::caller', target: '/src/routes.ts::getUsers',
			file_path: '/src/a.ts', line: 5,
		}));

		const eps = detectEntryPoints(store);
		const names = eps.map(ep => ep.name);
		expect(names).toContain('getUsers');
	});

	it('does not duplicate entry points', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'main', file_path: '/src/a.ts' }));

		const eps = detectEntryPoints(store);
		const mainCount = eps.filter(ep => ep.name === 'main').length;
		expect(mainCount).toBe(1);
	});
});

describe('traceFlows', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('traces a linear call chain as a single flow', () => {
		store = createTestStore(engine);
		seedCallChain(store);

		const flows = traceFlows(store);
		const mainFlow = flows.find(f => f.name === 'main');
		expect(mainFlow).toBeDefined();
		expect(mainFlow!.nodeCount).toBe(3);
		expect(mainFlow!.depth).toBe(2);
		expect(mainFlow!.fileCount).toBe(3);
	});

	it('skips trivial single-node flows', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'isolated', file_path: '/src/a.ts' }));

		const flows = traceFlows(store);
		expect(flows.find(f => f.name === 'isolated')).toBeUndefined();
	});

	it('sorts by criticality descending', () => {
		store = createTestStore(engine);
		seedCallChain(store);

		store.upsertNode(makeNode({ name: 'handler', file_path: '/src/a.ts', line_start: 20, line_end: 25 }));
		store.upsertNode(makeNode({ name: 'authCheck', file_path: '/src/auth.ts', line_start: 1, line_end: 10 }));
		store.upsertEdge(makeEdge({ source: '/src/a.ts::handler', target: '/src/auth.ts::authCheck', file_path: '/src/a.ts', line: 22 }));

		const flows = traceFlows(store);
		if (flows.length >= 2) {
			expect(flows[0]!.criticality).toBeGreaterThanOrEqual(flows[1]!.criticality);
		}
	});

	it('handles cycles without infinite loop', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'cycleA', file_path: '/src/cycle.ts', line_start: 1, line_end: 10 }));
		store.upsertNode(makeNode({ name: 'cycleB', file_path: '/src/cycle.ts', line_start: 15, line_end: 25 }));

		store.upsertEdge(makeEdge({ source: '/src/cycle.ts::cycleA', target: '/src/cycle.ts::cycleB', file_path: '/src/cycle.ts', line: 5 }));
		store.upsertEdge(makeEdge({ source: '/src/cycle.ts::cycleB', target: '/src/cycle.ts::cycleA', file_path: '/src/cycle.ts', line: 20 }));

		const flows = traceFlows(store);
		const cycleFlow = flows.find(f => f.name === 'cycleA' || f.name === 'cycleB');
		if (cycleFlow) {
			expect(cycleFlow.nodeCount).toBe(2);
		}
	});

	it('respects maxDepth', () => {
		store = createTestStore(engine);
		seedCallChain(store);
		store.upsertNode(makeNode({ name: 'deep', file_path: '/src/d.ts', line_start: 1, line_end: 10 }));
		store.upsertEdge(makeEdge({ source: '/src/c.ts::save', target: '/src/d.ts::deep', file_path: '/src/c.ts', line: 15 }));

		const flows = traceFlows(store, 1);
		const mainFlow = flows.find(f => f.name === 'main');
		if (mainFlow) {
			expect(mainFlow.nodeCount).toBeLessThanOrEqual(3);
		}
	});
});

describe('computeCriticality', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('returns 0 for empty flow', () => {
		store = createTestStore(engine);
		const score = computeCriticality({ name: 'empty', entryPointId: 0, pathIds: [], depth: 0, nodeCount: 0, fileCount: 0, files: [], criticality: 0 }, store);
		expect(score).toBe(0);
	});

	it('returns a value between 0 and 1', () => {
		store = createTestStore(engine);
		seedCallChain(store);

		const mainNode = store.getNode('/src/a.ts::main')!;
		const processNode = store.getNode('/src/b.ts::process')!;
		const saveNode = store.getNode('/src/c.ts::save')!;

		const score = computeCriticality({
			name: 'main',
			entryPointId: mainNode.id,
			pathIds: [mainNode.id, processNode.id, saveNode.id],
			depth: 2,
			nodeCount: 3,
			fileCount: 3,
			files: ['/src/a.ts', '/src/b.ts', '/src/c.ts'],
			criticality: 0,
		}, store);

		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	it('scores higher for security-sensitive flows', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'encrypt', file_path: '/src/crypto.ts' }));
		store.upsertNode(makeNode({ name: 'format', file_path: '/src/fmt.ts' }));

		const cryptoNode = store.getNode('/src/crypto.ts::encrypt')!;
		const fmtNode = store.getNode('/src/fmt.ts::format')!;

		const secScore = computeCriticality({
			name: 'encrypt', entryPointId: cryptoNode.id,
			pathIds: [cryptoNode.id, fmtNode.id], depth: 1, nodeCount: 2, fileCount: 2,
			files: ['/src/crypto.ts', '/src/fmt.ts'], criticality: 0,
		}, store);

		const plainScore = computeCriticality({
			name: 'format', entryPointId: fmtNode.id,
			pathIds: [fmtNode.id], depth: 0, nodeCount: 1, fileCount: 1,
			files: ['/src/fmt.ts'], criticality: 0,
		}, store);

		expect(secScore).toBeGreaterThan(plainScore);
	});
});

describe('storeFlows & retrieval', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('stores and retrieves flows', () => {
		store = createTestStore(engine);
		seedCallChain(store);

		const flows = traceFlows(store);
		const count = storeFlows(store, flows);
		expect(count).toBeGreaterThan(0);

		const retrieved = getFlows(store);
		expect(retrieved.length).toBe(count);
		expect(retrieved[0]!.name).toBeTruthy();
		expect(retrieved[0]!.criticality).toBeGreaterThanOrEqual(0);
	});

	it('retrieves flow by id with node details', () => {
		store = createTestStore(engine);
		seedCallChain(store);

		const flows = traceFlows(store);
		storeFlows(store, flows);

		const storedFlows = getFlows(store);
		const info = getFlowById(store, storedFlows[0]!.id);
		expect(info).not.toBeNull();
		expect(info!.nodes.length).toBeGreaterThan(0);
		expect(info!.flow.id).toBe(storedFlows[0]!.id);
	});

	it('clears old flows on re-store', () => {
		store = createTestStore(engine);
		seedCallChain(store);

		const flows = traceFlows(store);
		storeFlows(store, flows);
		storeFlows(store, []);

		const retrieved = getFlows(store);
		expect(retrieved).toHaveLength(0);
	});
});

describe('getAffectedFlows', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('finds flows affected by changed files', () => {
		store = createTestStore(engine);
		seedCallChain(store);
		const flows = traceFlows(store);
		storeFlows(store, flows);

		const result = getAffectedFlows(store, ['/src/b.ts']);
		expect(result.total).toBeGreaterThan(0);
		expect(result.flows.length).toBe(result.total);
	});

	it('returns empty for unrelated files', () => {
		store = createTestStore(engine);
		seedCallChain(store);
		const flows = traceFlows(store);
		storeFlows(store, flows);

		const result = getAffectedFlows(store, ['/src/unrelated.ts']);
		expect(result.total).toBe(0);
	});

	it('returns empty for empty input', () => {
		store = createTestStore(engine);
		const result = getAffectedFlows(store, []);
		expect(result.total).toBe(0);
	});
});
