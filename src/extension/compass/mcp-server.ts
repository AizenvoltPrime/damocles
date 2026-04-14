import type { CompassService } from './index';
import { textResult } from './mcp-handlers';

type SdkCreateServer = typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
type SdkTool = typeof import('@anthropic-ai/claude-agent-sdk').tool;
type ZodZ = typeof import('zod').z;


export function createCompassMcpServer(
	compassService: CompassService,
	createSdkMcpServer: SdkCreateServer,
	tool: SdkTool,
	z: ZodZ,
	_getSessionId: () => string,
	_workspace: string,
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
				return textResult(await compassService.mcpContext(input));
			}, readOnly),

			tool('compass_search', 'FTS5 BM25 search for code entities by name or keyword.', {
				query: z.string().describe('Entity name or keyword'),
				kind: z.enum(['File', 'Class', 'Function', 'Type', 'Test']).optional().describe('Filter by entity type'),
				limit: z.number().min(1).max(50).optional().describe('Max results (default 20)'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpSearch(input));
			}, readOnly),

			tool('compass_query', 'Structured relationship queries: callers, callees, imports, children, tests, inheritors, references.', {
				pattern: z.enum(['callers_of', 'callees_of', 'imports_of', 'importers_of', 'children_of', 'tests_for', 'inheritors_of', 'references_of', 'referencers_of', 'file_summary']).describe('Query pattern'),
				target: z.string().describe('Qualified name or entity name to resolve'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpQuery(input));
			}, readOnly),

			tool('compass_stats', 'Graph statistics: node/edge counts by kind, languages, last update.', {}, async () => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpStats());
			}, readOnly),

			tool('compass_blast_radius', 'BFS impact analysis from changed files. Shows affected nodes, files, and edges.', {
				changed_files: z.array(z.string()).describe('Changed file paths'),
				max_depth: z.number().min(1).max(10).optional().describe('Max traversal depth (default 2)'),
				max_results: z.number().min(1).max(2000).optional().describe('Max impacted nodes (default 500)'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpBlastRadius(input));
			}, readOnly),

			tool('compass_detect_changes', 'Risk-scored change analysis with test gap detection.', {
				base: z.string().optional().describe('Git ref to diff against (default HEAD~1)'),
				changed_files: z.array(z.string()).optional().describe('Override auto-detection with explicit file list'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpDetectChanges(input));
			}, readOnly),

			tool('compass_review_context', 'Full review context: impact + risk + affected flows + optional source snippets.', {
				changed_files: z.array(z.string()).describe('Changed file paths'),
				max_depth: z.number().min(1).max(10).optional().describe('Blast radius depth'),
				include_source: z.boolean().optional().describe('Include source code snippets'),
				base: z.string().optional().describe('Git ref to diff against'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpReviewContext(input));
			}, readOnly),

			tool('compass_list_flows', 'List execution flows sorted by criticality.', {
				sort_by: z.enum(['criticality', 'depth', 'node_count', 'file_count', 'name']).optional().describe('Sort field'),
				limit: z.number().min(1).max(200).optional().describe('Max results'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpListFlows(input));
			}, readOnly),

			tool('compass_get_flow', 'Single execution flow details with call path.', {
				flow_id: z.number().optional().describe('Flow ID'),
				flow_name: z.string().optional().describe('Flow name'),
				include_source: z.boolean().optional().describe('Include source code'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpGetFlow(input));
			}, readOnly),

			tool('compass_list_communities', 'List code communities by size or cohesion.', {
				sort_by: z.enum(['size', 'cohesion', 'name']).optional().describe('Sort field'),
				min_size: z.number().min(0).optional().describe('Minimum community size'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpListCommunities(input));
			}, readOnly),

			tool('compass_get_community', 'Community details with member list.', {
				community_id: z.number().optional().describe('Community ID'),
				community_name: z.string().optional().describe('Community name'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpGetCommunity(input));
			}, readOnly),

			tool('compass_architecture', 'Architecture overview: communities + cross-community coupling.', {
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpArchitecture(input));
			}, readOnly),

			tool('compass_build', 'Build or incrementally update the workspace knowledge graph.', {
				full_rebuild: z.boolean().optional().describe('Force full rebuild (default: incremental)'),
				postprocess: z.boolean().optional().describe('Run post-processing (default: true)'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpBuild(input));
			}, mutable),

			tool('compass_postprocess', 'Recompute flows, communities, or FTS index independently.', {
				flows: z.boolean().optional().describe('Recompute execution flows'),
				communities: z.boolean().optional().describe('Recompute community detection'),
				fts: z.boolean().optional().describe('Rebuild FTS5 search index'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpPostprocess(input));
			}, mutable),
		],
	});
}
