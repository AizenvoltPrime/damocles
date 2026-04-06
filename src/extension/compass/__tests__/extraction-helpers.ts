import type { ExtractionResult, GraphNode, GraphEdge } from '../types';

export function labels(result: ExtractionResult): string[] {
	return result.nodes.map(n => n.label);
}

export function relations(result: ExtractionResult): string[] {
	return [...new Set(result.edges.map(e => e.relation))];
}

export function callPairs(result: ExtractionResult): Array<[string, string]> {
	return result.edges
		.filter(e => e.relation === 'calls')
		.map(e => [e.source, e.target] as [string, string]);
}

export function confidences(result: ExtractionResult): string[] {
	return [...new Set(result.edges.map(e => e.confidence))];
}

export function findNode(result: ExtractionResult, label: string): GraphNode | undefined {
	return result.nodes.find(n => n.label.toLowerCase().includes(label.toLowerCase()));
}

export function findEdge(result: ExtractionResult, source: string, target: string): GraphEdge | undefined {
	return result.edges.find(e => e.source === source && e.target === target);
}

export function edgesBetween(result: ExtractionResult, sourceId: string, targetId: string): GraphEdge[] {
	return result.edges.filter(e =>
		(e.source === sourceId && e.target === targetId) ||
		(e.source === targetId && e.target === sourceId)
	);
}

export function hasDanglingEdges(result: ExtractionResult): boolean {
	const nodeIds = new Set(result.nodes.map(n => n.id));
	return result.edges.some(e => {
		if (e.relation === 'imports' || e.relation === 'imports_from') return false;
		return !nodeIds.has(e.source) || !nodeIds.has(e.target);
	});
}
