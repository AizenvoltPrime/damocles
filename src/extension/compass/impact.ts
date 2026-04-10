import type { GraphStore } from './database';
import type { StoredNode, ImpactResult } from './types';

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_NODES = 500;

export function computeBlastRadius(
	store: GraphStore,
	changedFiles: string[],
	maxDepth: number = DEFAULT_MAX_DEPTH,
	maxNodes: number = DEFAULT_MAX_NODES,
): ImpactResult {
	if (changedFiles.length === 0) {
		return emptyResult();
	}

	const seeds = collectSeeds(store, changedFiles);
	if (seeds.size === 0) {
		return emptyResult();
	}

	const visited = new Set<string>(seeds);
	const impactedQns = new Set<string>();
	let frontier = new Set<string>(seeds);

	for (let depth = 0; depth < maxDepth; depth++) {
		const nextFrontier = new Set<string>();

		for (const qn of frontier) {
			for (const e of store.getEdgesBySource(qn)) {
				if (!visited.has(e.target_qualified)) {
					visited.add(e.target_qualified);
					nextFrontier.add(e.target_qualified);
					if (!seeds.has(e.target_qualified)) {
						impactedQns.add(e.target_qualified);
					}
				}
			}
			for (const e of store.getEdgesByTarget(qn)) {
				if (!visited.has(e.source_qualified)) {
					visited.add(e.source_qualified);
					nextFrontier.add(e.source_qualified);
					if (!seeds.has(e.source_qualified)) {
						impactedQns.add(e.source_qualified);
					}
				}
			}
		}

		frontier = nextFrontier;
		if (frontier.size === 0) break;
		if (impactedQns.size >= maxNodes) break;
	}

	const changedNodes = batchGetNodes(store, seeds);
	const impactedNodes = batchGetNodes(store, impactedQns);

	const totalImpacted = impactedNodes.length;
	const truncated = totalImpacted > maxNodes;
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

function collectSeeds(store: GraphStore, changedFiles: string[]): Set<string> {
	const seeds = new Set<string>();
	for (const fp of changedFiles) {
		let nodes = store.getNodesByFile(fp);
		if (nodes.length === 0) {
			const matched = store.getFilesMatchingSuffix(fp);
			for (const mp of matched) {
				for (const n of store.getNodesByFile(mp)) {
					seeds.add(n.qualified_name);
				}
			}
		} else {
			for (const n of nodes) {
				seeds.add(n.qualified_name);
			}
		}
	}
	return seeds;
}

function batchGetNodes(store: GraphStore, qualifiedNames: Set<string>): StoredNode[] {
	const nodes: StoredNode[] = [];
	for (const qn of qualifiedNames) {
		const node = store.getNode(qn);
		if (node) nodes.push(node);
	}
	return nodes;
}
