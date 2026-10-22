import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { PiRuntime } from '../pi-runtime';
import { initPiLoader, type PiCodingAgentModule } from '../pi-loader';
import { backendSourceFiles } from '../../../__mocks__/source-tree';
import { installFakePlatform } from '../../../__mocks__/fake-platform';

/** The text of a call's arguments, from just past its opening parenthesis to the one that closes it. */
function callArguments(text: string, start: number): string {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(start, i);
  }
  throw new Error(`unclosed call at offset ${start}`);
}

/**
 * Every pi session Damocles builds delivers all steers pending at a boundary together, and all follow-ups
 * pending when a run would stop together, with install telemetry (and so pi's request attribution) off,
 * whatever the Damocles agent settings file or a trusted project's `.pi/settings.json` says, and keeps
 * doing so after pi re-reads its settings.
 */
describe('the pi settings policy', () => {
  const made: string[] = [];
  const sessions: AgentSession[] = [];
  let pi: PiCodingAgentModule;

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  /** A workspace and agent dir that both ask pi for one steer per boundary, one follow-up per stop and install telemetry. */
  const oneAtATimeEverywhere = (): { workspace: string; agentDir: string } => {
    const workspace = tempDir('damocles-settings-ws-');
    const agentDir = tempDir('damocles-settings-agent-');
    const settings = JSON.stringify({ steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', enableInstallTelemetry: true });
    fs.mkdirSync(path.join(workspace, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.pi', 'settings.json'), settings);
    fs.writeFileSync(path.join(agentDir, 'settings.json'), settings);
    return { workspace, agentDir };
  };

  beforeAll(async () => {
    const loaded = await initPiLoader();
    if (!loaded) throw new Error('pi failed to load');
    pi = loaded;
  }, 60_000);

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.dispose();
    await PiRuntime.disposeInstance();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('holds for a panel session over a project that sets one-at-a-time, and survives session.reload()', async () => {
    const { workspace, agentDir } = oneAtATimeEverywhere();
    const folder = await PiRuntime.get(agentDir).folder(workspace);
    // The project layer was read, so the policy is what outranks it.
    expect(folder.services.settingsManager.getProjectSettings().steeringMode).toBe('one-at-a-time');
    expect(folder.services.settingsManager.getProjectSettings().followUpMode).toBe('one-at-a-time');

    const { session } = await pi.createAgentSessionFromServices({
      services: folder.services,
      sessionManager: pi.SessionManager.inMemory(workspace),
    });
    sessions.push(session);
    expect(session.steeringMode).toBe('all');
    expect(session.followUpMode).toBe('all');

    session.agent.steeringMode = 'one-at-a-time';
    session.agent.followUpMode = 'one-at-a-time';
    await session.reload();
    expect(session.steeringMode).toBe('all');
    expect(session.followUpMode).toBe('all');
    expect(session.settingsManager.getProjectSettings().enableInstallTelemetry).toBe(true);
    expect(session.settingsManager.getEnableInstallTelemetry()).toBe(false);
  }, 60_000);

  it('keeps install telemetry off when the agent settings file cannot be read, which pi then loads nothing from', async () => {
    const workspace = tempDir('damocles-settings-ws-');
    const agentDir = tempDir('damocles-settings-agent-');
    const broken = '{ "enableInstallTelemetry": true, ';
    fs.writeFileSync(path.join(agentDir, 'settings.json'), broken);
    const runtime = PiRuntime.get(agentDir);
    const folder = await runtime.folder(workspace);

    expect(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).toBe(broken);
    expect(folder.services.settingsManager.getGlobalSettings()).toEqual({});
    expect(folder.services.settingsManager.getEnableInstallTelemetry()).toBe(false);
  }, 60_000);

  it('warns once, naming the agent settings file, only when pi itself cannot load it', async () => {
    const platform = installFakePlatform();
    const agentDir = tempDir('damocles-settings-agent-');
    const settingsFile = path.join(agentDir, 'settings.json');
    fs.writeFileSync(settingsFile, '{ "packages": ');
    await Promise.all([PiRuntime.get(agentDir).init(), PiRuntime.get(agentDir).init()]);
    expect(platform.notifications.calls).toEqual([
      expect.objectContaining({ level: 'warn', message: expect.stringContaining(`Damocles could not read ${settingsFile}`) }),
    ]);

    // The seed leaves an array alone, but pi loads one with no error.
    await PiRuntime.disposeInstance();
    fs.writeFileSync(settingsFile, '[{ "packages": [] }]');
    await PiRuntime.get(agentDir).init();
    expect(platform.notifications.calls).toHaveLength(1);
  }, 60_000);

  it('holds for a nested session, which subagents, team agents and /btw all run on', async () => {
    const { workspace, agentDir } = oneAtATimeEverywhere();
    const folder = await PiRuntime.get(agentDir).folder(workspace);

    const nested = await folder.createSubagentSession({
      cwd: workspace,
      systemPrompt: 'probe',
      tools: ['read'],
      customTools: [],
      extensionFactory: () => {},
      store: { kind: 'memory' },
    });
    sessions.push(nested);
    expect(nested.steeringMode).toBe('all');
    expect(nested.followUpMode).toBe('all');
    expect(nested.settingsManager.getEnableInstallTelemetry()).toBe(false);
  }, 60_000);

  it('is applied to every pi settings manager the extension creates', () => {
    const factoryCall = /(\w+\(\s*)?(?:\w+\.)?SettingsManager\s*\.\s*(?:create|inMemory|fromStorage)\s*\(/g;
    const calls = backendSourceFiles().flatMap((file) =>
      [...fs.readFileSync(file.path, 'utf8').matchAll(factoryCall)].map((match) => ({
        file: file.rel,
        wrapped: match[1]?.replace(/\s/g, '') === 'withSettingsPolicy(',
      })),
    );
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.filter((call) => !call.wrapped)).toEqual([]);

    // Given none, pi creates an unwrapped manager of its own (agent-session-services.js:62, sdk.js:76).
    const sessionFactoryCall = /\b(createAgentSessionServices|createAgentSession)\s*\(/g;
    const factoryCalls = backendSourceFiles().flatMap((file) => {
      const text = fs.readFileSync(file.path, 'utf8');
      return [...text.matchAll(sessionFactoryCall)].map((match) => ({
        file: file.rel,
        factory: match[1],
        passesSettings: /\bsettingsManager\b/.test(callArguments(text, match.index + match[0].length)),
      }));
    });
    expect(factoryCalls.length).toBeGreaterThanOrEqual(2);
    expect(factoryCalls.filter((call) => !call.passesSettings)).toEqual([]);
  });
});
