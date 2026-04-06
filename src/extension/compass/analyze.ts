import type { CompassGraph, CommunityMap, GodNode, SurprisingConnection, SuggestedQuestion, GraphDiff } from './types';
import { isFileNode, isConceptNode, CODE_STEMS } from './types';
import { cohesionScore } from './cluster';

const PAPER_EXTS = new Set(['pdf']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);

function nodeCommunityMap(communities: CommunityMap): Map<string, number> {
	const map = new Map<string, number>();
	for (const [cid, nodes] of Object.entries(communities)) {
		for (const n of nodes) map.set(n, Number(cid));
	}
	return map;
}

function fileCategory(filePath: string): string {
	const ext = filePath.includes('.') ? filePath.split('.').pop()!.toLowerCase() : '';
	if (CODE_STEMS.has(ext)) return 'code';
	if (PAPER_EXTS.has(ext)) return 'paper';
	if (IMAGE_EXTS.has(ext)) return 'image';
	return 'doc';
}

function topLevelDir(filePath: string): string {
	return filePath.includes('/') ? filePath.split('/')[0] ?? '' : filePath;
}

export function godNodes(G: CompassGraph, topN = 10): GodNode[] {
	const degrees: Array<[string, number]> = [];
	G.forEachNode(nodeId => {
		degrees.push([nodeId, G.degree(nodeId)]);
	});
	degrees.sort((a, b) => b[1] - a[1]);

	const result: GodNode[] = [];
	for (const [nodeId, deg] of degrees) {
		if (isFileNode(G, nodeId) || isConceptNode(G, nodeId)) continue;
		result.push({
			id: nodeId,
			label: G.getNodeAttribute(nodeId, 'label') ?? nodeId,
			edges: deg,
		});
		if (result.length >= topN) break;
	}
	return result;
}

function surpriseScore(
	G: CompassGraph,
	u: string,
	v: string,
	data: Record<string, unknown>,
	nodeCommunity: Map<string, number>,
	uSource: string,
	vSource: string,
): { score: number; reasons: string[] } {
	let score = 0;
	const reasons: string[] = [];

	const conf = (data['confidence'] as string) ?? 'EXTRACTED';
	const confBonus: Record<string, number> = { AMBIGUOUS: 3, INFERRED: 2, EXTRACTED: 1 };
	score += confBonus[conf] ?? 1;
	if (conf === 'AMBIGUOUS' || conf === 'INFERRED') {
		reasons.push(`${conf.toLowerCase()} connection - not explicitly stated in source`);
	}

	const catU = fileCategory(uSource);
	const catV = fileCategory(vSource);
	if (catU !== catV) {
		score += 2;
		reasons.push(`crosses file types (${catU} ↔ ${catV})`);
	}

	if (topLevelDir(uSource) !== topLevelDir(vSource)) {
		score += 2;
		reasons.push('connects across different repos/directories');
	}

	const cidU = nodeCommunity.get(u);
	const cidV = nodeCommunity.get(v);
	if (cidU !== undefined && cidV !== undefined && cidU !== cidV) {
		score += 1;
		reasons.push('bridges separate communities');
	}

	if (data['relation'] === 'semantically_similar_to') {
		score = Math.floor(score * 1.5);
		reasons.push('semantically similar concepts with no structural link');
	}

	const degU = G.degree(u);
	const degV = G.degree(v);
	if (Math.min(degU, degV) <= 2 && Math.max(degU, degV) >= 5) {
		score += 1;
		const peripheral = degU <= 2 ? (G.getNodeAttribute(u, 'label') ?? u) : (G.getNodeAttribute(v, 'label') ?? v);
		const hub = degU <= 2 ? (G.getNodeAttribute(v, 'label') ?? v) : (G.getNodeAttribute(u, 'label') ?? u);
		reasons.push(`peripheral node \`${peripheral}\` unexpectedly reaches hub \`${hub}\``);
	}

	return { score, reasons };
}

function crossFileSurprises(G: CompassGraph, communities: CommunityMap, topN: number): SurprisingConnection[] {
	const nodeCommunity = nodeCommunityMap(communities);
	const candidates: Array<SurprisingConnection & { _score: number }> = [];

	G.forEachEdge((_edge, attrs, u, v) => {
		const relation = (attrs.relation as string) ?? '';
		if (['imports', 'imports_from', 'contains', 'method'].includes(relation)) return;
		if (isConceptNode(G, u) || isConceptNode(G, v)) return;
		if (isFileNode(G, u) || isFileNode(G, v)) return;

		const uSource = G.getNodeAttribute(u, 'source_file') ?? '';
		const vSource = G.getNodeAttribute(v, 'source_file') ?? '';
		if (!uSource || !vSource || uSource === vSource) return;

		const data = attrs as unknown as Record<string, unknown>;
		const { score, reasons } = surpriseScore(G, u, v, data, nodeCommunity, uSource, vSource);

		const srcId = (attrs._src as string) ?? u;
		const tgtId = (attrs._tgt as string) ?? v;

		candidates.push({
			_score: score,
			source: G.getNodeAttribute(srcId, 'label') ?? srcId,
			target: G.getNodeAttribute(tgtId, 'label') ?? tgtId,
			source_files: [
				G.getNodeAttribute(srcId, 'source_file') ?? '',
				G.getNodeAttribute(tgtId, 'source_file') ?? '',
			],
			confidence: (attrs.confidence ?? 'EXTRACTED') as SurprisingConnection['confidence'],
			relation,
			why: reasons.length > 0 ? reasons.join('; ') : 'cross-file semantic connection',
		});
	});

	candidates.sort((a, b) => b._score - a._score);
	const result = candidates.slice(0, topN).map(({ _score, ...rest }) => rest);

	if (result.length > 0) return result;
	return crossCommunitySurprises(G, communities, topN);
}

function crossCommunitySurprises(G: CompassGraph, communities: CommunityMap, topN: number): SurprisingConnection[] {
	if (Object.keys(communities).length === 0) {
		if (G.size === 0) return [];
		const result: SurprisingConnection[] = [];
		const edgeDegrees: Array<{ u: string; v: string; score: number }> = [];
		G.forEachEdge((_, _attrs, u, v) => {
			edgeDegrees.push({ u, v, score: G.degree(u) + G.degree(v) });
		});
		edgeDegrees.sort((a, b) => b.score - a.score);
		for (const { u, v } of edgeDegrees.slice(0, topN)) {
			const attrs = G.getEdgeAttributes(G.edge(u, v)!);
			result.push({
				source: G.getNodeAttribute(u, 'label') ?? u,
				target: G.getNodeAttribute(v, 'label') ?? v,
				source_files: [
					G.getNodeAttribute(u, 'source_file') ?? '',
					G.getNodeAttribute(v, 'source_file') ?? '',
				],
				confidence: (attrs.confidence ?? 'EXTRACTED') as SurprisingConnection['confidence'],
				relation: (attrs.relation as string) ?? '',
				note: 'Bridges graph structure',
			});
		}
		return result;
	}

	const nodeCommunity = nodeCommunityMap(communities);
	const surprises: Array<SurprisingConnection & { _pair: string }> = [];

	G.forEachEdge((_, attrs, u, v) => {
		const cidU = nodeCommunity.get(u);
		const cidV = nodeCommunity.get(v);
		if (cidU === undefined || cidV === undefined || cidU === cidV) return;
		if (isFileNode(G, u) || isFileNode(G, v)) return;
		const relation = (attrs.relation as string) ?? '';
		if (['imports', 'imports_from', 'contains', 'method'].includes(relation)) return;

		const srcId = (attrs._src as string) ?? u;
		const tgtId = (attrs._tgt as string) ?? v;

		surprises.push({
			source: G.getNodeAttribute(srcId, 'label') ?? srcId,
			target: G.getNodeAttribute(tgtId, 'label') ?? tgtId,
			source_files: [
				G.getNodeAttribute(srcId, 'source_file') ?? '',
				G.getNodeAttribute(tgtId, 'source_file') ?? '',
			],
			confidence: (attrs.confidence ?? 'EXTRACTED') as SurprisingConnection['confidence'],
			relation,
			note: `Bridges community ${cidU} → community ${cidV}`,
			_pair: [Math.min(cidU, cidV), Math.max(cidU, cidV)].join(','),
		});
	});

	const order: Record<string, number> = { AMBIGUOUS: 0, INFERRED: 1, EXTRACTED: 2 };
	surprises.sort((a, b) => (order[a.confidence] ?? 3) - (order[b.confidence] ?? 3));

	const seenPairs = new Set<string>();
	const deduped: SurprisingConnection[] = [];
	for (const { _pair, ...rest } of surprises) {
		if (!seenPairs.has(_pair)) {
			seenPairs.add(_pair);
			deduped.push(rest);
		}
	}
	return deduped.slice(0, topN);
}

export function surprisingConnections(
	G: CompassGraph,
	communities: CommunityMap = {},
	topN = 5,
): SurprisingConnection[] {
	const sourceFiles = new Set<string>();
	G.forEachNode((_, attrs) => {
		const sf = attrs.source_file;
		if (sf) sourceFiles.add(sf);
	});

	if (sourceFiles.size > 1) {
		return crossFileSurprises(G, communities, topN);
	}
	return crossCommunitySurprises(G, communities, topN);
}

export function suggestQuestions(
	G: CompassGraph,
	communities: CommunityMap,
	communityLabels: Record<number, string>,
	topN = 7,
): SuggestedQuestion[] {
	const questions: SuggestedQuestion[] = [];
	G.forEachEdge((_, attrs, u, v) => {
		if (attrs.confidence === 'AMBIGUOUS') {
			const ul = G.getNodeAttribute(u, 'label') ?? u;
			const vl = G.getNodeAttribute(v, 'label') ?? v;
			const relation = attrs.relation ?? 'related to';
			questions.push({
				type: 'ambiguous_edge',
				question: `What is the exact relationship between \`${ul}\` and \`${vl}\`?`,
				why: `Edge tagged AMBIGUOUS (relation: ${relation}) - confidence is low.`,
			});
		}
	});

	const degrees: Array<[string, number]> = [];
	G.forEachNode(nodeId => {
		if (!isFileNode(G, nodeId)) {
			degrees.push([nodeId, G.degree(nodeId)]);
		}
	});
	degrees.sort((a, b) => b[1] - a[1]);

	for (const [nodeId] of degrees.slice(0, 5)) {
		const inferredEdges: Array<{ u: string; v: string; data: Record<string, unknown> }> = [];
		G.forEachEdge(nodeId, (_, attrs, u, v) => {
			if (attrs.confidence === 'INFERRED') {
				inferredEdges.push({ u, v, data: attrs as unknown as Record<string, unknown> });
			}
		});

		if (inferredEdges.length >= 2) {
			const label = G.getNodeAttribute(nodeId, 'label') ?? nodeId;
			const others: string[] = [];
			for (const { u, v, data } of inferredEdges.slice(0, 2)) {
				const srcId = (data['_src'] as string) ?? u;
				const tgtId = (data['_tgt'] as string) ?? v;
				const otherId = srcId === nodeId ? tgtId : srcId;
				others.push(G.getNodeAttribute(otherId, 'label') ?? otherId);
			}
			questions.push({
				type: 'verify_inferred',
				question: `Are the ${inferredEdges.length} inferred relationships involving \`${label}\` (e.g. with \`${others[0]}\` and \`${others[1]}\`) actually correct?`,
				why: `\`${label}\` has ${inferredEdges.length} INFERRED edges - model-reasoned connections that need verification.`,
			});
		}
	}

	const isolated: string[] = [];
	G.forEachNode(nodeId => {
		if (G.degree(nodeId) <= 1 && !isFileNode(G, nodeId) && !isConceptNode(G, nodeId)) {
			isolated.push(nodeId);
		}
	});
	if (isolated.length > 0) {
		const labels = isolated.slice(0, 3).map(n => G.getNodeAttribute(n, 'label') ?? n);
		questions.push({
			type: 'isolated_nodes',
			question: `What connects ${labels.map(l => `\`${l}\``).join(', ')} to the rest of the system?`,
			why: `${isolated.length} weakly-connected nodes found - possible documentation gaps or missing edges.`,
		});
	}

	for (const [cidStr, nodes] of Object.entries(communities)) {
		const cid = Number(cidStr);
		const score = cohesionScore(G, nodes);
		if (score < 0.15 && nodes.length >= 5) {
			const label = communityLabels[cid] ?? `Community ${cid}`;
			questions.push({
				type: 'low_cohesion',
				question: `Should \`${label}\` be split into smaller, more focused modules?`,
				why: `Cohesion score ${score} - nodes in this community are weakly interconnected.`,
			});
		}
	}

	if (questions.length === 0) {
		return [{
			type: 'no_signal',
			question: null,
			why: 'Not enough signal to generate questions. This usually means the corpus has no AMBIGUOUS edges, no bridge nodes, no INFERRED relationships, and all communities are tightly cohesive.',
		}];
	}

	return questions.slice(0, topN);
}

export function graphDiff(oldG: CompassGraph, newG: CompassGraph): GraphDiff {
	const oldNodes = new Set(oldG.nodes());
	const newNodes = new Set(newG.nodes());

	const addedNodeIds = [...newNodes].filter(n => !oldNodes.has(n));
	const removedNodeIds = [...oldNodes].filter(n => !newNodes.has(n));

	const newNodesList = addedNodeIds.map(n => ({
		id: n,
		label: newG.getNodeAttribute(n, 'label') ?? n,
	}));
	const removedNodesList = removedNodeIds.map(n => ({
		id: n,
		label: oldG.getNodeAttribute(n, 'label') ?? n,
	}));

	type EdgeKey = string;
	function edgeKey(u: string, v: string, relation: string): EdgeKey {
		const [a, b] = u < v ? [u, v] : [v, u];
		return `${a}||${b}||${relation}`;
	}

	const oldEdgeKeys = new Set<EdgeKey>();
	oldG.forEachEdge((_, attrs, u, v) => {
		oldEdgeKeys.add(edgeKey(u, v, attrs.relation ?? ''));
	});

	const newEdgeKeys = new Set<EdgeKey>();
	newG.forEachEdge((_, attrs, u, v) => {
		newEdgeKeys.add(edgeKey(u, v, attrs.relation ?? ''));
	});

	const newEdgesList: GraphDiff['new_edges'] = [];
	newG.forEachEdge((_, attrs, u, v) => {
		const key = edgeKey(u, v, attrs.relation ?? '');
		if (!oldEdgeKeys.has(key)) {
			newEdgesList.push({
				source: u, target: v,
				relation: attrs.relation ?? '',
				confidence: attrs.confidence ?? '',
			});
		}
	});

	const removedEdgesList: GraphDiff['removed_edges'] = [];
	oldG.forEachEdge((_, attrs, u, v) => {
		const key = edgeKey(u, v, attrs.relation ?? '');
		if (!newEdgeKeys.has(key)) {
			removedEdgesList.push({
				source: u, target: v,
				relation: attrs.relation ?? '',
				confidence: attrs.confidence ?? '',
			});
		}
	});

	const parts: string[] = [];
	if (newNodesList.length > 0) parts.push(`${newNodesList.length} new node${newNodesList.length !== 1 ? 's' : ''}`);
	if (newEdgesList.length > 0) parts.push(`${newEdgesList.length} new edge${newEdgesList.length !== 1 ? 's' : ''}`);
	if (removedNodesList.length > 0) parts.push(`${removedNodesList.length} node${removedNodesList.length !== 1 ? 's' : ''} removed`);
	if (removedEdgesList.length > 0) parts.push(`${removedEdgesList.length} edge${removedEdgesList.length !== 1 ? 's' : ''} removed`);

	return {
		new_nodes: newNodesList,
		removed_nodes: removedNodesList,
		new_edges: newEdgesList,
		removed_edges: removedEdgesList,
		summary: parts.length > 0 ? parts.join(', ') : 'no changes',
	};
}
