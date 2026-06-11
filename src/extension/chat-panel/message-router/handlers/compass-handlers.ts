import * as vscode from 'vscode';
import * as path from 'path';
import { log } from '../../../../extension/logger';
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { ValidationIssue, CompassValidationResult, CompassSearchResult, CompassGraphData, CompassBlastRadiusResult } from '../../../../shared/types/compass';
import type { WebviewValidationResponse, WebviewValidationBusy } from '../../../../extension/compass/worker-protocol';

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
				const results = await compassService.webviewSearch(msg.query, msg.kind ?? undefined, msg.limit ?? 30) as CompassSearchResult[];
				postMessage(ctx.host, {
					type: 'compassSearchResults',
					results,
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
				const data = await compassService.webviewGraph(msg.maxNodes ?? 500, msg.communityId) as CompassGraphData;
				postMessage(ctx.host, { type: 'compassGraphData', data });
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
				const depth = vscode.workspace.getConfiguration('damocles.compass').get<number>('blastRadiusDepth', 2);
				const data = await compassService.webviewBlastRadius(msg.filePath, depth) as CompassBlastRadiusResult;
				postMessage(ctx.host, { type: 'compassBlastRadiusData', data });
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
				const rawValidation = await compassService.webviewValidation() as WebviewValidationResponse | WebviewValidationBusy;

				if ('busy' in rawValidation) {
					postMessage(ctx.host, {
						type: 'compassValidationResult',
						data: {
							timestamp: Date.now(),
							durationMs: 0,
							totalIssues: 1,
							issues: [{ category: 'Graph rebuild in progress', severity: 'warning' as const, count: 1, description: rawValidation.message, entities: [], truncated: false }],
							summary: { nodeCount: 0, edgeCount: 0, fileCount: 0, communityCount: 0, edgeToNodeRatio: 0, workspaceFileCount: 0, coveragePercent: 0 },
						},
					});
					return;
				}

				const validation = rawValidation.validation;
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

				if (validation.knownExternalRefs.count > 0) {
					issues.push({
						category: 'Known external dependencies',
						severity: 'info',
						count: validation.knownExternalRefs.count,
						description: 'Import/inherit/implement edges targeting known framework/library dependencies',
						entities: validation.knownExternalRefs.entities,
						truncated: validation.knownExternalRefs.truncated,
					});
				}

				if (validation.unresolvedInternalRefs.count > 0) {
					issues.push({
						category: 'Unresolved internal references',
						severity: 'warning',
						count: validation.unresolvedInternalRefs.count,
						description: 'Import/inherit/implement edges targeting unresolved project-internal symbols',
						entities: validation.unresolvedInternalRefs.entities,
						truncated: validation.unresolvedInternalRefs.truncated,
					});
				}

				const staleFilesRemoved = rawValidation.staleFilesRemoved;
				if (staleFilesRemoved.length > 0) {
					issues.push({
						category: 'Stale files auto-removed',
						severity: 'info',
						count: staleFilesRemoved.length,
						description: `Auto-removed ${staleFilesRemoved.length} stale file(s) from graph during validation`,
						entities: staleFilesRemoved.slice(0, 100),
						truncated: staleFilesRemoved.length > 100,
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
					const expectedSet = new Set(validation.expectedOrphanFiles.entities);
					const expectedCount = validation.expectedOrphanFiles.count;
					const unexpectedEntities = fileOrphans.entities.filter(e => !expectedSet.has(e));
					const unexpectedCount = Math.max(fileOrphans.count - expectedCount, 0);

					if (unexpectedCount > 0) {
						issues.push({
							category: 'Orphaned File nodes',
							severity: 'warning',
							count: unexpectedCount,
							description: 'File nodes with no extractable entities — may indicate extractor gaps',
							entities: unexpectedEntities,
							truncated: fileOrphans.truncated,
						});
					}
					if (expectedCount > 0) {
						issues.push({
							category: 'Expected orphan files',
							severity: 'info',
							count: expectedCount,
							description: 'Files containing no callable entities (data-only, ambient declarations, or empty stubs) — flagged at extraction',
							entities: validation.expectedOrphanFiles.entities,
							truncated: validation.expectedOrphanFiles.truncated,
						});
					}
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

				const workspaceFiles = rawValidation.workspaceFiles;
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
