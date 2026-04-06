import Graph from 'graphology';
import type { CompassGraph, GraphNodeAttributes, GraphEdgeAttributes, ExtractionResult, Confidence, EntityKind } from '../types';

export function createTestGraph(): CompassGraph {
	return new Graph({ type: 'undirected' });
}

export function addTestNode(
	G: CompassGraph,
	id: string,
	label: string,
	sourceFile = 'test.py',
	fileType = 'code',
	kind?: EntityKind,
): void {
	G.addNode(id, {
		label,
		file_type: fileType,
		source_file: sourceFile,
		source_location: 'L1',
		...(kind ? { kind } : {}),
	} as GraphNodeAttributes);
}

export function addTestEdge(
	G: CompassGraph,
	source: string,
	target: string,
	relation = 'calls',
	confidence: Confidence = 'EXTRACTED',
): void {
	G.mergeEdge(source, target, {
		relation,
		confidence,
		source_file: 'test.py',
		_src: source,
		_tgt: target,
		weight: confidence === 'INFERRED' ? 0.8 : 1.0,
	} as GraphEdgeAttributes);
}

export function makeSimpleExtraction(overrides?: Partial<ExtractionResult>): ExtractionResult {
	return {
		nodes: [
			{ id: 'transformer', label: 'Transformer', file_type: 'code', source_file: 'model.py', source_location: 'L1', kind: 'class' },
			{ id: 'attention', label: 'MultiHeadAttention', file_type: 'code', source_file: 'model.py', source_location: 'L10', kind: 'class' },
			{ id: 'layernorm', label: 'LayerNorm', file_type: 'code', source_file: 'model.py', source_location: 'L20', kind: 'class' },
			{ id: 'mechanism', label: 'attention mechanism', file_type: 'code', source_file: 'docs.md', source_location: 'L1', kind: 'type' },
		],
		edges: [
			{ source: 'transformer', target: 'attention', relation: 'contains', confidence: 'EXTRACTED', source_file: 'model.py', weight: 1.0 },
			{ source: 'transformer', target: 'layernorm', relation: 'contains', confidence: 'EXTRACTED', source_file: 'model.py', weight: 1.0 },
			{ source: 'attention', target: 'mechanism', relation: 'implements', confidence: 'INFERRED', source_file: 'model.py', weight: 0.8 },
			{ source: 'layernorm', target: 'mechanism', relation: 'uses', confidence: 'AMBIGUOUS', source_file: 'model.py', weight: 0.5 },
		],
		...overrides,
	};
}

export function loadFixtureExtraction(): ExtractionResult {
	return require('./fixtures/extraction.json') as ExtractionResult;
}
