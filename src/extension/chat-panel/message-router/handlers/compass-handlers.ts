import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../../../extension/logger';
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { ValidationIssue, CompassValidationResult } from '../../../../shared/types/compass';

export function createCompassHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
	const { compassService, postMessage } = deps;

	return {
		requestCompassReindex: async () => {
			if (!compassService) return;
			try {
				await compassService.triggerReindex();
			} catch (err) {
				log('[compass-handlers] reindex error: %O', err);
			}
		},

		compassSearch: async (msg, ctx) => {
			if (msg.type !== 'compassSearch') return;
			if (!compassService?.isEnabled) return;
			try {
				await compassService.ensureInitialized();
				const { searchNodes } = await import('../../../../extension/compass/search');
				const store = compassService.store;
				const results = searchNodes(store, msg.query, {
					kind: msg.kind ?? undefined,
					limit: msg.limit ?? 30,
				});
				postMessage(ctx.host, {
					type: 'compassSearchResults',
					results: results.map(r => ({
						node: {
							id: r.node.id,
							kind: r.node.kind,
							name: r.node.name,
							qualified_name: r.node.qualified_name,
							file_path: r.node.file_path,
							line_start: r.node.line_start,
							line_end: r.node.line_end,
							language: r.node.language,
							community_id: r.node.community_id,
						},
						score: r.score,
					})),
				});
			} catch (err) {
				log('[compass-handlers] compassSearch error: %O', err);
				postMessage(ctx.host, { type: 'compassSearchResults', results: [] });
			}
		},

		compassRequestGraph: async (msg, ctx) => {
			if (msg.type !== 'compassRequestGraph') return;
			if (!compassService?.isEnabled) return;
			try {
				await compassService.ensureInitialized();
				const store = compassService.store;
				const maxNodes = msg.maxNodes ?? 500;

				const nodes = store.getNodesLimited(maxNodes, msg.communityId);

				const qnSet = new Set(nodes.map(n => n.qualified_name));
				const edges = store.getEdgesAmong(qnSet);

				const { getCommunities } = await import('../../../../extension/compass/communities');
				const communities = getCommunities(store);

				postMessage(ctx.host, {
					type: 'compassGraphData',
					data: {
						nodes: nodes.map(n => ({
							id: n.id,
							kind: n.kind,
							name: n.name,
							qualified_name: n.qualified_name,
							file_path: n.file_path,
							line_start: n.line_start,
							line_end: n.line_end,
							language: n.language,
							community_id: n.community_id,
						})),
						edges: edges.map(e => ({
							id: e.id,
							kind: e.kind,
							source_qualified: e.source_qualified,
							target_qualified: e.target_qualified,
							file_path: e.file_path,
						})),
						communities: communities.map(c => ({
							id: c.id,
							name: c.name,
							size: c.size,
							cohesion: c.cohesion,
							dominant_language: c.dominant_language,
							description: c.description,
						})),
					},
				});
			} catch (err) {
				log('[compass-handlers] compassRequestGraph error: %O', err);
				postMessage(ctx.host, {
					type: 'compassGraphData',
					data: { nodes: [], edges: [], communities: [] },
				});
			}
		},

		compassNavigateToNode: (msg) => {
			if (msg.type !== 'compassNavigateToNode') return;
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) return;
			const resolved = path.resolve(msg.filePath).replace(/\\/g, '/').toLowerCase();
			const isWithin = workspaceFolders.some(f => {
				const root = f.uri.fsPath.replace(/\\/g, '/').toLowerCase();
				return resolved.startsWith(root + '/') || resolved === root;
			});
			if (!isWithin) return;
			const uri = vscode.Uri.file(msg.filePath);
			const line = Math.max(0, msg.line - 1);
			vscode.window.showTextDocument(uri, {
				selection: new vscode.Range(line, 0, line, 0),
			});
		},

		compassRequestBlastRadius: async (msg, ctx) => {
			if (msg.type !== 'compassRequestBlastRadius') return;
			if (!compassService?.isEnabled) return;
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) return;
			const resolvedBlast = path.resolve(msg.filePath).replace(/\\/g, '/').toLowerCase();
			const withinWorkspace = workspaceFolders.some(f => {
				const root = f.uri.fsPath.replace(/\\/g, '/').toLowerCase();
				return resolvedBlast.startsWith(root + '/') || resolvedBlast === root;
			});
			if (!withinWorkspace) return;
			try {
				await compassService.ensureInitialized();
				const { computeBlastRadius } = await import('../../../../extension/compass/impact');
				const store = compassService.store;
				const depth = vscode.workspace.getConfiguration('damocles.compass').get<number>('blastRadiusDepth', 2);
				const impact = computeBlastRadius(store, [msg.filePath], depth);

				postMessage(ctx.host, {
					type: 'compassBlastRadiusData',
					data: {
						changed_files: [msg.filePath],
						changed_nodes: impact.changed_nodes.map(n => ({
							id: n.id,
							kind: n.kind,
							name: n.name,
							qualified_name: n.qualified_name,
							file_path: n.file_path,
							line_start: n.line_start,
							line_end: n.line_end,
							language: n.language,
							community_id: n.community_id,
						})),
						impacted_nodes: impact.impacted_nodes.map(n => ({
							id: n.id,
							kind: n.kind,
							name: n.name,
							qualified_name: n.qualified_name,
							file_path: n.file_path,
							line_start: n.line_start,
							line_end: n.line_end,
							language: n.language,
							community_id: n.community_id,
						})),
						impacted_files: impact.impacted_files,
						edges: impact.edges.map(e => ({
							id: e.id,
							kind: e.kind,
							source_qualified: e.source_qualified,
							target_qualified: e.target_qualified,
							file_path: e.file_path,
						})),
						total_impacted: impact.total_impacted,
						truncated: impact.truncated,
					},
				});
			} catch (err) {
				log('[compass-handlers] compassRequestBlastRadius error: %O', err);
				postMessage(ctx.host, {
					type: 'compassBlastRadiusData',
					data: { changed_files: [], changed_nodes: [], impacted_nodes: [], impacted_files: [], edges: [], total_impacted: 0, truncated: false },
				});
			}
		},

		compassDismissBlastRadius: (_msg, ctx) => {
			postMessage(ctx.host, { type: 'compassBlastRadiusDismissed' });
		},

		compassRequestValidation: async (_msg, ctx) => {
			if (!compassService?.isEnabled) {
				postMessage(ctx.host, {
					type: 'compassValidationResult',
					data: {
						timestamp: Date.now(),
						durationMs: 0,
						totalIssues: 1,
						issues: [{ category: 'Compass disabled', severity: 'error' as const, count: 1, description: 'Enable Compass in settings to run validation', entities: [], truncated: false }],
						summary: { nodeCount: 0, edgeCount: 0, fileCount: 0, communityCount: 0, edgeToNodeRatio: 0, workspaceFileCount: 0, coveragePercent: 0 },
					},
				});
				return;
			}
			try {
				await compassService.ensureInitialized();
				const startTime = Date.now();
				const store = compassService.store;
				const validation = store.runValidation();
				const issues: ValidationIssue[] = [];

				if (validation.brokenEdges.count > 0) {
					issues.push({
						category: 'Broken edges',
						severity: 'error',
						count: validation.brokenEdges.count,
						description: 'Edges with missing source node, or CALLS/CONTAINS/TESTED_BY edges with missing target',
						entities: validation.brokenEdges.entities,
						truncated: validation.brokenEdges.truncated,
					});
				}

				if (validation.unresolvedReferences.count > 0) {
					issues.push({
						category: 'Unresolved external references',
						severity: 'info',
						count: validation.unresolvedReferences.count,
						description: 'Import/inherit/implement edges targeting external dependencies not in the workspace',
						entities: validation.unresolvedReferences.entities,
						truncated: validation.unresolvedReferences.truncated,
					});
				}

				const staleFiles: string[] = [];
				const existChecks = await Promise.all(
					validation.filePaths.map(async (filePath) => {
						const resolved = path.resolve(deps.workspacePath, filePath);
						try { await fs.promises.access(resolved); return null; } catch { return filePath; }
					}),
				);
				for (const f of existChecks) { if (f) staleFiles.push(f); }
				if (staleFiles.length > 0) {
					issues.push({
						category: 'Stale files',
						severity: 'error',
						count: staleFiles.length,
						description: 'Files in the graph that no longer exist on disk',
						entities: staleFiles.slice(0, 100),
						truncated: staleFiles.length > 100,
					});
				}

				if (validation.ftsRowCount !== validation.nodeCount) {
					issues.push({
						category: 'FTS5 sync mismatch',
						severity: 'warning',
						count: 1,
						description: `FTS5 index has ${validation.ftsRowCount} rows but nodes table has ${validation.nodeCount} rows`,
						entities: [],
						truncated: false,
					});
				}

				const edgeToNodeRatio = validation.nodeCount > 0 ? validation.edgeCount / validation.nodeCount : 0;
				if (edgeToNodeRatio < 1.0 && validation.nodeCount > 0) {
					issues.push({
						category: 'Low edge-to-node ratio',
						severity: 'warning',
						count: 1,
						description: `Ratio is ${edgeToNodeRatio.toFixed(2)} (typical: 1.5-3.0). May indicate extraction failures`,
						entities: [],
						truncated: false,
					});
				}

				for (const kind of ['Function', 'Class', 'Type'] as const) {
					const orphans = validation.orphanedByKind[kind];
					if (orphans && orphans.count > 0) {
						const kindTotal = validation.totalByKind[kind] ?? 0;
						const pct = kindTotal > 0 ? orphans.count / kindTotal : 0;
						issues.push({
							category: `Orphaned ${kind} nodes`,
							severity: pct > 0.1 ? 'warning' : 'info',
							count: orphans.count,
							description: `${orphans.count} ${kind} nodes with no edges (${(pct * 100).toFixed(1)}% of ${kindTotal})`,
							entities: orphans.entities,
							truncated: orphans.truncated,
						});
					}
				}

				const fileOrphans = validation.orphanedByKind['File'];
				if (fileOrphans && fileOrphans.count > 0) {
					issues.push({
						category: 'Orphaned File nodes',
						severity: 'info',
						count: fileOrphans.count,
						description: 'File nodes with no extractable entities (configs, empty files)',
						entities: fileOrphans.entities,
						truncated: fileOrphans.truncated,
					});
				}

				if (validation.communityGaps.count > 0) {
					issues.push({
						category: 'Community gaps',
						severity: 'info',
						count: validation.communityGaps.count,
						description: 'Non-File nodes without community assignment',
						entities: validation.communityGaps.entities,
						truncated: validation.communityGaps.truncated,
					});
				}

				const { collectFiles } = await import('../../../../extension/compass/detect');
				const config = compassService.config;
				const workspaceFiles = collectFiles(deps.workspacePath, config.excludePatterns);
				const workspaceNormalized = workspaceFiles.map(f => path.relative(deps.workspacePath, f).replace(/\\/g, '/'));
				const graphRelative = new Set(validation.filePaths.map(p => {
					const rel = path.relative(deps.workspacePath, path.resolve(deps.workspacePath, p));
					return rel.replace(/\\/g, '/');
				}));
				const missing = workspaceNormalized.filter(f => !graphRelative.has(f));
				const coveragePercent = workspaceFiles.length > 0
					? ((workspaceFiles.length - missing.length) / workspaceFiles.length) * 100
					: 100;

				if (coveragePercent < 80) {
					issues.push({
						category: 'Low extraction coverage',
						severity: 'warning',
						count: missing.length,
						description: `Only ${coveragePercent.toFixed(1)}% of workspace files are in the graph (${missing.length} missing)`,
						entities: missing.slice(0, 100),
						truncated: missing.length > 100,
					});
				} else {
					issues.push({
						category: 'Extraction coverage',
						severity: 'info',
						count: 0,
						description: `${coveragePercent.toFixed(1)}% of workspace files are in the graph (${workspaceFiles.length} total)`,
						entities: [],
						truncated: false,
					});
				}

				const durationMs = Date.now() - startTime;
				const result: CompassValidationResult = {
					timestamp: Date.now(),
					durationMs,
					totalIssues: issues.filter(i => i.severity !== 'info').length,
					issues,
					summary: {
						nodeCount: validation.nodeCount,
						edgeCount: validation.edgeCount,
						fileCount: validation.fileCount,
						communityCount: validation.communityCount,
						edgeToNodeRatio: Math.round(edgeToNodeRatio * 100) / 100,
						workspaceFileCount: workspaceFiles.length,
						coveragePercent: Math.round(coveragePercent * 10) / 10,
					},
				};

				postMessage(ctx.host, { type: 'compassValidationResult', data: result });
			} catch (err) {
				log('[compass-handlers] compassRequestValidation error: %O', err);
				const msg = err instanceof Error ? err.message : 'Unknown validation error';
				postMessage(ctx.host, {
					type: 'compassValidationResult',
					data: {
						timestamp: Date.now(),
						durationMs: 0,
						totalIssues: 1,
						issues: [{ category: 'Validation failed', severity: 'error' as const, count: 1, description: msg, entities: [], truncated: false }],
						summary: { nodeCount: 0, edgeCount: 0, fileCount: 0, communityCount: 0, edgeToNodeRatio: 0, workspaceFileCount: 0, coveragePercent: 0 },
					},
				});
			}
		},
	};
}
