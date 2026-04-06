import { describe, it, expect } from 'vitest';
import { buildFromExtraction } from '../build';
import { cluster, scoreAll } from '../cluster';
import { surprisingConnections } from '../analyze';
import { generateReport } from '../report';
import { createTestGraph, addTestNode, addTestEdge, makeSimpleExtraction } from './graph-helpers';
import type { ExtractionResult, DetectionResult, SurprisingConnection } from '../types';

function makeSemSimilarExtraction(): ExtractionResult {
	return {
		nodes: [
			{ id: 'encoder', label: 'Encoder', file_type: 'code', source_file: 'encoder.py', source_location: 'L1' },
			{ id: 'decoder', label: 'Decoder', file_type: 'code', source_file: 'decoder.py', source_location: 'L1' },
			{ id: 'helper', label: 'EncoderHelper', file_type: 'code', source_file: 'encoder.py', source_location: 'L50' },
			{ id: 'utils', label: 'DecoderUtils', file_type: 'code', source_file: 'decoder.py', source_location: 'L40' },
		],
		edges: [
			{ source: 'encoder', target: 'decoder', relation: 'semantically_similar_to', confidence: 'INFERRED', source_file: 'encoder.py', weight: 0.8, confidence_score: 0.85 },
			{ source: 'encoder', target: 'helper', relation: 'calls', confidence: 'EXTRACTED', source_file: 'encoder.py', weight: 1.0 },
			{ source: 'decoder', target: 'utils', relation: 'calls', confidence: 'EXTRACTED', source_file: 'decoder.py', weight: 1.0 },
		],
	};
}

describe('semantically_similar_to edges', () => {
	it('survive buildFromExtraction', () => {
		const extraction = makeSemSimilarExtraction();
		const G = buildFromExtraction(extraction);
		const edgeKey = G.edge('encoder', 'decoder');
		expect(edgeKey).toBeTruthy();
		expect(G.getEdgeAttribute(edgeKey!, 'relation')).toBe('semantically_similar_to');
	});

	it('confidence_score is preserved', () => {
		const extraction = makeSemSimilarExtraction();
		const G = buildFromExtraction(extraction);
		const edgeKey = G.edge('encoder', 'decoder')!;
		expect(G.getEdgeAttribute(edgeKey, 'confidence_score')).toBe(0.85);
	});

	it('score higher in surprising connections', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'Alpha', 'f1.py');
		addTestNode(G, 'b', 'Beta', 'f2.py');
		addTestNode(G, 'c', 'Gamma', 'f3.py');
		addTestNode(G, 'd', 'Delta', 'f4.py');
		addTestEdge(G, 'a', 'b', 'semantically_similar_to', 'INFERRED');
		addTestEdge(G, 'c', 'd', 'calls', 'INFERRED');

		const surprises = surprisingConnections(G);
		if (surprises.length >= 2) {
			const semIdx = surprises.findIndex(
				s => s.relation === 'semantically_similar_to',
			);
			const callIdx = surprises.findIndex(
				s => s.relation === 'calls',
			);
			expect(semIdx).toBeLessThan(callIdx);
		}
	});

	it('report renders [semantically similar] tag', () => {
		const extraction = makeSemSimilarExtraction();
		const G = buildFromExtraction(extraction);
		const communities = cluster(G);
		const cohesionScores = scoreAll(G, communities);
		const communityLabels: Record<number, string> = {};
		for (const cid of Object.keys(communities)) {
			communityLabels[Number(cid)] = `Group ${cid}`;
		}

		const surpriseList: SurprisingConnection[] = [{
			source: 'Encoder',
			target: 'Decoder',
			source_files: ['encoder.py', 'decoder.py'],
			confidence: 'INFERRED',
			relation: 'semantically_similar_to',
		}];

		const detection: DetectionResult = {
			files: { code: ['encoder.py', 'decoder.py'], document: [], paper: [], image: [] },
			total_files: 2,
			total_words: 3000,
			needs_graph: true,
			warning: null,
			skipped_sensitive: [],
		};

		const report = generateReport(
			G, communities, cohesionScores, communityLabels,
			[], surpriseList, detection,
			{ input: 100, output: 50 }, '/project',
		);

		expect(report).toContain('[semantically similar]');
	});

	it('semantically similar edge with AMBIGUOUS confidence is preserved', () => {
		const extraction: ExtractionResult = {
			nodes: [
				{ id: 'p', label: 'Parser', file_type: 'code', source_file: 'parse.py', source_location: 'L1' },
				{ id: 'l', label: 'Lexer', file_type: 'code', source_file: 'lex.py', source_location: 'L1' },
			],
			edges: [
				{ source: 'p', target: 'l', relation: 'semantically_similar_to', confidence: 'AMBIGUOUS', source_file: 'parse.py', weight: 0.4 },
			],
		};
		const G = buildFromExtraction(extraction);
		const edgeKey = G.edge('p', 'l')!;
		expect(G.getEdgeAttribute(edgeKey, 'relation')).toBe('semantically_similar_to');
		expect(G.getEdgeAttribute(edgeKey, 'confidence')).toBe('AMBIGUOUS');
	});

	it('works alongside normal edges in same extraction', () => {
		const extraction = makeSemSimilarExtraction();
		const G = buildFromExtraction(extraction);
		expect(G.size).toBe(3);
		const relations = new Set<string>();
		G.forEachEdge((_, attrs) => {
			relations.add(attrs.relation);
		});
		expect(relations.has('semantically_similar_to')).toBe(true);
		expect(relations.has('calls')).toBe(true);
	});

	it('semantic similarity edges participate in communities', () => {
		const extraction = makeSemSimilarExtraction();
		const G = buildFromExtraction(extraction);
		const communities = cluster(G);
		const allNodes = new Set<string>();
		for (const nodes of Object.values(communities)) {
			for (const n of nodes) allNodes.add(n);
		}
		expect(allNodes.has('encoder')).toBe(true);
		expect(allNodes.has('decoder')).toBe(true);
	});

	it('report does not tag non-semantic edges as similar', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const communities = cluster(G);
		const cohesionScores = scoreAll(G, communities);
		const communityLabels: Record<number, string> = {};
		for (const cid of Object.keys(communities)) {
			communityLabels[Number(cid)] = `Group ${cid}`;
		}

		const surpriseList: SurprisingConnection[] = [{
			source: 'Transformer',
			target: 'LayerNorm',
			source_files: ['model.py', 'model.py'],
			confidence: 'EXTRACTED',
			relation: 'contains',
		}];

		const detection: DetectionResult = {
			files: { code: ['model.py'], document: [], paper: [], image: [] },
			total_files: 1,
			total_words: 2000,
			needs_graph: true,
			warning: null,
			skipped_sensitive: [],
		};

		const report = generateReport(
			G, communities, cohesionScores, communityLabels,
			[], surpriseList, detection,
			{ input: 100, output: 50 }, '/project',
		);

		expect(report).not.toContain('[semantically similar]');
	});
});
