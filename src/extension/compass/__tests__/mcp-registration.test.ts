import { describe, it, expect, vi } from 'vitest';
import { createCompassMcpServer } from '../mcp-server';
import type { CompassService } from '../index';

function mockCompassService(): CompassService {
	return {
		ensureInitialized: vi.fn().mockResolvedValue(undefined),
		searchEntities: vi.fn(),
		inspectNode: vi.fn(),
		graphOverview: vi.fn(),
		tracePath: vi.fn(),
		triggerReindex: vi.fn(),
		getStatus: vi.fn().mockReturnValue({ state: 'ready' }),
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

describe('MCP server registration', () => {
	it('registers exactly 4 tools with correct names', () => {
		const service = mockCompassService();
		const { registered, toolFn, createServer } = captureTool();

		createCompassMcpServer(
			service,
			createServer as any,
			toolFn as any,
			mockZod() as any,
			() => 'test-session',
			'/workspace',
		);

		const names = registered.map(t => t.name);
		expect(names).toEqual(['query_graph', 'inspect_node', 'graph_overview', 'trace_path']);
		expect(registered).toHaveLength(4);
	});

	it('all tools are marked readOnly', () => {
		const service = mockCompassService();
		const { registered, toolFn, createServer } = captureTool();

		createCompassMcpServer(service, createServer as any, toolFn as any, mockZod() as any, () => 's', '/w');

		for (const t of registered) {
			expect(t.opts, `${t.name} should have readOnlyHint`).toEqual({ annotations: { readOnlyHint: true } });
		}
	});
});
