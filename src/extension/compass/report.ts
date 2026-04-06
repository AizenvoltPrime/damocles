import type { CompassGraph, CommunityMap, CohesionScores, GodNode, SurprisingConnection, SuggestedQuestion, DetectionResult } from './types';
import { isFileNode, isConceptNode } from './types';

export function generateReport(
	G: CompassGraph,
	communities: CommunityMap,
	cohesionScores: CohesionScores,
	communityLabels: Record<number, string>,
	godNodeList: GodNode[],
	surpriseList: SurprisingConnection[],
	detectionResult: DetectionResult,
	tokenCost: { input: number; output: number },
	root: string,
	suggestedQuestions?: SuggestedQuestion[],
): string {
	const today = new Date().toISOString().split('T')[0];

	const confidences: string[] = [];
	G.forEachEdge((_, attrs) => {
		confidences.push(attrs.confidence ?? 'EXTRACTED');
	});
	const total = confidences.length || 1;
	const extPct = Math.round(confidences.filter(c => c === 'EXTRACTED').length / total * 100);
	const infPct = Math.round(confidences.filter(c => c === 'INFERRED').length / total * 100);
	const ambPct = Math.round(confidences.filter(c => c === 'AMBIGUOUS').length / total * 100);

	const infScores: number[] = [];
	G.forEachEdge((_, attrs) => {
		if (attrs.confidence === 'INFERRED') {
			infScores.push(attrs.confidence_score ?? 0.5);
		}
	});
	const infAvg = infScores.length > 0
		? Math.round(infScores.reduce((a, b) => a + b, 0) / infScores.length * 100) / 100
		: null;

	const lines: string[] = [
		`# Graph Report - ${root}  (${today})`,
		'',
		'## Corpus Check',
	];

	if (detectionResult.warning) {
		lines.push(`- ${detectionResult.warning}`);
	} else {
		lines.push(`- ${detectionResult.total_files} files · ~${detectionResult.total_words.toLocaleString()} words`);
		lines.push('- Verdict: corpus is large enough that graph structure adds value.');
	}

	let summaryLine = `- Extraction: ${extPct}% EXTRACTED · ${infPct}% INFERRED · ${ambPct}% AMBIGUOUS`;
	if (infAvg !== null) {
		summaryLine += ` · INFERRED: ${infScores.length} edges (avg confidence: ${infAvg})`;
	}

	lines.push(
		'',
		'## Summary',
		`- ${G.order} nodes · ${G.size} edges · ${Object.keys(communities).length} communities detected`,
		summaryLine,
		`- Token cost: ${tokenCost.input.toLocaleString()} input · ${tokenCost.output.toLocaleString()} output`,
		'',
		'## God Nodes (most connected - your core abstractions)',
	);

	for (let i = 0; i < godNodeList.length; i++) {
		const node = godNodeList[i]!;
		lines.push(`${i + 1}. \`${node.label}\` - ${node.edges} edges`);
	}

	lines.push('', '## Surprising Connections (you probably didn\'t know these)');
	if (surpriseList.length > 0) {
		for (const s of surpriseList) {
			const relation = s.relation ?? 'related_to';
			const note = s.note ?? '';
			const files = s.source_files ?? ['', ''];
			const conf = s.confidence ?? 'EXTRACTED';
			const confTag = conf;
			const semTag = relation === 'semantically_similar_to' ? ' [semantically similar]' : '';
			lines.push(
				`- \`${s.source}\` --${relation}--> \`${s.target}\`  [${confTag}]${semTag}`,
				`  ${files[0]} → ${files[1]}` + (note ? `  _${note}_` : ''),
			);
		}
	} else {
		lines.push('- None detected - all connections are within the same source files.');
	}

	lines.push('', '## Communities');
	for (const [cidStr, nodes] of Object.entries(communities)) {
		const cid = Number(cidStr);
		const label = communityLabels[cid] ?? `Community ${cid}`;
		const score = cohesionScores[cid] ?? 0.0;
		const realNodes = nodes.filter((n: string) => !isFileNode(G, n));
		const display = realNodes.slice(0, 8).map((n: string) => G.getNodeAttribute(n, 'label') ?? n);
		const suffix = realNodes.length > 8 ? ` (+${realNodes.length - 8} more)` : '';
		lines.push(
			'',
			`### Community ${cid} - "${label}"`,
			`Cohesion: ${score}`,
			`Nodes (${realNodes.length}): ${display.join(', ')}${suffix}`,
		);
	}

	const ambiguous: Array<{ u: string; v: string; relation: string; source_file: string }> = [];
	G.forEachEdge((_, attrs, u, v) => {
		if (attrs.confidence === 'AMBIGUOUS') {
			ambiguous.push({
				u, v,
				relation: attrs.relation ?? 'unknown',
				source_file: attrs.source_file ?? '',
			});
		}
	});

	if (ambiguous.length > 0) {
		lines.push('', '## Ambiguous Edges - Review These');
		for (const e of ambiguous) {
			const ul = G.getNodeAttribute(e.u, 'label') ?? e.u;
			const vl = G.getNodeAttribute(e.v, 'label') ?? e.v;
			lines.push(
				`- \`${ul}\` → \`${vl}\`  [AMBIGUOUS]`,
				`  ${e.source_file} · relation: ${e.relation}`,
			);
		}
	}

	const isolated: string[] = [];
	G.forEachNode(nodeId => {
		if (G.degree(nodeId) <= 1 && !isFileNode(G, nodeId) && !isConceptNode(G, nodeId)) {
			isolated.push(nodeId);
		}
	});
	const thinCommunities: Record<number, string[]> = {};
	for (const [cidStr, nodes] of Object.entries(communities)) {
		if (nodes.length < 3) thinCommunities[Number(cidStr)] = nodes;
	}
	const gapCount = isolated.length + Object.keys(thinCommunities).length;

	if (gapCount > 0 || ambPct > 20) {
		lines.push('', '## Knowledge Gaps');
		if (isolated.length > 0) {
			const isolatedLabels = isolated.slice(0, 5).map(n => G.getNodeAttribute(n, 'label') ?? n);
			const suffix = isolated.length > 5 ? ` (+${isolated.length - 5} more)` : '';
			lines.push(`- **${isolated.length} isolated node(s):** ${isolatedLabels.map(l => `\`${l}\``).join(', ')}${suffix}`);
			lines.push('  These have ≤1 connection - possible missing edges or undocumented components.');
		}
		if (Object.keys(thinCommunities).length > 0) {
			for (const [cidStr, nodes] of Object.entries(thinCommunities)) {
				const cid = Number(cidStr);
				const label = communityLabels[cid] ?? `Community ${cid}`;
				const nodeLabels = nodes.map(n => G.getNodeAttribute(n, 'label') ?? n);
				lines.push(`- **Thin community \`${label}\`** (${nodes.length} nodes): ${nodeLabels.map(l => `\`${l}\``).join(', ')}`);
				lines.push('  Too small to be a meaningful cluster - may be noise or needs more connections extracted.');
			}
		}
		if (ambPct > 20) {
			lines.push(`- **High ambiguity: ${ambPct}% of edges are AMBIGUOUS.** Review the Ambiguous Edges section above.`);
		}
	}

	if (suggestedQuestions && suggestedQuestions.length > 0) {
		lines.push('', '## Suggested Questions');
		const noSignal = suggestedQuestions.length === 1 && suggestedQuestions[0]!.type === 'no_signal';
		if (noSignal) {
			lines.push(`_${suggestedQuestions[0]!.why}_`);
		} else {
			lines.push('_Questions this graph is uniquely positioned to answer:_');
			lines.push('');
			for (const q of suggestedQuestions) {
				if (q.question) {
					lines.push(`- **${q.question}**`);
					lines.push(`  _${q.why}_`);
				}
			}
		}
	}

	return lines.join('\n');
}
