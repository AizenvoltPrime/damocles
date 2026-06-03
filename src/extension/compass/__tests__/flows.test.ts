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
	buildFlowAdjacency,
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

	it('detects test_ and Test prefix names when includeTests=true', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'test_login', file_path: '/test/auth.ts', kind: 'Test' }));
		store.upsertNode(makeNode({ name: 'TestAuth', file_path: '/test/auth2.ts', kind: 'Test' }));

		const eps = detectEntryPoints(store, { includeTests: true });
		const names = eps.map(ep => ep.name);
		expect(names).toContain('test_login');
		expect(names).toContain('TestAuth');
	});

	it('detects expanded entry-name patterns (lambda_handler, ngOnInit, doGet, componentDidMount, upgrade)', () => {
		store = createTestStore(engine);
		const names = ['lambda_handler', 'ngOnInit', 'doGet', 'componentDidMount', 'upgrade'];
		for (const n of names) {
			store.upsertNode(makeNode({ name: n, file_path: `/src/${n}.ts` }));
			store.upsertNode(makeNode({ name: `caller_${n}`, file_path: `/src/caller_${n}.ts` }));
			store.upsertEdge(makeEdge({
				source: `/src/caller_${n}.ts::caller_${n}`,
				target: `/src/${n}.ts::${n}`,
				file_path: `/src/caller_${n}.ts`, line: 1,
			}));
		}

		const eps = detectEntryPoints(store);
		const detected = new Set(eps.map(ep => ep.name));
		for (const n of names) {
			expect(detected.has(n)).toBe(true);
		}
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

	it('detects expanded decorator patterns (NestJS, Spring, Django, AI-agent, Express, middleware)', () => {
		store = createTestStore(engine);

		const cases: Array<{ name: string; file: string; decorator: string }> = [
			{ name: 'NestController', file: '/src/nest.ts', decorator: 'Controller' },
			{ name: 'SpringGetMapping', file: '/src/spring.ts', decorator: '@GetMapping' },
			{ name: 'SpringRequestMapping', file: '/src/spring2.ts', decorator: '@RequestMapping' },
			{ name: 'LangchainTool', file: '/src/ai.ts', decorator: 'tool' },
			{ name: 'ExpressUse', file: '/src/express.ts', decorator: 'app.use' },
			{ name: 'DjangoReceiver', file: '/src/django.ts', decorator: 'receiver' },
		];

		for (const c of cases) {
			store.upsertNode(makeNode({
				name: c.name,
				file_path: c.file,
				extra: { decorators: [c.decorator] },
			}));
			store.upsertNode(makeNode({ name: `called_${c.name}`, file_path: '/src/caller.ts' }));
			store.upsertEdge(makeEdge({
				source: '/src/caller.ts::called_' + c.name,
				target: `${c.file}::${c.name}`,
				file_path: '/src/caller.ts', line: 1,
			}));
		}

		const eps = detectEntryPoints(store);
		const names = new Set(eps.map(ep => ep.name));
		for (const c of cases) {
			expect(names.has(c.name)).toBe(true);
		}
	});

	it('does not duplicate entry points', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'main', file_path: '/src/a.ts' }));

		const eps = detectEntryPoints(store);
		const mainCount = eps.filter(ep => ep.name === 'main').length;
		expect(mainCount).toBe(1);
	});

	it('excludes .spec test-file nodes by default and includes them when includeTests=true', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'specFunc', file_path: '/src/foo.spec.ts' }));
		store.upsertNode(makeNode({ name: 'prodFunc', file_path: '/src/foo.ts' }));

		const defaultEps = detectEntryPoints(store);
		const defaultNames = new Set(defaultEps.map(ep => ep.name));
		expect(defaultNames.has('specFunc')).toBe(false);
		expect(defaultNames.has('prodFunc')).toBe(true);

		const withTests = detectEntryPoints(store, { includeTests: true });
		const withNames = new Set(withTests.map(ep => ep.name));
		expect(withNames.has('specFunc')).toBe(true);
		expect(withNames.has('prodFunc')).toBe(true);
	});

	it('excludes __tests__ directory nodes by default', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'underTests', file_path: '/src/__tests__/bar.ts' }));
		store.upsertNode(makeNode({ name: 'prodFunc', file_path: '/src/prod.ts' }));

		const eps = detectEntryPoints(store);
		const names = new Set(eps.map(ep => ep.name));
		expect(names.has('underTests')).toBe(false);
		expect(names.has('prodFunc')).toBe(true);
	});

	it('excludes nodes flagged is_test even in non-test-named files', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'flagged', file_path: '/src/foo.ts', is_test: true }));
		store.upsertNode(makeNode({ name: 'regular', file_path: '/src/bar.ts' }));

		const eps = detectEntryPoints(store);
		const names = new Set(eps.map(ep => ep.name));
		expect(names.has('flagged')).toBe(false);
		expect(names.has('regular')).toBe(true);
	});

	it('still classifies a function with no non-File callers as an entry point even when only a File-sourced CALLS edge targets it (US-A3 mitigation)', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ kind: 'File', name: 'app.py', file_path: '/src/app.py', line_start: 1, line_end: 20 }));
		store.upsertNode(makeNode({ name: 'bootstrapApp', file_path: '/src/app.py', line_start: 5, line_end: 10 }));
		store.upsertEdge(makeEdge({
			source: '/src/app.py::app.py',
			target: '/src/app.py::bootstrapApp',
			file_path: '/src/app.py',
			line: 18,
		}));

		const eps = detectEntryPoints(store);
		const names = new Set(eps.map(ep => ep.name));
		expect(names.has('bootstrapApp')).toBe(true);
	});

	it('demotes a function from entry-by-in-degree when a non-File node calls it, ignoring concurrent File-sourced CALLS', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ kind: 'File', name: 'app.py', file_path: '/src/app.py', line_start: 1, line_end: 20 }));
		store.upsertNode(makeNode({ name: 'bootstrapApp', file_path: '/src/app.py', line_start: 5, line_end: 10 }));
		store.upsertNode(makeNode({ name: 'caller_func', file_path: '/src/other.py', line_start: 1, line_end: 5 }));
		store.upsertEdge(makeEdge({
			source: '/src/app.py::app.py',
			target: '/src/app.py::bootstrapApp',
			file_path: '/src/app.py',
			line: 18,
		}));
		store.upsertEdge(makeEdge({
			source: '/src/other.py::caller_func',
			target: '/src/app.py::bootstrapApp',
			file_path: '/src/other.py',
			line: 3,
		}));

		const eps = detectEntryPoints(store);
		const names = new Set(eps.map(ep => ep.name));
		expect(names.has('bootstrapApp')).toBe(false);
		expect(names.has('caller_func')).toBe(true);
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

function seedLargeFlowFixture(
	store: GraphStore,
	options: { entryPoints: number; workerNodes: number; fanoutPerWorker: number },
): void {
	const { entryPoints, workerNodes, fanoutPerWorker } = options;

	store.withTransaction(() => {
		const epQns: string[] = [];
		for (let e = 0; e < entryPoints; e++) {
			const epName = `entry_${e}`;
			const epFile = `/src/entry_${e}.ts`;
			store.upsertNode(makeNode({ name: epName, file_path: epFile, line_start: 1, line_end: 5 }));
			epQns.push(`${epFile}::${epName}`);
		}

		const workerQns: string[] = [];
		for (let w = 0; w < workerNodes; w++) {
			const name = `worker_${w}`;
			const file = `/src/mod_${w % 100}.ts`;
			store.upsertNode(makeNode({ name, file_path: file, line_start: w * 5 + 1, line_end: w * 5 + 4 }));
			workerQns.push(`${file}::${name}`);
		}

		const sharedTargetSize = Math.min(20, workerNodes);
		for (let e = 0; e < entryPoints; e++) {
			for (let s = 0; s < sharedTargetSize; s++) {
				const target = workerQns[s]!;
				store.upsertEdge(makeEdge({ source: epQns[e]!, target, file_path: `/src/entry_${e}.ts`, line: s + 1 }));
			}
		}

		for (let w = 0; w < workerNodes; w++) {
			const sourceQn = workerQns[w]!;
			for (let f = 0; f < fanoutPerWorker; f++) {
				const targetIdx = (w * 13 + f * 7 + 1) % sharedTargetSize;
				if (targetIdx === w) continue;
				const target = workerQns[targetIdx]!;
				store.upsertEdge(makeEdge({ source: sourceQn, target, file_path: `/src/mod_${w % 100}.ts`, line: f + 10 }));
			}
		}
		return undefined;
	});
}

interface FlowDataShape {
	name: string;
	entryPointId: number;
	pathIds: number[];
	depth: number;
	nodeCount: number;
	fileCount: number;
	files: string[];
	criticality: number;
}

function legacyTraceFlows(store: GraphStore, maxDepth: number = 15): FlowDataShape[] {
	const includeTests = false;
	const callTargets = store.getCallTargetsExcludingFileSources();
	const candidates = store.getNodesByKinds(['Function', 'Test']);
	const entryPoints = candidates.filter(n => {
		if (!includeTests && n.is_test === 1) return false;
		return !callTargets.has(n.qualified_name);
	});

	const flows: FlowDataShape[] = [];
	for (const ep of entryPoints) {
		const pathIds: number[] = [ep.id];
		const visited = new Set<string>([ep.qualified_name]);
		const queue: Array<[string, number]> = [[ep.qualified_name, 0]];
		let actualDepth = 0;
		while (queue.length > 0) {
			const [currentQn, depth] = queue.shift()!;
			if (depth > actualDepth) actualDepth = depth;
			if (depth >= maxDepth) continue;
			const edges = store.getEdgesBySource(currentQn);
			for (const edge of edges) {
				if (edge.kind !== 'CALLS') continue;
				if (visited.has(edge.target_qualified)) continue;
				const target = store.getNode(edge.target_qualified);
				if (!target) continue;
				visited.add(edge.target_qualified);
				pathIds.push(target.id);
				queue.push([edge.target_qualified, depth + 1]);
			}
		}
		if (pathIds.length < 2) continue;

		const fileSet = new Set<string>();
		for (const id of pathIds) {
			const n = store.getNodeById(id);
			if (n) fileSet.add(n.file_path);
		}
		for (const id of pathIds) {
			const n = store.getNodeById(id);
			if (!n) continue;
			for (const e of store.getEdgesBySource(n.qualified_name)) {
				if (e.kind === 'CALLS') store.getNode(e.target_qualified);
			}
			store.getEdgesByTarget(n.qualified_name);
		}
		flows.push({
			name: ep.name,
			entryPointId: ep.id,
			pathIds,
			depth: actualDepth,
			nodeCount: pathIds.length,
			fileCount: fileSet.size,
			files: [...fileSet],
			criticality: 0,
		});
	}
	return flows;
}

describe('traceFlows adjacency preload', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('produces flow path/depth/file output identical to the legacy per-node-loop implementation across three reference fixtures', () => {
		const fixtures: Array<(s: GraphStore) => void> = [
			(s) => seedCallChain(s),
			(s) => {
				seedCallChain(s);
				s.upsertNode(makeNode({ name: 'handler', file_path: '/src/handler.ts', line_start: 1, line_end: 8 }));
				s.upsertNode(makeNode({ name: 'authenticate', file_path: '/src/auth.ts', line_start: 1, line_end: 12 }));
				s.upsertEdge(makeEdge({ source: '/src/handler.ts::handler', target: '/src/auth.ts::authenticate', file_path: '/src/handler.ts', line: 3 }));
			},
			(s) => seedLargeFlowFixture(s, { entryPoints: 10, workerNodes: 90, fanoutPerWorker: 3 }),
		];

		for (const seed of fixtures) {
			store = createTestStore(engine);
			seed(store);

			const expected = legacyTraceFlows(store)
				.map(f => ({
					name: f.name,
					entryPointId: f.entryPointId,
					pathIds: [...f.pathIds].sort((a, b) => a - b),
					depth: f.depth,
					nodeCount: f.nodeCount,
					fileCount: f.fileCount,
					files: [...f.files].sort(),
				}))
				.sort((a, b) => a.name.localeCompare(b.name));

			const actual = traceFlows(store)
				.map(f => ({
					name: f.name,
					entryPointId: f.entryPointId,
					pathIds: [...f.pathIds].sort((a, b) => a - b),
					depth: f.depth,
					nodeCount: f.nodeCount,
					fileCount: f.fileCount,
					files: [...f.files].sort(),
				}))
				.sort((a, b) => a.name.localeCompare(b.name));

			expect(actual).toEqual(expected);
			store.close();
		}
	}, 60000);

	it('makes a single edge sweep instead of per-node SQL round-trips on a 1000-node fixture', () => {
		store = createTestStore(engine);
		seedLargeFlowFixture(store, { entryPoints: 50, workerNodes: 950, fanoutPerWorker: 5 });

		expect(store.getNodeCount()).toBeGreaterThanOrEqual(1000);
		expect(store.getEdgeCount()).toBeGreaterThanOrEqual(1000);

		const originalGetEdgesBySource = store.getEdgesBySource.bind(store);
		const originalGetEdgesByTarget = store.getEdgesByTarget.bind(store);
		const originalGetAllEdges = store.getAllEdges.bind(store);
		let bySourceCalls = 0;
		let byTargetCalls = 0;
		let allEdgesCalls = 0;
		store.getEdgesBySource = (qn: string) => { bySourceCalls++; return originalGetEdgesBySource(qn); };
		store.getEdgesByTarget = (qn: string) => { byTargetCalls++; return originalGetEdgesByTarget(qn); };
		store.getAllEdges = () => { allEdgesCalls++; return originalGetAllEdges(); };

		// Legacy path issues thousands of per-node SQL round-trips.
		legacyTraceFlows(store);
		expect(bySourceCalls + byTargetCalls).toBeGreaterThanOrEqual(5000);

		bySourceCalls = 0;
		byTargetCalls = 0;
		allEdgesCalls = 0;
		const flows = traceFlows(store);

		// Deterministic proof of the single-sweep design: zero per-node edge lookups and exactly
		// one full edge sweep, vs the legacy 5000+ round-trips. (No wall-clock assertion — absolute
		// timings and speedup ratios are machine-load-dependent and flake under CI contention.)
		expect(flows.length).toBeGreaterThan(0);
		expect(bySourceCalls).toBe(0);
		expect(byTargetCalls).toBe(0);
		expect(allEdgesCalls).toBe(1);
	}, 300000);

	it('detectEntryPoints does not call store.getNode for source-kind lookups (US-A16 in-memory adjacency)', () => {
		store = createTestStore(engine);
		seedLargeFlowFixture(store, { entryPoints: 10, workerNodes: 90, fanoutPerWorker: 3 });

		const originalGetNode = store.getNode.bind(store);
		let getNodeCalls = 0;
		store.getNode = (qn: string) => { getNodeCalls++; return originalGetNode(qn); };

		const adjacency = buildFlowAdjacency(store);
		expect(getNodeCalls).toBe(0);

		getNodeCalls = 0;
		const eps = detectEntryPoints(store, {}, adjacency);
		expect(eps.length).toBeGreaterThan(0);
		expect(getNodeCalls).toBe(0);
	});

	it('buildFlowAdjacency populates nodeKindByQn for every node', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ kind: 'File', name: 'app.ts', file_path: '/src/app.ts' }));
		store.upsertNode(makeNode({ kind: 'Function', name: 'doWork', file_path: '/src/app.ts' }));
		store.upsertNode(makeNode({ kind: 'Class', name: 'Worker', file_path: '/src/app.ts' }));

		const adjacency = buildFlowAdjacency(store);
		expect(adjacency.nodeKindByQn.get('/src/app.ts::app.ts')).toBe('File');
		expect(adjacency.nodeKindByQn.get('/src/app.ts::doWork')).toBe('Function');
		expect(adjacency.nodeKindByQn.get('/src/app.ts::Worker')).toBe('Class');
	});

	it('buildFlowAdjacency partitions every edge into both maps', () => {
		store = createTestStore(engine);
		seedCallChain(store);

		const adjacency = buildFlowAdjacency(store);
		const totalOut = [...adjacency.outBySource.values()].reduce((s, arr) => s + arr.length, 0);
		const totalIn = [...adjacency.inByTarget.values()].reduce((s, arr) => s + arr.length, 0);
		const edgeCount = store.getEdgeCount();
		expect(totalOut).toBe(edgeCount);
		expect(totalIn).toBe(edgeCount);
	});
});
