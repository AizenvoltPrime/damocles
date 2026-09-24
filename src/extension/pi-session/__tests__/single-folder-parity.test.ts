import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSession, AgentSessionServices } from '@earendil-works/pi-coding-agent';

const H = vi.hoisted(() => ({ home: '' }));

// Global context and user asset dirs resolve through `os.homedir()`; a temp home keeps the developer's
// own `~/.damocles` and `~/.claude` out of both prompts.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => (H.home !== '' ? H.home : actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { PiRuntime } from '../pi-runtime';
import { initPiLoader } from '../pi-loader';
import { createDamoclesExtensionFactory } from '../damocles-extension';
import { overrideGlobalContextFile } from '../context-files';
import { assetSourceDirs } from '../../asset-sources';

/**
 * A single-folder window must see exactly what it saw when one services object was pinned to the first
 * folder. The baseline below builds services the way that single object was built (same cwd, trust-gated
 * settings, Damocles extension factory, asset roots, context-file override, extension filter), so any
 * drift the per-folder split introduces into the loader or the prompt shows up as a string diff.
 */
describe('single-folder parity', () => {
  const made: string[] = [];
  const sessions: AgentSession[] = [];

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  beforeAll(() => {
    vi.spyOn(vscode.window, 'createOutputChannel').mockReturnValue({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    } as unknown as vscode.LogOutputChannel);
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.dispose();
    await PiRuntime.disposeInstance();
    H.home = '';
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeSkill(root: string, rel: string, name: string): void {
    const dir = path.join(root, ...rel.split('/'), name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody of ${name}.\n`);
  }

  function fixture(): { workspace: string; agentDir: string } {
    H.home = tempDir('damocles-parity-home-');
    const workspace = tempDir('Damocles-Parity-WS-');
    const agentDir = tempDir('damocles-parity-agent-');
    fs.mkdirSync(path.join(H.home, '.damocles'), { recursive: true });
    fs.writeFileSync(path.join(H.home, '.damocles', 'AGENTS.md'), 'Global instructions.\n');
    writeSkill(H.home, '.claude/skills', 'userskill');
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'Project instructions.\n');
    writeSkill(workspace, '.damocles/skills', 'projectskill');
    fs.mkdirSync(path.join(workspace, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.pi', 'APPEND_SYSTEM.md'), 'Appended by the project.\n');
    return { workspace, agentDir };
  }

  async function baselineServices(workspace: string, agentDir: string): Promise<AgentSessionServices> {
    const pi = await initPiLoader();
    if (!pi) throw new Error('pi failed to load');
    const home = os.homedir();
    const entries = (kind: 'skills' | 'commands') =>
      assetSourceDirs(kind, { workspacePath: workspace, homeDir: home }).filter((d) => fs.existsSync(d.dir));
    const services = await pi.createAgentSessionServices({
      cwd: workspace,
      agentDir,
      settingsManager: pi.SettingsManager.create(workspace, agentDir, { projectTrusted: true }),
      resourceLoaderOptions: {
        extensionFactories: [
          createDamoclesExtensionFactory(
            { get: () => undefined, values: () => [] },
            { get: () => undefined },
            () => undefined,
            undefined,
            () => () => undefined,
          ),
        ],
        additionalSkillPaths: entries('skills').map((e) => e.dir),
        additionalPromptTemplatePaths: entries('commands').map((e) => e.dir),
        agentsFilesOverride: (base) => ({
          agentsFiles: overrideGlobalContextFile(base.agentsFiles, { agentDir, homeDir: home, trusted: true }),
        }),
        extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((e) => e.path.startsWith('<inline:')) }),
      },
    });
    const withMetadata = (kind: 'skills' | 'commands') =>
      entries(kind).map((e) => ({ path: e.dir, metadata: { source: e.source, scope: e.scope, origin: 'top-level' as const } }));
    services.resourceLoader.extendResources({ skillPaths: withMetadata('skills'), promptPaths: withMetadata('commands') });
    return services;
  }

  async function sessionOn(services: AgentSessionServices): Promise<AgentSession> {
    const pi = await initPiLoader();
    if (!pi) throw new Error('pi failed to load');
    const { session } = await pi.createAgentSessionFromServices({ services, sessionManager: pi.SessionManager.inMemory(services.cwd) });
    sessions.push(session);
    return session;
  }

  it('builds the same loader and system prompt as the single pinned services object', async () => {
    const { workspace, agentDir } = fixture();
    const baseline = await baselineServices(workspace, agentDir);
    const folder = await PiRuntime.get(agentDir).folder(workspace);
    const services = folder.services;

    expect(services.cwd).toBe(baseline.cwd);
    expect(services.resourceLoader.getAgentsFiles()).toEqual(baseline.resourceLoader.getAgentsFiles());
    expect(services.resourceLoader.getSkills().skills.map((s) => s.name)).toEqual(
      baseline.resourceLoader.getSkills().skills.map((s) => s.name),
    );
    expect(services.resourceLoader.getAppendSystemPrompt()).toEqual(baseline.resourceLoader.getAppendSystemPrompt());

    const expected = (await sessionOn(baseline)).systemPrompt;
    const actual = (await sessionOn(services)).systemPrompt;
    expect(expected).toContain('Project instructions.');
    expect(expected).toContain('Global instructions.');
    expect(expected).toContain('projectskill');
    expect(expected).toContain('Appended by the project.');
    expect(actual).toBe(expected);
  }, 60_000);
});
