import * as vscode from 'vscode';
import * as path from 'path';
import { log } from '../../../../extension/logger';
import type { HandlerDependencies, HandlerRegistry } from "../types";

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
	};
}
