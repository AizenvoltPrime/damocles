import * as fs from 'fs';
import * as path from 'path';
import type { CompassService } from './index';
import type { GraphStore } from './database';
import type { StoredNode, StoredFlow, StoredCommunity, DetailLevel, ChangeRisk, FlowInfo, CommunityInfo, CompassConfig } from './types';
import { searchNodes } from './search';
import { computeBlastRadius } from './impact';
import { analyzeChanges } from './changes';
import { getChangedFiles, fullBuild, incrementalUpdate } from './incremental';
import { getFlows, getFlowById, getAffectedFlows, traceFlows, storeFlows } from './flows';
import { getCommunities, getCommunityById, getArchitectureOverview, detectCommunities, storeCommunities } from './communities';

type SdkCreateServer = typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
type SdkTool = typeof import('@anthropic-ai/claude-agent-sdk').tool;
type ZodZ = typeof import('zod').z;

function textResult(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}

function formatNode(n: StoredNode, level: DetailLevel): string {
	if (level === 'minimal') return `${n.name} (${n.kind}, ${n.file_path}:${n.line_start})`;
	const base = `${n.name} — ${n.kind} @ ${n.file_path}:${n.line_start}-${n.line_end}`;
	if (level === 'summary') return [base, n.params && `params: ${n.params}`, n.return_type && `→ ${n.return_type}`].filter(Boolean).join(', ');
	return [base, n.params && `  params: ${n.params}`, n.return_type && `  return: ${n.return_type}`, n.parent_name && `  parent: ${n.parent_name}`, n.signature && `  signature: ${n.signature}`, n.language && `  language: ${n.language}`].filter(Boolean).join('\n');
}

function formatRisk(r: ChangeRisk, level: DetailLevel): string {
	if (level === 'minimal') return `[${r.risk_level}] ${r.node.name} (${r.risk_score.toFixed(2)})`;
	return `[${r.risk_level}] ${r.node.name} — score: ${r.risk_score.toFixed(2)}, factors: ${r.factors.join(', ')}, ${r.node.file_path}:${r.node.line_start}`;
}

function formatFlow(f: StoredFlow, level: DetailLevel): string {
	if (level === 'minimal') return `${f.name} (criticality: ${f.criticality.toFixed(2)})`;
	return `${f.name} — depth: ${f.depth}, nodes: ${f.node_count}, files: ${f.file_count}, criticality: ${f.criticality.toFixed(4)}`;
}

function formatCommunity(c: StoredCommunity, level: DetailLevel): string {
	if (level === 'minimal') return `${c.name} (size: ${c.size})`;
	return `${c.name} — size: ${c.size}, cohesion: ${c.cohesion.toFixed(4)}, lang: ${c.dominant_language ?? 'mixed'}`;
}

function resolveTarget(store: GraphStore, target: string): StoredNode | undefined {
	const exact = store.getNode(target);
	if (exact) return exact;
	const results = searchNodes(store, target, { limit: 1 });
	return results[0]?.node;
}

function isWithinWorkspace(filePath: string, workspace: string): boolean {
	const resolved = path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
	const root = path.resolve(workspace).replace(/\\/g, '/').toLowerCase();
	return resolved.startsWith(root + '/') || resolved === root;
}

function readSourceLines(filePath: string, lineStart: number, lineEnd: number, workspace: string): string | null {
	if (!isWithinWorkspace(filePath, workspace)) return null;
	try {
		const content = fs.readFileSync(filePath, 'utf8');
		const lines = content.split('\n');
		return lines.slice(lineStart - 1, lineEnd).join('\n');
	} catch {
		return null;
	}
}

function suggestNextTools(task?: string): string {
	const t = (task ?? '').toLowerCase();
	if (t.includes('review') || t.includes('pr')) {
		return 'Next: compass_blast_radius → compass_review_context';
	}
	if (t.includes('debug') || t.includes('fix') || t.includes('bug')) {
		return 'Next: compass_search → compass_query(callers_of)';
	}
	if (t.includes('explore') || t.includes('understand') || t.includes('architect')) {
		return 'Next: compass_architecture → compass_list_communities';
	}
	return 'Next: compass_search for entities, compass_blast_radius for impact';
}

export function handleContext(
	store: GraphStore, workspace: string,
	input: { task?: string | undefined; changed_files?: string[] | undefined; base?: string | undefined },
): string {
	const stats = store.getStats();
	const lines: string[] = [
		`Graph: ${stats.total_nodes} nodes, ${stats.total_edges} edges, ${store.getCommunityCount()} communities, ${store.getFlowCount()} flows`,
	];

	if (input.changed_files?.length) {
		const analysis = analyzeChanges(store, input.changed_files, undefined, workspace, input.base);
		const high = analysis.risks.filter(r => r.risk_level === 'HIGH').length;
		const med = analysis.risks.filter(r => r.risk_level === 'MEDIUM').length;
		lines.push(`Changes: ${input.changed_files.length} files → ${high} HIGH, ${med} MEDIUM risk`);
		if (analysis.test_gaps.length > 0) {
			lines.push(`Test gaps: ${analysis.test_gaps.length} untested`);
		}
	}

	lines.push('', suggestNextTools(input.task));
	return lines.join('\n');
}

export function handleSearch(
	store: GraphStore,
	input: { query: string; kind?: string | undefined; limit?: number | undefined; detail_level?: string | undefined },
): string {
	const level = (input.detail_level ?? 'summary') as DetailLevel;
	const results = searchNodes(store, input.query, {
		kind: input.kind as import('./types').NodeKind | undefined,
		limit: input.limit,
	});
	if (results.length === 0) return `No results for "${input.query}"`;
	return `Results (${results.length}):\n${results.map(r => formatNode(r.node, level)).join('\n')}`;
}

function handleFileSummary(store: GraphStore, target: string, level: DetailLevel): string {
	let nodes = store.getNodesByFile(target);
	if (nodes.length === 0) {
		const matched = store.getFilesMatchingSuffix(target);
		for (const mp of matched) nodes.push(...store.getNodesByFile(mp));
	}
	if (nodes.length === 0) return `No entities found in "${target}"`;
	return `File: ${target} (${nodes.length} entities)\n${nodes.map(n => formatNode(n, level)).join('\n')}`;
}

export function handleQuery(
	store: GraphStore,
	input: { pattern: string; target: string; detail_level?: string | undefined },
): string {
	const level = (input.detail_level ?? 'summary') as DetailLevel;

	if (input.pattern === 'file_summary') {
		return handleFileSummary(store, input.target, level);
	}

	const node = resolveTarget(store, input.target);
	if (!node) return `No entity found for "${input.target}"`;

	const qn = node.qualified_name;
	const PATTERNS: Record<string, { dir: 'source' | 'target'; kind?: string; kinds?: string[]; label: string }> = {
		callers_of: { dir: 'target', kind: 'CALLS', label: 'Callers of' },
		callees_of: { dir: 'source', kind: 'CALLS', label: 'Callees of' },
		imports_of: { dir: 'source', kind: 'IMPORTS_FROM', label: 'Imports of' },
		importers_of: { dir: 'target', kind: 'IMPORTS_FROM', label: 'Importers of' },
		children_of: { dir: 'source', kind: 'CONTAINS', label: 'Children of' },
		tests_for: { dir: 'target', kind: 'TESTED_BY', label: 'Tests for' },
		inheritors_of: { dir: 'target', kinds: ['INHERITS', 'IMPLEMENTS'], label: 'Inheritors of' },
		references_of: { dir: 'source', kind: 'REFERENCES', label: 'References of' },
		referencers_of: { dir: 'target', kind: 'REFERENCES', label: 'Referencers of' },
	};

	const pattern = PATTERNS[input.pattern];
	if (!pattern) return `Unknown pattern "${input.pattern}". Valid: callers_of, callees_of, imports_of, importers_of, children_of, tests_for, inheritors_of, references_of, referencers_of, file_summary`;

	const allEdges = pattern.dir === 'source' ? store.getEdgesBySource(qn) : store.getEdgesByTarget(qn);
	const matchKinds = pattern.kinds ?? [pattern.kind];
	const edges = allEdges.filter(e => matchKinds.includes(e.kind));
	const nodes: StoredNode[] = [];
	for (const e of edges) {
		const resolvedQn = pattern.dir === 'source' ? e.target_qualified : e.source_qualified;
		const n = store.getNode(resolvedQn);
		if (n) nodes.push(n);
	}

	if ((input.pattern === 'inheritors_of' || input.pattern === 'callers_of') && nodes.length === 0) {
		const fallbackEdges = store.getEdgesByTargetName(node.name, matchKinds as string[]);
		const FALLBACK_CAP = 25;
		for (const e of fallbackEdges) {
			if (nodes.length >= FALLBACK_CAP) break;
			const n = store.getNode(e.source_qualified);
			if (n && !nodes.some(existing => existing.id === n.id)) nodes.push(n);
		}
	}

	const label = `${pattern.label} ${node.name}`;
	if (nodes.length === 0) return `${label}: none`;
	return `${label} (${nodes.length}):\n${nodes.map(n => formatNode(n, level)).join('\n')}`;
}

export function handleStats(store: GraphStore): string {
	const stats = store.getStats();
	const lines = [
		`Nodes: ${stats.total_nodes}`,
		`  ${Object.entries(stats.nodes_by_kind).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
		`Edges: ${stats.total_edges}`,
		`  ${Object.entries(stats.edges_by_kind).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
		`Languages: ${stats.languages.join(', ') || 'none'}`,
		`Files: ${stats.files_count}`,
		`Communities: ${store.getCommunityCount()}`,
		`Flows: ${store.getFlowCount()}`,
	];
	if (stats.last_updated) lines.push(`Last Updated: ${stats.last_updated}`);
	return lines.join('\n');
}

export function handleBlastRadius(
	store: GraphStore,
	input: { changed_files: string[]; max_depth?: number | undefined; max_results?: number | undefined; detail_level?: string | undefined },
): string {
	const level = (input.detail_level ?? 'summary') as DetailLevel;
	const result = computeBlastRadius(store, input.changed_files, input.max_depth, input.max_results);

	if (result.changed_nodes.length === 0 && result.impacted_nodes.length === 0) {
		return 'No impact detected for the given files.';
	}

	const lines: string[] = [
		`Changed: ${result.changed_nodes.length} nodes`,
		`Impacted: ${result.total_impacted} nodes${result.truncated ? ' (truncated)' : ''}`,
		`Files affected: ${result.impacted_files.length}`,
	];

	if (level !== 'minimal') {
		lines.push('', '--- Impacted Files ---');
		for (const f of result.impacted_files) lines.push(f);
	}

	if (level === 'full') {
		lines.push('', '--- Changed Nodes ---');
		for (const n of result.changed_nodes) lines.push(formatNode(n, level));
		lines.push('', '--- Impacted Nodes ---');
		for (const n of result.impacted_nodes) lines.push(formatNode(n, level));
	}

	return lines.join('\n');
}

export function handleDetectChanges(
	store: GraphStore, workspace: string,
	input: { base?: string | undefined; changed_files?: string[] | undefined; detail_level?: string | undefined },
): string {
	const level = (input.detail_level ?? 'summary') as DetailLevel;

	let files = input.changed_files;
	if (!files || files.length === 0) {
		files = getChangedFiles(workspace, input.base);
	}
	if (files.length === 0) return 'No changed files detected.';

	const analysis = analyzeChanges(store, files, undefined, workspace, input.base);

	if (analysis.risks.length === 0) return 'No changed entities detected.';

	const lines: string[] = [
		`Changed files: ${analysis.changed_files.length}`,
		`Risks: ${analysis.risks.length}`,
	];
	for (const risk of analysis.risks) lines.push(formatRisk(risk, level));

	if (analysis.test_gaps.length > 0 && level !== 'minimal') {
		lines.push('', `Test Gaps (${analysis.test_gaps.length}):`);
		for (const gap of analysis.test_gaps) {
			lines.push(`  ${gap.name} @ ${gap.file_path}:${gap.line_start}`);
		}
	}

	return lines.join('\n');
}

export function handleReviewContext(
	store: GraphStore, workspace: string,
	input: { changed_files: string[]; max_depth?: number | undefined; include_source?: boolean | undefined; base?: string | undefined },
): string {
	const analysis = analyzeChanges(store, input.changed_files, undefined, workspace, input.base);
	const impact = computeBlastRadius(store, input.changed_files, input.max_depth);
	const affected = getAffectedFlows(store, input.changed_files);

	const lines: string[] = [
		'=== Review Context ===',
		'',
		`Changed Files: ${input.changed_files.length}`,
		`Risk: ${analysis.risks.filter(r => r.risk_level === 'HIGH').length} HIGH, ${analysis.risks.filter(r => r.risk_level === 'MEDIUM').length} MEDIUM, ${analysis.risks.filter(r => r.risk_level === 'LOW').length} LOW`,
		`Blast Radius: ${impact.total_impacted} nodes across ${impact.impacted_files.length} files`,
		`Affected Flows: ${affected.total}`,
		`Test Gaps: ${analysis.test_gaps.length}`,
	];

	if (analysis.risks.length > 0) {
		lines.push('', '--- Risks ---');
		for (const risk of analysis.risks.slice(0, 10)) lines.push(formatRisk(risk, 'summary'));
	}

	if (impact.impacted_files.length > 0) {
		lines.push('', '--- Impacted Files ---');
		for (const f of impact.impacted_files.slice(0, 20)) lines.push(f);
	}

	if (affected.flows.length > 0) {
		lines.push('', '--- Affected Flows ---');
		for (const f of affected.flows.slice(0, 10)) lines.push(formatFlow(f, 'summary'));
	}

	if (input.include_source && analysis.risks.length > 0) {
		lines.push('', '--- Changed Function Sources ---');
		for (const risk of analysis.risks.slice(0, 5)) {
			const source = readSourceLines(risk.node.file_path, risk.node.line_start, risk.node.line_end, workspace);
			if (source) {
				lines.push(`\n// ${risk.node.name} @ ${risk.node.file_path}:${risk.node.line_start}-${risk.node.line_end}`);
				lines.push(source);
			}
		}
	}

	return lines.join('\n');
}

export function handleListFlows(
	store: GraphStore,
	input: { sort_by?: string | undefined; limit?: number | undefined; detail_level?: string | undefined },
): string {
	const level = (input.detail_level ?? 'summary') as DetailLevel;
	const flows = getFlows(store, input.sort_by, input.limit);
	if (flows.length === 0) return 'No flows detected. Run compass_postprocess with flows=true.';
	return `Flows (${flows.length}):\n${flows.map(f => formatFlow(f, level)).join('\n')}`;
}

export function handleGetFlow(
	store: GraphStore,
	input: { flow_id?: number | undefined; flow_name?: string | undefined; include_source?: boolean | undefined },
	workspace: string = '',
): string {
	let info: FlowInfo | null = null;
	if (input.flow_id !== undefined) {
		info = getFlowById(store, input.flow_id);
	} else if (input.flow_name) {
		const flows = getFlows(store);
		const match = flows.find(f => f.name === input.flow_name);
		if (match) info = getFlowById(store, match.id);
	}
	if (!info) return 'Flow not found.';

	const lines = [
		`Flow: ${info.flow.name}`,
		`Depth: ${info.flow.depth}, Nodes: ${info.flow.node_count}, Files: ${info.flow.file_count}`,
		`Criticality: ${info.flow.criticality.toFixed(4)}`,
		'',
		'Call path:',
	];
	for (const n of info.nodes) {
		lines.push(`  ${formatNode(n, 'summary')}`);
		if (input.include_source) {
			const source = readSourceLines(n.file_path, n.line_start, n.line_end, workspace);
			if (source) lines.push(source.split('\n').map(l => `    ${l}`).join('\n'));
		}
	}
	return lines.join('\n');
}

export function handleListCommunities(
	store: GraphStore,
	input: { sort_by?: string | undefined; min_size?: number | undefined; detail_level?: string | undefined },
): string {
	const level = (input.detail_level ?? 'summary') as DetailLevel;
	const communities = getCommunities(store, input.sort_by, input.min_size);
	if (communities.length === 0) return 'No communities detected. Run compass_postprocess with communities=true.';
	return `Communities (${communities.length}):\n${communities.map(c => formatCommunity(c, level)).join('\n')}`;
}

export function handleGetCommunity(
	store: GraphStore,
	input: { community_id?: number | undefined; community_name?: string | undefined },
): string {
	let info: CommunityInfo | null = null;
	if (input.community_id !== undefined) {
		info = getCommunityById(store, input.community_id);
	} else if (input.community_name) {
		const communities = getCommunities(store);
		const match = communities.find(c => c.name === input.community_name);
		if (match) info = getCommunityById(store, match.id);
	}
	if (!info) return 'Community not found.';

	const lines = [
		`Community: ${info.community.name}`,
		`Size: ${info.community.size}, Cohesion: ${info.community.cohesion.toFixed(4)}`,
		`Language: ${info.community.dominant_language ?? 'mixed'}`,
		'',
		`Members (${info.members.length}):`,
	];
	for (const m of info.members) lines.push(`  ${formatNode(m, 'minimal')}`);
	return lines.join('\n');
}

export function handleArchitecture(
	store: GraphStore,
	input: { detail_level?: string | undefined },
): string {
	const level = (input.detail_level ?? 'summary') as DetailLevel;
	const overview = getArchitectureOverview(store);

	if (overview.communities.length === 0) return 'No communities detected. Run compass_postprocess first.';

	const lines = [`Architecture (${overview.communities.length} communities):`];
	for (const c of overview.communities) lines.push(formatCommunity(c, level));

	if (overview.cross_edges.length > 0 && level !== 'minimal') {
		lines.push('', 'Cross-community edges:');
		for (const edge of overview.cross_edges.slice(0, 20)) {
			lines.push(`  #${edge.source_community} ↔ #${edge.target_community}: ${edge.edge_count} edges (${edge.edge_kinds.join(', ')})`);
		}
	}

	return lines.join('\n');
}

export async function handleBuild(
	store: GraphStore, workspace: string, config: CompassConfig,
	input: { full_rebuild?: boolean | undefined; postprocess?: boolean | undefined },
): Promise<string> {
	const result = input.full_rebuild
		? await fullBuild(store, workspace, config)
		: await incrementalUpdate(store, workspace);

	const lines = [
		`Build complete: ${result.filesParsed} files`,
		`Nodes: ${result.totalNodes}, Edges: ${result.totalEdges}`,
	];

	if (result.errors.length > 0) {
		lines.push(`Errors: ${result.errors.length}`);
		for (const err of result.errors.slice(0, 5)) lines.push(`  ${err.file}: ${err.error}`);
	}

	if (input.postprocess !== false) {
		const flows = traceFlows(store);
		storeFlows(store, flows);
		const comms = detectCommunities(store);
		storeCommunities(store, comms);
		lines.push(`Post-processed: ${flows.length} flows, ${comms.length} communities`);
	}

	return lines.join('\n');
}

export function handlePostprocess(
	store: GraphStore,
	input: { flows?: boolean | undefined; communities?: boolean | undefined; fts?: boolean | undefined },
): string {
	const lines: string[] = [];

	if (input.flows) {
		const flows = traceFlows(store);
		storeFlows(store, flows);
		lines.push(`Flows: ${flows.length} traced`);
	}

	if (input.communities) {
		const comms = detectCommunities(store);
		storeCommunities(store, comms);
		lines.push(`Communities: ${comms.length} detected`);
	}

	if (input.fts) {
		store.execRaw("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
		lines.push('FTS: index rebuilt');
	}

	if (lines.length === 0) return 'No steps selected. Specify flows, communities, or fts.';
	return lines.join('\n');
}

export function createCompassMcpServer(
	compassService: CompassService,
	createSdkMcpServer: SdkCreateServer,
	tool: SdkTool,
	z: ZodZ,
	_getSessionId: () => string,
	workspace: string,
): ReturnType<SdkCreateServer> {
	const readOnly = { annotations: { readOnlyHint: true } };
	const mutable = { annotations: { readOnlyHint: false } };

	return createSdkMcpServer({
		name: 'damocles-compass',
		version: '4.0.0',
		tools: [
			tool('compass_context', 'Ultra-compact workspace overview (~100 tokens). Stats + risk + next tool suggestions.', {
				task: z.string().optional().describe('Current task description for targeted suggestions'),
				changed_files: z.array(z.string()).optional().describe('Changed file paths for risk assessment'),
				base: z.string().optional().describe('Git ref to diff against'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(handleContext(compassService.store, workspace, input));
			}, readOnly),

			tool('compass_search', 'FTS5 BM25 search for code entities by name or keyword.', {
				query: z.string().describe('Entity name or keyword'),
				kind: z.enum(['File', 'Class', 'Function', 'Type', 'Test']).optional().describe('Filter by entity type'),
				limit: z.number().min(1).max(50).optional().describe('Max results (default 20)'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(handleSearch(compassService.store, input));
			}, readOnly),

			tool('compass_query', 'Structured relationship queries: callers, callees, imports, children, tests, inheritors, references.', {
				pattern: z.enum(['callers_of', 'callees_of', 'imports_of', 'importers_of', 'children_of', 'tests_for', 'inheritors_of', 'references_of', 'referencers_of', 'file_summary']).describe('Query pattern'),
				target: z.string().describe('Qualified name or entity name to resolve'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(handleQuery(compassService.store, input));
			}, readOnly),

			tool('compass_stats', 'Graph statistics: node/edge counts by kind, languages, last update.', {}, async () => {
				await compassService.ensureInitialized();
				return textResult(handleStats(compassService.store));
			}, readOnly),

			tool('compass_blast_radius', 'BFS impact analysis from changed files. Shows affected nodes, files, and edges.', {
				changed_files: z.array(z.string()).describe('Changed file paths'),
				max_depth: z.number().min(1).max(10).optional().describe('Max traversal depth (default 2)'),
				max_results: z.number().min(1).max(2000).optional().describe('Max impacted nodes (default 500)'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(handleBlastRadius(compassService.store, input));
			}, readOnly),

			tool('compass_detect_changes', 'Risk-scored change analysis with test gap detection.', {
				base: z.string().optional().describe('Git ref to diff against (default HEAD~1)'),
				changed_files: z.array(z.string()).optional().describe('Override auto-detection with explicit file list'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(handleDetectChanges(compassService.store, workspace, input));
			}, readOnly),

			tool('compass_review_context', 'Full review context: impact + risk + affected flows + optional source snippets.', {
				changed_files: z.array(z.string()).describe('Changed file paths'),
				max_depth: z.number().min(1).max(10).optional().describe('Blast radius depth'),
				include_source: z.boolean().optional().describe('Include source code snippets'),
				base: z.string().optional().describe('Git ref to diff against'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(handleReviewContext(compassService.store, workspace, input));
			}, readOnly),

			tool('compass_list_flows', 'List execution flows sorted by criticality.', {
				sort_by: z.enum(['criticality', 'depth', 'node_count', 'file_count', 'name']).optional().describe('Sort field'),
				limit: z.number().min(1).max(200).optional().describe('Max results'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(handleListFlows(compassService.store, input));
			}, readOnly),

			tool('compass_get_flow', 'Single execution flow details with call path.', {
				flow_id: z.number().optional().describe('Flow ID'),
				flow_name: z.string().optional().describe('Flow name'),
				include_source: z.boolean().optional().describe('Include source code'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(handleGetFlow(compassService.store, input, workspace));
			}, readOnly),

			tool('compass_list_communities', 'List code communities by size or cohesion.', {
				sort_by: z.enum(['size', 'cohesion', 'name']).optional().describe('Sort field'),
				min_size: z.number().min(0).optional().describe('Minimum community size'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(handleListCommunities(compassService.store, input));
			}, readOnly),

			tool('compass_get_community', 'Community details with member list.', {
				community_id: z.number().optional().describe('Community ID'),
				community_name: z.string().optional().describe('Community name'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(handleGetCommunity(compassService.store, input));
			}, readOnly),

			tool('compass_architecture', 'Architecture overview: communities + cross-community coupling.', {
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(handleArchitecture(compassService.store, input));
			}, readOnly),

			tool('compass_build', 'Build or incrementally update the workspace knowledge graph.', {
				full_rebuild: z.boolean().optional().describe('Force full rebuild (default: incremental)'),
				postprocess: z.boolean().optional().describe('Run post-processing (default: true)'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await handleBuild(compassService.store, workspace, compassService.config, input));
			}, mutable),

			tool('compass_postprocess', 'Recompute flows, communities, or FTS index independently.', {
				flows: z.boolean().optional().describe('Recompute execution flows'),
				communities: z.boolean().optional().describe('Recompute community detection'),
				fts: z.boolean().optional().describe('Rebuild FTS5 search index'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(handlePostprocess(compassService.store, input));
			}, mutable),
		],
	});
}
