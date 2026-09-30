import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphStore, rowToStoredEdge } from '../database';
import type { StoredEdge } from '../types';
import { createTestStore } from './sql-test-helper';

const NODE_COUNT = 300;
const EDGE_COUNT = 1000;
const FILE_COUNT = 20;
const SEED = 0xBEEFCAFE;

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

function runInPath(store: GraphStore, list: string[]): StoredEdge[] {
	if (list.length === 0) return [];
	const placeholders = list.map(() => '?').join(',');
	return store.db.prepare(
		`SELECT * FROM edges WHERE source_qualified IN (${placeholders}) AND target_qualified IN (${placeholders})`,
	).all(...list, ...list).map(rowToStoredEdge);
}

function seedFixture(store: GraphStore): string[] {
	const rng = mulberry32(SEED);
	const qns: string[] = [];
	const filePaths: string[] = [];
	for (let f = 0; f < FILE_COUNT; f++) {
		filePaths.push(`/src/pkg/file${f}.ts`);
	}

	const NON_FILE = NODE_COUNT - FILE_COUNT;
	const perFile = Math.ceil(NON_FILE / FILE_COUNT);

	store.withTransaction(() => {
		const insertNode = store.db.prepare(`
			INSERT INTO nodes
				(kind, name, name_tokens, qualified_name, file_path, line_start, line_end,
				 language, parent_name, params, return_type, modifiers, signature,
				 is_test, file_hash, extra, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const now = Date.now() / 1000;

		for (let f = 0; f < FILE_COUNT; f++) {
			const fp = filePaths[f]!;
			insertNode.run('File', `file${f}.ts`, `file ${f} ts`, `${fp}::file${f}.ts`,
				fp, 1, perFile * 15 + 10,
				'typescript', null, null, null, null, null,
				0, null, '{}', now);
		}

		let inserted = 0;
		outer: for (let f = 0; f < FILE_COUNT; f++) {
			const fp = filePaths[f]!;
			for (let fn = 0; fn < perFile; fn++) {
				if (inserted >= NON_FILE) break outer;
				const kindIdx = (f + fn) % 3;
				const kind = kindIdx === 0 ? 'Function' : kindIdx === 1 ? 'Class' : 'Type';
				const name = `${kind.toLowerCase()}_${f}_${fn}`;
				const qn = `${fp}::${name}`;
				qns.push(qn);
				const ls = fn * 15 + 5;
				insertNode.run(kind, name, `${kind.toLowerCase()} ${f} ${fn}`, qn,
					fp, ls, ls + 12,
					'typescript', null,
					kind === 'Function' ? '(x: number)' : null,
					kind === 'Function' ? 'void' : null,
					null, null,
					0, null, '{}', now);
				inserted++;
			}
		}

		const insertEdge = store.db.prepare(`
			INSERT INTO edges (kind, source_qualified, target_qualified, file_path, line, extra, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		const edgeKinds = ['CALLS', 'REFERENCES', 'CONTAINS', 'IMPORTS_FROM'];
		for (let e = 0; e < EDGE_COUNT; e++) {
			const s = Math.floor(rng() * qns.length);
			let t = Math.floor(rng() * qns.length);
			if (t === s) t = (t + 1) % qns.length;
			const kind = edgeKinds[Math.floor(rng() * edgeKinds.length)]!;
			const src = qns[s]!;
			const dst = qns[t]!;
			const srcFile = src.split('::')[0]!;
			insertEdge.run(kind, src, dst, srcFile, Math.floor(rng() * 1000), '{}', now);
		}
	});

	return qns;
}

describe('getEdgesAmong — IN-path vs temp-table-path parity', () => {
	let store: GraphStore;
	let qns: string[];

	beforeAll(async () => {
		store = createTestStore();
		qns = seedFixture(store);
	});

	afterAll(() => {
		store?.close();
	});

	function edgeIds(edges: StoredEdge[]): Set<number> {
		return new Set(edges.map(e => e.id));
	}

	it('empty set returns empty (both paths agree trivially)', () => {
		const res = store.getEdgesAmong(new Set());
		expect(res).toEqual([]);
	});

	it('small set (< 250) — baseline IN path still used; result matches simulated IN path', () => {
		const subset = new Set<string>(qns.slice(0, 100));
		const fromApi = store.getEdgesAmong(subset);
		const fromIn = runInPath(store, [...subset]);
		expect(edgeIds(fromApi)).toEqual(edgeIds(fromIn));
	});

	it('large set (>= 250) — temp-table path used; result matches IN path edge IDs', () => {
		const subset = new Set<string>(qns.slice(0, 280));
		expect(subset.size).toBeGreaterThanOrEqual(250);
		const fromTempTable = store.getEdgesAmong(subset);
		const fromIn = runInPath(store, [...subset]);
		expect(edgeIds(fromTempTable)).toEqual(edgeIds(fromIn));
		expect(fromTempTable.length).toBe(fromIn.length);
	});

	it('full node set — temp-table path result identical to IN path', () => {
		const subset = new Set<string>(qns);
		const fromTempTable = store.getEdgesAmong(subset);
		const fromIn = runInPath(store, [...subset]);
		expect(edgeIds(fromTempTable)).toEqual(edgeIds(fromIn));
	});

	it('duplicate inputs are deduplicated — results stable across calls', () => {
		const subset = new Set<string>(qns.slice(0, 260));
		const a = store.getEdgesAmong(subset);
		const b = store.getEdgesAmong(subset);
		expect(edgeIds(a)).toEqual(edgeIds(b));
		expect(a.length).toBe(b.length);
	});

	it('temp table is cleaned up between calls (no cross-call leakage)', () => {
		const subset1 = new Set<string>(qns.slice(0, 260));
		const subset2 = new Set<string>(qns.slice(260, 280));
		store.getEdgesAmong(subset1);
		const second = store.getEdgesAmong(subset2);
		const fromIn = runInPath(store, [...subset2]);
		expect(edgeIds(second)).toEqual(edgeIds(fromIn));
	});
});
