import Graph from 'graphology';
import type { ExtractionResult, CompassGraph, GraphNodeAttributes, GraphEdgeAttributes } from './types';
import { validateExtraction } from './validate';

export function buildFromExtraction(extraction: ExtractionResult): CompassGraph {
	const errors = validateExtraction(extraction);
	const realErrors = errors.filter(e => !e.includes('does not match any node id'));
	if (realErrors.length > 0) {
		console.warn(`[Compass] Extraction warning (${realErrors.length} issues): ${realErrors[0]}`);
	}

	const G: CompassGraph = new Graph({ type: 'undirected' });

	for (const node of extraction.nodes) {
		const { id, ...attrs } = node;
		G.mergeNode(id, attrs as GraphNodeAttributes);
	}

	const nodeSet = new Set(G.nodes());

	for (const edge of extraction.edges) {
		const { source, target, ...rest } = edge;
		if (!nodeSet.has(source) || !nodeSet.has(target)) continue;

		const attrs: GraphEdgeAttributes = {
			...rest,
			_src: source,
			_tgt: target,
		};
		G.mergeEdge(source, target, attrs);
	}

	return G;
}

export function buildGraph(extractions: ExtractionResult[]): CompassGraph {
	const combined: ExtractionResult = { nodes: [], edges: [] };
	for (const ext of extractions) {
		combined.nodes.push(...ext.nodes);
		combined.edges.push(...ext.edges);
	}
	return buildFromExtraction(combined);
}
