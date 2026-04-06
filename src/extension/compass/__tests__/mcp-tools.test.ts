import { describe, it, expect } from 'vitest';
import {
	communitiesFromGraph,
	scoreNodes,
	bfs,
	dfs,
	subgraphToText,
	queryGraph,
	getNodeInfo,
	getNeighbors,
	shortestPath,
} from '../query';
import { buildFromExtraction } from '../build';
import { createTestGraph, addTestNode, addTestEdge, makeSimpleExtraction } from './graph-helpers';

describe('communitiesFromGraph', () => {
	it('extracts community attribute from nodes', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'A');
		addTestNode(G, 'b', 'B');
		G.setNodeAttribute('a', 'community', 0);
		G.setNodeAttribute('b', 'community', 0);
		const communities = communitiesFromGraph(G);
		expect(communities[0]).toContain('a');
		expect(communities[0]).toContain('b');
	});

	it('returns {} if nodes lack community attr', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'A');
		addTestNode(G, 'b', 'B');
		const communities = communitiesFromGraph(G);
		expect(communities).toEqual({});
	});
});

describe('scoreNodes', () => {
	it('exact label match scores highest', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'transformer');
		addTestNode(G, 'b', 'attention');
		addTestNode(G, 'c', 'layernorm');
		const scored = scoreNodes(G, ['transformer']);
		expect(scored.length).toBeGreaterThan(0);
		expect(scored[0][1]).toBe('a');
	});

	it('no match returns empty', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'Alpha');
		const scored = scoreNodes(G, ['zzzznotfound']);
		expect(scored).toEqual([]);
	});

	it('partial source file match scores 0.5', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'MyClass', 'special_file.py');
		const scored = scoreNodes(G, ['special_file']);
		expect(scored.length).toBe(1);
		expect(scored[0][0]).toBe(0.5);
	});
});

describe('bfs', () => {
	it('respects depth limit', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'A');
		addTestNode(G, 'b', 'B');
		addTestNode(G, 'c', 'C');
		addTestNode(G, 'd', 'D');
		addTestEdge(G, 'a', 'b');
		addTestEdge(G, 'b', 'c');
		addTestEdge(G, 'c', 'd');
		const { visited } = bfs(G, ['a'], 1);
		expect(visited.has('a')).toBe(true);
		expect(visited.has('b')).toBe(true);
		expect(visited.has('c')).toBe(false);
		expect(visited.has('d')).toBe(false);
	});
});

describe('dfs', () => {
	it('covers chain at depth=5', () => {
		const G = createTestGraph();
		const ids = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
		for (const id of ids) addTestNode(G, id, id);
		for (let i = 0; i < ids.length - 1; i++) addTestEdge(G, ids[i], ids[i + 1]);
		const { visited } = dfs(G, ['n0'], 5);
		expect(visited.size).toBe(6);
	});
});

describe('subgraphToText', () => {
	it('contains labels and relations', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'Alpha');
		addTestNode(G, 'b', 'Beta');
		addTestEdge(G, 'a', 'b', 'calls');
		const nodes = new Set(['a', 'b']);
		const edges: Array<[string, string]> = [['a', 'b']];
		const text = subgraphToText(G, nodes, edges);
		expect(text).toContain('Alpha');
		expect(text).toContain('Beta');
		expect(text).toContain('calls');
	});

	it('truncates on small token_budget', () => {
		const G = createTestGraph();
		for (let i = 0; i < 20; i++) {
			addTestNode(G, `n${i}`, `VeryLongNodeName_${i}_SomeExtraText`);
		}
		for (let i = 0; i < 19; i++) {
			addTestEdge(G, `n${i}`, `n${i + 1}`, 'calls');
		}
		const nodes = new Set(Array.from({ length: 20 }, (_, i) => `n${i}`));
		const edges: Array<[string, string]> = Array.from({ length: 19 }, (_, i) => [`n${i}`, `n${i + 1}`] as [string, string]);
		const text = subgraphToText(G, nodes, edges, 5);
		expect(text).toContain('truncated');
	});

	it('contains "EDGE" and "NODE" prefixes', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'Alpha');
		addTestNode(G, 'b', 'Beta');
		addTestEdge(G, 'a', 'b', 'uses');
		const nodes = new Set(['a', 'b']);
		const edges: Array<[string, string]> = [['a', 'b']];
		const text = subgraphToText(G, nodes, edges);
		expect(text).toContain('NODE');
		expect(text).toContain('EDGE');
	});
});

describe('queryGraph', () => {
	it('returns QueryResult structure', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const result = queryGraph(G, 'Transformer attention');
		expect(result).toHaveProperty('header');
		expect(result).toHaveProperty('text');
		expect(result).toHaveProperty('nodeCount');
	});
});

describe('getNodeInfo', () => {
	it('returns node details', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const info = getNodeInfo(G, 'Transformer');
		expect(info).toContain('Transformer');
		expect(info).toContain('model.py');
	});
});

describe('getNeighbors', () => {
	it('returns neighbor list', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const neighbors = getNeighbors(G, 'Transformer');
		expect(neighbors).toContain('Neighbors of');
		expect(neighbors).toContain('-->');
	});
});

describe('shortestPath', () => {
	it('finds a path', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const result = shortestPath(G, 'Transformer', 'attention mechanism');
		expect(typeof result).not.toBe('string');
		if (typeof result !== 'string') {
			expect(result.hops).toBeGreaterThan(0);
			expect(result.segments.length).toBeGreaterThan(0);
			expect(result.text).toContain('Shortest path');
		}
	});
});
