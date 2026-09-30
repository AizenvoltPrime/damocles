import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakePlatform, type FakePlatform } from '../../__mocks__/fake-platform';
import { McpManager } from '../chat-panel/settings-manager/managers/mcp-manager';
import { folderTarget } from '../chat-panel/settings-manager/managers/__tests__/mcp-folder-fixtures';
import { EvaluatorManager } from '../permission-handler/managers/evaluator-manager';
import { PermissionState } from '../permission-handler/state';
import { HooksConfigService } from '../pi-session/hooks/config';
import type { ParseFrontmatter } from '../pi-session/subagents/custom-agents';
import { WorkspaceAgentRegistry } from '../pi-session/subagents/workspace-agent-registry';
import { loadSkillDescription } from '../skills/utils';

// McpManager asks git whether mcp.local.json is ignored, only for a trusted folder.
const execMock = vi.hoisted(() => vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })));
vi.mock('../pi-session/checkpoints/exec', () => ({ exec: execMock }));

const parseFrontmatter: ParseFrontmatter = ((content: string) => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  const fm: Record<string, unknown> = {};
  for (const line of m?.[1]?.split('\n') ?? []) {
    const idx = line.indexOf(':');
    if (idx !== -1) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { frontmatter: fm, body: m ? m[2] : content };
}) as ParseFrontmatter;

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

let ws: string;
let fake: FakePlatform;
const disposables: Array<{ dispose(): void }> = [];

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), 'damocles-trust-gate-'));
  fake = installFakePlatform({ trusted: false, folders: [{ fsPath: ws, name: path.basename(ws) }] });

  write(path.join(ws, '.damocles', 'hooks.json'), JSON.stringify({ hooks: { tool_call: [{ command: 'echo project-hook' }] } }));
  write(path.join(ws, '.damocles', 'agents', 'RepoAgent.md'), '---\ndescription: repo agent\n---\nBODY');
  write(path.join(ws, '.damocles', 'skills', 'repo-skill', 'SKILL.md'), '---\ndescription: repo skill\n---\nBODY');
  write(path.join(ws, '.damocles', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
  write(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { 'repo-server': { command: 'node', args: ['server.js'] } } }));
});

afterEach(() => {
  for (const d of disposables.splice(0)) d.dispose();
  rmSync(ws, { recursive: true, force: true });
});

describe('trust gate: an untrusted folder loads no repository-authored input, and a grant enables it live', () => {
  it('project hooks', () => {
    const hooks = new HooksConfigService(ws, fake.trust, fake.fileWatchers);
    disposables.push(hooks);
    expect(hooks.getEntries('tool_call')).toEqual([]);

    fake.trust.grantTrust();
    expect(hooks.getEntries('tool_call').map((e) => e.command)).toEqual(['echo project-hook']);
    expect(fake.trust.checkedPaths).toContain(ws);
  });

  it('project subagents', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'damocles-trust-gate-home-'));
    const agents = new WorkspaceAgentRegistry(ws, parseFrontmatter, fake.trust, fake.fileWatchers, { homeDir: home });
    disposables.push(agents, { dispose: () => rmSync(home, { recursive: true, force: true }) });
    expect(agents.getRegistry().getAgentConfig('RepoAgent')).toBeUndefined();

    const reloaded = vi.fn();
    agents.onChange(reloaded);
    fake.trust.grantTrust();
    expect(reloaded).toHaveBeenCalledOnce();
    expect(agents.getRegistry().getAgentConfig('RepoAgent')?.description).toBe('repo agent');
  });

  it('project skills', async () => {
    expect(await loadSkillDescription('repo-skill', ws)).toBeUndefined();

    fake.trust.grantTrust();
    expect(await loadSkillDescription('repo-skill', ws)).toBe('repo skill');
  });

  it('project permission rules', async () => {
    const evaluator = new EvaluatorManager(new PermissionState(), fake);
    disposables.push(evaluator);
    expect(await evaluator.evaluate('Bash', { command: 'x' }, ws)).toBe('ask');

    fake.trust.grantTrust();
    expect(await evaluator.evaluate('Bash', { command: 'x' }, ws)).toBe('allow');
  });

  it('project MCP servers', async () => {
    const target = folderTarget(ws);
    const mcp = new McpManager(fake, () => [target]);
    disposables.push(mcp);
    await mcp.loadConfig();
    expect(Object.keys(mcp.getEnabledServers(target.key).folder)).not.toContain('repo-server');
    expect(mcp.getServersForUI(target.key).find((s) => s.name === 'repo-server')?.untrusted).toBe(true);

    // chat-panel/index.ts reloads MCP config from its onDidGrantTrust listener.
    fake.trust.grantTrust();
    await mcp.loadConfig();
    expect(Object.keys(mcp.getEnabledServers(target.key).folder)).toContain('repo-server');
    expect(mcp.getServersForUI(target.key).find((s) => s.name === 'repo-server')?.untrusted).toBeUndefined();
  });
});
