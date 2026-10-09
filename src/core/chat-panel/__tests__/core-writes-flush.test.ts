import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushAcrossHeldRename } from '../../../__mocks__/held-rename';
import { flushCoreWrites } from '..';
import { DAMOCLES_MCP_CONFIG_PATH } from '../settings-manager/managers/mcp-config-import';
import { addDamoclesMcpServer, migrateOwnedMcpFile } from '../settings-manager/managers/mcp-config-write';
import { syncPermissionRulesToSettings } from '../settings-manager/utils';
import { rewritePermissionRuleToolNames } from '../../permission-handler/permission-settings';

const NO_SHADOWING = new Map();

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'core-writes-'));
  fs.rmSync(DAMOCLES_MCP_CONFIG_PATH, { force: true });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('flushCoreWrites', () => {
  it('resolves with no write queued', async () => {
    await expect(flushCoreWrites()).resolves.toBeUndefined();
  });

  it('waits for an mcp.json write in flight and for one queued while it waits', async () => {
    const servers = await flushAcrossHeldRename(DAMOCLES_MCP_CONFIG_PATH, {
      first: () => addDamoclesMcpServer('first', { command: 'first-server' }, NO_SHADOWING),
      flush: flushCoreWrites,
      second: () => addDamoclesMcpServer('second', { command: 'second-server' }, NO_SHADOWING),
      onDisk: () => Object.keys(readJson(DAMOCLES_MCP_CONFIG_PATH)['mcpServers'] as object),
    });
    expect(servers).toEqual(['first', 'second']);
  });

  it('waits for a folder mcp.local.json migration in flight', async () => {
    const local = path.join(workspace, '.damocles', 'mcp.local.json');
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, JSON.stringify({ mcpServers: { s: { command: 'x', env: { TOKEN: '$env:TOKEN' } } } }));
    const onDisk = await flushAcrossHeldRename(local, {
      first: () => migrateOwnedMcpFile(local),
      flush: flushCoreWrites,
      second: () => undefined,
      onDisk: () => readJson(local),
    });
    expect(onDisk).toEqual({ mcpServers: { s: { command: 'x', env: { TOKEN: '${TOKEN}' } } } });
  });

  it('waits for a permission rule rename in flight and for a rule saved while it waits', async () => {
    const file = path.join(workspace, '.damocles', 'settings.local.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['old_tool(arg)'] } }));
    const onDisk = await flushAcrossHeldRename(file, {
      first: () => rewritePermissionRuleToolNames(file, new Map([['old_tool', 'new_tool']]), { confineTo: path.dirname(file) }),
      flush: flushCoreWrites,
      second: () => syncPermissionRulesToSettings(
        [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }], behavior: 'allow', destination: 'localSettings' }],
        workspace,
      ),
      onDisk: () => readJson(file),
    });
    expect(onDisk).toEqual({ permissions: { allow: ['new_tool(arg)', 'Bash(git push:*)'] } });
  });
});
