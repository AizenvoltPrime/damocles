import louvain from 'graphology-communities-louvain';
import type { CompassGraph, CommunityMap, CohesionScores } from './types';

const MAX_COMMUNITY_FRACTION = 0.25;
const MIN_SPLIT_SIZE = 10;

export function cluster(G: CompassGraph): CommunityMap {
	if (G.order === 0) return {};
	if (G.size === 0) {
		const nodes = G.nodes().sort();
		const result: CommunityMap = {};
		nodes.forEach((n, i) => { result[i] = [n]; });
		return result;
	}

	const communityAttr = louvain(G);

	const raw: Record<number, string[]> = {};
	for (const [nodeId, cid] of Object.entries(communityAttr)) {
		const group = raw[cid] ?? (raw[cid] = []);
		group.push(nodeId);
	}

	const maxSize = Math.max(MIN_SPLIT_SIZE, Math.floor(G.order * MAX_COMMUNITY_FRACTION));
	const finalCommunities: string[][] = [];

	for (const nodes of Object.values(raw)) {
		if (nodes.length > maxSize) {
			finalCommunities.push(...splitCommunity(G, nodes));
		} else {
			finalCommunities.push(nodes);
		}
	}

	finalCommunities.sort((a, b) => b.length - a.length);

	const result: CommunityMap = {};
	for (let i = 0; i < finalCommunities.length; i++) {
		result[i] = finalCommunities[i]!.sort();
	}
	return result;
}

function splitCommunity(G: CompassGraph, nodes: string[]): string[][] {
	const subNodes = new Set(nodes);
	let hasEdges = false;

	for (const node of nodes) {
		if (hasEdges) break;
		G.forEachNeighbor(node, neighbor => {
			if (!hasEdges && subNodes.has(neighbor)) hasEdges = true;
		});
	}

	if (!hasEdges) {
		return nodes.sort().map(n => [n]);
	}

	try {
		const Graph = G.constructor as new (opts: { type: string }) => CompassGraph;
		const subGraph = new Graph({ type: 'undirected' });
		for (const node of nodes) {
			subGraph.addNode(node, G.getNodeAttributes(node));
		}
		for (const node of nodes) {
			G.forEachEdge(node, (_edge, attrs, source, target) => {
				if (subNodes.has(source) && subNodes.has(target) && !subGraph.hasEdge(source, target)) {
					subGraph.mergeEdge(source, target, attrs);
				}
			});
		}

		const subCommunities = louvain(subGraph);
		const groups: Record<number, string[]> = {};
		for (const [nodeId, cid] of Object.entries(subCommunities)) {
			if (!groups[cid]) groups[cid] = [];
			groups[cid].push(nodeId);
		}

		const values = Object.values(groups);
		if (values.length <= 1) return [nodes.sort()];
		return values.map(v => v.sort());
	} catch {
		return [nodes.sort()];
	}
}

export function cohesionScore(G: CompassGraph, communityNodes: string[]): number {
	const n = communityNodes.length;
	if (n <= 1) return 1.0;

	const nodeSet = new Set(communityNodes);
	let actual = 0;

	for (const node of communityNodes) {
		G.forEachNeighbor(node, neighbor => {
			if (nodeSet.has(neighbor)) actual++;
		});
	}
	actual = Math.floor(actual / 2);

	const possible = (n * (n - 1)) / 2;
	return possible > 0 ? Math.round((actual / possible) * 100) / 100 : 0.0;
}

export function scoreAll(G: CompassGraph, communities: CommunityMap): CohesionScores {
	const scores: CohesionScores = {};
	for (const [cid, nodes] of Object.entries(communities)) {
		scores[Number(cid)] = cohesionScore(G, nodes);
	}
	return scores;
}
