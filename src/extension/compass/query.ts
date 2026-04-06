import type { CompassGraph, CommunityMap, GodNode, GraphEdgeAttributes } from './types';
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

const STOP_WORDS = new Set([
	'the', 'and', 'for', 'with', 'from', 'that', 'this', 'how', 'does', 'what',
	'are', 'was', 'were', 'been', 'has', 'have', 'its', 'all', 'not', 'but',
	'system', 'class', 'classes', 'interface', 'interfaces', 'function', 'functions',
	'method', 'methods', 'module', 'modules', 'file', 'files', 'code', 'project',
	'use', 'used', 'using', 'find', 'get', 'set', 'show', 'list',
]);

function splitCamelCase(s: string): string[] {
	return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.\-/\\]+/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
}

export function scoreNodes(G: CompassGraph, terms: string[]): Array<[number, string]> {
	const lengthFiltered = terms.filter(t => t.length > 2);
	const filtered = lengthFiltered.filter(t => !STOP_WORDS.has(t));
	const effective = filtered.length >= 2 ? filtered : lengthFiltered;
	if (effective.length === 0) return [];

	const termFreq = new Map<string, number>();
	G.forEachNode((_, data) => {
		const words = splitCamelCase(data.label ?? '');
		for (const w of words) {
			termFreq.set(w, (termFreq.get(w) ?? 0) + 1);
		}
	});
	const nodeCount = G.order || 1;

	const scored: Array<[number, string]> = [];
	G.forEachNode((nid, data) => {
		const label = (data.label ?? '').toLowerCase();
		const labelWords = splitCamelCase(data.label ?? '');
		const source = (data.source_file ?? '').toLowerCase();
		let score = 0;

		for (const t of effective) {
			const df = termFreq.get(t) ?? 0;
			const idf = Math.log(1 + (nodeCount - df + 0.5) / (df + 0.5));

			if (labelWords.includes(t)) {
				score += 2.0 * idf;
			} else if (label.includes(t)) {
				score += 1.0 * idf;
			}

			if (source.includes(t)) score += 0.3 * idf;
		}

		if (score > 0) scored.push([score, nid]);
	});
	return scored.sort((a, b) => b[0] - a[0]);
}

export function bfs(
	G: CompassGraph,
	startNodes: string[],
	depth: number,
	maxNodes = 0,
): { visited: Set<string> } {
	const visited = new Set(startNodes);
	let frontier = new Set(startNodes);

	for (let i = 0; i < depth; i++) {
		const nextFrontier = new Set<string>();
		for (const n of frontier) {
			if (maxNodes > 0 && visited.size >= maxNodes) break;
			G.forEachNeighbor(n, neighbor => {
				if (!visited.has(neighbor) && !nextFrontier.has(neighbor)
					&& (maxNodes <= 0 || visited.size + nextFrontier.size < maxNodes)) {
					nextFrontier.add(neighbor);
				}
			});
		}
		for (const n of nextFrontier) visited.add(n);
		frontier = nextFrontier;
		if (maxNodes > 0 && visited.size >= maxNodes) break;
	}

	return { visited };
}

export function findNode(G: CompassGraph, label: string): string[] {
	const term = label.toLowerCase();
	const exact: Array<{ nid: string; degree: number }> = [];
	const startsWith: Array<{ nid: string; degree: number }> = [];
	const substring: Array<{ nid: string; degree: number }> = [];

	G.forEachNode((nid, d) => {
		const nodeLabel = (d.label ?? '').toLowerCase().replace(/^\./, '').replace(/\(\)$/, '');
		const degree = G.degree(nid);

		if (nodeLabel === term || nid.toLowerCase() === term) {
			exact.push({ nid, degree });
		} else if (nodeLabel.startsWith(term)) {
			startsWith.push({ nid, degree });
		} else if (nodeLabel.includes(term)) {
			substring.push({ nid, degree });
		}
	});

	const byDegreeDesc = (a: { degree: number }, b: { degree: number }) => b.degree - a.degree;
	return [
		...exact.sort(byDegreeDesc),
		...startsWith.sort(byDegreeDesc),
		...substring.sort(byDegreeDesc),
	].map(m => m.nid);
}

const MAX_TRAVERSAL_NODES = 60;

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


const KIND_FILTER_MAP: Record<string, Set<string>> = {
	file: new Set(['file']),
	class: new Set(['class']),
	function: new Set(['function']),
	method: new Set(['method']),
};

function matchesKindFilter(nodeKind: string | undefined, filter: string): boolean {
	if (filter === 'any') return true;
	const allowed = KIND_FILTER_MAP[filter];
	if (!allowed) return true;
	return allowed.has(nodeKind ?? '');
}

function groupNeighborsByRelation(
	G: CompassGraph,
	nid: string,
	direction: 'outgoing' | 'incoming',
	maxPerGroup: number,
): string[] {
	const groups = new Map<string, string[]>();

	G.forEachEdge(nid, (_, attrs, source, target) => {
		const srcId = (attrs as GraphEdgeAttributes)._src ?? source;
		const tgtId = (attrs as GraphEdgeAttributes)._tgt ?? target;
		const isOutgoing = srcId === nid;

		if (direction === 'outgoing' && !isOutgoing) return;
		if (direction === 'incoming' && isOutgoing) return;

		const neighbor = isOutgoing ? tgtId : srcId;
		if (!G.hasNode(neighbor)) return;

		const rel = attrs.relation ?? 'related';
		const arrow = direction === 'outgoing' ? `${rel}→` : `${rel}←`;

		if (!groups.has(arrow)) groups.set(arrow, []);
		const list = groups.get(arrow)!;
		if (list.length < maxPerGroup) {
			list.push(sanitizeLabel(G.getNodeAttribute(neighbor, 'label') ?? neighbor));
		}
	});

	const parts: string[] = [];
	for (const [arrow, labels] of groups) {
		parts.push(`${arrow} ${labels.join(', ')}`);
	}
	return parts;
}

export function searchEntities(
	G: CompassGraph,
	queryStr: string,
	kind?: string,
	limit = 20,
): string {
	const terms = queryStr.split(/\s+/).filter(t => t.length > 2).map(t => t.toLowerCase());
	const scored = scoreNodes(G, terms);

	if (scored.length === 0) return `No entities matching "${queryStr}" found.`;

	const kindFilter = kind ?? 'any';
	const filtered: Array<[number, string]> = [];
	const seenFiles = new Set<string>();

	for (const [score, nid] of scored) {
		if (filtered.length >= limit) break;

		const nodeKind = G.getNodeAttribute(nid, 'kind') as string | undefined;
		if (!matchesKindFilter(nodeKind, kindFilter)) continue;

		const label = G.getNodeAttribute(nid, 'label') ?? '';
		if (label.startsWith('.') && kindFilter !== 'method') {
			const sourceFile = G.getNodeAttribute(nid, 'source_file') ?? '';
			if (sourceFile && seenFiles.has(sourceFile)) continue;
		}

		const sourceFile = G.getNodeAttribute(nid, 'source_file') ?? '';
		if (sourceFile) seenFiles.add(sourceFile);

		filtered.push([score, nid]);
	}

	if (filtered.length === 0) return `No entities matching "${queryStr}" with kind="${kindFilter}" found.`;

	const lines: string[] = [`Found ${filtered.length} entities matching "${queryStr}":\n`];

	for (let i = 0; i < filtered.length; i++) {
		const nid = filtered[i]![1];
		const attrs = G.getNodeAttributes(nid);
		const label = sanitizeLabel(attrs.label ?? nid);
		const nodeKind = (attrs.kind as string) ?? '';
		const kindStr = nodeKind ? `[${nodeKind}]` : '';
		const source = attrs.source_file ?? '';
		const loc = attrs.source_location ?? '';
		const community = attrs.community ?? '';
		const degree = G.degree(nid);

		lines.push(`${i + 1}. ${label} ${kindStr} — ${source} ${loc} | community ${community} | ${degree} edges`);

		const outgoing = groupNeighborsByRelation(G, nid, 'outgoing', 3);
		const incoming = groupNeighborsByRelation(G, nid, 'incoming', 3);

		for (const line of outgoing) lines.push(`   ${line}`);
		for (const line of incoming) lines.push(`   ${line}`);
	}

	return lines.join('\n');
}

export function inspectNode(
	G: CompassGraph,
	label: string,
	relationFilter?: string,
	depth = 1,
): string {
	const matches = findNode(G, label);
	if (matches.length === 0) return `No node matching '${label}' found.`;

	const nid = matches[0]!;
	const attrs = G.getNodeAttributes(nid);
	const nodeLabel = sanitizeLabel(attrs.label ?? nid);
	const nodeKind = (attrs.kind as string) ?? '';
	const kindStr = nodeKind ? `[${nodeKind}]` : '';

	const lines: string[] = [
		`${nodeLabel} ${kindStr}`,
		`  Source: ${attrs.source_file ?? ''} ${attrs.source_location ?? ''}`,
		`  Community: ${attrs.community ?? ''} | Degree: ${G.degree(nid)}`,
	];

	if (depth >= 2) {
		const { visited } = bfs(G, [nid], depth, MAX_TRAVERSAL_NODES);

		const outgoing: string[] = [];
		const incoming: string[] = [];
		const directNeighbors = new Set<string>();
		const seen = new Set<string>();

		G.forEachEdge(nid, (_, eAttrs, source, target) => {
			const srcId = (eAttrs as GraphEdgeAttributes)._src ?? source;
			const isOutgoing = srcId === nid;
			const other = isOutgoing ? target : source;
			if (!visited.has(other)) return;

			directNeighbors.add(other);
			const rel = eAttrs.relation ?? 'related';
			const conf = eAttrs.confidence ?? '';
			const vLabel = sanitizeLabel(G.getNodeAttribute(other, 'label') ?? other);
			const vSource = G.getNodeAttribute(other, 'source_file') ?? '';
			const key = `${isOutgoing ? '>' : '<'}${other}${rel}`;
			if (seen.has(key)) return;
			seen.add(key);

			if (isOutgoing) {
				outgoing.push(`  --${rel}--> ${vLabel} [${conf}] ${vSource}`);
			} else {
				incoming.push(`  <--${rel}-- ${vLabel} [${conf}] ${vSource}`);
			}
		});

		lines.push('', `Outgoing (${outgoing.length}):`);
		lines.push(...outgoing);
		lines.push('', `Incoming (${incoming.length}):`);
		lines.push(...incoming);

		const depth2Neighbors: string[] = [];
		for (const vNid of visited) {
			if (vNid === nid || directNeighbors.has(vNid)) continue;
			const vLabel = sanitizeLabel(G.getNodeAttribute(vNid, 'label') ?? vNid);
			depth2Neighbors.push(`  ${vLabel}`);
		}
		if (depth2Neighbors.length > 0) {
			lines.push('', `Depth-2 neighbors (${depth2Neighbors.length}):`);
			lines.push(...depth2Neighbors);
		}

		return lines.join('\n');
	}

	const filter = relationFilter?.toLowerCase();
	const outgoing: string[] = [];
	const incoming: string[] = [];

	G.forEachEdge(nid, (_, eAttrs, source, target) => {
		const rel = eAttrs.relation ?? 'related';
		if (filter && !rel.toLowerCase().includes(filter)) return;

		const conf = eAttrs.confidence ?? '';
		const srcId = (eAttrs as GraphEdgeAttributes)._src ?? source;
		const isOutgoing = srcId === nid;
		const other = isOutgoing ? target : source;
		if (!G.hasNode(other)) return;

		const vLabel = sanitizeLabel(G.getNodeAttribute(other, 'label') ?? other);
		const vSource = G.getNodeAttribute(other, 'source_file') ?? '';

		if (isOutgoing) {
			outgoing.push(`  --${rel}--> ${vLabel} [${conf}] ${vSource}`);
		} else {
			incoming.push(`  <--${rel}-- ${vLabel} [${conf}] ${vSource}`);
		}
	});

	lines.push('', `Outgoing (${outgoing.length}):`);
	lines.push(...outgoing);
	lines.push('', `Incoming (${incoming.length}):`);
	lines.push(...incoming);

	return lines.join('\n');
}

export function graphOverview(
	G: CompassGraph,
	communities: CommunityMap,
	view: 'summary' | 'hubs' | 'community' = 'summary',
	godNodesFn: (g: CompassGraph, n: number) => GodNode[],
	communityId?: number,
	topN = 10,
): string {
	if (view === 'hubs') {
		const hubs = godNodesFn(G, topN);
		if (hubs.length === 0) return 'No hub entities found.';
		const lines = [`Top ${hubs.length} hub entities:\n`];
		for (let i = 0; i < hubs.length; i++) {
			const h = hubs[i]!;
			lines.push(`  ${i + 1}. ${h.label} (${h.edges} edges)`);
		}
		return lines.join('\n');
	}

	if (view === 'community') {
		if (communityId === undefined) return 'community_id is required for community view.';
		const nodes = communities[communityId];
		if (!nodes || nodes.length === 0) return `Community ${communityId} not found.`;

		const byFile = new Map<string, string[]>();
		for (const n of nodes) {
			const source = G.getNodeAttribute(n, 'source_file') ?? '(unknown)';
			if (!byFile.has(source)) byFile.set(source, []);
			const label = G.getNodeAttribute(n, 'label') ?? n;
			const kind = G.getNodeAttribute(n, 'kind') as string | undefined;
			const kindStr = kind ? ` [${kind}]` : '';
			byFile.get(source)!.push(`    ${sanitizeLabel(label)}${kindStr}`);
		}

		const lines = [`Community ${communityId} (${nodes.length} nodes):\n`];
		for (const [file, labels] of byFile) {
			lines.push(`  ${file}:`);
			lines.push(...labels);
		}
		return lines.join('\n');
	}

	const confs: string[] = [];
	G.forEachEdge((_, attrs) => {
		confs.push(attrs.confidence ?? 'EXTRACTED');
	});
	const total = confs.length || 1;
	const extracted = confs.filter(c => c === 'EXTRACTED').length;
	const inferred = confs.filter(c => c === 'INFERRED').length;
	const ambiguous = confs.filter(c => c === 'AMBIGUOUS').length;

	const hubs = godNodesFn(G, 5);
	const communityCount = Object.keys(communities).length;

	const lines = [
		'Workspace Graph:',
		`  Nodes: ${G.order} | Edges: ${G.size} | Communities: ${communityCount}`,
		`  Confidence: EXTRACTED ${Math.round(extracted / total * 100)}% | INFERRED ${Math.round(inferred / total * 100)}% | AMBIGUOUS ${Math.round(ambiguous / total * 100)}%`,
	];

	if (hubs.length > 0) {
		lines.push('', `Top ${hubs.length} Hubs:`);
		for (let i = 0; i < hubs.length; i++) {
			const h = hubs[i]!;
			lines.push(`  ${i + 1}. ${h.label} (${h.edges} edges)`);
		}
	}

	return lines.join('\n');
}

export function tracePath(
	G: CompassGraph,
	sourceTerm: string,
	targetTerm: string,
	maxHops = 8,
): string {
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
		const u = pathNodes[i]!;
		const v = pathNodes[i + 1]!;
		const edgeKey = G.edge(u, v);
		const edata = edgeKey ? G.getEdgeAttributes(edgeKey) : null;
		const rel = edata?.relation ?? '';
		const conf = edata?.confidence ?? '';
		const confStr = conf ? ` [${conf}]` : '';

		if (i === 0) segments.push(G.getNodeAttribute(u, 'label') ?? u);
		segments.push(`--${rel}${confStr}--> ${G.getNodeAttribute(v, 'label') ?? v}`);
	}

	return `Shortest path (${hops} hops):\n  ${segments.join(' ')}`;
}
