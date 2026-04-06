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
		version: '2.0.0',
		tools: [
			tool(
				'query_graph',
				'Search the workspace knowledge graph for code entities by name or keyword. Returns a ranked list of matching entities with source locations, types, and key relationships. Use specific entity names (e.g. "EffectActivationService") for best results.',
				{
					query: z.string().describe('Entity name or keyword to search for'),
					kind: z.enum(['file', 'class', 'function', 'method', 'any']).optional().describe('Filter by entity type (default: any)'),
					limit: z.number().min(1).max(50).optional().describe('Max results (default 20)'),
				},
				async (input) => {
					await compassService.ensureInitialized();
					const result = compassService.searchEntities(
						input.query,
						input.kind ?? 'any',
						input.limit ?? 20,
					);
					return textResult(result ?? 'Compass not indexed yet. Try again after indexing completes.');
				},
				{ annotations: { readOnlyHint: true } },
			),

			tool(
				'inspect_node',
				'Get complete details for a code entity including all its relationships. Shows the entity\'s source location, type, and every connection (calls, imports, inherits) with confidence levels. Use after query_graph identifies an entity you want to explore.',
				{
					label: z.string().describe('Entity name or ID from query_graph results'),
					relation_filter: z.string().optional().describe('Filter by relation type (e.g. "calls", "imports", "inherits")'),
					depth: z.number().min(1).max(2).optional().describe('1 = direct connections (default), 2 = connections of connections'),
				},
				async (input) => {
					await compassService.ensureInitialized();
					const result = compassService.inspectNode(
						input.label,
						input.relation_filter,
						input.depth ?? 1,
					);
					return textResult(result ?? 'Compass not indexed yet. Try again after indexing completes.');
				},
				{ annotations: { readOnlyHint: true } },
			),

			tool(
				'graph_overview',
				'Get a high-level overview of the workspace knowledge graph. Shows statistics, most-connected entities (hubs), or community contents. Use at the start of exploration to orient yourself.',
				{
					view: z.enum(['summary', 'hubs', 'community']).optional().describe('summary = stats + top hubs (default), hubs = ranked hub list, community = entities in a community'),
					community_id: z.number().optional().describe('Required for community view: community ID (0 = largest)'),
					top_n: z.number().min(1).max(50).optional().describe('Number of hubs to show (default 10)'),
					reindex: z.boolean().optional().describe('Trigger a full workspace reindex'),
				},
				async (input) => {
					await compassService.ensureInitialized();

					if (input.reindex) {
						compassService.triggerReindex();
						const status = compassService.getStatus();
						return textResult(`Reindex started.\n${JSON.stringify(status, null, 2)}`);
					}

					const result = compassService.graphOverview(
						(input.view as 'summary' | 'hubs' | 'community') ?? 'summary',
						input.community_id,
						input.top_n ?? 10,
					);

					if (!result) return textResult('Compass not indexed yet. Try again after indexing completes.');

					const status = compassService.getStatus();
					const statusLine = `Status: ${status.state} | Last indexed: ${status.lastIndexedAt ? `${Math.round((Date.now() - status.lastIndexedAt) / 1000)}s ago` : 'never'}`;
					return textResult(`${result}\n\n${statusLine}`);
				},
				{ annotations: { readOnlyHint: true } },
			),

			tool(
				'trace_path',
				'Find the shortest connection path between two code entities in the knowledge graph. Shows each hop with relationship type. Use to understand how two seemingly unrelated parts of the code connect.',
				{
					source: z.string().describe('Source entity name or keyword'),
					target: z.string().describe('Target entity name or keyword'),
					max_hops: z.number().min(1).max(20).optional().describe('Maximum path length (default 8)'),
				},
				async (input) => {
					await compassService.ensureInitialized();
					const result = compassService.tracePath(
						input.source,
						input.target,
						input.max_hops ?? 8,
					);
					return textResult(result ?? 'Compass not indexed yet. Try again after indexing completes.');
				},
				{ annotations: { readOnlyHint: true } },
			),
		],
	});
}
