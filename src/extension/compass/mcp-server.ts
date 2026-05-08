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
	const readOnlyAlwaysLoad = { annotations: { readOnlyHint: true }, alwaysLoad: true };
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

			tool('compass_search', 'Primary tool for finding code entities (functions, classes, types, files) by name or keyword. Use this BEFORE Glob/Grep when targeting symbols, definitions, or call sites — one call returns exact paths and line numbers, replacing 3-5 rounds of pattern guessing. Use Grep only for literal text searches in file contents (error strings, log lines, comments).', {
				query: z.string().describe('Entity name or keyword'),
				kind: z.enum(['File', 'Class', 'Function', 'Type', 'Test']).optional().describe('Filter by entity type'),
				limit: z.number().min(1).max(50).optional().describe('Max results (default 20)'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpSearch(input));
			}, readOnlyAlwaysLoad),

			tool('compass_query', 'Primary tool for relationship queries between code entities (callers, callees, imports, children, tests, inheritors, references). Use this BEFORE reading files to map blast radius and locate call sites.', {
				pattern: z.enum(['callers_of', 'callees_of', 'imports_of', 'importers_of', 'children_of', 'tests_for', 'inheritors_of', 'references_of', 'referencers_of', 'file_summary']).describe('Query pattern'),
				target: z.string().describe('Qualified name or entity name to resolve'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpQuery(input));
			}, readOnlyAlwaysLoad),

			tool('compass_stats', 'Graph statistics: node/edge counts by kind, languages, last update.', {}, async () => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpStats());
			}, readOnly),

			tool('compass_blast_radius', 'Primary tool for impact analysis: BFS from changed files through the dependency graph. Returns affected nodes, files, and edges. Use this BEFORE reviewing a change to scope risk.', {
				changed_files: z.array(z.string()).describe('Changed file paths'),
				max_depth: z.number().min(1).max(10).optional().describe('Max traversal depth (default 2)'),
				max_results: z.number().min(1).max(2000).optional().describe('Max impacted nodes (default 500)'),
				detail_level: z.enum(['minimal', 'summary', 'full']).optional().describe('Output detail'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpBlastRadius(input));
			}, readOnly),

			tool('compass_review_context', 'Primary tool for change review: returns impact + risk + affected flows + optional source snippets. Use this when reviewing diffs or assessing pull-request safety. Auto-detects changed files via git when changed_files is omitted.', {
				changed_files: z.array(z.string()).optional().describe('Changed file paths (omit to auto-detect via git)'),
				max_depth: z.number().min(1).max(10).optional().describe('Blast radius depth'),
				include_source: z.boolean().optional().describe('Include source code snippets'),
				base: z.string().optional().describe('Git ref to diff against'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpReviewContext(input));
			}, readOnly),

			tool('compass_build', 'Build or incrementally update the workspace knowledge graph.', {
				full_rebuild: z.boolean().optional().describe('Force full rebuild (default: incremental)'),
				postprocess: z.boolean().optional().describe('Run post-processing (default: true)'),
			}, async (input) => {
				await compassService.ensureInitialized();
				return textResult(await compassService.mcpBuild(input));
			}, mutable),
		],
	});
}
