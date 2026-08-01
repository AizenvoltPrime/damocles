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
    // The tool STILL EXISTS — the server was merely unreachable. `getToolDescriptor` therefore answers,
    // and the text must stay the plain transient-failure wording: a retry here is legitimate.
    const callTool = vi.fn(async () => {
      throw new Error('server down');
    });
    const manager = {
      callTool,
      getToolDescriptor: (piName: string) => (piName === 'mcp__git__commit' ? descriptor() : undefined),
    } as unknown as McpClientManager;
    const tool = buildMcpPiTool(piStub, descriptor(), manager) as unknown as PiTool;

    const result = await tool.execute('t1', {}, undefined);
    expect(result.details?.isError).toBe(true);
    expect(result.content[0]?.text).toContain('server down');
    expect(result.content[0]?.text).toContain('MCP tool "mcp__git__commit" failed');
    expect(result.content[0]?.text).not.toContain('no longer available');
  });

  /** A tool whose descriptor the manager no longer knows — the vanished case, for either caller. */
  function vanishedTool(opts?: { frozen?: boolean }): PiTool {
    const callTool = vi.fn(async () => {
      throw new Error('MCP tool "mcp__git__commit" is no longer available');
    });
    const manager = { callTool, getToolDescriptor: () => undefined } as unknown as McpClientManager;
    return buildMcpPiTool(piStub, descriptor(), manager, opts) as unknown as PiTool;
  }

  it('a VANISHED tool in a FROZEN nested snapshot says so permanently and does not invite a retry (criterion 12)', async () => {
    // The branch that matters to a nested agent: its tool set is frozen at spawn, so a tool the server
    // stopped advertising can never come back to it. A retry loop against a permanently-absent tool is
    // the worst outcome the freeze decision can produce, and the only thing standing between the model
    // and that loop is this sentence. Detected by asking the manager (covering both `Unknown MCP tool`
    // and the reconcile race), never by matching wording.
    const result = await vanishedTool({ frozen: true }).execute('t1', {}, undefined);

    expect(result.details?.isError).toBe(true);
    const text = result.content[0]!.text!;
    expect(text).toContain('is no longer available');
    expect(text).toContain('permanent for the rest of this agent');
    expect(text).toContain('retrying it will fail the same way');
    // The text must never read as "try again": asserted on the words a model acts on, because this is
    // the one failure mode where a hopeful re-read of the sentence costs the rest of the agent's turns.
    expect(text).not.toMatch(/try again|in a moment|retry it|please retry/i);
  });

  it('the SAME vanished tool on the PANEL is described as recoverable, because it is', async () => {
    // Same catch, same detection, opposite truth. The panel's registrar builds its tools with no
    // `frozen` flag, and for it a removed descriptor is transient: the pi tool stays registered,
    // `rebuildDescriptors` re-adds it when the server returns, and `callTool` resolves live. Telling a
    // user who toggled a server off and on that a working capability is permanently dead — in wording
    // written specifically to suppress retries — would be a lie the model then acts on.
    const result = await vanishedTool().execute('t1', {}, undefined);

    const text = result.content[0]!.text!;
    expect(result.details?.isError).toBe(true);
    expect(text).toContain('is not currently available');
    expect(text).toContain('may return if the server reconnects');
    expect(text).not.toContain('permanent');
  });

  it('flags an MCP isError result in details', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'bad' }], isError: true }));
    const manager = { callTool } as unknown as McpClientManager;
    const tool = buildMcpPiTool(piStub, descriptor(), manager) as unknown as PiTool;

    const result = await tool.execute('t1', {}, undefined);
    expect(result.details?.isError).toBe(true);
  });
});
