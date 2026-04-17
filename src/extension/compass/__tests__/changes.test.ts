import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import {
	parseUnifiedDiff,
	mapChangesToNodes,
	computeRiskScore,
	analyzeChanges,
} from '../changes';
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

describe('parseUnifiedDiff', () => {
	it('extracts file names and line ranges from unified diff', () => {
		const diff = [
			'diff --git a/src/foo.ts b/src/foo.ts',
			'--- a/src/foo.ts',
			'+++ b/src/foo.ts',
			'@@ -10,3 +10,5 @@ function foo() {',
			'+  added line',
			'+  another line',
			'@@ -30,0 +32,2 @@ function bar() {',
			'+  new line 1',
			'+  new line 2',
		].join('\n');

		const ranges = parseUnifiedDiff(diff);
		expect(ranges.has('src/foo.ts')).toBe(true);
		const fooRanges = ranges.get('src/foo.ts')!;
		expect(fooRanges).toHaveLength(2);
		expect(fooRanges[0]).toEqual([10, 14]);
		expect(fooRanges[1]).toEqual([32, 33]);
	});

	it('handles multiple files', () => {
		const diff = [
			'+++ b/src/a.ts',
			'@@ -5,2 +5,3 @@',
			'+++ b/src/b.ts',
			'@@ -10 +10 @@',
		].join('\n');

		const ranges = parseUnifiedDiff(diff);
		expect(ranges.size).toBe(2);
		expect(ranges.get('src/a.ts')).toEqual([[5, 7]]);
		expect(ranges.get('src/b.ts')).toEqual([[10, 10]]);
	});

	it('handles pure deletion hunks (count=0)', () => {
		const diff = [
			'+++ b/src/c.ts',
			'@@ -5,3 +5,0 @@',
		].join('\n');

		const ranges = parseUnifiedDiff(diff);
		expect(ranges.get('src/c.ts')).toEqual([[5, 5]]);
	});

	it('returns empty for empty input', () => {
		expect(parseUnifiedDiff('')).toEqual(new Map());
	});
});

describe('mapChangesToNodes', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('maps changed lines to overlapping nodes', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'foo', file_path: '/src/a.ts', line_start: 5, line_end: 15 }));
		store.upsertNode(makeNode({ name: 'bar', file_path: '/src/a.ts', line_start: 20, line_end: 30 }));
		store.upsertNode(makeNode({ name: 'baz', file_path: '/src/a.ts', line_start: 35, line_end: 45 }));

		const ranges = new Map<string, Array<[number, number]>>([
			['/src/a.ts', [[10, 12], [25, 27]]],
		]);

		const nodes = mapChangesToNodes(store, ranges);
		const names = nodes.map(n => n.name);
		expect(names).toContain('foo');
		expect(names).toContain('bar');
		expect(names).not.toContain('baz');
	});

	it('deduplicates nodes', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'wide', file_path: '/src/a.ts', line_start: 1, line_end: 100 }));

		const ranges = new Map<string, Array<[number, number]>>([
			['/src/a.ts', [[5, 10], [50, 60]]],
		]);

		const nodes = mapChangesToNodes(store, ranges);
		expect(nodes).toHaveLength(1);
	});

	it('handles suffix-based file matching', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'func', file_path: '/abs/src/a.ts', line_start: 1, line_end: 10 }));

		const ranges = new Map<string, Array<[number, number]>>([
			['src/a.ts', [[1, 5]]],
		]);

		const nodes = mapChangesToNodes(store, ranges);
		expect(nodes).toHaveLength(1);
	});

	it('handles single-line entities', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'oneliner', file_path: '/src/a.ts', line_start: 10, line_end: 10 }));

		const ranges = new Map<string, Array<[number, number]>>([
			['/src/a.ts', [[10, 10]]],
		]);

		const nodes = mapChangesToNodes(store, ranges);
		expect(nodes).toHaveLength(1);
		expect(nodes[0]!.name).toBe('oneliner');
	});

	it('returns empty when no ranges overlap any nodes', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'foo', file_path: '/src/a.ts', line_start: 5, line_end: 15 }));

		const ranges = new Map<string, Array<[number, number]>>([
			['/src/a.ts', [[50, 60]]],
		]);

		const nodes = mapChangesToNodes(store, ranges);
		expect(nodes).toHaveLength(0);
	});
});

describe('computeRiskScore', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('returns score between 0 and 1', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'func', file_path: '/src/a.ts' }));
		const node = store.getNode('/src/a.ts::func')!;
		const score = computeRiskScore(store, node);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	it('gives higher score to security-sensitive functions', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'authenticate', file_path: '/src/auth.ts' }));
		store.upsertNode(makeNode({ name: 'formatOutput', file_path: '/src/util.ts' }));

		const authNode = store.getNode('/src/auth.ts::authenticate')!;
		const utilNode = store.getNode('/src/util.ts::formatOutput')!;

		const authScore = computeRiskScore(store, authNode);
		const utilScore = computeRiskScore(store, utilNode);
		expect(authScore).toBeGreaterThan(utilScore);
	});

	it('gives lower score when TESTED_BY edge exists', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'tested', file_path: '/src/a.ts' }));
		store.upsertNode(makeNode({ name: 'untested', file_path: '/src/b.ts' }));
		store.upsertEdge(makeEdge({
			kind: 'TESTED_BY', source: 'test_tested', target: '/src/a.ts::tested', file_path: '/test/a.test.ts',
		}));

		const testedNode = store.getNode('/src/a.ts::tested')!;
		const untestedNode = store.getNode('/src/b.ts::untested')!;

		const testedScore = computeRiskScore(store, testedNode);
		const untestedScore = computeRiskScore(store, untestedNode);
		expect(testedScore).toBeLessThan(untestedScore);
	});

	it('boosts score for flow membership', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'inFlow', file_path: '/src/a.ts' }));
		store.upsertNode(makeNode({ name: 'notInFlow', file_path: '/src/b.ts' }));

		const inFlowNode = store.getNode('/src/a.ts::inFlow')!;
		const notInFlowNode = store.getNode('/src/b.ts::notInFlow')!;

		store.execRaw(
			"INSERT INTO flows (name, entry_point_id, depth, node_count, file_count, criticality, path_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
			['testFlow', inFlowNode.id, 1, 2, 1, 0.5, JSON.stringify([inFlowNode.id])],
		);
		const flowRow = store.queryRaw('SELECT last_insert_rowid() as id');
		const flowId = (flowRow[0]?.['id'] ?? 0) as number;
		store.execRaw(
			'INSERT INTO flow_memberships (flow_id, node_id, position) VALUES (?, ?, ?)',
			[flowId, inFlowNode.id, 0],
		);

		const inFlowScore = computeRiskScore(store, inFlowNode);
		const notInFlowScore = computeRiskScore(store, notInFlowNode);
		expect(inFlowScore).toBeGreaterThan(notInFlowScore);
	});

	it('contributes flow criticality sum (capped at 0.25) to risk score', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'oneFlow', file_path: '/src/a.ts' }));
		const node = store.getNode('/src/a.ts::oneFlow')!;

		store.execRaw(
			"INSERT INTO flows (name, entry_point_id, depth, node_count, file_count, criticality, path_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
			['f1', node.id, 1, 1, 1, 0.3, JSON.stringify([node.id])],
		);
		const row = store.queryRaw('SELECT last_insert_rowid() as id');
		const flowId = (row[0]?.['id'] ?? 0) as number;
		store.execRaw(
			'INSERT INTO flow_memberships (flow_id, node_id, position) VALUES (?, ?, ?)',
			[flowId, node.id, 0],
		);

		const score = computeRiskScore(store, node);
		expect(score).toBeCloseTo(0.55, 4);
	});

	it('sums flow criticalities below cap', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'threeFlows', file_path: '/src/b.ts' }));
		const node = store.getNode('/src/b.ts::threeFlows')!;

		for (const crit of [0.1, 0.05, 0.02]) {
			store.execRaw(
				"INSERT INTO flows (name, entry_point_id, depth, node_count, file_count, criticality, path_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[`flow_${crit}`, node.id, 1, 1, 1, crit, JSON.stringify([node.id])],
			);
			const r = store.queryRaw('SELECT last_insert_rowid() as id');
			const fid = (r[0]?.['id'] ?? 0) as number;
			store.execRaw(
				'INSERT INTO flow_memberships (flow_id, node_id, position) VALUES (?, ?, ?)',
				[fid, node.id, 0],
			);
		}

		const score = computeRiskScore(store, node);
		expect(score).toBeCloseTo(0.47, 4);
	});

	it('caps flow criticality sum at 0.25 when sum exceeds cap', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'manyFlows', file_path: '/src/c.ts' }));
		const node = store.getNode('/src/c.ts::manyFlows')!;

		for (const crit of [0.2, 0.2, 0.1]) {
			store.execRaw(
				"INSERT INTO flows (name, entry_point_id, depth, node_count, file_count, criticality, path_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[`flow_${Math.random()}`, node.id, 1, 1, 1, crit, JSON.stringify([node.id])],
			);
			const r = store.queryRaw('SELECT last_insert_rowid() as id');
			const fid = (r[0]?.['id'] ?? 0) as number;
			store.execRaw(
				'INSERT INTO flow_memberships (flow_id, node_id, position) VALUES (?, ?, ?)',
				[fid, node.id, 0],
			);
		}

		const score = computeRiskScore(store, node);
		expect(score).toBeCloseTo(0.55, 4);
	});

	it('contributes zero from flows when node has no memberships', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'orphan', file_path: '/src/d.ts' }));
		const node = store.getNode('/src/d.ts::orphan')!;

		const score = computeRiskScore(store, node);
		expect(score).toBeCloseTo(0.30, 4);
	});

	it('boosts score for high caller count', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'popular', file_path: '/src/a.ts' }));
		store.upsertNode(makeNode({ name: 'lonely', file_path: '/src/b.ts' }));
		for (let i = 0; i < 10; i++) {
			store.upsertNode(makeNode({ name: `caller${i}`, file_path: `/src/c${i}.ts` }));
			store.upsertEdge(makeEdge({
				source: `/src/c${i}.ts::caller${i}`, target: '/src/a.ts::popular',
				file_path: `/src/c${i}.ts`, line: 5,
			}));
		}

		const popularNode = store.getNode('/src/a.ts::popular')!;
		const lonelyNode = store.getNode('/src/b.ts::lonely')!;

		expect(computeRiskScore(store, popularNode)).toBeGreaterThan(computeRiskScore(store, lonelyNode));
	});
});

describe('analyzeChanges', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('produces risk-scored analysis', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ kind: 'File', name: 'a.ts', file_path: '/src/a.ts', line_start: 1, line_end: 50 }));
		store.upsertNode(makeNode({ name: 'doAuth', file_path: '/src/a.ts', line_start: 5, line_end: 15 }));
		store.upsertNode(makeNode({ name: 'helper', file_path: '/src/a.ts', line_start: 20, line_end: 30 }));

		const ranges = new Map<string, Array<[number, number]>>([
			['/src/a.ts', [[5, 30]]],
		]);

		const result = analyzeChanges(store, ['/src/a.ts'], ranges);
		expect(result.changed_files).toEqual(['/src/a.ts']);
		expect(result.risks.length).toBeGreaterThan(0);
		expect(result.risks[0]!.risk_score).toBeGreaterThanOrEqual(0);
	});

	it('identifies test gaps', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'untestedFunc', file_path: '/src/a.ts' }));
		store.upsertNode(makeNode({ kind: 'File', name: 'a.ts', file_path: '/src/a.ts', line_start: 1, line_end: 50 }));

		const result = analyzeChanges(store, ['/src/a.ts']);
		expect(result.test_gaps.some(n => n.name === 'untestedFunc')).toBe(true);
	});

	it('sorts risks by score descending', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'highRiskAuth', file_path: '/src/a.ts', line_start: 1, line_end: 10 }));
		store.upsertNode(makeNode({ name: 'lowRisk', file_path: '/src/a.ts', line_start: 15, line_end: 25 }));
		store.upsertNode(makeNode({ kind: 'File', name: 'a.ts', file_path: '/src/a.ts', line_start: 1, line_end: 50 }));

		const ranges = new Map<string, Array<[number, number]>>([
			['/src/a.ts', [[1, 25]]],
		]);

		const result = analyzeChanges(store, ['/src/a.ts'], ranges);
		expect(result.risks.length).toBeGreaterThanOrEqual(2);
		expect(result.risks[0]!.risk_score).toBeGreaterThanOrEqual(result.risks[1]!.risk_score);
	});

	it('falls back to all-file nodes when no ranges provided', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ kind: 'File', name: 'a.ts', file_path: '/src/a.ts', line_start: 1, line_end: 50 }));
		store.upsertNode(makeNode({ name: 'func', file_path: '/src/a.ts', line_start: 5, line_end: 15 }));

		const result = analyzeChanges(store, ['/src/a.ts']);
		expect(result.risks.length).toBe(1);
	});
});
