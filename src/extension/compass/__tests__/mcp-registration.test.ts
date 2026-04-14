import { describe, it, expect, vi } from 'vitest';
import { createCompassMcpServer } from '../mcp-server';
import type { CompassService } from '../index';

function mockCompassService(): CompassService {
	return {
		isEnabled: true,
		ensureInitialized: vi.fn().mockResolvedValue(undefined),
		config: { excludePatterns: [], autoReindex: true },
		getStatus: vi.fn().mockReturnValue({ state: 'ready', fileCount: 0, nodeCount: 0, edgeCount: 0, communityCount: 0, flowCount: 0, lastIndexedAt: null }),
		getGraphTerms: vi.fn().mockResolvedValue([]),
		mcpContext: vi.fn().mockResolvedValue(''),
		mcpSearch: vi.fn().mockResolvedValue(''),
		mcpQuery: vi.fn().mockResolvedValue(''),
		mcpStats: vi.fn().mockResolvedValue(''),
		mcpBlastRadius: vi.fn().mockResolvedValue(''),
		mcpDetectChanges: vi.fn().mockResolvedValue(''),
		mcpReviewContext: vi.fn().mockResolvedValue(''),
		mcpListFlows: vi.fn().mockResolvedValue(''),
		mcpGetFlow: vi.fn().mockResolvedValue(''),
		mcpListCommunities: vi.fn().mockResolvedValue(''),
		mcpGetCommunity: vi.fn().mockResolvedValue(''),
		mcpArchitecture: vi.fn().mockResolvedValue(''),
		mcpBuild: vi.fn().mockResolvedValue(''),
		mcpPostprocess: vi.fn().mockResolvedValue(''),
		getMcpServerConfig: vi.fn(),
		onStatusChange: vi.fn(),
		triggerReindex: vi.fn(),
		runPostProcess: vi.fn(),
		dispose: vi.fn(),
	} as unknown as CompassService;
}

const zodChain = (): unknown => new Proxy(() => zodChain(), {
	get: () => zodChain,
	apply: () => zodChain(),
});

function mockZod(): unknown {
	return new Proxy({}, { get: () => zodChain });
}

function captureTool() {
	const registered: Array<{ name: string; opts: unknown }> = [];
	const toolFn = (name: string, _desc: string, _schema: unknown, _handler: unknown, opts?: unknown) => {
		registered.push({ name, opts });
		return { name };
	};
	const createServer = (config: { tools: unknown[] }) => config;
	return { registered, toolFn, createServer };
}

const EXPECTED_TOOLS = [
	'compass_context',
	'compass_search',
	'compass_query',
	'compass_stats',
	'compass_blast_radius',
	'compass_detect_changes',
	'compass_review_context',
	'compass_list_flows',
	'compass_get_flow',
	'compass_list_communities',
	'compass_get_community',
	'compass_architecture',
	'compass_build',
	'compass_postprocess',
];

const ADMIN_TOOLS = new Set(['compass_build', 'compass_postprocess']);

describe('MCP server registration', () => {
	it('registers exactly 14 tools', () => {
		const service = mockCompassService();
		const { registered, toolFn, createServer } = captureTool();
		createCompassMcpServer(service, createServer as any, toolFn as any, mockZod() as any, () => 's', '/w');
		expect(registered.length).toBe(14);
	});

	it('registers all expected tool names', () => {
		const service = mockCompassService();
		const { registered, toolFn, createServer } = captureTool();
		createCompassMcpServer(service, createServer as any, toolFn as any, mockZod() as any, () => 's', '/w');
		const names = registered.map(t => t.name);
		for (const expected of EXPECTED_TOOLS) {
			expect(names, `missing tool: ${expected}`).toContain(expected);
		}
	});

	it('read-only tools have readOnlyHint: true', () => {
		const service = mockCompassService();
		const { registered, toolFn, createServer } = captureTool();
		createCompassMcpServer(service, createServer as any, toolFn as any, mockZod() as any, () => 's', '/w');

		for (const t of registered) {
			if (!ADMIN_TOOLS.has(t.name)) {
				expect(t.opts, `${t.name} should be readOnly`).toEqual({ annotations: { readOnlyHint: true } });
			}
		}
	});

	it('admin tools have readOnlyHint: false', () => {
		const service = mockCompassService();
		const { registered, toolFn, createServer } = captureTool();
		createCompassMcpServer(service, createServer as any, toolFn as any, mockZod() as any, () => 's', '/w');

		for (const t of registered) {
			if (ADMIN_TOOLS.has(t.name)) {
				expect(t.opts, `${t.name} should be mutable`).toEqual({ annotations: { readOnlyHint: false } });
			}
		}
	});

	it('tool names are unique', () => {
		const service = mockCompassService();
		const { registered, toolFn, createServer } = captureTool();
		createCompassMcpServer(service, createServer as any, toolFn as any, mockZod() as any, () => 's', '/w');
		const names = registered.map(t => t.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('server has correct name and version', () => {
		const service = mockCompassService();
		const { toolFn } = captureTool();
		let serverConfig: any;
		const createServer = (config: any) => { serverConfig = config; return config; };
		createCompassMcpServer(service, createServer as any, toolFn as any, mockZod() as any, () => 's', '/w');
		expect(serverConfig.name).toBe('damocles-compass');
		expect(serverConfig.version).toBe('4.0.0');
	});
});
