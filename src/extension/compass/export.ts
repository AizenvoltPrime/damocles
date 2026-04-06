import type { CompassGraph, CommunityMap } from './types';

interface JsonNode {
	id: string;
	label: string;
	file_type: string;
	source_file: string;
	source_location: string;
	community: number | undefined;
	[key: string]: unknown;
}

interface JsonEdge {
	source: string;
	target: string;
	relation: string;
	confidence: string;
	confidence_score: number | undefined;
	weight: number | undefined;
	[key: string]: unknown;
}

interface GraphJson {
	nodes: JsonNode[];
	links: JsonEdge[];
}

export function toJson(G: CompassGraph, communities: CommunityMap): GraphJson {
	const nodeCommunity = new Map<string, number>();
	for (const [cid, nodes] of Object.entries(communities)) {
		for (const n of nodes) nodeCommunity.set(n, Number(cid));
	}

	const nodes: JsonNode[] = [];
	G.forEachNode((nodeId, attrs) => {
		nodes.push({
			id: nodeId,
			label: attrs.label ?? nodeId,
			file_type: attrs.file_type ?? '',
			source_file: attrs.source_file ?? '',
			source_location: attrs.source_location ?? '',
			community: nodeCommunity.get(nodeId),
		});
	});

	const links: JsonEdge[] = [];
	G.forEachEdge((_, attrs, source, target) => {
		links.push({
			source,
			target,
			relation: attrs.relation ?? '',
			confidence: attrs.confidence ?? 'EXTRACTED',
			confidence_score: attrs.confidence_score,
			weight: attrs.weight,
		});
	});

	return { nodes, links };
}

export function toJsonString(G: CompassGraph, communities: CommunityMap): string {
	return JSON.stringify(toJson(G, communities), null, 2);
}
