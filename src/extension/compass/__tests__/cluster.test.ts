import { describe, it, expect } from 'vitest';
import { cluster, cohesionScore, scoreAll } from '../cluster';
import { buildFromExtraction } from '../build';
import { createTestGraph, addTestNode, addTestEdge, makeSimpleExtraction } from './graph-helpers';

describe('cluster', () => {
	it('returns empty for empty graph', () => {
		const G = createTestGraph();
		expect(cluster(G)).toEqual({});
	});

	it('creates single-node communities for edgeless graph', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'A');
		addTestNode(G, 'b', 'B');
		const result = cluster(G);
		expect(Object.keys(result).length).toBe(2);
	});

	it('assigns all nodes to communities', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const communities = cluster(G);
		const allNodes = new Set<string>();
		for (const nodes of Object.values(communities)) {
			for (const n of nodes) allNodes.add(n);
		}
		G.forEachNode(nodeId => {
			expect(allNodes.has(nodeId)).toBe(true);
		});
	});

	it('communities from fixture extraction', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const communities = cluster(G);
		expect(Object.keys(communities).length).toBeGreaterThan(0);
	});
});

describe('cohesionScore', () => {
	it('returns 1.0 for single node', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'A');
		expect(cohesionScore(G, ['a'])).toBe(1.0);
	});

	it('returns 1.0 for complete graph', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'A');
		addTestNode(G, 'b', 'B');
		addTestNode(G, 'c', 'C');
		addTestEdge(G, 'a', 'b');
		addTestEdge(G, 'a', 'c');
		addTestEdge(G, 'b', 'c');
		expect(cohesionScore(G, ['a', 'b', 'c'])).toBe(1.0);
	});

	it('returns 0.0 for disconnected nodes', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'A');
		addTestNode(G, 'b', 'B');
		expect(cohesionScore(G, ['a', 'b'])).toBe(0.0);
	});

	it('returns values in [0, 1] range', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const communities = cluster(G);
		for (const nodes of Object.values(communities)) {
			const score = cohesionScore(G, nodes);
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(1);
		}
	});
});

describe('scoreAll', () => {
	it('keys match community keys', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const communities = cluster(G);
		const scores = scoreAll(G, communities);
		expect(Object.keys(scores).sort()).toEqual(Object.keys(communities).sort());
	});
});
