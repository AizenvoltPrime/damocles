import { describe, it, expect } from 'vitest';
import { buildFromExtraction } from '../build';
import { toJson } from '../export';
import { cluster } from '../cluster';
import { makeSimpleExtraction } from './graph-helpers';
import type { ExtractionResult } from '../types';

describe('confidence through build/export pipeline', () => {
	it('EXTRACTED edges have confidence_score defaulting to 1.0', () => {
		const extraction: ExtractionResult = {
			nodes: [
				{ id: 'a', label: 'A', file_type: 'code', source_file: 'f.py', source_location: 'L1' },
				{ id: 'b', label: 'B', file_type: 'code', source_file: 'f.py', source_location: 'L2' },
			],
			edges: [
				{ source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED', source_file: 'f.py', weight: 1.0, confidence_score: 1.0 },
			],
		};
		const G = buildFromExtraction(extraction);
		const edgeKey = G.edge('a', 'b')!;
		expect(G.getEdgeAttribute(edgeKey, 'confidence_score')).toBe(1.0);
	});

	it('INFERRED edges have confidence_score in [0, 1]', () => {
		const extraction: ExtractionResult = {
			nodes: [
				{ id: 'a', label: 'A', file_type: 'code', source_file: 'f.py', source_location: 'L1' },
				{ id: 'b', label: 'B', file_type: 'code', source_file: 'f.py', source_location: 'L2' },
			],
			edges: [
				{ source: 'a', target: 'b', relation: 'calls', confidence: 'INFERRED', source_file: 'f.py', weight: 0.8, confidence_score: 0.75 },
			],
		};
		const G = buildFromExtraction(extraction);
		const edgeKey = G.edge('a', 'b')!;
		const score = G.getEdgeAttribute(edgeKey, 'confidence_score');
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	it('AMBIGUOUS edges have confidence_score <= 0.4', () => {
		const extraction: ExtractionResult = {
			nodes: [
				{ id: 'a', label: 'A', file_type: 'code', source_file: 'f.py', source_location: 'L1' },
				{ id: 'b', label: 'B', file_type: 'code', source_file: 'f.py', source_location: 'L2' },
			],
			edges: [
				{ source: 'a', target: 'b', relation: 'calls', confidence: 'AMBIGUOUS', source_file: 'f.py', weight: 0.3, confidence_score: 0.3 },
			],
		};
		const G = buildFromExtraction(extraction);
		const edgeKey = G.edge('a', 'b')!;
		const score = G.getEdgeAttribute(edgeKey, 'confidence_score');
		expect(score).toBeLessThanOrEqual(0.4);
	});

	it('confidence survives build -> export roundtrip', () => {
		const extraction: ExtractionResult = {
			nodes: [
				{ id: 'a', label: 'A', file_type: 'code', source_file: 'f.py', source_location: 'L1' },
				{ id: 'b', label: 'B', file_type: 'code', source_file: 'f.py', source_location: 'L2' },
			],
			edges: [
				{ source: 'a', target: 'b', relation: 'calls', confidence: 'INFERRED', source_file: 'f.py', weight: 0.8, confidence_score: 0.65 },
			],
		};
		const G = buildFromExtraction(extraction);
		const communities = cluster(G);
		const json = toJson(G, communities);
		const link = json.links.find(l => l.source === 'a' && l.target === 'b');
		expect(link).toBeTruthy();
		expect(link!.confidence_score).toBe(0.65);
		expect(link!.confidence).toBe('INFERRED');
	});

	it('toJson defaults: EXTRACTED edges preserve confidence_score', () => {
		const extraction: ExtractionResult = {
			nodes: [
				{ id: 'x', label: 'X', file_type: 'code', source_file: 'f.py', source_location: 'L1' },
				{ id: 'y', label: 'Y', file_type: 'code', source_file: 'f.py', source_location: 'L2' },
			],
			edges: [
				{ source: 'x', target: 'y', relation: 'calls', confidence: 'EXTRACTED', source_file: 'f.py', weight: 1.0, confidence_score: 1.0 },
			],
		};
		const G = buildFromExtraction(extraction);
		const json = toJson(G, {});
		const link = json.links[0];
		expect(link.confidence).toBe('EXTRACTED');
		expect(link.confidence_score).toBe(1.0);
	});

	it('multiple confidence types in same graph work', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const communities = cluster(G);
		const json = toJson(G, communities);

		const confidences = new Set(json.links.map(l => l.confidence));
		expect(confidences.has('EXTRACTED')).toBe(true);
		expect(confidences.has('INFERRED')).toBe(true);
		expect(confidences.has('AMBIGUOUS')).toBe(true);
	});

	it('edges without explicit confidence_score still have confidence string', () => {
		const extraction: ExtractionResult = {
			nodes: [
				{ id: 'a', label: 'A', file_type: 'code', source_file: 'f.py', source_location: 'L1' },
				{ id: 'b', label: 'B', file_type: 'code', source_file: 'f.py', source_location: 'L2' },
			],
			edges: [
				{ source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED', source_file: 'f.py', weight: 1.0 },
			],
		};
		const G = buildFromExtraction(extraction);
		const edgeKey = G.edge('a', 'b')!;
		expect(G.getEdgeAttribute(edgeKey, 'confidence')).toBe('EXTRACTED');
	});
});
