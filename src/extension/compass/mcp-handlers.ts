import * as fs from 'fs';
import * as path from 'path';
import type { GraphStore } from './database';
import type { StoredNode, DetailLevel, ChangeRisk, CompassConfig } from './types';
import { searchNodes } from './search';
import { computeBlastRadius } from './impact';
import { analyzeChanges } from './changes';
import { getChangedFiles, fullBuild, incrementalUpdate } from './incremental';
import { getAffectedFlows, traceFlows, storeFlows } from './flows';
import { detectCommunities, storeCommunities } from './communities';

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

export function resolveTarget(store: GraphStore, target: string): StoredNode | undefined {
	const exact = store.getNode(target);
	if (exact) return exact;
	const results = searchNodes(store, target, { limit: 1 });
	return results[0]?.node;
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

export function handleReviewContext(
	store: GraphStore, workspace: string,
	input: { changed_files?: string[] | undefined; max_depth?: number | undefined; include_source?: boolean | undefined; base?: string | undefined },
): string {
	const files = (input.changed_files && input.changed_files.length > 0)
		? input.changed_files
		: getChangedFiles(workspace, input.base);
	const analysis = analyzeChanges(store, files, undefined, workspace, input.base);
	const impact = computeBlastRadius(store, files, input.max_depth);
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
		const comms = await detectCommunities(store);
		await storeCommunities(store, comms);
		lines.push(`Post-processed: ${flows.length} flows, ${comms.length} communities`);
	}

	return lines.join('\n');
}

