import { describe, it, expect, afterEach, vi } from 'vitest';
import { createFakePlatform, installFakePlatform } from '../../../../../__mocks__/fake-platform';
import { deleteTypesafeApiKey, storeTypesafeApiKey, typesafeAuthStatus } from '../explore-manager';
import { PiRuntime } from '../../../../pi-session/pi-runtime';

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

describe('TypeSafe key and memory-judge status', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await PiRuntime.disposeInstance();
  });

  it('stores the trimmed key under its own secret and reads the judge from the keys before pi starts', async () => {
    const platform = createFakePlatform({ secrets: { 'damocles.explore.apiKey.openrouter': 'or-key' } });
    expect(await typesafeAuthStatus(platform)).toEqual({ type: 'typesafeAuthStatusChanged', configured: false, memoryJudge: { kind: 'jev', via: 'openrouter' } });

    await storeTypesafeApiKey(platform, '  ts-key  ');
    expect(await platform.secrets.get('damocles.typesafe.apiKey')).toBe('ts-key');
    expect(await typesafeAuthStatus(platform)).toMatchObject({ configured: true, memoryJudge: { kind: 'jev', via: 'typesafe' } });

    await deleteTypesafeApiKey(platform);
    await platform.secrets.delete('damocles.explore.apiKey.openrouter');
    expect(await typesafeAuthStatus(platform)).toMatchObject({ configured: false, memoryJudge: { kind: 'unknown' } });
  });

  it('counts the environment keys pi reads before pi starts', async () => {
    const platform = createFakePlatform();
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', 'or-env');
    expect(await typesafeAuthStatus(platform)).toMatchObject({ configured: false, memoryJudge: { kind: 'jev', via: 'openrouter' } });
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-env');
    expect(await typesafeAuthStatus(platform)).toMatchObject({ configured: false, memoryJudge: { kind: 'jev', via: 'typesafe' } });
  });

  it('keeps the sub-call model unknown while pi is loaded but no chat has started it', async () => {
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
