import type { CompassGraph, CommunityMap, QueryResult, PathResult } from './types';
import { sanitizeLabel } from './sanitize';

export function communitiesFromGraph(G: CompassGraph): CommunityMap {
	const communities: CommunityMap = {};
	G.forEachNode((nodeId, attrs) => {
		const cid = attrs.community;
		if (cid !== undefined && cid !== null) {
			if (!communities[cid]) communities[cid] = [];
			communities[cid].push(nodeId);
		}
	});
	return communities;
}

export function scoreNodes(G: CompassGraph, terms: string[]): Array<[number, string]> {
	const scored: Array<[number, string]> = [];
	G.forEachNode((nid, data) => {
		const label = (data.label ?? '').toLowerCase();
		const source = (data.source_file ?? '').toLowerCase();
		let score = 0;
		for (const t of terms) {
			if (label.includes(t)) score += 1;
			if (source.includes(t)) score += 0.5;
		}
		if (score > 0) scored.push([score, nid]);
	});
	return scored.sort((a, b) => b[0] - a[0]);
}

export function bfs(
	G: CompassGraph,
	startNodes: string[],
	depth: number,
): { visited: Set<string>; edges: Array<[string, string]> } {
	const visited = new Set(startNodes);
	let frontier = new Set(startNodes);
	const edges: Array<[string, string]> = [];

	for (let i = 0; i < depth; i++) {
		const nextFrontier = new Set<string>();
		for (const n of frontier) {
			G.forEachNeighbor(n, neighbor => {
				if (!visited.has(neighbor)) {
					nextFrontier.add(neighbor);
					edges.push([n, neighbor]);
				}
			});
		}
		for (const n of nextFrontier) visited.add(n);
		frontier = nextFrontier;
	}

	return { visited, edges };
}

export function dfs(
	G: CompassGraph,
	startNodes: string[],
	depth: number,
): { visited: Set<string>; edges: Array<[string, string]> } {
	const visited = new Set<string>();
	const edges: Array<[string, string]> = [];
	const stack: Array<[string, number]> = [];

	for (let i = startNodes.length - 1; i >= 0; i--) {
		stack.push([startNodes[i]!, 0]);
	}

	while (stack.length > 0) {
		const [node, d] = stack.pop()!;
		if (visited.has(node) || d > depth) continue;
		visited.add(node);
		G.forEachNeighbor(node, neighbor => {
			if (!visited.has(neighbor)) {
				stack.push([neighbor, d + 1]);
				edges.push([node, neighbor]);
			}
		});
	}

	return { visited, edges };
}

export function subgraphToText(
	G: CompassGraph,
	nodes: Set<string>,
	edges: Array<[string, string]>,
	tokenBudget = 2000,
): string {
	const charBudget = tokenBudget * 4;
	const lines: string[] = [];

	const sortedNodes = [...nodes].sort((a, b) => G.degree(b) - G.degree(a));
	for (const nid of sortedNodes) {
		const d = G.getNodeAttributes(nid);
		lines.push(
			`NODE ${sanitizeLabel(d.label ?? nid)} [src=${d.source_file ?? ''} loc=${d.source_location ?? ''} community=${d.community ?? ''}]`
		);
	}

	for (const [u, v] of edges) {
		if (nodes.has(u) && nodes.has(v)) {
			const edgeKey = G.edge(u, v);
			if (!edgeKey) continue;
			const d = G.getEdgeAttributes(edgeKey);
			lines.push(
				`EDGE ${sanitizeLabel(G.getNodeAttribute(u, 'label') ?? u)} --${d.relation ?? ''} [${d.confidence ?? ''}]--> ${sanitizeLabel(G.getNodeAttribute(v, 'label') ?? v)}`
			);
		}
	}

	let output = lines.join('\n');
	if (output.length > charBudget) {
		output = output.slice(0, charBudget) + `\n... (truncated to ~${tokenBudget} token budget)`;
	}
	return output;
}

export function findNode(G: CompassGraph, label: string): string[] {
	const term = label.toLowerCase();
	const results: string[] = [];
	G.forEachNode((nid, d) => {
		if (term === nid.toLowerCase() || (d.label ?? '').toLowerCase().includes(term)) {
			results.push(nid);
		}
	});
	return results;
}

export function queryGraph(
	G: CompassGraph,
	question: string,
	mode: 'bfs' | 'dfs' = 'bfs',
	depth = 3,
	tokenBudget = 2000,
): QueryResult {
	depth = Math.min(depth, 6);
	const terms = question.split(/\s+/).filter(t => t.length > 2).map(t => t.toLowerCase());
	const scored = scoreNodes(G, terms);
	const startNodes = scored.slice(0, 3).map(([, nid]) => nid);

	if (startNodes.length === 0) {
		return { header: 'No matching nodes found.', text: '', nodeCount: 0 };
	}

	const { visited, edges } = mode === 'dfs'
		? dfs(G, startNodes, depth)
		: bfs(G, startNodes, depth);

	const startLabels = startNodes.map(n => G.getNodeAttribute(n, 'label') ?? n);
	const header = `Traversal: ${mode.toUpperCase()} depth=${depth} | Start: [${startLabels.join(', ')}] | ${visited.size} nodes found`;
	const text = subgraphToText(G, visited, edges, tokenBudget);

	return { header, text, nodeCount: visited.size };
}

export function getNodeInfo(G: CompassGraph, label: string): string {
	const matches = findNode(G, label);
	if (matches.length === 0) return `No node matching '${label}' found.`;

	const nid = matches[0];
	const d = G.getNodeAttributes(nid);
	return [
		`Node: ${d.label ?? nid}`,
		`  ID: ${nid}`,
		`  Source: ${d.source_file ?? ''} ${d.source_location ?? ''}`,
		`  Type: ${d.file_type ?? ''}`,
		`  Community: ${d.community ?? ''}`,
		`  Degree: ${G.degree(nid)}`,
	].join('\n');
}

export function getNeighbors(G: CompassGraph, label: string, relationFilter?: string): string {
	const matches = findNode(G, label);
	if (matches.length === 0) return `No node matching '${label}' found.`;

	const nid = matches[0];
	const lines = [`Neighbors of ${G.getNodeAttribute(nid, 'label') ?? nid}:`];
	const filter = relationFilter?.toLowerCase();

	G.forEachNeighbor(nid, neighbor => {
		const edgeKey = G.edge(nid, neighbor);
		if (!edgeKey) return;
		const d = G.getEdgeAttributes(edgeKey);
		const rel = d.relation ?? '';
		if (filter && !rel.toLowerCase().includes(filter)) return;
		lines.push(`  --> ${G.getNodeAttribute(neighbor, 'label') ?? neighbor} [${rel}] [${d.confidence ?? ''}]`);
	});

	return lines.join('\n');
}

export function getCommunityInfo(G: CompassGraph, communities: CommunityMap, communityId: number): string {
	const nodes = communities[communityId];
	if (!nodes || nodes.length === 0) return `Community ${communityId} not found.`;

	const lines = [`Community ${communityId} (${nodes.length} nodes):`];
	for (const n of nodes) {
		const d = G.getNodeAttributes(n);
		lines.push(`  ${d.label ?? n} [${d.source_file ?? ''}]`);
	}
	return lines.join('\n');
}

export function getGraphStats(G: CompassGraph, communities: CommunityMap): string {
	const confs: string[] = [];
	G.forEachEdge((_, attrs) => {
		confs.push(attrs.confidence ?? 'EXTRACTED');
	});
	const total = confs.length || 1;
	const extracted = confs.filter(c => c === 'EXTRACTED').length;
	const inferred = confs.filter(c => c === 'INFERRED').length;
	const ambiguous = confs.filter(c => c === 'AMBIGUOUS').length;

	return [
		`Nodes: ${G.order}`,
		`Edges: ${G.size}`,
		`Communities: ${Object.keys(communities).length}`,
		`EXTRACTED: ${Math.round(extracted / total * 100)}%`,
		`INFERRED: ${Math.round(inferred / total * 100)}%`,
		`AMBIGUOUS: ${Math.round(ambiguous / total * 100)}%`,
	].join('\n');
}

export function shortestPath(
	G: CompassGraph,
	sourceTerm: string,
	targetTerm: string,
	maxHops = 8,
): PathResult | string {
	const srcScored = scoreNodes(G, sourceTerm.split(/\s+/).map(t => t.toLowerCase()));
	const tgtScored = scoreNodes(G, targetTerm.split(/\s+/).map(t => t.toLowerCase()));

	if (srcScored.length === 0) return `No node matching source '${sourceTerm}' found.`;
	if (tgtScored.length === 0) return `No node matching target '${targetTerm}' found.`;

	const srcNid = srcScored[0]![1];
	const tgtNid = tgtScored[0]![1];

	const pathNodes = bfsPath(G, srcNid, tgtNid);
	if (!pathNodes) {
		return `No path found between '${G.getNodeAttribute(srcNid, 'label') ?? srcNid}' and '${G.getNodeAttribute(tgtNid, 'label') ?? tgtNid}'.`;
	}

	const hops = pathNodes.length - 1;
	if (hops > maxHops) return `Path exceeds max_hops=${maxHops} (${hops} hops found).`;

	const segments: string[] = [];
	for (let i = 0; i < pathNodes.length - 1; i++) {
		const u = pathNodes[i];
		const v = pathNodes[i + 1];
		const edgeKey = G.edge(u, v);
		const edata = edgeKey ? G.getEdgeAttributes(edgeKey) : null;
		const rel = edata?.relation ?? '';
		const conf = edata?.confidence ?? '';
		const confStr = conf ? ` [${conf}]` : '';

		if (i === 0) segments.push(G.getNodeAttribute(u, 'label') ?? u);
		segments.push(`--${rel}${confStr}--> ${G.getNodeAttribute(v, 'label') ?? v}`);
	}

	return {
		hops,
		segments,
		text: `Shortest path (${hops} hops):\n  ${segments.join(' ')}`,
	};
}

function bfsPath(G: CompassGraph, source: string, target: string): string[] | null {
	if (source === target) return [source];
	if (!G.hasNode(source) || !G.hasNode(target)) return null;

	const visited = new Set([source]);
	const queue: string[] = [source];
	let head = 0;
	const parent = new Map<string, string>();

	while (head < queue.length) {
		const node = queue[head++]!;
		for (const neighbor of G.neighbors(node)) {
			if (!visited.has(neighbor)) {
				visited.add(neighbor);
				parent.set(neighbor, node);
				if (neighbor === target) {
					const p: string[] = [target];
					let current = target;
					while (parent.has(current)) {
						current = parent.get(current)!;
						p.unshift(current);
					}
					return p;
				}
				queue.push(neighbor);
			}
		}
	}

	return null;
}
