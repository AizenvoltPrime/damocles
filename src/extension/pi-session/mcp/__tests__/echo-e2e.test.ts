import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { McpClientManager } from '../mcp-client-manager';
import { MCP_METADATA_CACHE_DIR } from '../paths';

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
});

describe('MCP end-to-end (real stdio echo server)', () => {
  it('connects, lists tools, calls echo, and converts the result', async () => {
    manager = new McpClientManager({ healthCheckMs: 60_000 });
    manager.initialize({ [SERVER]: { command: process.execPath, args: [echoServer] } });
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
    manager = new McpClientManager({ healthCheckMs: 60_000 });
    manager.initialize({ [SERVER]: { command: process.execPath, args: [echoServer] } });
    await manager.whenReady();

    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.callTool(`mcp__${SERVER}__echo`, { text: 'x' }, { signal: controller.signal }),
    ).rejects.toBeDefined();
  }, 30_000);

  it('auto-reconnects after the server process crashes (onclose self-heal)', async () => {
    // Long health interval so the recovery is driven by the onclose handler, not a periodic check.
    manager = new McpClientManager({ healthCheckMs: 60_000 });
    manager.initialize({ [SERVER]: { command: process.execPath, args: [echoServer] } });
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
