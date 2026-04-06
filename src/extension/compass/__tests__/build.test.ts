import { describe, it, expect } from 'vitest';
import { buildFromExtraction, buildGraph } from '../build';
import { makeSimpleExtraction, loadFixtureExtraction } from './graph-helpers';

describe('buildFromExtraction', () => {
	it('builds graph with correct node count', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		expect(G.order).toBe(4);
	});

	it('builds graph with correct edge count', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		expect(G.size).toBe(4);
	});

	it('preserves node label attributes', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		expect(G.getNodeAttribute('transformer', 'label')).toBe('Transformer');
	});

	it('preserves edge confidence attributes', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const edgeKey = G.edge('attention', 'mechanism');
		expect(edgeKey).toBeTruthy();
		expect(G.getEdgeAttribute(edgeKey!, 'confidence')).toBe('INFERRED');
	});

	it('works with fixture extraction.json', () => {
		const extraction = loadFixtureExtraction();
		const G = buildFromExtraction(extraction);
		expect(G.order).toBeGreaterThan(0);
		expect(G.size).toBeGreaterThan(0);
	});
});

describe('buildGraph (multiple extractions)', () => {
	it('merges multiple extractions', () => {
		const ext1 = makeSimpleExtraction();
		const ext2 = {
			nodes: [
				{ id: 'extra', label: 'Extra', file_type: 'code' as const, source_file: 'extra.py', source_location: 'L1' },
			],
			edges: [],
		};
		const G = buildGraph([ext1, ext2]);
		expect(G.order).toBe(5);
	});
});
