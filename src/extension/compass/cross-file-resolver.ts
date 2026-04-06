import type { ExtractionResult, GraphEdge } from './types';

interface FileIndex {
	stem: string;
	entities: Map<string, string>;
}

export function resolveCrossFileImports(extractions: ExtractionResult[]): ExtractionResult[] {
	const fileIndices: FileIndex[] = [];

	for (const ext of extractions) {
		const entityMap = new Map<string, string>();
		let stem = '';

		for (const node of ext.nodes) {
			if (!stem && node.source_file) {
				const parts = node.source_file.replace(/\\/g, '/').split('/');
				const filename = parts[parts.length - 1] ?? '';
				stem = filename.replace(/\.[^.]+$/, '');
			}

			const label = node.label;
			if (!label.endsWith('()') && !label.startsWith('.') && node.source_file) {
				entityMap.set(label.toLowerCase(), node.id);
			}
		}

		if (stem) {
			fileIndices.push({ stem, entities: entityMap });
		}
	}

	for (const ext of extractions) {
		const importEdges = ext.edges.filter(
			e => e.relation === 'imports_from' || e.relation === 'imports'
		);

		const localNames = new Set(
			ext.nodes
				.filter(n => n.source_file)
				.map(n => n.label.replace(/[()]/g, '').replace(/^\./, '').toLowerCase())
		);

		for (const edge of importEdges) {
			const targetStem = edge.target.toLowerCase();
			const matchingFile = fileIndices.find(fi => fi.stem.toLowerCase() === targetStem);
			if (!matchingFile) continue;

			const fileNode = ext.nodes.find(n =>
				!n.label.endsWith('()') && !n.label.startsWith('.') && n.source_file
			);
			if (!fileNode) continue;

			for (const [entityName, entityId] of matchingFile.entities) {
				if (fileNode.id === entityId) continue;
				if (!localNames.has(entityName)) continue;

				const newEdge: GraphEdge = {
					source: fileNode.id,
					target: entityId,
					relation: 'uses',
					confidence: 'INFERRED',
					source_file: fileNode.source_file,
					weight: 0.6,
				};
				ext.edges.push(newEdge);
			}
		}
	}

	return extractions;
}
