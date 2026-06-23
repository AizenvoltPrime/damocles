import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMcpSdk } from '../mcp-sdk-loader';
import { McpServerManager } from '../server-manager';
import type { McpServerDefinition } from '../types';

const echoServer = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'echo-server.mjs');
const def: McpServerDefinition = { command: process.execPath, args: [echoServer] };

let manager: McpServerManager | undefined;
afterEach(async () => {
  await manager?.closeAll();
  manager = undefined;
});

describe('McpServerManager connection-lost identity guard', () => {
  it('does NOT fire onConnectionLost for a deliberate close()', async () => {
    const sdk = await loadMcpSdk();
    expect(sdk).not.toBeNull();
    let lost = 0;
    manager = new McpServerManager({ sdk: sdk!, onConnectionLost: () => { lost++; } });

    await manager.connect('echo', def);
    expect(manager.getConnection('echo')?.status).toBe('connected');

    await manager.close('echo');
    // Let any stray onclose microtasks settle.
    await new Promise((r) => setTimeout(r, 50));

    // A deliberate close deletes the connection from the map first, so the onclose identity guard no-ops.
    expect(lost).toBe(0);
    expect(manager.getConnection('echo')).toBeUndefined();
  }, 30_000);

  it('fires onConnectionLost exactly once when the server process crashes (spontaneous drop)', async () => {
    const sdk = await loadMcpSdk();
    expect(sdk).not.toBeNull();
    let lost = 0;
    const lostNames: string[] = [];
    manager = new McpServerManager({
      sdk: sdk!,
      onConnectionLost: (n) => { lost++; lostNames.push(n); },
    });

    await manager.connect('echo', def);
    expect(manager.getConnection('echo')?.status).toBe('connected');

    // The crash tool exits the child ~50ms after responding, dropping the transport unsolicited.
    await manager.callTool('echo', 'crash', {}, {});

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && lost === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(lost).toBe(1);
    expect(lostNames).toEqual(['echo']);
    // The dropped connection was removed from the live map by the guard.
    expect(manager.getConnection('echo')).toBeUndefined();
  }, 30_000);
});
