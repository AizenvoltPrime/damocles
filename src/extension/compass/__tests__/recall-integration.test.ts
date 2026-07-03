import { describe, it, expect, afterEach } from 'vitest';
import { GraphStore } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import { expandGraphTerms } from '../search';
import { createTestStore } from './sql-test-helper';


function makeNode(overrides: Partial<NodeInfo> & { name: string; file_path: string }): NodeInfo {
	return { kind: 'Function', line_start: 1, line_end: 10, ...overrides };
}

function makeEdge(overrides: Partial<EdgeInfo> & { source: string; target: string; file_path: string }): EdgeInfo {
	return { kind: 'CALLS', ...overrides };
}

describe('expandGraphTerms (production function)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('returns empty for empty store', () => {
		store = createTestStore();
		const result = expandGraphTerms(store, ['anything']);
		expect(result).toEqual([]);
	});

	it('expands query with neighbor names', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'CompassService', file_path: '/src/compass.ts' }));
		store.upsertNode(makeNode({ name: 'GraphStore', file_path: '/src/database.ts' }));
		store.upsertEdge(makeEdge({
			source: '/src/compass.ts::CompassService',
			target: '/src/database.ts::GraphStore',
			file_path: '/src/compass.ts',
		}));

		const result = expandGraphTerms(store, ['compass']);
		expect(result.length).toBeGreaterThan(0);
		expect(result).toContain('service');
	});

	it('includes neighbor tokens from graph traversal', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'authenticate', file_path: '/src/auth.ts' }));
		store.upsertNode(makeNode({ name: 'validateToken', file_path: '/src/token.ts' }));
		store.upsertEdge(makeEdge({
			source: '/src/auth.ts::authenticate',
			target: '/src/token.ts::validateToken',
			file_path: '/src/auth.ts',
		}));

		const result = expandGraphTerms(store, ['authenticate']);
		expect(result).toContain('validate');
		expect(result).toContain('token');
	});

	it('removes original query terms from expansion', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'authenticate', file_path: '/src/auth.ts' }));

		const result = expandGraphTerms(store, ['authenticate']);
		expect(result).not.toContain('authenticate');
	});

	it('limits expansion to 20 terms', () => {
		store = createTestStore();
		for (let i = 0; i < 30; i++) {
			store.upsertNode(makeNode({ name: `function${i}Extra`, file_path: `/src/f${i}.ts` }));
		}
		store.upsertNode(makeNode({ name: 'centralHub', file_path: '/src/hub.ts' }));
		for (let i = 0; i < 30; i++) {
			store.upsertEdge(makeEdge({
				source: '/src/hub.ts::centralHub',
				target: `/src/f${i}.ts::function${i}Extra`,
				file_path: '/src/hub.ts',
			}));
		}

		const result = expandGraphTerms(store, ['central']);
		expect(result.length).toBeLessThanOrEqual(20);
	});

	it('filters out short tokens', () => {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'do_x', file_path: '/src/a.ts' }));
		const result = expandGraphTerms(store, ['do_x']);
		for (const t of result) {
			expect(t.length).toBeGreaterThan(2);
		}
	});
});
