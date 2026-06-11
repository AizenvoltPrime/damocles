import type { GraphStore } from './database';
import type { StoredNode, ChangeAnalysis, ChangeRisk } from './types';
import { SECURITY_KEYWORDS } from './types';
import { parseGitDiffRanges } from './git';

const MAX_CHANGED_FUNCS = 500;

export function mapChangesToNodes(
	store: GraphStore,
	changedRanges: Map<string, Array<[number, number]>>,
	workspaceRoot?: string,
): StoredNode[] {
	const seen = new Set<string>();
	const result: StoredNode[] = [];
	const resolved = store.resolveGraphFilePathsGrouped([...changedRanges.keys()], workspaceRoot);

	for (const [filePath, ranges] of changedRanges) {
		const nodes: StoredNode[] = [];
		for (const mp of resolved.get(filePath) ?? []) {
			nodes.push(...store.getNodesByFile(mp));
		}

		for (const node of nodes) {
			if (seen.has(node.qualified_name)) continue;
			for (const [start, end] of ranges) {
				if (node.line_start <= end && node.line_end >= start) {
					result.push(node);
					seen.add(node.qualified_name);
					break;
				}
			}
		}
	}

	return result;
}

export interface RiskAnalysis {
	score: number;
	factors: string[];
	testCoverage: boolean;
}

export function computeRiskScore(store: GraphStore, node: StoredNode): number {
	return analyzeNodeRisk(store, node).score;
}

export function analyzeNodeRisk(store: GraphStore, node: StoredNode): RiskAnalysis {
	let score = 0;
	const factors: string[] = [];

	const flowCriticalities = store.getFlowCriticalitiesForNode(node.id);
	const criticalitySum = flowCriticalities.reduce((acc, c) => acc + c, 0);
	score += Math.min(criticalitySum, 0.25);
	if (flowCriticalities.length > 0) factors.push('flow_participation');

	const allTargetEdges = store.getEdgesByTarget(node.qualified_name);
	const callerEdges = allTargetEdges.filter(e => e.kind === 'CALLS' || e.kind === 'REFERENCES');

	const nodeCid = store.getNodeCommunityId(node.id);
	if (nodeCid !== null && callerEdges.length > 0) {
		const callerQns = callerEdges.map(e => e.source_qualified);
		const cidMap = store.getCommunityIdsByQualifiedNames(callerQns);
		let crossCommunity = 0;
		for (const cid of cidMap.values()) {
			if (cid !== null && cid !== nodeCid) crossCommunity++;
		}
		score += Math.min(crossCommunity * 0.05, 0.15);
	}

	const hasTest = allTargetEdges.some(e => e.kind === 'TESTED_BY');
	score += hasTest ? 0.05 : 0.30;
	if (!hasTest) factors.push('no_test_coverage');

	const nameLower = node.name.toLowerCase();
	const qnLower = node.qualified_name.toLowerCase();
	for (const kw of SECURITY_KEYWORDS) {
		if (nameLower.includes(kw) || qnLower.includes(kw)) {
			score += 0.20;
			factors.push('security_sensitive');
			break;
		}
	}

	score += Math.min(callerEdges.length / 20, 0.10);
	if (callerEdges.length > 3) factors.push('high_caller_count');

	const rounded = Math.round(Math.min(Math.max(score, 0), 1) * 10000) / 10000;
	return { score: rounded, factors, testCoverage: hasTest };
}

export function analyzeChanges(
	store: GraphStore,
	changedFiles: string[],
	changedRanges?: Map<string, Array<[number, number]>>,
	workspaceRoot?: string,
	base: string = 'HEAD~1',
): ChangeAnalysis {
	if (!changedRanges && workspaceRoot) {
		changedRanges = parseGitDiffRanges(workspaceRoot, base);
	}

	let changedNodes: StoredNode[];
	if (changedRanges && changedRanges.size > 0) {
		changedNodes = mapChangesToNodes(store, changedRanges, workspaceRoot);
	} else {
		changedNodes = [];
		for (const mp of store.resolveGraphFilePaths(changedFiles, workspaceRoot)) {
			changedNodes.push(...store.getNodesByFile(mp));
		}
	}

	const allChangedFuncs = changedNodes
		.filter(n => n.kind === 'Function' || n.kind === 'Test' || n.kind === 'Class')
		.sort((a, b) => a.qualified_name.localeCompare(b.qualified_name));

	const truncated = allChangedFuncs.length > MAX_CHANGED_FUNCS;
	const changedFuncs = truncated ? allChangedFuncs.slice(0, MAX_CHANGED_FUNCS) : allChangedFuncs;

	const testGaps: StoredNode[] = [];
	const risks: ChangeRisk[] = changedFuncs.map(node => {
		const analysis = analyzeNodeRisk(store, node);

		if (!node.is_test && !analysis.testCoverage) {
			testGaps.push(node);
		}

		let riskLevel: 'HIGH' | 'MEDIUM' | 'LOW';
		if (analysis.score >= 0.6) riskLevel = 'HIGH';
		else if (analysis.score >= 0.3) riskLevel = 'MEDIUM';
		else riskLevel = 'LOW';

		return {
			node,
			risk_score: analysis.score,
			risk_level: riskLevel,
			factors: analysis.factors,
			test_coverage: analysis.testCoverage,
		};
	});

	risks.sort((a, b) => b.risk_score - a.risk_score);

	const rangesRecord: Record<string, Array<[number, number]>> = {};
	if (changedRanges) {
		for (const [k, v] of changedRanges) {
			rangesRecord[k] = v;
		}
	}

	return {
		changed_files: changedFiles,
		changed_ranges: rangesRecord,
		risks,
		test_gaps: testGaps,
		total_changed_funcs: allChangedFuncs.length,
		truncated,
	};
}
