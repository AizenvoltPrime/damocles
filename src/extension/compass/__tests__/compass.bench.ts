import { bench, describe, beforeAll, afterAll } from 'vitest';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import { searchNodes } from '../search';
import { computeBlastRadius } from '../impact';
import { detectEntryPoints, traceFlows, storeFlows } from '../flows';
import { detectCommunities, storeCommunities } from '../communities';
import { analyzeChanges } from '../changes';
import { getSqlEngine, createTestStore } from './sql-test-helper';

let engine: SqlJsStatic;
let store: GraphStore;

function makeNode(overrides: Partial<NodeInfo> & { name: string; file_path: string }): NodeInfo {
	return { kind: 'Function', line_start: 1, line_end: 10, ...overrides };
}

function makeEdge(overrides: Partial<EdgeInfo> & { source: string; target: string; file_path: string }): EdgeInfo {
	return { kind: 'CALLS', ...overrides };
}

function seedLargeGraph(store: GraphStore, fileCount: number, functionsPerFile: number): void {
	const kinds: Array<NodeInfo['kind']> = ['Function', 'Class', 'Type'];
	const files: string[] = [];

	for (let f = 0; f < fileCount; f++) {
		const dir = `src/module${Math.floor(f / 10)}`;
		const filePath = `/${dir}/file${f}.ts`;
		files.push(filePath);

		store.upsertNode(makeNode({
			kind: 'File',
			name: `file${f}.ts`,
			file_path: filePath,
			line_start: 1,
			line_end: functionsPerFile * 15 + 10,
			language: 'typescript',
		}));

		for (let fn = 0; fn < functionsPerFile; fn++) {
			const kind = kinds[fn % 3]!;
			const name = `${kind === 'Class' ? 'Class' : kind === 'Type' ? 'Type' : 'func'}${f}_${fn}`;
			const lineStart = fn * 15 + 5;
			store.upsertNode(makeNode({
				kind,
				name,
				file_path: filePath,
				line_start: lineStart,
				line_end: lineStart + 12,
				language: 'typescript',
				params: kind === 'Function' ? '(x: number)' : undefined,
				return_type: kind === 'Function' ? 'void' : undefined,
			}));

			store.upsertEdge(makeEdge({
				kind: 'CONTAINS',
				source: `${filePath}::file${f}.ts`,
				target: `${filePath}::${name}`,
				file_path: filePath,
			}));
		}
	}

	for (let f = 0; f < fileCount; f++) {
		const srcFile = files[f]!;
		for (let fn = 0; fn < functionsPerFile; fn++) {
			const srcName = `func${f}_${fn}`;
			const srcQn = `${srcFile}::${srcName}`;

			if (fn > 0) {
				const prevName = `func${f}_${fn - 1}`;
				store.upsertEdge(makeEdge({
					source: srcQn,
					target: `${srcFile}::${prevName}`,
					file_path: srcFile,
					line: fn * 15 + 7,
				}));
			}

			if (f > 0 && fn === 0) {
				const prevFile = files[f - 1]!;
				store.upsertEdge(makeEdge({
					source: srcQn,
					target: `${prevFile}::func${f - 1}_0`,
					file_path: srcFile,
					line: 8,
				}));

				store.upsertEdge(makeEdge({
					kind: 'IMPORTS_FROM',
					source: `${srcFile}::file${f}.ts`,
					target: `${prevFile}::file${f - 1}.ts`,
					file_path: srcFile,
					line: 1,
				}));
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 1K-node synthetic graph: 100 files × 10 functions each
// Target performance: insert <5s, search <100ms, blast radius <500ms
// ---------------------------------------------------------------------------
describe('Compass benchmarks (1K nodes)', () => {
	beforeAll(async () => {
		engine = await getSqlEngine();
		store = createTestStore(engine);
		seedLargeGraph(store, 100, 10);
	});

	afterAll(() => {
		store?.close();
	});

	bench('FTS5 search — single term', () => {
		searchNodes(store, 'func50');
	});

	bench('FTS5 search — camelCase split', () => {
		searchNodes(store, 'ClassModule');
	});

	bench('FTS5 search — with kind filter', () => {
		searchNodes(store, 'func', { kind: 'Function', limit: 20 });
	});

	bench('blast radius — depth 2, single file', () => {
		computeBlastRadius(store, ['/src/module5/file50.ts'], 2);
	});

	bench('blast radius — depth 3, single file', () => {
		computeBlastRadius(store, ['/src/module5/file50.ts'], 3);
	});

	bench('blast radius — depth 2, multiple files', () => {
		computeBlastRadius(store, [
			'/src/module0/file0.ts',
			'/src/module5/file50.ts',
			'/src/module9/file99.ts',
		], 2);
	});

	bench('entry point detection', () => {
		detectEntryPoints(store);
	});

	bench('analyzeChanges — single file', () => {
		analyzeChanges(store, ['/src/module5/file50.ts']);
	});

	bench('getStats', () => {
		store.getStats();
	});

	bench('getAllNodes', () => {
		store.getAllNodes();
	});

	bench('getEdgesAmong — 50 nodes', () => {
		const qns = new Set<string>();
		for (let i = 0; i < 50; i++) {
			qns.add(`/src/module5/file50.ts::func50_${i % 10}`);
		}
		store.getEdgesAmong(qns);
	});
});

describe('Compass benchmarks — post-processing (1K nodes)', () => {
	beforeAll(async () => {
		engine = await getSqlEngine();
		store = createTestStore(engine);
		seedLargeGraph(store, 100, 10);
	});

	afterAll(() => {
		store?.close();
	});

	bench('flow tracing + storage', () => {
		const flows = traceFlows(store);
		storeFlows(store, flows);
	});

	bench('community detection + storage', () => {
		const comms = detectCommunities(store);
		storeCommunities(store, comms);
	});
});

describe('Compass benchmarks — insert throughput', () => {
	bench('insert 100 nodes + 100 edges', async () => {
		const benchStore = createTestStore(engine);
		for (let i = 0; i < 100; i++) {
			benchStore.upsertNode(makeNode({
				name: `benchFunc${i}`,
				file_path: `/bench/file${i}.ts`,
				line_start: 1,
				line_end: 20,
			}));
		}
		for (let i = 1; i < 100; i++) {
			benchStore.upsertEdge(makeEdge({
				source: `/bench/file${i}.ts::benchFunc${i}`,
				target: `/bench/file${i - 1}.ts::benchFunc${i - 1}`,
				file_path: `/bench/file${i}.ts`,
			}));
		}
		benchStore.close();
	});
});
