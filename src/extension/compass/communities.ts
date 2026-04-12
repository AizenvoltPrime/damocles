import type { GraphStore } from './database';
import type { StoredNode, StoredEdge, StoredCommunity, CommunityInfo, ArchitectureOverview, ArchitectureEdge } from './types';
import { log } from '../logger';

const EDGE_WEIGHTS: Record<string, number> = {
	CALLS: 1.0,
	IMPORTS_FROM: 0.5,
	INHERITS: 0.8,
	IMPLEMENTS: 0.7,
	CONTAINS: 0.3,
	TESTED_BY: 0.4,
	DEPENDS_ON: 0.6,
	REFERENCES: 0.4,
};

const COMMON_WORDS = new Set([
	'get', 'set', 'self', 'init', 'new', 'create', 'update', 'delete',
	'add', 'remove', 'make', 'build', 'from', 'to', 'for', 'with',
	'the', 'and', 'test', 'main', 'run', 'do', 'is', 'has', 'on',
	'of', 'in', 'at', 'by', 'my', 'this', 'that', 'all', 'none',
]);

const MAX_LOUVAIN_NODES = 20_000;

interface CommunityData {
	name: string;
	level: number;
	size: number;
	cohesion: number;
	dominantLanguage: string;
	description: string;
	memberQns: string[];
}

function splitName(name: string): string[] {
	const s = name.replace(/([a-z])([A-Z])/g, '$1_$2');
	return s.split(/[_\-.\s]+/).filter(Boolean);
}

function toSlug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
}

function extractFilePrefix(filePaths: string[]): string {
	if (filePaths.length === 0) return '';
	const parts: string[] = [];
	for (const fp of filePaths) {
		const segments = fp.replace(/\\/g, '/').split('/');
		if (segments.length >= 2) {
			parts.push(segments[segments.length - 2]!);
		} else {
			const stem = segments[segments.length - 1]!.replace(/\.[^.]+$/, '');
			parts.push(stem);
		}
	}
	const counts = new Map<string, number>();
	for (const p of parts) {
		counts.set(p, (counts.get(p) ?? 0) + 1);
	}
	let maxCount = 0;
	let topPart = '';
	for (const [part, count] of counts) {
		if (count > maxCount) { maxCount = count; topPart = part; }
	}
	return toSlug(topPart);
}

function extractKeywords(members: StoredNode[]): string[] {
	const wordCounts = new Map<string, number>();
	for (const m of members) {
		if (m.kind === 'Function' || m.kind === 'Class' || m.kind === 'Test' || m.kind === 'Type') {
			for (const w of splitName(m.name)) {
				const wl = w.toLowerCase();
				if (!COMMON_WORDS.has(wl) && wl.length > 1) {
					wordCounts.set(wl, (wordCounts.get(wl) ?? 0) + 1);
				}
			}
		}
	}
	return [...wordCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([w]) => w);
}

function generateCommunityName(members: StoredNode[]): string {
	if (members.length === 0) return 'empty';

	const prefix = extractFilePrefix(members.map(m => m.file_path));

	const classNames = members.filter(m => m.kind === 'Class').map(m => m.name);
	if (classNames.length > 0) {
		const counts = new Map<string, number>();
		for (const cn of classNames) counts.set(cn, (counts.get(cn) ?? 0) + 1);
		let topClass = '';
		let topCount = 0;
		for (const [name, count] of counts) {
			if (count > topCount) { topCount = count; topClass = name; }
		}
		if (topCount > members.length * 0.4) {
			return prefix ? `${prefix}-${toSlug(topClass)}` : toSlug(topClass);
		}
	}

	const keywords = extractKeywords(members);
	const keyword = keywords[0] ?? '';

	if (prefix && keyword) return `${prefix}-${keyword}`;
	if (prefix) return prefix;
	if (keyword) return keyword;
	return 'cluster';
}

interface EdgeIndex {
	bySource: Map<string, StoredEdge[]>;
	byTarget: Map<string, StoredEdge[]>;
}

function buildEdgeIndex(edges: StoredEdge[]): EdgeIndex {
	const bySource = new Map<string, StoredEdge[]>();
	const byTarget = new Map<string, StoredEdge[]>();
	for (const e of edges) {
		let srcList = bySource.get(e.source_qualified);
		if (!srcList) { srcList = []; bySource.set(e.source_qualified, srcList); }
		srcList.push(e);
		let tgtList = byTarget.get(e.target_qualified);
		if (!tgtList) { tgtList = []; byTarget.set(e.target_qualified, tgtList); }
		tgtList.push(e);
	}
	return { bySource, byTarget };
}

function computeCohesion(memberQns: Set<string>, edgeIndex: EdgeIndex): number {
	let internal = 0;
	let external = 0;
	const seen = new Set<number>();

	for (const qn of memberQns) {
		for (const e of edgeIndex.bySource.get(qn) ?? []) {
			if (seen.has(e.id)) continue;
			seen.add(e.id);
			if (memberQns.has(e.target_qualified)) internal++;
			else external++;
		}
		for (const e of edgeIndex.byTarget.get(qn) ?? []) {
			if (seen.has(e.id)) continue;
			seen.add(e.id);
			if (memberQns.has(e.source_qualified)) internal++;
			else external++;
		}
	}

	const total = internal + external;
	return total === 0 ? 0 : internal / total;
}

function detectLouvain(
	allNodes: StoredNode[],
	allEdges: StoredEdge[],
	minSize: number,
): CommunityData[] | null {
	let louvain: (graph: unknown, options?: { resolution?: number }) => Record<string, number>;
	let Graph: new () => {
		addNode(id: string): void;
		mergeEdge(source: string, target: string, attrs?: { weight?: number }): void;
		order: number;
	};

	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const graphologyMod = require('graphology');
		Graph = graphologyMod.default ?? graphologyMod;
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		louvain = require('graphology-communities-louvain');
	} catch {
		return null;
	}

	const qnSet = new Set(allNodes.map(n => n.qualified_name));
	const graph = new Graph();

	for (const node of allNodes) {
		graph.addNode(node.qualified_name);
	}

	for (const edge of allEdges) {
		if (!qnSet.has(edge.source_qualified) || !qnSet.has(edge.target_qualified)) continue;
		if (edge.source_qualified === edge.target_qualified) continue;
		const weight = EDGE_WEIGHTS[edge.kind] ?? 0.5;
		graph.mergeEdge(edge.source_qualified, edge.target_qualified, { weight });
	}

	if (graph.order < 2) return null;

	let partition: Record<string, number>;
	try {
		partition = louvain(graph, { resolution: 1.0 });
	} catch {
		return null;
	}

	const clusters = new Map<number, StoredNode[]>();
	const nodeMap = new Map(allNodes.map(n => [n.qualified_name, n]));
	for (const [qn, cid] of Object.entries(partition)) {
		const node = nodeMap.get(qn);
		if (!node) continue;
		let list = clusters.get(cid);
		if (!list) { list = []; clusters.set(cid, list); }
		list.push(node);
	}

	const edgeIndex = buildEdgeIndex(allEdges);
	const communities: CommunityData[] = [];
	for (const members of clusters.values()) {
		if (members.length < minSize) continue;
		const memberQns = new Set(members.map(m => m.qualified_name));
		const cohesion = computeCohesion(memberQns, edgeIndex);
		const langCounts = new Map<string, number>();
		for (const m of members) {
			if (m.language) langCounts.set(m.language, (langCounts.get(m.language) ?? 0) + 1);
		}
		let dominantLang = '';
		let maxLangCount = 0;
		for (const [lang, count] of langCounts) {
			if (count > maxLangCount) { maxLangCount = count; dominantLang = lang; }
		}

		communities.push({
			name: generateCommunityName(members),
			level: 0,
			size: members.length,
			cohesion: Math.round(cohesion * 10000) / 10000,
			dominantLanguage: dominantLang,
			description: `Community of ${members.length} nodes`,
			memberQns: [...memberQns],
		});
	}

	return communities;
}

function detectFileBased(
	allNodes: StoredNode[],
	allEdges: StoredEdge[],
	minSize: number,
): CommunityData[] {
	const byFile = new Map<string, StoredNode[]>();
	for (const n of allNodes) {
		let list = byFile.get(n.file_path);
		if (!list) { list = []; byFile.set(n.file_path, list); }
		list.push(n);
	}

	const edgeIndex = buildEdgeIndex(allEdges);
	const communities: CommunityData[] = [];
	for (const [filePath, members] of byFile) {
		if (members.length < minSize) continue;
		const memberQns = new Set(members.map(m => m.qualified_name));
		const cohesion = computeCohesion(memberQns, edgeIndex);
		const langCounts = new Map<string, number>();
		for (const m of members) {
			if (m.language) langCounts.set(m.language, (langCounts.get(m.language) ?? 0) + 1);
		}
		let dominantLang = '';
		let maxLangCount = 0;
		for (const [lang, count] of langCounts) {
			if (count > maxLangCount) { maxLangCount = count; dominantLang = lang; }
		}

		communities.push({
			name: generateCommunityName(members),
			level: 0,
			size: members.length,
			cohesion: Math.round(cohesion * 10000) / 10000,
			dominantLanguage: dominantLang,
			description: `File-based community: ${filePath}`,
			memberQns: [...memberQns],
		});
	}

	return communities;
}

export function detectCommunities(store: GraphStore, minSize: number = 2): CommunityData[] {
	const allNodes = store.getAllNodes();
	const allEdges = store.getAllEdges();

	if (allNodes.length > MAX_LOUVAIN_NODES) {
		log('[Compass] Node count %d exceeds maxLouvainNodes (%d), using file-based fallback', allNodes.length, MAX_LOUVAIN_NODES);
		return detectFileBased(allNodes, allEdges, minSize);
	}

	const louvainResult = detectLouvain(allNodes, allEdges, minSize);
	if (louvainResult !== null) {
		return louvainResult;
	}

	log('[Compass] Louvain unavailable or insufficient edges, using file-based fallback');
	return detectFileBased(allNodes, allEdges, minSize);
}

export function storeCommunities(store: GraphStore, communities: CommunityData[]): number {
	store.beginTransaction();
	try {
		store.execRaw('DELETE FROM communities');
		store.execRaw('UPDATE nodes SET community_id = NULL');

		let count = 0;
		for (const comm of communities) {
			store.execRaw(
				`INSERT INTO communities (name, level, cohesion, size, dominant_language, description)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[comm.name, comm.level, comm.cohesion, comm.size, comm.dominantLanguage, comm.description],
			);

			const row = store.queryRaw('SELECT last_insert_rowid() as id');
			const communityId = (row[0]?.['id'] ?? 0) as number;

			for (const qn of comm.memberQns) {
				store.execRaw(
					'UPDATE nodes SET community_id = ? WHERE qualified_name = ?',
					[communityId, qn],
				);
			}
			count++;
		}

		store.commitTransaction();
		return count;
	} catch (err) {
		store.rollbackTransaction();
		throw err;
	}
}

function rowToStoredCommunity(row: Record<string, unknown>): StoredCommunity {
	return {
		id: row['id'] as number,
		name: row['name'] as string,
		level: row['level'] as number,
		parent_id: (row['parent_id'] as number | null) ?? null,
		cohesion: row['cohesion'] as number,
		size: row['size'] as number,
		dominant_language: (row['dominant_language'] as string | null) ?? null,
		description: (row['description'] as string | null) ?? null,
		created_at: row['created_at'] as string,
	};
}

export function getCommunities(
	store: GraphStore,
	sortBy: string = 'size',
	minSize: number = 0,
): StoredCommunity[] {
	const validSorts = new Set(['size', 'cohesion', 'name']);
	if (!validSorts.has(sortBy)) sortBy = 'size';
	const order = sortBy === 'name' ? 'ASC' : 'DESC';

	const rows = store.queryRaw(
		`SELECT * FROM communities WHERE size >= ? ORDER BY ${sortBy} ${order}`,
		minSize,
	);
	return rows.map(rowToStoredCommunity);
}

export function getCommunityById(store: GraphStore, communityId: number): CommunityInfo | null {
	const rows = store.queryRaw('SELECT * FROM communities WHERE id = ?', communityId);
	if (rows.length === 0) return null;
	const community = rowToStoredCommunity(rows[0]!);
	const memberQns = store.getCommunityMemberQns(communityId);
	const members: StoredNode[] = [];
	for (const qn of memberQns) {
		const node = store.getNode(qn);
		if (node) members.push(node);
	}
	return { community, members };
}

export function getArchitectureOverview(store: GraphStore): ArchitectureOverview {
	const communities = getCommunities(store);
	if (communities.length === 0) {
		return { communities, cross_edges: [] };
	}

	const nodeToCommId = new Map<string, number>();
	for (const comm of communities) {
		const memberQns = store.getCommunityMemberQns(comm.id);
		for (const qn of memberQns) {
			nodeToCommId.set(qn, comm.id);
		}
	}

	const allEdges = store.getAllEdges();
	const crossCounts = new Map<string, { source: number; target: number; count: number; kinds: Set<string> }>();

	for (const e of allEdges) {
		const srcComm = nodeToCommId.get(e.source_qualified);
		const tgtComm = nodeToCommId.get(e.target_qualified);
		if (srcComm === undefined || tgtComm === undefined || srcComm === tgtComm) continue;

		const key = `${Math.min(srcComm, tgtComm)}:${Math.max(srcComm, tgtComm)}`;
		let entry = crossCounts.get(key);
		if (!entry) {
			entry = { source: srcComm, target: tgtComm, count: 0, kinds: new Set() };
			crossCounts.set(key, entry);
		}
		entry.count++;
		entry.kinds.add(e.kind);
	}

	const crossEdges: ArchitectureEdge[] = [];
	for (const entry of crossCounts.values()) {
		crossEdges.push({
			source_community: entry.source,
			target_community: entry.target,
			edge_count: entry.count,
			edge_kinds: [...entry.kinds],
		});
	}

	crossEdges.sort((a, b) => b.edge_count - a.edge_count);

	return { communities, cross_edges: crossEdges };
}
