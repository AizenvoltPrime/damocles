import { describe, it, expect, vi } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { McpClientManager } from '../../mcp/mcp-client-manager';
import type { McpToolDescriptor } from '../../mcp/types';
import { buildMcpPiTool } from '../mcp-tools';

vi.mock('../../../logger', () => ({ log: vi.fn() }));

/**
 * Schema parity (US-014.3): an MCP tool registers under the `mcp__{server}__{tool}` name with the
 * server's raw JSON Schema preserved (via `Type.Unsafe`), and `execute` routes to the client manager
 * with the abort signal, converting MCP content into pi text/image blocks.
 */

const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

function descriptor(overrides: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    piName: 'mcp__git__commit',
    serverName: 'git',
    kind: 'tool',
    originalName: 'commit',
    description: 'Create a commit',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' }, all: { type: 'boolean' } },
      required: ['message'],
    },
    readOnly: false,
    ...overrides,
  };
}

type PiTool = {
  name: string;
  label: string;
  parameters: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  execute: (id: string, params: unknown, signal: AbortSignal | undefined) => Promise<{ content: Array<{ type: string; text?: string }>; details?: { isError: boolean } }>;
};

describe('MCP tool builder — schema parity + routing', () => {
  it('names the tool with the mcp__ scheme and preserves the JSON Schema', () => {
    const tool = buildMcpPiTool(piStub, descriptor(), {} as McpClientManager) as unknown as PiTool;
    expect(tool.name).toBe('mcp__git__commit');
    expect(tool.parameters.type).toBe('object');
    expect(Object.keys(tool.parameters.properties ?? {}).sort()).toEqual(['all', 'message']);
    expect(tool.parameters.required).toEqual(['message']);
  });

  it('defaults to an empty object schema when the MCP tool has no inputSchema', () => {
    const tool = buildMcpPiTool(piStub, descriptor({ inputSchema: undefined }), {} as McpClientManager) as unknown as PiTool;
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties).toEqual({});
  });

  it('routes execute to the client manager (forwarding the signal) and converts content to pi blocks', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }], isError: false }));
    const manager = { callTool } as unknown as McpClientManager;
    const tool = buildMcpPiTool(piStub, descriptor(), manager) as unknown as PiTool;

    const controller = new AbortController();
    const result = await tool.execute('t1', { message: 'hi' }, controller.signal);
    expect(callTool).toHaveBeenCalledWith('mcp__git__commit', { message: 'hi' }, { signal: controller.signal });
    expect(result.content[0]).toEqual({ type: 'text', text: 'done' });
  });

  it('returns a structured error result instead of throwing when the call fails', async () => {
    const callTool = vi.fn(async () => {
      throw new Error('server down');
    });
    const manager = { callTool } as unknown as McpClientManager;
    const tool = buildMcpPiTool(piStub, descriptor(), manager) as unknown as PiTool;

    const result = await tool.execute('t1', {}, undefined);
    expect(result.details?.isError).toBe(true);
    expect(result.content[0]?.text).toContain('server down');
  });

  it('flags an MCP isError result in details', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'bad' }], isError: true }));
    const manager = { callTool } as unknown as McpClientManager;
    const tool = buildMcpPiTool(piStub, descriptor(), manager) as unknown as PiTool;

    const result = await tool.execute('t1', {}, undefined);
    expect(result.details?.isError).toBe(true);
  });
});
