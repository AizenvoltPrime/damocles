import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionOptions } from '../../session-types';
import { PiSession } from '../pi-session';
import { PiRuntime } from '../pi-runtime';
import { initPiLoader } from '../pi-loader';
import { installFakePlatform } from '../../../__mocks__/fake-platform';

const ENDPOINT = 'http://127.0.0.1:9/v1';
const MODELS = {
  providers: {
    openai: {
      baseUrl: ENDPOINT,
      api: 'openai-completions',
      models: [{ id: 'gpt-6-luna', name: 'Own endpoint', reasoning: false, input: ['text'], contextWindow: 272000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    },
  },
};

/** pi's models.json is read when a chat starts, so a provider entry written while the engine runs reaches the next chat. */
describe("a chat's start and pi's models.json", () => {
  const made: string[] = [];
  const sessions: PiSession[] = [];

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  const chat = (platform: SessionOptions['platform'], cwd: string): PiSession => {
    const session = new PiSession({
      cwd,
      settingsFolder: undefined,
      projectScope: true,
      platform,
      model: 'gpt-6-luna',
      permissionHandler: { getPermissionMode: () => 'default', turnPermissionMode: () => 'default', setPermissionRequiredNotifier: () => {}, setPlanContentResolver: () => {}, setPendingPromptsListener: () => {}, setPromptOwnerResolver: () => {}, pendingPrompts: () => [] } as unknown as SessionOptions['permissionHandler'],
      onMessage: () => {},
      resolveThinking: () => ({ thinkingDisabled: false, effort: null }),
    });
    sessions.push(session);
    return session;
  };

  const modelOf = (session: PiSession): unknown => (session as unknown as { runtime: { session: { model: unknown } } | null }).runtime?.session.model;

  beforeAll(async () => {
    if (!(await initPiLoader())) throw new Error('pi failed to load');
  }, 60_000);

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.dispose();
    await PiRuntime.disposeInstance();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs a chat started after models.json named an endpoint on that endpoint, in a folder another chat already runs in', async () => {
    const platform = installFakePlatform();
    const workspace = tempDir('damocles-models-ws-');
    const agentDir = tempDir('damocles-models-agent-');
    PiRuntime.get(agentDir);

    const first = chat(platform, workspace);
    await first.initializeEarly();
    expect(modelOf(first)).toMatchObject({ provider: 'openai', id: 'gpt-6-luna', baseUrl: 'https://api.openai.com/v1' });

    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(MODELS));
    const second = chat(platform, workspace);
    await second.initializeEarly();
    expect(modelOf(second)).toMatchObject({ provider: 'openai', id: 'gpt-6-luna', baseUrl: ENDPOINT, api: 'openai-completions', reasoning: false });
    expect(PiRuntime.get().folders()).toHaveLength(1);
  }, 60_000);
});
