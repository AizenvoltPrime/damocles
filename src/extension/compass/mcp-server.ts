import type { CompassService } from './index';

type SdkCreateServer = typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
type SdkTool = typeof import('@anthropic-ai/claude-agent-sdk').tool;
type ZodZ = typeof import('zod').z;

function textResult(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}

export function createCompassMcpServer(
	compassService: CompassService,
	createSdkMcpServer: SdkCreateServer,
	tool: SdkTool,
	z: ZodZ,
	_getSessionId: () => string,
	_workspace: string,
): ReturnType<SdkCreateServer> {
	return createSdkMcpServer({
		name: 'damocles-compass',
		version: '1.0.0',
		tools: [
			tool(
				'query_graph',
				'Search the workspace knowledge graph using BFS or DFS. Returns relevant code entities and their relationships as text context. Use this instead of reading files when you need to understand codebase structure.',
				{
					question: z.string().describe('Natural language question or keyword search'),
					mode: z.enum(['bfs', 'dfs']).optional().describe('bfs=broad context (default), dfs=trace a specific path'),
					depth: z.number().min(1).max(6).optional().describe('Traversal depth 1-6 (default 3)'),
					token_budget: z.number().min(100).max(10000).optional().describe('Max output tokens (default 2000)'),
				},
				async (input) => {
					await compassService.ensureInitialized();
					const result = compassService.queryGraph(
						input.question,
						input.mode ?? 'bfs',
						input.depth ?? 3,
						input.token_budget ?? 2000,
					);
					if (!result) return textResult('Compass not indexed yet. Try again after indexing completes.');
					if (result.nodeCount === 0) return textResult(result.header);
					return textResult(`${result.header}\n\n${result.text}`);
				},
				{ annotations: { readOnlyHint: true } },
			),

			tool(
				'get_node',
				'Get full details for a specific code entity by label or ID. Shows source file, type, community, and degree.',
				{
					label: z.string().describe('Node label or ID to look up'),
				},
				async (input) => {
					await compassService.ensureInitialized();
					const result = compassService.getNode(input.label);
					return textResult(result ?? 'Compass not indexed yet.');
				},
				{ annotations: { readOnlyHint: true } },
			),

			tool(
				'get_neighbors',
				'Get all direct neighbors of a code entity with edge details (relation type, confidence).',
				{
					label: z.string().describe('Node label or ID'),
					relation_filter: z.string().optional().describe('Optional: filter by relation type (e.g. "calls", "imports")'),
				},
				async (input) => {
					await compassService.ensureInitialized();
					const result = compassService.getNeighbors(input.label, input.relation_filter);
					return textResult(result ?? 'Compass not indexed yet.');
				},
				{ annotations: { readOnlyHint: true } },
			),

			tool(
				'shortest_path',
				'Find the shortest path between two code entities in the knowledge graph.',
				{
					source: z.string().describe('Source concept label or keyword'),
					target: z.string().describe('Target concept label or keyword'),
					max_hops: z.number().min(1).max(20).optional().describe('Maximum hops to consider (default 8)'),
				},
				async (input) => {
					await compassService.ensureInitialized();
					const result = compassService.shortestPath(input.source, input.target, input.max_hops ?? 8);
					return textResult(result ?? 'Compass not indexed yet.');
				},
				{ annotations: { readOnlyHint: true } },
			),

			tool(
				'god_nodes',
				'Return the most connected code entities — the core abstractions of the workspace.',
				{
					top_n: z.number().min(1).max(50).optional().describe('Number of results (default 10)'),
				},
				async (input) => {
					await compassService.ensureInitialized();
					const result = compassService.getGodNodes(input.top_n ?? 10);
					return textResult(result ?? 'Compass not indexed yet.');
				},
				{ annotations: { readOnlyHint: true } },
			),

			tool(
				'get_community',
				'Get all code entities in a community by community ID.',
				{
					community_id: z.number().describe('Community ID (0-indexed by size, 0 = largest)'),
				},
				async (input) => {
					await compassService.ensureInitialized();
					const result = compassService.getCommunity(input.community_id);
					return textResult(result ?? 'Compass not indexed yet.');
				},
				{ annotations: { readOnlyHint: true } },
			),

			tool(
				'graph_stats',
				'Return summary statistics: node count, edge count, communities, confidence breakdown.',
				{},
				async () => {
					await compassService.ensureInitialized();
					const result = compassService.getGraphStats();
					return textResult(result ?? 'Compass not indexed yet.');
				},
				{ annotations: { readOnlyHint: true } },
			),

			tool(
				'compass_reindex',
				'Trigger a full workspace reindex. Use when significant code changes have been made.',
				{},
				async () => {
					await compassService.ensureInitialized();
					compassService.triggerReindex();
					return textResult('Reindex started. Use compass_status to check progress.');
				},
			),

			tool(
				'compass_status',
				'Return the current indexing state: idle, indexing, ready, or error.',
				{},
				async () => {
					await compassService.ensureInitialized();
					const status = compassService.getStatus();
					return textResult(JSON.stringify(status, null, 2));
				},
				{ annotations: { readOnlyHint: true } },
			),
		],
	});
}
