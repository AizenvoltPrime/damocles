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

const LARGE_GRAPH_NODE_THRESHOLD = 20_000;
const MIN_QUALIFYING_DIRECTORY_GROUPS = 10;
const STORE_COMMUNITY_MEMBER_CHUNK_SIZE = 1_000;

let louvainNodeThresholdOverride: number | undefined = undefined;

export function __setLouvainNodeThresholdForTesting(n: number | undefined): void {
	louvainNodeThresholdOverride = n;
}

function shouldRunLouvain(graph: LouvainGraph): boolean {
	const threshold = louvainNodeThresholdOverride ?? LARGE_GRAPH_NODE_THRESHOLD;
	return graph.order <= threshold;
}

function createSeededRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6D2B79F5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function hashNodeOrder(nodes: StoredNode[]): number {
	let h = 0x811C9DC5;
	for (const n of nodes) {
		for (let i = 0; i < n.qualified_name.length; i++) {
			h = Math.imul(h ^ n.qualified_name.charCodeAt(i), 0x01000193) >>> 0;
		}
	}
	return h >>> 0;
}

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

type LouvainGraph = {
	addNode(id: string): void;
	mergeEdge(source: string, target: string, attrs?: { weight?: number }): void;
	order: number;
};

type LouvainAlgorithm = (
	graph: unknown,
	options?: { resolution?: number; rng?: () => number },
) => Record<string, number>;

interface LouvainModules {
	Graph: new () => LouvainGraph;
	louvain: LouvainAlgorithm;
}

function loadLouvainModules(): LouvainModules | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const graphologyMod = require('graphology');
		const Graph = (graphologyMod.default ?? graphologyMod) as new () => LouvainGraph;
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const louvain = require('graphology-communities-louvain') as LouvainAlgorithm;
		return { Graph, louvain };
	} catch {
		return null;
	}
}

function buildLouvainGraph(
	GraphCtor: new () => LouvainGraph,
	allNodes: StoredNode[],
	allEdges: StoredEdge[],
): LouvainGraph {
	const qnSet = new Set(allNodes.map(n => n.qualified_name));
	const graph = new GraphCtor();
	for (const node of allNodes) graph.addNode(node.qualified_name);
	for (const edge of allEdges) {
		if (!qnSet.has(edge.source_qualified) || !qnSet.has(edge.target_qualified)) continue;
		if (edge.source_qualified === edge.target_qualified) continue;
		const weight = EDGE_WEIGHTS[edge.kind] ?? 0.5;
		graph.mergeEdge(edge.source_qualified, edge.target_qualified, { weight });
	}
	return graph;
}

function runLouvainSync(
	louvain: LouvainAlgorithm,
	graph: LouvainGraph,
	resolution: number,
	rng: () => number,
): Record<string, number> | null {
	try {
		return louvain(graph, { resolution, rng });
	} catch (err) {
		log('[Compass] Louvain unrunnable on mixed graph; using directory-based detection (%s)', (err as Error).message);
		return null;
	}
}

function partitionToCommunities(
	partition: Record<string, number>,
	allNodes: StoredNode[],
	allEdges: StoredEdge[],
	minSize: number,
): CommunityData[] {
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

function detectDirectoryBased(
	allNodes: StoredNode[],
	allEdges: StoredEdge[],
	minSize: number,
): CommunityData[] {
	if (allNodes.length === 0) return [];

	type Remainder = { node: StoredNode; segments: string[]; filename: string };

	const segmentsList: string[][] = [];
	const remainders: Remainder[] = [];
	for (const node of allNodes) {
		const norm = node.file_path.replace(/\\/g, '/');
		const parts = norm.split('/');
		const dirSegs = parts.slice(0, -1);
		segmentsList.push(dirSegs);
	}

	const commonSegs: string[] = [];
	if (segmentsList.length > 0) {
		const first = segmentsList[0]!;
		outer:
		for (let i = 0; i < first.length; i++) {
			const seg = first[i];
			for (const segs of segmentsList) {
				if (i >= segs.length || segs[i] !== seg) break outer;
			}
			commonSegs.push(seg!);
		}
	}
	const commonPrefix = commonSegs.join('/');
	const prefixLen = commonPrefix.length;

	for (const node of allNodes) {
		const norm = node.file_path.replace(/\\/g, '/');
		let rest = prefixLen > 0 ? norm.slice(prefixLen) : norm;
		if (rest.startsWith('/')) rest = rest.slice(1);
		const parts = rest.split('/').filter(Boolean);
		const filename = parts.length > 0 ? parts[parts.length - 1]! : '';
		const segments = parts.length > 1 ? parts.slice(0, -1) : [];
		remainders.push({ node, segments, filename });
	}

	let maxDepth = 0;
	for (const r of remainders) {
		if (r.segments.length > maxDepth) maxDepth = r.segments.length;
	}

	const iterMaxDepth = Math.max(maxDepth, 1);
	let chosenGroups = new Map<string, StoredNode[]>();
	for (let depth = 1; depth <= iterMaxDepth; depth++) {
		const groups = new Map<string, StoredNode[]>();
		for (const r of remainders) {
			let key: string;
			if (r.segments.length === 0) {
				const stem = r.filename.replace(/\.[^.]+$/, '');
				key = stem || r.filename || '(root)';
			} else {
				key = r.segments.slice(0, depth).join('/');
			}
			let list = groups.get(key);
			if (!list) { list = []; groups.set(key, list); }
			list.push(r.node);
		}
		chosenGroups = groups;

		let qualifying = 0;
		for (const list of groups.values()) {
			if (list.length >= minSize) qualifying++;
		}
		if (qualifying >= MIN_QUALIFYING_DIRECTORY_GROUPS) break;
	}

	const edgeIndex = buildEdgeIndex(allEdges);
	const communities: CommunityData[] = [];
	for (const [dirPath, members] of chosenGroups) {
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
			description: `Directory-based community: ${dirPath}`,
			memberQns: [...memberQns],
		});
	}

	return communities;
}

type YieldFn = () => Promise<void>;

const NOOP_YIELD: YieldFn = async () => { };

export async function detectCommunities(
	store: GraphStore,
	minSize: number = 2,
	yieldFn: YieldFn = NOOP_YIELD,
): Promise<CommunityData[]> {
	log('[Compass] community detection: graph load start');
	const allNodes = store.getAllNodes();
	const allEdges = store.getAllEdges();
	log('[Compass] community detection: graph load end (%d nodes, %d edges)', allNodes.length, allEdges.length);
	await yieldFn();

	const modules = loadLouvainModules();
	if (!modules) {
		log('[Compass] graphology modules unavailable, using directory-based fallback');
		return runDirectoryFallback(allNodes, allEdges, minSize);
	}

	const graph = buildLouvainGraph(modules.Graph, allNodes, allEdges);
	if (graph.order < 2) {
		log('[Compass] graph order %d insufficient for Louvain, using directory-based fallback', graph.order);
		return runDirectoryFallback(allNodes, allEdges, minSize);
	}

	if (!shouldRunLouvain(graph)) {
		log('[Compass] graph order %d exceeds Louvain node threshold, using directory-based fallback', graph.order);
		return runDirectoryFallback(allNodes, allEdges, minSize);
	}

	await yieldFn();

	const resolution = Math.max(0.05, 1 / Math.log10(Math.max(graph.order, 10)));
	const rng = createSeededRng(hashNodeOrder(allNodes));

	log('[Compass] Louvain start (order=%d, resolution=%f)', graph.order, resolution);
	const louvainStart = Date.now();
	const partition = runLouvainSync(modules.louvain, graph, resolution, rng);
	const louvainElapsed = Date.now() - louvainStart;

	if (partition === null) {
		return runDirectoryFallback(allNodes, allEdges, minSize);
	}

	const partitionCount = new Set(Object.values(partition)).size;
	log('[Compass] Louvain end (%d partitions, %dms)', partitionCount, louvainElapsed);
	await yieldFn();

	log('[Compass] cohesion start');
	const cohesionStart = Date.now();
	const communities = partitionToCommunities(partition, allNodes, allEdges, minSize);
	log('[Compass] cohesion end (%d communities, %dms)', communities.length, Date.now() - cohesionStart);

	return communities;
}

function runDirectoryFallback(
	allNodes: StoredNode[],
	allEdges: StoredEdge[],
	minSize: number,
): CommunityData[] {
	log('[Compass] directory-based detection start');
	const start = Date.now();
	const communities = detectDirectoryBased(allNodes, allEdges, minSize);
	log('[Compass] directory-based detection end (%d communities, %dms)', communities.length, Date.now() - start);
	return communities;
}

function chunkArray<T>(items: T[], size: number): T[][] {
	if (items.length <= size) return items.length === 0 ? [] : [items];
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

async function updateCommunityMembers(
	store: GraphStore,
	communityId: number,
	memberQns: string[],
	yieldFn: YieldFn,
): Promise<void> {
	const chunks = chunkArray(memberQns, STORE_COMMUNITY_MEMBER_CHUNK_SIZE);
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]!;
		const placeholders = chunk.map(() => '?').join(', ');
		store.execRaw(
			`UPDATE nodes SET community_id = ? WHERE qualified_name IN (${placeholders})`,
			[communityId, ...chunk],
		);
		if (i < chunks.length - 1) await yieldFn();
	}
}

export async function storeCommunities(
	store: GraphStore,
	communities: CommunityData[],
	yieldFn: YieldFn = NOOP_YIELD,
): Promise<number> {
	log('[Compass] storeCommunities start (%d communities)', communities.length);
	const start = Date.now();

	store.beginTransaction();
	let stored = 0;
	try {
		store.execRaw('DELETE FROM communities');
		store.execRaw('UPDATE nodes SET community_id = NULL');

		for (const comm of communities) {
			store.execRaw(
				`INSERT INTO communities (name, level, cohesion, size, dominant_language, description)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[comm.name, comm.level, comm.cohesion, comm.size, comm.dominantLanguage, comm.description],
			);

			const row = store.queryRaw('SELECT last_insert_rowid() as id');
			const communityId = (row[0]?.['id'] ?? 0) as number;

			await updateCommunityMembers(store, communityId, comm.memberQns, yieldFn);
			stored++;
		}
		store.commitTransaction();
	} catch (err) {
		store.rollbackTransaction();
		throw err;
	}

	log('[Compass] storeCommunities end (%d stored, %dms)', stored, Date.now() - start);
	return stored;
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
		if (e.kind === 'TESTED_BY') continue;
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
