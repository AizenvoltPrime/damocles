import * as fs from 'fs';
import * as path from 'path';
import type { GraphStore } from './database';
import type { StoredNode, DetailLevel, ChangeRisk, CompassConfig, NodeKind } from './types';
import { searchNodes } from './search';
import { computeBlastRadius } from './impact';
import { analyzeChanges } from './changes';
import { getChangedFiles } from './git';
import { fullBuild, incrementalUpdate } from './incremental';
import { getAffectedFlows } from './flows';
import { runPostProcess } from './post-process';
import { isKnownExternal } from './known-externals';
import { estimateSavings, estimateSourceChars, formatSavingsLine } from './context-savings';
import { findDeadCode } from './refactor';

export function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
	return { content: [{ type: 'text' as const, text }] };
}

export function formatNode(n: StoredNode, level: DetailLevel): string {
	if (level === 'minimal') return `${n.name} (${n.kind}, ${n.file_path}:${n.line_start})`;
	const base = `${n.name} — ${n.kind} @ ${n.file_path}:${n.line_start}-${n.line_end}`;
	if (level === 'summary') return [base, n.params && `params: ${n.params}`, n.return_type && `→ ${n.return_type}`].filter(Boolean).join(', ');
	return [base, n.params && `  params: ${n.params}`, n.return_type && `  return: ${n.return_type}`, n.parent_name && `  parent: ${n.parent_name}`, n.signature && `  signature: ${n.signature}`, n.language && `  language: ${n.language}`].filter(Boolean).join('\n');
}

export function formatRisk(r: ChangeRisk, level: DetailLevel): string {
	if (level === 'minimal') return `[${r.risk_level}] ${r.node.name} (${r.risk_score.toFixed(2)})`;
	return `[${r.risk_level}] ${r.node.name} — score: ${r.risk_score.toFixed(2)}, factors: ${r.factors.join(', ')}, ${r.node.file_path}:${r.node.line_start}`;
}

const QUERY_PATTERNS: Record<string, { dir: 'source' | 'target'; kind?: string; kinds?: string[]; label: string; prefer?: readonly NodeKind[] }> = {
	callers_of: { dir: 'target', kind: 'CALLS', label: 'Callers of', prefer: ['Function'] },
	callees_of: { dir: 'source', kind: 'CALLS', label: 'Callees of', prefer: ['Function'] },
	imports_of: { dir: 'source', kind: 'IMPORTS_FROM', label: 'Imports of', prefer: ['File'] },
	importers_of: { dir: 'target', kind: 'IMPORTS_FROM', label: 'Importers of', prefer: ['File'] },
	children_of: { dir: 'source', kind: 'CONTAINS', label: 'Children of', prefer: ['File', 'Class'] },
	tests_for: { dir: 'target', kind: 'TESTED_BY', label: 'Tests for' },
	inheritors_of: { dir: 'target', kinds: ['INHERITS', 'IMPLEMENTS'], label: 'Inheritors of', prefer: ['Class', 'Type'] },
	references_of: { dir: 'source', kind: 'REFERENCES', label: 'References from' },
	referencers_of: { dir: 'target', kind: 'REFERENCES', label: 'Referencers of' },
};

export interface ResolvedTarget {
	node: StoredNode;
	alternates: StoredNode[];
}

function byPreference(nodes: StoredNode[], preferKinds?: readonly NodeKind[]): StoredNode[] {
	if (!preferKinds?.length) return nodes;
	const preferred = nodes.filter(n => preferKinds.includes(n.kind));
	return preferred.length > 0 ? preferred : nodes;
}

function nameMatchAlternates(candidates: StoredNode[], target: string, resolved: StoredNode): StoredNode[] {
	const lowerTarget = target.toLowerCase();
	return candidates
		.filter(n => n.qualified_name !== resolved.qualified_name && n.name.toLowerCase().includes(lowerTarget))
		.slice(0, 3);
}

export function resolveTarget(store: GraphStore, target: string, preferKinds?: readonly NodeKind[]): ResolvedTarget | undefined {
	const exact = store.getNode(target);
	if (exact) return { node: exact, alternates: [] };

	const anchored = store.getNodesByQualifiedSuffix(target);
	if (anchored.length === 1) return { node: anchored[0]!, alternates: [] };
	if (anchored.length > 1) {
		const pool = byPreference(anchored, preferKinds);
		const candidates = new Set(pool.map(n => n.qualified_name));
		const ranked = searchNodes(store, target, { limit: 50 });
		const best = ranked.find(r => candidates.has(r.node.qualified_name))?.node
			?? pool.find(n => n.kind !== 'File')
			?? pool[0]!;
		return { node: best, alternates: anchored.filter(n => n.qualified_name !== best.qualified_name).slice(0, 3) };
	}

	if (preferKinds?.includes('File') && !target.includes('.')) {
		const stems = store.getFileNodesByStem(target);
		if (stems.length === 1) {
			const ranked = searchNodes(store, target, { limit: 10 }).map(r => r.node);
			return { node: stems[0]!, alternates: nameMatchAlternates(ranked, target, stems[0]!) };
		}
		if (stems.length > 1) return { node: stems[0]!, alternates: stems.slice(1, 4) };
	}

	const results = searchNodes(store, target, { limit: 10 });
	if (results.length === 0) return undefined;
	const rankedNodes = results.map(r => r.node);
	const node = byPreference(rankedNodes, preferKinds)[0]!;
	return { node, alternates: nameMatchAlternates(rankedNodes, target, node) };
}

export function isWithinWorkspace(filePath: string, workspace: string): boolean {
	const resolved = path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
	const root = path.resolve(workspace).replace(/\\/g, '/').toLowerCase();
	return resolved.startsWith(root + '/') || resolved === root;
}

export function readSourceLines(filePath: string, lineStart: number, lineEnd: number, workspace: string): string | null {
	if (!isWithinWorkspace(filePath, workspace)) return null;
	try {
		const content = fs.readFileSync(filePath, 'utf8');
		const lines = content.split('\n');
		return lines.slice(lineStart - 1, lineEnd).join('\n');
	} catch {
		return null;
	}
}

export function suggestNextTools(task?: string): string {
	const t = (task ?? '').toLowerCase();
	if (t.includes('review') || t.includes('pr')) {
		return 'Next: compass_blast_radius → compass_review_context';
	}
	if (t.includes('debug') || t.includes('fix') || t.includes('bug')) {
		return 'Next: compass_search → compass_query(callers_of)';
	}
	if (t.includes('explore') || t.includes('understand') || t.includes('architect')) {
		return 'Next: compass_search → compass_query(children_of)';
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

function handleFileSummary(store: GraphStore, target: string, level: DetailLevel, workspace?: string): string {
	const nodes: StoredNode[] = [];
	for (const mp of store.resolveGraphFilePaths([target], workspace)) {
		nodes.push(...store.getNodesByFile(mp));
	}
	if (nodes.length === 0) return `No entities found in "${target}"`;
	return `File: ${target} (${nodes.length} entities)\n${nodes.map(n => formatNode(n, level)).join('\n')}`;
}

export function handleQuery(
	store: GraphStore,
	input: { pattern: string; target: string; detail_level?: string | undefined },
	workspace?: string,
): string {
	const level = (input.detail_level ?? 'summary') as DetailLevel;

	if (input.pattern === 'file_summary') {
		return handleFileSummary(store, input.target, level, workspace);
	}

	const pattern = QUERY_PATTERNS[input.pattern];
	if (!pattern) return `Unknown pattern "${input.pattern}". Valid: callers_of, callees_of, imports_of, importers_of, children_of, tests_for, inheritors_of, references_of, referencers_of, file_summary`;

	const resolved = resolveTarget(store, input.target, pattern.prefer);
	if (!resolved) return `No entity found for "${input.target}"`;
	const { node, alternates } = resolved;

	const qn = node.qualified_name;
	const allEdges = pattern.dir === 'source' ? store.getEdgesBySource(qn) : store.getEdgesByTarget(qn);
	const matchKinds = pattern.kinds ?? [pattern.kind];
	const edges = allEdges.filter(e => matchKinds.includes(e.kind));
	const resolvedQns = edges.map(e => pattern.dir === 'source' ? e.target_qualified : e.source_qualified);
	const nodesByQn = new Map<string, StoredNode>();
	for (const n of store.getNodesByQualifiedNames([...new Set(resolvedQns)])) {
		nodesByQn.set(n.qualified_name, n);
	}
	const nodes: StoredNode[] = [];
	const seenQn = new Set<string>();
	const externalCallees: string[] = [];
	const seenExternal = new Set<string>();
	for (const e of edges) {
		const resolvedQn = pattern.dir === 'source' ? e.target_qualified : e.source_qualified;
		const n = nodesByQn.get(resolvedQn);
		if (n) {
			if (!seenQn.has(n.qualified_name)) {
				seenQn.add(n.qualified_name);
				nodes.push(n);
			}
		} else if (
			input.pattern === 'callees_of'
			&& !resolvedQn.includes('::')
			&& !isKnownExternal(resolvedQn)
			&& !seenExternal.has(resolvedQn)
		) {
			seenExternal.add(resolvedQn);
			externalCallees.push(resolvedQn);
		}
	}

	if ((input.pattern === 'inheritors_of' || input.pattern === 'callers_of') && nodes.length === 0) {
		const fallbackEdges = store.getEdgesByTargetName(node.name, matchKinds as string[]);
		const FALLBACK_CAP = 25;
		for (const e of fallbackEdges) {
			if (nodes.length >= FALLBACK_CAP) break;
			const n = store.getNode(e.source_qualified);
			if (n && !seenQn.has(n.qualified_name)) {
				seenQn.add(n.qualified_name);
				nodes.push(n);
			}
		}
	}

	const label = `${pattern.label} ${formatNode(node, 'minimal')}`;
	const lines = nodes.map(n => formatNode(n, level));
	for (const ext of externalCallees) lines.push(`${ext} (external, unresolved)`);
	const alternatesSuffix = alternates.length > 0
		? `\nAlso matched: ${alternates.map(a => formatNode(a, 'minimal')).join('; ')}`
		: '';
	if (lines.length === 0) return `${label}: none. If unexpected, verify with one Grep; relationship coverage is not guaranteed.${alternatesSuffix}`;
	return `${label} (${lines.length}):\n${lines.join('\n')}${alternatesSuffix}`;
}

function formatLocalTimestamp(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const pad = (n: number) => String(n).padStart(2, '0');
	const tzMinutes = -d.getTimezoneOffset();
	const tzSign = tzMinutes >= 0 ? '+' : '-';
	const tzAbs = Math.abs(tzMinutes);
	const tzLabel = `UTC${tzSign}${pad(Math.trunc(tzAbs / 60))}:${pad(tzAbs % 60)}`;
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (${tzLabel})`;
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
	if (stats.last_updated) lines.push(`Last Updated: ${formatLocalTimestamp(stats.last_updated)}`);
	return lines.join('\n');
}

export function handleBlastRadius(
	store: GraphStore,
	input: { changed_files: string[]; max_depth?: number | undefined; max_results?: number | undefined; detail_level?: string | undefined },
	workspace?: string,
): string {
	const level = (input.detail_level ?? 'summary') as DetailLevel;
	const result = computeBlastRadius(store, input.changed_files, input.max_depth, input.max_results, workspace);

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

	const fullSourceChars = estimateSourceChars([...result.changed_nodes, ...result.impacted_nodes]);
	if (fullSourceChars > 0) {
		lines.push('', formatSavingsLine(estimateSavings(lines.join('\n'), fullSourceChars)));
	}

	return lines.join('\n');
}

export function handleReviewContext(
	store: GraphStore, workspace: string,
	input: { changed_files?: string[] | undefined; max_depth?: number | undefined; include_source?: boolean | undefined; base?: string | undefined },
): string {
	const files = (input.changed_files && input.changed_files.length > 0)
		? input.changed_files
		: getChangedFiles(workspace, input.base);
	const analysis = analyzeChanges(store, files, undefined, workspace, input.base);
	const impact = computeBlastRadius(store, files, input.max_depth, undefined, workspace);
	const affected = getAffectedFlows(store, files);

	const lines: string[] = [
		'=== Review Context ===',
		'',
		`Changed Files: ${files.length}`,
		`Risk: ${analysis.risks.filter(r => r.risk_level === 'HIGH').length} HIGH, ${analysis.risks.filter(r => r.risk_level === 'MEDIUM').length} MEDIUM, ${analysis.risks.filter(r => r.risk_level === 'LOW').length} LOW`,
		`Blast Radius: ${impact.total_impacted} nodes across ${impact.impacted_files.length} files`,
		`Affected Flows: ${affected.total}`,
		`Test Gaps: ${analysis.test_gaps.length}`,
	];

	if (analysis.truncated) {
		lines.push(`Risk analysis truncated: analyzed ${analysis.risks.length} of ${analysis.total_changed_funcs} changed functions`);
	}

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
		for (const f of affected.flows.slice(0, 10)) {
			lines.push(`${f.name} — depth: ${f.depth}, nodes: ${f.node_count}, files: ${f.file_count}, criticality: ${f.criticality.toFixed(4)}`);
		}
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

	const fullSourceChars = estimateSourceChars([...impact.changed_nodes, ...impact.impacted_nodes]);
	if (fullSourceChars > 0) {
		lines.push('', formatSavingsLine(estimateSavings(lines.join('\n'), fullSourceChars)));
	}

	return lines.join('\n');
}

export function handleDeadCode(
	store: GraphStore,
	input: { kind?: string | undefined; file_pattern?: string | undefined; limit?: number | undefined },
): string {
	const options: { kind?: 'Function' | 'Class'; filePattern?: string } = {};
	if (input.kind === 'Function' || input.kind === 'Class') options.kind = input.kind;
	if (input.file_pattern) options.filePattern = input.file_pattern;

	const results = findDeadCode(store, options);
	if (results.length === 0) {
		return 'No dead code detected (no unreferenced functions/classes, excluding entry points and framework-managed classes).';
	}

	const limit = input.limit ?? 100;
	const shown = results.slice(0, limit);
	const header = results.length > limit
		? `Dead code candidates (${results.length}, showing ${limit}):`
		: `Dead code candidates (${results.length}):`;
	const lines = [header];
	for (const r of shown) {
		lines.push(`${r.name} — ${r.kind} @ ${r.file_path}:${r.line}${r.language ? ` [${r.language}]` : ''}`);
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
		const post = await runPostProcess(store, { flows: true, communities: true });
		lines.push(`Post-processed: ${post.flowCount} flows, ${post.communityCount} communities`);
	}

	return lines.join('\n');
}

