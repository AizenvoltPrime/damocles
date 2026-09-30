import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { PiRuntime } from '../pi-runtime';
import { initPiLoader, type PiCodingAgentModule } from '../pi-loader';
import { backendSourceFiles } from '../../../__mocks__/source-tree';

/**
 * Every pi session Damocles builds delivers all steers pending at a boundary together, whatever the
 * Damocles agent settings file or a trusted project's `.pi/settings.json` says, and keeps doing so
 * after pi re-reads its settings.
 */
describe('the steering queue policy', () => {
  const made: string[] = [];
  const sessions: AgentSession[] = [];
  let pi: PiCodingAgentModule;

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  /** A workspace and agent dir that both ask pi for one steer per boundary. */
  const oneAtATimeEverywhere = (): { workspace: string; agentDir: string } => {
    const workspace = tempDir('damocles-queue-ws-');
    const agentDir = tempDir('damocles-queue-agent-');
    fs.mkdirSync(path.join(workspace, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.pi', 'settings.json'), JSON.stringify({ steeringMode: 'one-at-a-time' }));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ steeringMode: 'one-at-a-time' }));
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

    const { session } = await pi.createAgentSessionFromServices({
      services: folder.services,
      sessionManager: pi.SessionManager.inMemory(workspace),
    });
    sessions.push(session);
    expect(session.steeringMode).toBe('all');

    session.agent.steeringMode = 'one-at-a-time';
    await session.reload();
    expect(session.steeringMode).toBe('all');
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
  }, 60_000);

  it('is applied to every pi settings manager the extension creates', () => {
    const factoryCall = /(\w+\(\s*)?(?:\w+\.)?SettingsManager\s*\.\s*(?:create|inMemory|fromStorage)\s*\(/g;
    const calls = backendSourceFiles().flatMap((file) =>
      [...fs.readFileSync(file.path, 'utf8').matchAll(factoryCall)].map((match) => ({
        file: file.rel,
        wrapped: match[1]?.replace(/\s/g, '') === 'withQueuePolicy(',
      })),
    );
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.filter((call) => !call.wrapped)).toEqual([]);
  });
});
