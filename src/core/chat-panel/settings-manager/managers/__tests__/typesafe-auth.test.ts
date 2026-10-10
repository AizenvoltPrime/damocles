import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createFakePlatform, installFakePlatform } from '../../../../../__mocks__/fake-platform';
import { deleteTypesafeApiKey, storeTypesafeApiKey, typesafeAuthStatus } from '../explore-manager';
import { PiRuntime } from '../../../../pi-session/pi-runtime';
import { PI_AGENT_DIR } from '../../../../pi-session/agent-dir';

/** A started runtime whose model runtime answers the way pi's does for the keys applied to it. */
function startedRuntime(classify: () => Record<string, unknown>) {
  const runtime = PiRuntime.get();
  const keys = new Map<string, string>();
  const fake = {
    hasConfiguredAuth: (p: string) => keys.has(p),
    getModelOfType: (type: string, provider: string, id: string) => ({ type, provider, id, api: 'typesafe-system-one' }),
    getProviderAuthStatus: (p: string) => ({ configured: keys.has(p), source: 'runtime' }),
    setRuntimeApiKey: vi.fn(async (p: string, key: string) => void keys.set(p, key)),
    removeRuntimeApiKey: vi.fn(async (p: string) => void keys.delete(p)),
    logout: vi.fn(async () => {}),
    unregisterProvider: vi.fn(),
    registerProvider: vi.fn(),
    classify: vi.fn(async (model: { provider: string; id: string }) => ({
      api: 'typesafe-system-one', provider: model.provider, model: model.id, answers: {}, stopReason: 'stop', timestamp: 0, ...classify(),
    })),
  };
  (runtime as unknown as { _modelRuntime: unknown })._modelRuntime = fake;
  return { runtime, fake };
}

const REQ = {
  state: { a: 'b' },
  questions: { q: { type: 'bool' as const, instructions: 'i', criteria: { true: 't', false: 'f' } } },
  purpose: 'memory-merge' as const,
  timeoutMs: 1000,
};

function writeAuthFile(entries: Record<string, unknown>): void {
  fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(PI_AGENT_DIR, 'auth.json'), JSON.stringify(entries));
}
const CHATGPT_GRANT = { openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 9_999_999_999_999 } };

describe('TypeSafe key and memory-judge status', () => {
  beforeEach(() => {
    for (const name of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) vi.stubEnv(name, '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    fs.rmSync(path.join(PI_AGENT_DIR, 'auth.json'), { force: true });
    await PiRuntime.disposeInstance();
  });

  it('stores the trimmed key under its own secret and reads the judge from the keys before pi starts', async () => {
    const platform = createFakePlatform({ secrets: { 'damocles.explore.apiKey.openrouter': 'or-key' } });
    expect(await typesafeAuthStatus(platform)).toEqual({
      type: 'typesafeAuthStatusChanged',
      configured: false,
      memoryJudge: { kind: 'classifier', via: 'openrouter' },
      classifierCredentials: { typesafe: 'no-key', openrouter: 'ok', openai: 'no-key' },
    });

    await storeTypesafeApiKey(platform, '  ts-key  ');
    expect(await platform.secrets.get('damocles.typesafe.apiKey')).toBe('ts-key');
    expect(await typesafeAuthStatus(platform)).toMatchObject({ configured: true, memoryJudge: { kind: 'classifier', via: 'typesafe' } });

    await deleteTypesafeApiKey(platform);
    await platform.secrets.delete('damocles.explore.apiKey.openrouter');
    expect(await typesafeAuthStatus(platform)).toMatchObject({ configured: false, memoryJudge: { kind: 'unknown' } });
  });

  it('counts the environment keys pi reads before pi starts', async () => {
    const platform = createFakePlatform();
    vi.stubEnv('OPENAI_API_KEY', 'sk-env');
    expect(await typesafeAuthStatus(platform)).toMatchObject({ configured: false, memoryJudge: { kind: 'classifier', via: 'openai' } });
    vi.stubEnv('OPENROUTER_API_KEY', 'or-env');
    expect(await typesafeAuthStatus(platform)).toMatchObject({ configured: false, memoryJudge: { kind: 'classifier', via: 'openrouter' } });
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-env');
    expect(await typesafeAuthStatus(platform)).toMatchObject({ configured: false, memoryJudge: { kind: 'classifier', via: 'typesafe' } });
  });

  it('names GPT-6 Luna before pi starts only while the OpenAI request credential is the API key', async () => {
    const platform = createFakePlatform({ secrets: { 'damocles.openai.apiKey': 'sk-key' } });
    expect(await typesafeAuthStatus(platform)).toMatchObject({ memoryJudge: { kind: 'classifier', via: 'openai' }, classifierCredentials: { openai: 'ok' } });

    writeAuthFile(CHATGPT_GRANT);
    expect(await typesafeAuthStatus(platform)).toMatchObject({ memoryJudge: { kind: 'unknown' }, classifierCredentials: { openai: 'chatgpt-active' } });

    await platform.state.workspace.update('damocles.openai.preferApiKey', true);
    expect(await typesafeAuthStatus(platform)).toMatchObject({ classifierCredentials: { openai: 'chatgpt-active' } });
    await platform.state.global.update('damocles.openai.preferApiKey', true);
    expect(await typesafeAuthStatus(platform)).toMatchObject({ memoryJudge: { kind: 'classifier', via: 'openai' } });
  });

  it('reports a chosen classifier that cannot run as no judge before pi starts, never another classifier', async () => {
    const platform = createFakePlatform({
      secrets: { 'damocles.explore.apiKey.openrouter': 'or-key' },
      settings: { user: { 'damocles.memory.judge': 'jev-typesafe' } },
    });
    expect(await typesafeAuthStatus(platform)).toMatchObject({ memoryJudge: { kind: 'none', forced: { choice: 'jev-typesafe', reason: 'no-key' } } });

    await platform.settings.update('damocles.memory.judge', 'jev-openrouter', 'user');
    expect(await typesafeAuthStatus(platform)).toMatchObject({ memoryJudge: { kind: 'classifier', via: 'openrouter' } });

    await platform.settings.update('damocles.memory.judge', 'claude-sonnet-5-5', 'user');
    expect(await typesafeAuthStatus(platform)).toMatchObject({ memoryJudge: { kind: 'unknown' } });
  });

  it('reports a stored judge outside the catalog as unrecognized before pi starts', async () => {
    const platform = createFakePlatform({ settings: { user: { 'damocles.memory.judge': 'claude-opus-1' } } });
    expect(await typesafeAuthStatus(platform)).toMatchObject({ memoryJudge: { kind: 'none', forced: { choice: 'claude-opus-1', reason: 'unrecognized' } } });
  });

  it('keeps the judge model unknown while pi is loaded but no chat has started it', async () => {
    const platform = createFakePlatform();
    startedRuntime(() => ({}));
    expect(await typesafeAuthStatus(platform)).toMatchObject({ memoryJudge: { kind: 'unknown' } });
  });

  it('saving the same key again clears its refusal at once', async () => {
    const platform = installFakePlatform();
    const { runtime } = startedRuntime(() => ({ stopReason: 'error', errorMessage: 'System One API error (402): {}' }));
    await storeTypesafeApiKey(platform, 'ts-key');
    expect(runtime.hasClassifier()).toBe(true);
    await runtime.runClassification(REQ);
    expect(runtime.hasClassifier()).toBe(false);

    await storeTypesafeApiKey(platform, 'ts-key');
    expect(runtime.hasClassifier()).toBe(true);
  });
});
