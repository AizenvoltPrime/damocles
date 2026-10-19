import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { McpClientManager, USER_RESOURCE_REQUEST } from '../mcp-client-manager';
import { directoryChildren } from '../../../chat-panel/mcp-resource-attachments';
import { parseUriTemplate, resolveUriTemplate } from '../../../../shared/uri-template';
import { MCP_METADATA_CACHE_DIR } from '../paths';
import { specOf } from './fake-server-manager';
import { createMcpResourceTools } from '../../tools/mcp-resource-tools';
import { removeSavedMcpOutputs } from '../content';

const fixtureDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const echoServer = join(fixtureDir, 'echo-server.mjs');
const SERVER = 'damocles_e2e_echo';
const cacheFile = join(
  MCP_METADATA_CACHE_DIR,
  `${createHash('sha256').update(SERVER).digest('hex').slice(0, 32)}.json`,
);

let manager: McpClientManager | undefined;

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  if (existsSync(cacheFile)) rmSync(cacheFile);
  await removeSavedMcpOutputs();
});

// Interop: pi-mcp's client against a server built on the official MCP SDK.
describe('MCP end-to-end (real stdio echo server)', () => {
  it('connects, lists tools, calls echo, and converts the result', async () => {
    manager = new McpClientManager({ clientVersion: 'test', healthCheckMs: 60_000 });
    manager.initialize({ [SERVER]: specOf({ command: process.execPath, args: [echoServer] }) });
    await manager.whenReady();

    expect(manager.getServerStatus(SERVER)?.status).toBe('connected');
    expect(manager.allToolNames()).toContain(`mcp__${SERVER}__echo`);
    // The echo tool is annotated read-only — the gate would auto-allow it.
    expect(manager.isMcpReadOnly(`mcp__${SERVER}__echo`)).toBe(true);

    const result = await manager.callTool(`mcp__${SERVER}__echo`, { text: 'hello mcp' }, {});
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ type: 'text', text: 'echo: hello mcp' });
  }, 30_000);

  it('cancels an in-flight call when the abort signal fires', async () => {
    manager = new McpClientManager({ clientVersion: 'test', healthCheckMs: 60_000 });
    manager.initialize({ [SERVER]: specOf({ command: process.execPath, args: [echoServer] }) });
    await manager.whenReady();

    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.callTool(`mcp__${SERVER}__echo`, { text: 'x' }, { signal: controller.signal }),
    ).rejects.toBeDefined();
  }, 30_000);

  it('auto-reconnects after the server process crashes (onclose self-heal)', async () => {
    // Long health interval so the recovery is driven by the onclose handler, not a periodic check.
    manager = new McpClientManager({ clientVersion: 'test', healthCheckMs: 60_000 });
    manager.initialize({ [SERVER]: specOf({ command: process.execPath, args: [echoServer] }) });
    await manager.whenReady();
    expect(manager.getServerStatus(SERVER)?.status).toBe('connected');

    // The crash tool exits the child ~50ms after responding, dropping the transport.
    await manager.callTool(`mcp__${SERVER}__crash`, {}, {});

    // Poll until the onclose-driven forced reconnect restores a live connection.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (manager.getServerStatus(SERVER)?.status === 'connected' &&
          manager.allToolNames().includes(`mcp__${SERVER}__echo`)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(manager.getServerStatus(SERVER)?.status).toBe('connected');

    // The reconnected server is fully usable again.
    const result = await manager.callTool(`mcp__${SERVER}__echo`, { text: 'back' }, {});
    expect(result.content[0]).toEqual({ type: 'text', text: 'echo: back' });
  }, 30_000);
});

type ToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };

describe('MCP resources end-to-end (real stdio echo server)', () => {
  async function connected(): Promise<{ manager: McpClientManager; run: (name: string, params: unknown) => Promise<ToolResult> }> {
    const live = new McpClientManager({ clientVersion: 'test', healthCheckMs: 60_000 });
    manager = live;
    live.initialize({ [SERVER]: specOf({ command: process.execPath, args: [echoServer] }) });
    await live.whenReady();
    const tools = createMcpResourceTools({ source: () => live, disabledResource: () => () => false, ruleFilter: async () => ({ serverCovered: () => false, resourceDenied: () => false, resourceDenyRule: () => undefined, contentCovered: () => false }) });
    const run = (name: string, params: unknown): Promise<ToolResult> =>
      (tools.find((t) => t.name === name)!.execute as unknown as (id: string, p: unknown, s: undefined, u: undefined, c: unknown) => Promise<ToolResult>)('tc', params, undefined, undefined, {});
    return { manager: live, run };
  }
  const json = (result: ToolResult): Record<string, unknown> => JSON.parse(result.content[0]!.text!) as Record<string, unknown>;

  it('connects with tools/list alone and records that the server offers resources', async () => {
    const { manager: live } = await connected();
    expect(live.getServerStatus(SERVER)).toMatchObject({ status: 'connected', hasResources: true });
    expect(live.resourceServers().map((s) => s.serverName)).toEqual([SERVER]);
    const received = await live.callTool(`mcp__${SERVER}__received`, {}, {});
    expect(JSON.parse(received.content[0]!.text!)).toEqual({ 'resources/list': 0 });
  }, 30_000);

  it('lists one page plus a cursor with a server and every page without, never an MCP App, and lists templates', async () => {
    const { run } = await connected();
    const page = json(await run('list_mcp_resources', { server: SERVER }));
    expect(page).toEqual({
      server: SERVER,
      resources: [
        { server: SERVER, uri: 'echo://text', name: 'text', mimeType: 'text/plain' },
        { server: SERVER, uri: 'echo://image', name: 'image', mimeType: 'image/png' },
      ],
      nextCursor: '2',
    });
    const all = json(await run('list_mcp_resources', {}));
    expect((all['resources'] as Array<{ uri: string }>).map((r) => r.uri)).toEqual(['echo://text', 'echo://image', 'echo://bin', 'echo://dir']);
    expect(json(await run('list_mcp_resource_templates', {}))).toEqual({ resourceTemplates: [{ server: SERVER, uriTemplate: 'echo://items/{id}', name: 'item' }] });
  }, 30_000);

  it('reads text as text, an image as an image block, other bytes as a saved file, and a directory labeled per child', async () => {
    const { run } = await connected();
    expect((await run('read_mcp_resource', { server: SERVER, uri: 'echo://text' })).content).toEqual([{ type: 'text', text: 'hello resource' }]);
    const image = (await run('read_mcp_resource', { server: SERVER, uri: 'echo://image' })).content;
    expect(image).toEqual([{ type: 'image', mimeType: 'image/png', data: expect.stringMatching(/^iVBOR/) }]);
    const bin = (await run('read_mcp_resource', { server: SERVER, uri: 'echo://bin' })).content[0]!.text!;
    const saved = /saved to (.+)\]$/.exec(bin)![1]!;
    expect(existsSync(saved)).toBe(true);
    expect((await run('read_mcp_resource', { server: SERVER, uri: 'echo://dir' })).content.map((c) => c.text)).toEqual([
      'echo://dir/a:', 'child a', 'echo://dir/b:', 'child b', 'echo://dir/sub/c:', 'child c',
    ]);
  }, 30_000);

  it('serves the MCP panel with resources Off: a page, a template completion, a template read and a directory’s children', async () => {
    const live = new McpClientManager({ clientVersion: 'test', healthCheckMs: 60_000 });
    manager = live;
    live.initialize({ [SERVER]: specOf({ command: process.execPath, args: [echoServer], exposeResources: false }) });
    await live.whenReady();
    await expect(live.listResourcesPage(SERVER, undefined)).rejects.toThrow(/are turned off/);

    const page = await live.listResourcesPage(SERVER, '2', {}, USER_RESOURCE_REQUEST);
    expect(page.resources.map((r) => r.uri)).toEqual(['echo://bin', 'echo://dir']);
    expect(page.nextCursor).toBe('4');
    expect(await live.completeResourceArgument(SERVER, 'echo://items/{id}', 'id', 'ap', {})).toEqual(['apple', 'apricot']);
    const uri = resolveUriTemplate(parseUriTemplate('echo://items/{id}'), { id: 'apricot' });
    expect(await live.readResource(SERVER, uri, {}, USER_RESOURCE_REQUEST)).toEqual({ contents: [{ uri, mimeType: 'text/plain', text: 'item apricot' }] });

    const deniedB = (_s: string, u: string): boolean => u === 'echo://dir/b';
    const rules = {
      serverCovered: () => false,
      resourceDenied: deniedB,
      resourceDenyRule: (s: string, u: string) => (deniedB(s, u) ? 'mcp__x(echo://dir/b)' : undefined),
      contentCovered: deniedB,
    };
    const dir = await live.readResource(SERVER, 'echo://dir', {}, USER_RESOURCE_REQUEST);
    expect(directoryChildren('echo://dir', dir, SERVER, rules)).toEqual([
      { uri: 'echo://dir/a', name: 'a', mimeType: 'text/plain', size: 7 },
      { uri: 'echo://dir/b', name: 'b', mimeType: 'text/plain', size: 7, denied: { rule: 'mcp__x(echo://dir/b)' } },
      { uri: 'echo://dir/sub', name: 'sub', directory: true },
    ]);
    const sub = await live.readResource(SERVER, 'echo://dir/sub', {}, USER_RESOURCE_REQUEST);
    expect(directoryChildren('echo://dir/sub', sub, SERVER, rules)).toEqual([{ uri: 'echo://dir/sub/c', name: 'c', mimeType: 'text/plain', size: 7 }]);
    expect(directoryChildren('echo://text', await live.readResource(SERVER, 'echo://text', {}, USER_RESOURCE_REQUEST), SERVER, rules)).toBeNull();
  }, 30_000);
});
