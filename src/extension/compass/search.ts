import { splitIdentifier, sanitizeFtsQuery } from './schema';
import { rowToStoredNode } from './database';
import type { GraphStore } from './database';
import type { StoredNode, NodeKind } from './types';

export interface SearchOptions {
	kind?: NodeKind | undefined;
	limit?: number | undefined;
}

export interface SearchResult {
	node: StoredNode;
	score: number;
}

const KIND_BOOST = 1.5;

function detectQueryStyle(query: string): 'pascal' | 'snake' | 'other' {
	const trimmed = query.trim();
	if (/^[A-Z][a-zA-Z0-9]*$/.test(trimmed)) return 'pascal';
	if (/_/.test(trimmed)) return 'snake';
	return 'other';
}

export function searchNodes(store: GraphStore, query: string, options?: SearchOptions): SearchResult[] {
	const limit = options?.limit ?? 20;
	const tokens = splitIdentifier(query);
	const andQuery = sanitizeFtsQuery(tokens);
	if (andQuery === '""') return [];

	let rows = store.searchFts(andQuery, options?.kind, limit);

	if (rows.length === 0) {
		const orQuery = sanitizeFtsQuery(tokens, 'OR');
		if (orQuery !== andQuery) {
			rows = store.searchFts(orQuery, options?.kind, limit);
		}
	}

	const style = detectQueryStyle(query);
	const results: SearchResult[] = rows.map(row => ({
		node: rowToStoredNode(row),
		score: -(row['score'] as number),
	}));

	if (style !== 'other') {
		for (const r of results) {
			if (style === 'pascal' && (r.node.kind === 'Class' || r.node.kind === 'Type')) {
				r.score *= KIND_BOOST;
			}
			if (style === 'snake' && r.node.kind === 'Function') {
				r.score *= KIND_BOOST;
			}
		}
		results.sort((a, b) => b.score - a.score);
	}

	return results;
}

export function expandGraphTerms(store: GraphStore, queryTerms: string[]): string[] {
	const expanded = new Set<string>();
	for (const term of queryTerms) {
		const results = searchNodes(store, term, { limit: 3 });
		for (const r of results) {
			for (const token of r.node.name_tokens.split(/\s+/)) {
				if (token.length > 2) expanded.add(token);
			}
			const outEdges = store.getEdgesBySource(r.node.qualified_name).slice(0, 5);
			const inEdges = store.getEdgesByTarget(r.node.qualified_name).slice(0, 5);
			for (const edge of [...outEdges, ...inEdges]) {
				const neighborQn = edge.source_qualified === r.node.qualified_name
					? edge.target_qualified
					: edge.source_qualified;
				const neighbor = store.getNode(neighborQn);
				if (neighbor) {
					for (const token of neighbor.name_tokens.split(/\s+/)) {
						if (token.length > 2) expanded.add(token);
					}
				}
			}
		}
	}

	for (const term of queryTerms) {
		for (const w of term.toLowerCase().split(/\s+/)) {
			expanded.delete(w);
		}
	}

	return [...expanded].slice(0, 20);
}
