import { describe, it, expect, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphStore, runChunked } from '../database';
import { incrementalUpdate } from '../incremental';
import type { NodeInfo } from '../types';
import { createTestStore } from './sql-test-helper';


function makeNode(overrides: Partial<NodeInfo> & { name: string; file_path: string }): NodeInfo {
	return {
		kind: 'Function',
		line_start: 1,
		line_end: 10,
		...overrides,
	};
}

const GENERATED_FILE = 'src/generated.ts';
const SYMBOL_COUNT = 1000;

function seedGeneratedFile(store: GraphStore): number[] {
	const nodes = Array.from({ length: SYMBOL_COUNT }, (_, i) =>
		makeNode({ name: `sym${i}`, file_path: GENERATED_FILE, line_start: i + 1, line_end: i + 1 }),
	);
	store.storeFileNodesEdges(GENERATED_FILE, nodes, []);
	return store.getNodeIdsByFiles([GENERATED_FILE]);
}

function seedFlowWithMemberships(store: GraphStore, nodeIds: number[]): number {
	store.execRaw(
		'INSERT INTO flows (name, entry_point_id, depth, node_count, file_count, criticality, path_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
		['generated-flow', nodeIds[0], 1, nodeIds.length, 1, 0.5, JSON.stringify(nodeIds)],
	);
	const flowId = (store.queryRaw('SELECT last_insert_rowid() as id')[0]?.['id'] ?? 0) as number;
	store.withTransaction(() => {
		for (let i = 0; i < nodeIds.length; i++) {
			store.execRaw(
				'INSERT INTO flow_memberships (flow_id, node_id, position) VALUES (?, ?, ?)',
				[flowId, nodeIds[i], i],
			);
		}
	});
	return flowId;
}

describe('runChunked', () => {
	it('splits items into batches of 400 with matching placeholder lists', () => {
		const items = Array.from({ length: 1000 }, (_, i) => i);
		const chunkSizes: number[] = [];
		const collected = runChunked(items, (chunk, placeholders) => {
			chunkSizes.push(chunk.length);
			expect(placeholders.split(',')).toHaveLength(chunk.length);
			return chunk.map(n => n * 2);
		});
		expect(chunkSizes).toEqual([400, 400, 200]);
		expect(collected).toHaveLength(1000);
		expect(collected[0]).toBe(0);
		expect(collected[999]).toBe(1998);
	});

	it('supports statement-only callbacks that return nothing', () => {
		const seen: number[] = [];
		const result = runChunked([1, 2, 3], chunk => {
			seen.push(...chunk);
		});
		expect(result).toEqual([]);
		expect(seen).toEqual([1, 2, 3]);
	});

	it('does nothing for empty input', () => {
		const calls: unknown[] = [];
		expect(runChunked([], chunk => { calls.push(chunk); })).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});

describe('GraphStore batched IN-list queries (US-008)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('removeFileData succeeds for a single file with 1,000 symbols and flow memberships', () => {
		store = createTestStore();
		const nodeIds = seedGeneratedFile(store);
		expect(nodeIds).toHaveLength(SYMBOL_COUNT);
		seedFlowWithMemberships(store, nodeIds);

		store.removeFileData(GENERATED_FILE);

		expect(store.getNodesByFile(GENERATED_FILE)).toHaveLength(0);
		const memberships = store.queryRaw('SELECT COUNT(*) as cnt FROM flow_memberships');
		expect(memberships[0]?.['cnt']).toBe(0);
	});

	it('getFlowIdsByNodeIds deduplicates flow ids across chunks', () => {
		store = createTestStore();
		const nodeIds = seedGeneratedFile(store);
		const flowId = seedFlowWithMemberships(store, nodeIds);

		expect(store.getFlowIdsByNodeIds(nodeIds)).toEqual([flowId]);
	});

	it('getCommunityIdsByQualifiedNames covers more than 400 names', () => {
		store = createTestStore();
		seedGeneratedFile(store);
		const names = Array.from({ length: SYMBOL_COUNT }, (_, i) => `${GENERATED_FILE}::sym${i}`);

		const result = store.getCommunityIdsByQualifiedNames(names);

		expect(result.size).toBe(SYMBOL_COUNT);
		expect(result.get(`${GENERATED_FILE}::sym0`)).toBeNull();
		expect(result.get(`${GENERATED_FILE}::sym999`)).toBeNull();
	});

	it('returns empty results for empty inputs', () => {
		store = createTestStore();
		expect(store.getNodeIdsByFiles([])).toEqual([]);
		expect(store.getFlowIdsByNodeIds([])).toEqual([]);
		expect(store.getCommunityIdsByQualifiedNames([]).size).toBe(0);
	});
});

describe('GraphStore dirty-aware serialize (US-008)', () => {
	let dir: string;
	let store: GraphStore;

	afterEach(() => {
		vi.restoreAllMocks();
		store?.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function openDiskStore(): GraphStore {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-dirty-'));
		return GraphStore.openAt(path.join(dir, 'graph.db'));
	}

	// serialize() checkpoints the WAL only when the store is dirty; spy on that to assert the gate.
	function spyCheckpoint(s: GraphStore) {
		return vi.spyOn(s.db, 'checkpoint');
	}

	it('skips the checkpoint when nothing changed since the last serialize', async () => {
		store = openDiskStore();
		store.upsertNode(makeNode({ name: 'persisted', file_path: 'src/a.ts' }));
		await store.serialize();
		expect(fs.existsSync(store.dbPath)).toBe(true);

		const checkpointSpy = spyCheckpoint(store);
		store.getNodesByFile('src/a.ts');
		store.getNode('src/a.ts::persisted');
		await store.serialize();

		expect(checkpointSpy).not.toHaveBeenCalled();
	});

	it('does not mark dirty for a read-only transaction (BEGIN/COMMIT only)', async () => {
		store = openDiskStore();
		store.upsertNode(makeNode({ name: 'reader', file_path: 'src/r.ts' }));
		await store.serialize();

		const checkpointSpy = spyCheckpoint(store);
		store.withTransaction(() => {
			expect(store.getNodeCount()).toBe(1);
		});
		await store.serialize();

		expect(checkpointSpy).not.toHaveBeenCalled();
	});

	it('checkpoints again after a mutation re-marks the store dirty', async () => {
		store = openDiskStore();
		store.upsertNode(makeNode({ name: 'first', file_path: 'src/a.ts' }));
		await store.serialize();

		const checkpointSpy = spyCheckpoint(store);
		await store.serialize();
		expect(checkpointSpy).not.toHaveBeenCalled();

		store.upsertNode(makeNode({ name: 'second', file_path: 'src/b.ts' }));
		await store.serialize();
		expect(checkpointSpy).toHaveBeenCalledTimes(1);
	});

	it('a no-op incremental leaves the store clean so serialize skips the checkpoint', async () => {
		store = openDiskStore();
		const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-noop-'));
		try {
			const file = path.join(srcDir, 'a.ts').replace(/\\/g, '/');
			fs.writeFileSync(file, 'export const a = 1;');
			const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
			store.storeFileNodesEdges(file, [makeNode({ kind: 'File', name: 'a.ts', file_path: file })], [], hash);
			await store.serialize();

			const checkpointSpy = spyCheckpoint(store);
			await incrementalUpdate(store, srcDir, undefined, [file]);
			await store.serialize();

			expect(checkpointSpy).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(srcDir, { recursive: true, force: true });
		}
	});

	it('does not mark dirty for the temp-table getEdgesAmong path', async () => {
		store = openDiskStore();
		const qns = new Set<string>();
		for (let i = 0; i < 300; i++) {
			store.upsertNode(makeNode({ name: `fn${i}`, file_path: 'src/big.ts', line_start: i + 1, line_end: i + 1 }));
			qns.add(`src/big.ts::fn${i}`);
		}
		store.upsertEdge({ kind: 'CALLS', source: 'src/big.ts::fn0', target: 'src/big.ts::fn1', file_path: 'src/big.ts', line: 1 });
		await store.serialize();

		const checkpointSpy = spyCheckpoint(store);
		const edges = store.getEdgesAmong(qns);
		expect(edges).toHaveLength(1);
		await store.serialize();

		expect(checkpointSpy).not.toHaveBeenCalled();
	});
});
