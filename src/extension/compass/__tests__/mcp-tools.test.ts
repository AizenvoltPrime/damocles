import { describe, it, expect } from 'vitest';
import {
	communitiesFromGraph,
	scoreNodes,
	bfs,
	searchEntities,
	inspectNode,
	graphOverview,
	tracePath,
} from '../query';
import { buildFromExtraction } from '../build';
import { createTestGraph, addTestNode, addTestEdge, makeSimpleExtraction } from './graph-helpers';
import type { GodNode } from '../types';

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

	it('partial source file match scores > 0', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'MyClass', 'special_file.py');
		const scored = scoreNodes(G, ['special_file']);
		expect(scored.length).toBe(1);
		expect(scored[0][0]).toBeGreaterThan(0);
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

function stubGodNodes(G: import('graphology').default, topN: number): GodNode[] {
	const degrees: Array<[string, number]> = [];
	G.forEachNode(nid => { degrees.push([nid, G.degree(nid)]); });
	degrees.sort((a, b) => b[1] - a[1]);
	return degrees.slice(0, topN).map(([nid, deg]) => ({
		id: nid, label: G.getNodeAttribute(nid, 'label') ?? nid, edges: deg,
	}));
}

describe('searchEntities', () => {
	it('returns ranked results with neighbor previews', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const result = searchEntities(G, 'Transformer');
		expect(result).toContain('Transformer');
		expect(result).toContain('model.py');
		expect(result).toContain('Found');
	});

	it('filters by kind', () => {
		const G = createTestGraph();
		addTestNode(G, 'cls', 'UserService', 'service.ts', 'code', 'class');
		addTestNode(G, 'fn', 'getUserData', 'utils.ts', 'code', 'function');

		const classOnly = searchEntities(G, 'user', 'class');
		expect(classOnly).toContain('UserService');
		expect(classOnly).not.toMatch(/^\d+\.\s+getUserData/m);

		const funcOnly = searchEntities(G, 'user', 'function');
		expect(funcOnly).toContain('getUserData');
		expect(funcOnly).not.toMatch(/^\d+\.\s+UserService/m);
	});

	it('returns no-match message for unknown query', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'Alpha');
		const result = searchEntities(G, 'zzzznotfound');
		expect(result).toContain('No entities matching');
	});

	it('respects limit parameter', () => {
		const G = createTestGraph();
		for (let i = 0; i < 10; i++) {
			addTestNode(G, `svc${i}`, `Service${i}`, `file${i}.ts`, 'code', 'class');
		}
		const result = searchEntities(G, 'Service', undefined, 3);
		const matches = result.match(/^\d+\./gm);
		expect(matches?.length).toBeLessThanOrEqual(3);
	});

	it('shows outgoing and incoming neighbor labels', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'AuthService', 'auth.ts', 'code', 'class');
		addTestNode(G, 'b', 'UserRepo', 'repo.ts', 'code', 'class');
		addTestNode(G, 'c', 'Controller', 'ctrl.ts', 'code', 'class');
		addTestEdge(G, 'a', 'b', 'calls');
		addTestEdge(G, 'c', 'a', 'calls');

		const result = searchEntities(G, 'AuthService');
		expect(result).toContain('calls→');
		expect(result).toContain('UserRepo');
	});
});

describe('inspectNode', () => {
	it('returns full node details at depth 1', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const result = inspectNode(G, 'Transformer');
		expect(result).toContain('Transformer');
		expect(result).toContain('model.py');
		expect(result).toContain('Outgoing');
		expect(result).toContain('Incoming');
	});

	it('filters by relation type', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'ClassA', 'a.ts');
		addTestNode(G, 'b', 'ClassB', 'b.ts');
		addTestNode(G, 'c', 'ModuleC', 'c.ts');
		addTestEdge(G, 'a', 'b', 'calls');
		addTestEdge(G, 'a', 'c', 'imports');

		const callsOnly = inspectNode(G, 'ClassA', 'calls');
		expect(callsOnly).toContain('ClassB');
		expect(callsOnly).not.toContain('ModuleC');
	});

	it('returns not-found for unknown label', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'Alpha');
		const result = inspectNode(G, 'zzzznotfound');
		expect(result).toContain('No node matching');
	});

	it('supports depth=2 with expanded neighborhood', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'Alpha', 'a.ts');
		addTestNode(G, 'b', 'Beta', 'b.ts');
		addTestNode(G, 'c', 'Gamma', 'c.ts');
		addTestEdge(G, 'a', 'b', 'calls');
		addTestEdge(G, 'b', 'c', 'calls');

		const result = inspectNode(G, 'Alpha', undefined, 2);
		expect(result).toContain('Alpha');
		expect(result).toContain('Depth-2 neighbors');
		expect(result).toContain('Gamma');
	});
});

describe('graphOverview', () => {
	it('returns summary with stats and hubs', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const communities = communitiesFromGraph(G);

		const result = graphOverview(G, communities, 'summary', stubGodNodes);
		expect(result).toContain('Workspace Graph:');
		expect(result).toContain('Nodes:');
		expect(result).toContain('Edges:');
	});

	it('returns hub list', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const communities = communitiesFromGraph(G);

		const result = graphOverview(G, communities, 'hubs', stubGodNodes, undefined, 5);
		expect(result).toContain('hub entities');
	});

	it('returns community members grouped by file', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'ClassA', 'src/a.ts', 'code', 'class');
		addTestNode(G, 'b', 'ClassB', 'src/a.ts', 'code', 'class');
		addTestNode(G, 'c', 'ClassC', 'src/b.ts', 'code', 'class');
		G.setNodeAttribute('a', 'community', 0);
		G.setNodeAttribute('b', 'community', 0);
		G.setNodeAttribute('c', 'community', 0);

		const communities = communitiesFromGraph(G);
		const result = graphOverview(G, communities, 'community', stubGodNodes, 0);
		expect(result).toContain('Community 0');
		expect(result).toContain('src/a.ts:');
		expect(result).toContain('ClassA');
		expect(result).toContain('[class]');
	});

	it('returns error for missing community_id', () => {
		const G = createTestGraph();
		const result = graphOverview(G, {}, 'community', stubGodNodes);
		expect(result).toContain('community_id is required');
	});
});

describe('tracePath', () => {
	it('finds shortest path between entities', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const result = tracePath(G, 'Transformer', 'attention mechanism');
		expect(result).toContain('Shortest path');
		expect(result).toContain('hops');
	});

	it('returns no-match for unknown source', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'Alpha');
		const result = tracePath(G, 'zzzznotfound', 'Alpha');
		expect(result).toContain('No node matching source');
	});

	it('returns no-match for unknown target', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'Alpha');
		const result = tracePath(G, 'Alpha', 'zzzznotfound');
		expect(result).toContain('No node matching target');
	});

	it('respects max_hops limit', () => {
		const G = createTestGraph();
		const labels = ['AlphaNode', 'BetaNode', 'GammaNode', 'DeltaNode', 'EpsilonNode'];
		for (let i = 0; i < labels.length; i++) addTestNode(G, `hop${i}`, labels[i]!);
		for (let i = 0; i < labels.length - 1; i++) addTestEdge(G, `hop${i}`, `hop${i + 1}`);

		const result = tracePath(G, 'AlphaNode', 'EpsilonNode', 2);
		expect(result).toContain('exceeds max_hops');
	});
});
