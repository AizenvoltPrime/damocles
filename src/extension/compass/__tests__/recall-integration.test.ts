import { describe, it, expect } from 'vitest';
import { buildFromExtraction } from '../build';
import { scoreNodes } from '../query';
import { createTestGraph, addTestNode, addTestEdge, makeSimpleExtraction } from './graph-helpers';
import type { CompassGraph } from '../types';

interface CompassTermProvider {
	getGraphTerms(queryTerms: string[]): string[];
}

function createMockProvider(graph: CompassGraph): CompassTermProvider {
	return {
		getGraphTerms(queryTerms: string[]): string[] {
			const scored = scoreNodes(graph, queryTerms);
			const terms = new Set<string>();
			for (const [, nid] of scored.slice(0, 5)) {
				const label = graph.getNodeAttribute(nid, 'label') ?? '';
				if (label) {
					const parts = label.replace(/[()]/g, '').replace(/\./g, ' ').split(/\s+/);
					for (const p of parts) {
						if (p.length > 2) terms.add(p.toLowerCase());
					}
				}
			}
			return [...terms];
		},
	};
}

describe('CompassTermProvider interface', () => {
	it('creates a mock provider that returns graph terms', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const provider = createMockProvider(G);
		const terms = provider.getGraphTerms(['transformer']);
		expect(Array.isArray(terms)).toBe(true);
		expect(terms.length).toBeGreaterThan(0);
	});

	it('returned terms are string arrays', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const provider = createMockProvider(G);
		const terms = provider.getGraphTerms(['attention']);
		for (const term of terms) {
			expect(typeof term).toBe('string');
		}
	});

	it('empty graph returns empty terms', () => {
		const G = createTestGraph();
		const provider = createMockProvider(G);
		const terms = provider.getGraphTerms(['anything']);
		expect(terms).toEqual([]);
	});

	it('graph with nodes returns relevant terms', () => {
		const G = createTestGraph();
		addTestNode(G, 'svc', 'AuthService', 'auth.py');
		addTestNode(G, 'ctrl', 'AuthController', 'auth.py');
		addTestEdge(G, 'svc', 'ctrl', 'calls');
		const provider = createMockProvider(G);
		const terms = provider.getGraphTerms(['auth']);
		expect(terms.length).toBeGreaterThan(0);
		const joined = terms.join(' ');
		expect(joined.toLowerCase()).toContain('auth');
	});

	it('provider ignores unmatched query terms', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const provider = createMockProvider(G);
		const terms = provider.getGraphTerms(['zzz_no_match_zzz']);
		expect(terms).toEqual([]);
	});
});
