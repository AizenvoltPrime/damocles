import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { StoredNode, ImpactResult } from '../types';
import { computeBlastRadius } from '../impact';
import { handleQuery } from '../mcp-handlers';
import { getSqlEngine, createTestStore } from './sql-test-helper';

let engine: SqlJsStatic;

beforeAll(async () => {
	engine = await getSqlEngine();
});

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return function (): number {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface RawNode {
	kind: string;
	name: string;
	qualified_name: string;
	file_path: string;
}

function insertRawNodes(store: GraphStore, nodes: RawNode[]): void {
	const insertNode = store.db.prepare(`
		INSERT INTO nodes
			(kind, name, name_tokens, qualified_name, file_path, line_start, line_end,
			 language, parent_name, params, return_type, modifiers, signature,
			 is_test, file_hash, extra, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const now = Date.now() / 1000;
	for (const n of nodes) {
		insertNode.run(n.kind, n.name, n.name, n.qualified_name, n.file_path, 1, 10,
			'typescript', null, null, null, null, null, 0, null, '{}', now);
	}
}

interface RawEdge {
	kind: string;
	source: string;
	target: string;
	file_path: string;
}

function insertRawEdges(store: GraphStore, edges: RawEdge[]): void {
	const insertEdge = store.db.prepare(`
		INSERT INTO edges (kind, source_qualified, target_qualified, file_path, line, extra, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	const now = Date.now() / 1000;
	let line = 1;
	for (const e of edges) {
		insertEdge.run(e.kind, e.source, e.target, e.file_path, line++, '{}', now);
	}
}

function legacyEmptyResult(): ImpactResult {
	return {
		changed_nodes: [],
		impacted_nodes: [],
		impacted_files: [],
		edges: [],
		total_impacted: 0,
		truncated: false,
	};
}

function legacyCollectSeeds(store: GraphStore, changedFiles: string[], workspaceRoot?: string): Set<string> {
	const seeds = new Set<string>();
	for (const mp of store.resolveGraphFilePaths(changedFiles, workspaceRoot)) {
		for (const n of store.getNodesByFile(mp)) {
			seeds.add(n.qualified_name);
		}
	}
	return seeds;
}

function legacyBatchGetNodes(store: GraphStore, qualifiedNames: Set<string>): StoredNode[] {
	const nodes: StoredNode[] = [];
	for (const qn of qualifiedNames) {
		const node = store.getNode(qn);
		if (node) nodes.push(node);
	}
	return nodes;
}

function legacyComputeBlastRadius(
	store: GraphStore,
	changedFiles: string[],
	maxDepth: number = 2,
	maxNodes: number = 500,
	workspaceRoot?: string,
): ImpactResult {
	if (changedFiles.length === 0) {
		return legacyEmptyResult();
	}

	const seeds = legacyCollectSeeds(store, changedFiles, workspaceRoot);
	if (seeds.size === 0) {
		return legacyEmptyResult();
	}

	const visited = new Set<string>(seeds);
	const impactedQns = new Set<string>();
	let frontier = new Set<string>(seeds);
	let cappedByLimit = false;

	bfs:
	for (let depth = 0; depth < maxDepth; depth++) {
		const nextFrontier = new Set<string>();

		for (const qn of frontier) {
			for (const e of store.getEdgesBySource(qn)) {
				if (!visited.has(e.target_qualified)) {
					visited.add(e.target_qualified);
					nextFrontier.add(e.target_qualified);
					if (!seeds.has(e.target_qualified)) {
						impactedQns.add(e.target_qualified);
					}
				}
				if (impactedQns.size >= maxNodes) { cappedByLimit = true; break bfs; }
			}
			for (const e of store.getEdgesByTarget(qn)) {
				if (!visited.has(e.source_qualified)) {
					visited.add(e.source_qualified);
					nextFrontier.add(e.source_qualified);
					if (!seeds.has(e.source_qualified)) {
						impactedQns.add(e.source_qualified);
					}
				}
				if (impactedQns.size >= maxNodes) { cappedByLimit = true; break bfs; }
			}
		}

		frontier = nextFrontier;
		if (frontier.size === 0) break;
	}

	const changedNodes = legacyBatchGetNodes(store, seeds);
	const impactedNodes = legacyBatchGetNodes(store, impactedQns);

	const totalImpacted = impactedNodes.length;
	const truncated = cappedByLimit || totalImpacted > maxNodes;
	const finalImpacted = truncated ? impactedNodes.slice(0, maxNodes) : impactedNodes;

	const impactedFiles = [...new Set(finalImpacted.map(n => n.file_path))];

	const allQns = new Set([...seeds, ...finalImpacted.map(n => n.qualified_name)]);
	const edges = store.getEdgesAmong(allQns);

	return {
		changed_nodes: changedNodes,
		impacted_nodes: finalImpacted,
		impacted_files: impactedFiles,
		edges,
		total_impacted: totalImpacted,
		truncated,
	};
}

function comparable(r: ImpactResult): Record<string, unknown> {
	return {
		changed: r.changed_nodes.map(n => n.qualified_name),
		impacted: r.impacted_nodes.map(n => n.qualified_name),
		files: r.impacted_files,
		edgeIds: r.edges.map(e => e.id),
		total: r.total_impacted,
		truncated: r.truncated,
	};
}

function seedRandomGraph(store: GraphStore, seed: number): { filePaths: string[] } {
	const FILE_COUNT = 24;
	const PER_FILE = 11;
	const EDGE_COUNT = 1200;
	const DANGLING_COUNT = 80;
	const SELF_LOOP_COUNT = 20;
	const rng = mulberry32(seed);

	const filePaths: string[] = [];
	const nodes: RawNode[] = [];
	const pool: string[] = [];

	for (let f = 0; f < FILE_COUNT; f++) {
		const fp = `/src/pkg/file${f}.ts`;
		filePaths.push(fp);
		const fileQn = `${fp}::file${f}.ts`;
		nodes.push({ kind: 'File', name: `file${f}.ts`, qualified_name: fileQn, file_path: fp });
		pool.push(fileQn);
		for (let fn = 0; fn < PER_FILE; fn++) {
			const kind = (f + fn) % 3 === 0 ? 'Function' : (f + fn) % 3 === 1 ? 'Class' : 'Type';
			const name = `${kind.toLowerCase()}_${f}_${fn}`;
			const qn = `${fp}::${name}`;
			nodes.push({ kind, name, qualified_name: qn, file_path: fp });
			pool.push(qn);
		}
	}

	const edges: RawEdge[] = [];
	const edgeKinds = ['CALLS', 'REFERENCES', 'CONTAINS', 'IMPORTS_FROM'];
	for (let e = 0; e < EDGE_COUNT; e++) {
		const s = Math.floor(rng() * pool.length);
		let t = Math.floor(rng() * pool.length);
		if (t === s) t = (t + 1) % pool.length;
		const kind = edgeKinds[Math.floor(rng() * edgeKinds.length)]!;
		const src = pool[s]!;
		edges.push({ kind, source: src, target: pool[t]!, file_path: src.split('::')[0]! });
	}
	for (let d = 0; d < DANGLING_COUNT; d++) {
		const s = Math.floor(rng() * pool.length);
		const src = pool[s]!;
		edges.push({ kind: 'CALLS', source: src, target: `unresolved::ext_${d % 25}`, file_path: src.split('::')[0]! });
	}
	for (let l = 0; l < SELF_LOOP_COUNT; l++) {
		const s = Math.floor(rng() * pool.length);
		const qn = pool[s]!;
		edges.push({ kind: 'REFERENCES', source: qn, target: qn, file_path: qn.split('::')[0]! });
	}

	store.withTransaction(() => {
		insertRawNodes(store, nodes);
		insertRawEdges(store, edges);
	});

	return { filePaths };
}

describe('computeBlastRadius — level-batched BFS parity with legacy per-node BFS', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	const SEEDS = [0xBEEFCAFE, 0x12345678, 0xC0FFEE42];

	it('produces identical results across seeded random graphs at varying depths', () => {
		for (const seed of SEEDS) {
			store = createTestStore(engine);
			const { filePaths } = seedRandomGraph(store, seed);

			const scenarios: Array<{ files: string[]; depth: number; max: number }> = [
				{ files: [filePaths[0]!], depth: 1, max: 5000 },
				{ files: [filePaths[3]!], depth: 2, max: 5000 },
				{ files: [filePaths[5]!, filePaths[12]!], depth: 3, max: 5000 },
				{ files: [filePaths[7]!], depth: 4, max: 5000 },
				{ files: ['/src/nonexistent.ts'], depth: 2, max: 5000 },
			];

			for (const sc of scenarios) {
				const expected = comparable(legacyComputeBlastRadius(store, sc.files, sc.depth, sc.max));
				const actual = comparable(computeBlastRadius(store, sc.files, sc.depth, sc.max));
				expect(actual).toEqual(expected);
			}
			store.close();
		}
	}, 60000);

	it('produces identical results at truncation boundaries (non-lossy cap, per-edge early-exit)', () => {
		for (const seed of SEEDS) {
			store = createTestStore(engine);
			const { filePaths } = seedRandomGraph(store, seed);

			for (const max of [1, 2, 3, 5, 8, 13, 21, 34, 55]) {
				for (const depth of [2, 3]) {
					const expected = legacyComputeBlastRadius(store, [filePaths[2]!], depth, max);
					const actual = computeBlastRadius(store, [filePaths[2]!], depth, max);
					expect(comparable(actual)).toEqual(comparable(expected));
					expect(actual.impacted_nodes.length).toBeLessThanOrEqual(max);
				}
			}
			store.close();
		}
	}, 60000);

	it('matches legacy on dangling edge targets counting toward the cap but excluded from nodes', () => {
		store = createTestStore(engine);
		insertRawNodes(store, [
			{ kind: 'File', name: 'a.ts', qualified_name: '/src/a.ts::a.ts', file_path: '/src/a.ts' },
			{ kind: 'Function', name: 'fnA', qualified_name: '/src/a.ts::fnA', file_path: '/src/a.ts' },
		]);
		insertRawEdges(store, [
			{ kind: 'CALLS', source: '/src/a.ts::fnA', target: 'unresolved::ext_0', file_path: '/src/a.ts' },
			{ kind: 'CALLS', source: '/src/a.ts::fnA', target: 'unresolved::ext_1', file_path: '/src/a.ts' },
		]);

		const expected = legacyComputeBlastRadius(store, ['/src/a.ts'], 2, 2);
		const actual = computeBlastRadius(store, ['/src/a.ts'], 2, 2);
		expect(comparable(actual)).toEqual(comparable(expected));
		expect(actual.truncated).toBe(true);
		expect(actual.impacted_nodes).toHaveLength(0);
	});
});

function seedHubFixture(store: GraphStore): { seedCount: number; level1Count: number; impactedCount: number } {
	const OUT_FANOUT = 450;
	const IN_FANOUT = 450;
	const DEEP_COUNT = 100;

	const nodes: RawNode[] = [
		{ kind: 'File', name: 'hub.ts', qualified_name: '/src/hub.ts::hub.ts', file_path: '/src/hub.ts' },
		{ kind: 'Function', name: 'hubOut', qualified_name: '/src/hub.ts::hubOut', file_path: '/src/hub.ts' },
		{ kind: 'Function', name: 'hubIn', qualified_name: '/src/hub.ts::hubIn', file_path: '/src/hub.ts' },
	];
	const edges: RawEdge[] = [];

	for (let i = 0; i < OUT_FANOUT; i++) {
		const qn = `/src/out_${i}.ts::out_${i}`;
		nodes.push({ kind: 'Function', name: `out_${i}`, qualified_name: qn, file_path: `/src/out_${i}.ts` });
		edges.push({ kind: 'CALLS', source: '/src/hub.ts::hubOut', target: qn, file_path: '/src/hub.ts' });
	}
	for (let i = 0; i < IN_FANOUT; i++) {
		const qn = `/src/in_${i}.ts::src_${i}`;
		nodes.push({ kind: 'Function', name: `src_${i}`, qualified_name: qn, file_path: `/src/in_${i}.ts` });
		edges.push({ kind: 'CALLS', source: qn, target: '/src/hub.ts::hubIn', file_path: `/src/in_${i}.ts` });
	}
	for (let i = 0; i < DEEP_COUNT; i++) {
		const qn = `/src/deep_${i}.ts::deep_${i}`;
		nodes.push({ kind: 'Function', name: `deep_${i}`, qualified_name: qn, file_path: `/src/deep_${i}.ts` });
		edges.push({ kind: 'CALLS', source: `/src/out_${i}.ts::out_${i}`, target: qn, file_path: `/src/out_${i}.ts` });
	}

	store.withTransaction(() => {
		insertRawNodes(store, nodes);
		insertRawEdges(store, edges);
	});

	return {
		seedCount: 3,
		level1Count: OUT_FANOUT + IN_FANOUT,
		impactedCount: OUT_FANOUT + IN_FANOUT + DEEP_COUNT,
	};
}

interface SqlCounters {
	edgeInQueries: number;
	nodeInQueries: number;
}

function instrumentPrepare(store: GraphStore): SqlCounters {
	const counters: SqlCounters = { edgeInQueries: 0, nodeInQueries: 0 };
	const original = store.db.prepare.bind(store.db);
	store.db.prepare = (sql: string) => {
		const isBatchedSourceQuery = sql.includes('FROM edges WHERE source_qualified IN (') && !sql.includes('AND target_qualified IN');
		const isBatchedTargetQuery = sql.includes('FROM edges WHERE target_qualified IN (');
		if (isBatchedSourceQuery || isBatchedTargetQuery) counters.edgeInQueries++;
		if (sql.includes('FROM nodes WHERE qualified_name IN (')) counters.nodeInQueries++;
		return original(sql);
	};
	return counters;
}

describe('computeBlastRadius — O(depth + chunks) statement count (FR-8)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('issues at most 2×ceil(|frontier|/400) edge queries per level plus ceil(|results|/400) node fetches on a depth-2/1000-node radius', () => {
		store = createTestStore(engine);
		const { seedCount, level1Count, impactedCount } = seedHubFixture(store);

		const originalGetEdgesBySource = store.getEdgesBySource.bind(store);
		const originalGetEdgesByTarget = store.getEdgesByTarget.bind(store);
		const originalGetNode = store.getNode.bind(store);
		const originalGetAllEdges = store.getAllEdges.bind(store);
		let bySourceCalls = 0;
		let byTargetCalls = 0;
		let getNodeCalls = 0;
		let allEdgesCalls = 0;
		store.getEdgesBySource = (qn: string) => { bySourceCalls++; return originalGetEdgesBySource(qn); };
		store.getEdgesByTarget = (qn: string) => { byTargetCalls++; return originalGetEdgesByTarget(qn); };
		store.getNode = (qn: string) => { getNodeCalls++; return originalGetNode(qn); };
		store.getAllEdges = () => { allEdgesCalls++; return originalGetAllEdges(); };

		legacyComputeBlastRadius(store, ['/src/hub.ts'], 2, 2000);
		expect(bySourceCalls + byTargetCalls).toBeGreaterThanOrEqual(1800);
		expect(getNodeCalls).toBeGreaterThanOrEqual(1000);

		bySourceCalls = 0;
		byTargetCalls = 0;
		getNodeCalls = 0;
		allEdgesCalls = 0;
		const counters = instrumentPrepare(store);
		const result = computeBlastRadius(store, ['/src/hub.ts'], 2, 2000);

		expect(result.total_impacted).toBe(impactedCount);
		expect(result.truncated).toBe(false);
		expect(bySourceCalls).toBe(0);
		expect(byTargetCalls).toBe(0);
		expect(getNodeCalls).toBe(0);
		expect(allEdgesCalls).toBe(0);

		const expectedEdgeQueries = 2 * Math.ceil(seedCount / 400) + 2 * Math.ceil(level1Count / 400);
		const expectedNodeQueries = Math.ceil(seedCount / 400) + Math.ceil(impactedCount / 400);
		expect(counters.edgeInQueries).toBe(expectedEdgeQueries);
		expect(counters.nodeInQueries).toBe(expectedNodeQueries);
	}, 60000);

	it('matches legacy output on the hub fixture', () => {
		store = createTestStore(engine);
		seedHubFixture(store);
		const expected = comparable(legacyComputeBlastRadius(store, ['/src/hub.ts'], 2, 2000));
		const actual = comparable(computeBlastRadius(store, ['/src/hub.ts'], 2, 2000));
		expect(actual).toEqual(expected);
	}, 60000);
});

describe('handleQuery — batched node fetch instead of per-edge getNode', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('resolves 600 callers with chunked node queries and a single resolveTarget getNode call', () => {
		store = createTestStore(engine);
		const CALLER_COUNT = 600;
		const nodes: RawNode[] = [
			{ kind: 'Function', name: 'calleeFn', qualified_name: '/src/lib.ts::calleeFn', file_path: '/src/lib.ts' },
		];
		const edges: RawEdge[] = [];
		for (let i = 0; i < CALLER_COUNT; i++) {
			const qn = `/src/caller_${i}.ts::caller_${i}`;
			nodes.push({ kind: 'Function', name: `caller_${i}`, qualified_name: qn, file_path: `/src/caller_${i}.ts` });
			edges.push({ kind: 'CALLS', source: qn, target: '/src/lib.ts::calleeFn', file_path: `/src/caller_${i}.ts` });
		}
		store.withTransaction(() => {
			insertRawNodes(store, nodes);
			insertRawEdges(store, edges);
		});

		const originalGetNode = store.getNode.bind(store);
		let getNodeCalls = 0;
		store.getNode = (qn: string) => { getNodeCalls++; return originalGetNode(qn); };
		const counters = instrumentPrepare(store);

		const output = handleQuery(store, { pattern: 'callers_of', target: '/src/lib.ts::calleeFn' });

		expect(output).toContain(`Callers of calleeFn (Function, /src/lib.ts:1) (${CALLER_COUNT}):`);
		expect(output).toContain('caller_0');
		expect(output).toContain('caller_599');
		expect(getNodeCalls).toBe(1);
		expect(counters.nodeInQueries).toBe(Math.ceil(CALLER_COUNT / 400));
	});
});

describe('batched getters — chunk-boundary correctness', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	function seedChain(store: GraphStore, count: number): string[] {
		const nodes: RawNode[] = [];
		const edges: RawEdge[] = [];
		const qns: string[] = [];
		for (let i = 0; i < count; i++) {
			const qn = `/src/chain_${i}.ts::fn_${i}`;
			qns.push(qn);
			nodes.push({ kind: 'Function', name: `fn_${i}`, qualified_name: qn, file_path: `/src/chain_${i}.ts` });
			if (i > 0) {
				edges.push({ kind: 'CALLS', source: qns[i - 1]!, target: qn, file_path: `/src/chain_${i - 1}.ts` });
			}
		}
		store.withTransaction(() => {
			insertRawNodes(store, nodes);
			insertRawEdges(store, edges);
		});
		return qns;
	}

	it('getEdgesBySources over 450 names equals union of per-name lookups', () => {
		store = createTestStore(engine);
		const qns = seedChain(store, 450);
		const batched = new Set(store.getEdgesBySources(qns).map(e => e.id));
		const single = new Set(qns.flatMap(qn => store.getEdgesBySource(qn)).map(e => e.id));
		expect(batched).toEqual(single);
		expect(batched.size).toBe(449);
	});

	it('getEdgesByTargets over 450 names equals union of per-name lookups', () => {
		store = createTestStore(engine);
		const qns = seedChain(store, 450);
		const batched = new Set(store.getEdgesByTargets(qns).map(e => e.id));
		const single = new Set(qns.flatMap(qn => store.getEdgesByTarget(qn)).map(e => e.id));
		expect(batched).toEqual(single);
		expect(batched.size).toBe(449);
	});

	it('getNodesByQualifiedNames returns each existing node once and skips missing names', () => {
		store = createTestStore(engine);
		const qns = seedChain(store, 450);
		const requested = [...qns, ...Array.from({ length: 30 }, (_, i) => `missing::ghost_${i}`)];
		const fetched = store.getNodesByQualifiedNames(requested);
		expect(fetched).toHaveLength(450);
		expect(new Set(fetched.map(n => n.qualified_name))).toEqual(new Set(qns));
	});

	it('empty inputs return empty results without issuing queries', () => {
		store = createTestStore(engine);
		const counters = instrumentPrepare(store);
		expect(store.getEdgesBySources([])).toEqual([]);
		expect(store.getEdgesByTargets([])).toEqual([]);
		expect(store.getNodesByQualifiedNames([])).toEqual([]);
		expect(counters.edgeInQueries).toBe(0);
		expect(counters.nodeInQueries).toBe(0);
	});
});
