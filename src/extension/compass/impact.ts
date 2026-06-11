import type { GraphStore } from './database';
import type { StoredNode, StoredEdge, ImpactResult } from './types';

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_NODES = 500;

export function computeBlastRadius(
	store: GraphStore,
	changedFiles: string[],
	maxDepth: number = DEFAULT_MAX_DEPTH,
	maxNodes: number = DEFAULT_MAX_NODES,
	workspaceRoot?: string,
): ImpactResult {
	if (changedFiles.length === 0) {
		return emptyResult();
	}

	const seeds = collectSeeds(store, changedFiles, workspaceRoot);
	if (seeds.size === 0) {
		return emptyResult();
	}

	const visited = new Set<string>(seeds);
	const impactedQns = new Set<string>();
	let frontier = new Set<string>(seeds);
	let cappedByLimit = false;

	bfs:
	for (let depth = 0; depth < maxDepth; depth++) {
		const nextFrontier = new Set<string>();
		const frontierList = [...frontier];
		const outBySource = groupEdges(store.getEdgesBySources(frontierList), e => e.source_qualified);
		const inByTarget = groupEdges(store.getEdgesByTargets(frontierList), e => e.target_qualified);

		for (const qn of frontier) {
			for (const e of outBySource.get(qn) ?? []) {
				if (!visited.has(e.target_qualified)) {
					visited.add(e.target_qualified);
					nextFrontier.add(e.target_qualified);
					if (!seeds.has(e.target_qualified)) {
						impactedQns.add(e.target_qualified);
					}
				}
				if (impactedQns.size >= maxNodes) { cappedByLimit = true; break bfs; }
			}
			for (const e of inByTarget.get(qn) ?? []) {
				if (!visited.has(e.source_qualified)) {
					visited.add(e.source_qualified);
					nextFrontier.add(e.source_qualified);
					if (!seeds.has(e.source_qualified)) {
						impactedQns.add(e.source_qualified);
					}
				}
				if (impactedQns.size >= maxNodes) { cappedByLimit = true; break bfs; }
			}
		}

		frontier = nextFrontier;
		if (frontier.size === 0) break;
	}

	const changedNodes = batchGetNodes(store, seeds);
	const impactedNodes = batchGetNodes(store, impactedQns);

	const totalImpacted = impactedNodes.length;
	const truncated = cappedByLimit || totalImpacted > maxNodes;
	const finalImpacted = truncated ? impactedNodes.slice(0, maxNodes) : impactedNodes;

	const impactedFiles = [...new Set(finalImpacted.map(n => n.file_path))];

	const allQns = new Set([...seeds, ...finalImpacted.map(n => n.qualified_name)]);
	const edges = store.getEdgesAmong(allQns);

	return {
		changed_nodes: changedNodes,
		impacted_nodes: finalImpacted,
		impacted_files: impactedFiles,
		edges,
		total_impacted: totalImpacted,
		truncated,
	};
}

function emptyResult(): ImpactResult {
	return {
		changed_nodes: [],
		impacted_nodes: [],
		impacted_files: [],
		edges: [],
		total_impacted: 0,
		truncated: false,
	};
}

function collectSeeds(store: GraphStore, changedFiles: string[], workspaceRoot?: string): Set<string> {
	const seeds = new Set<string>();
	for (const mp of store.resolveGraphFilePaths(changedFiles, workspaceRoot)) {
		for (const n of store.getNodesByFile(mp)) {
			seeds.add(n.qualified_name);
		}
	}
	return seeds;
}

function groupEdges(edges: StoredEdge[], keyOf: (e: StoredEdge) => string): Map<string, StoredEdge[]> {
	const groups = new Map<string, StoredEdge[]>();
	for (const e of edges) {
		const key = keyOf(e);
		const group = groups.get(key);
		if (group) group.push(e);
		else groups.set(key, [e]);
	}
	return groups;
}

function batchGetNodes(store: GraphStore, qualifiedNames: Set<string>): StoredNode[] {
	const byQn = new Map<string, StoredNode>();
	for (const n of store.getNodesByQualifiedNames([...qualifiedNames])) {
		byQn.set(n.qualified_name, n);
	}
	const nodes: StoredNode[] = [];
	for (const qn of qualifiedNames) {
		const node = byQn.get(qn);
		if (node) nodes.push(node);
	}
	return nodes;
}
