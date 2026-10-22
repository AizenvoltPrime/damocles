import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createFakePlatform, installFakePlatform } from '../../../../../__mocks__/fake-platform';
import { deleteProviderKey, providerAuthStatus, storeProviderKey } from '../provider-keys';
import { PiRuntime } from '../../../../pi-session/pi-runtime';
import { KEY_PROVIDER_IDS } from '../../../../../shared/settings-sections';

const SECRET_NAMES = {
  deepseek: 'damocles.deepseek.apiKey',
  stepfun: 'damocles.explore.apiKey.stepfun',
  minimax: 'damocles.minimax.apiKey',
  xai: 'damocles.xai.apiKey',
  openrouter: 'damocles.explore.apiKey.openrouter',
  typesafe: 'damocles.typesafe.apiKey',
} as const;

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

describe('provider keys', () => {
  beforeEach(() => {
    for (const name of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) vi.stubEnv(name, '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await PiRuntime.disposeInstance();
  });

  it.each(KEY_PROVIDER_IDS)('stores the trimmed %s key under its unchanged secret name, and its status follows the store', async (provider) => {
    const platform = createFakePlatform();
    expect(await providerAuthStatus(platform, provider)).toEqual({ type: 'providerAuthStatusChanged', provider, configured: false, external: null });

    await storeProviderKey(platform, provider, '  the-key  ');
    expect(await platform.secrets.get(SECRET_NAMES[provider])).toBe('the-key');
    expect(await providerAuthStatus(platform, provider)).toEqual({ type: 'providerAuthStatusChanged', provider, configured: true, external: null });

    await deleteProviderKey(platform, provider);
    expect(await platform.secrets.get(SECRET_NAMES[provider])).toBeUndefined();
    expect(await providerAuthStatus(platform, provider)).toEqual({ type: 'providerAuthStatusChanged', provider, configured: false, external: null });
  });

  it('marks a credential pi holds that Damocles did not apply, never the key Damocles applied', async () => {
    const platform = installFakePlatform();
    const { fake } = startedRuntime(() => ({}));
    await storeProviderKey(platform, 'minimax', 'sk-cp-x');
    expect(await providerAuthStatus(platform, 'minimax')).toEqual({ type: 'providerAuthStatusChanged', provider: 'minimax', configured: true, external: null });

    // pi reports its runtime key ahead of an environment key (model-runtime.js:441-450), so the environment shows once the stored key is gone.
    const runtimeStatus = fake.getProviderAuthStatus;
    fake.getProviderAuthStatus = (p: string) => (p === 'minimax' && !runtimeStatus(p).configured ? { configured: true, source: 'environment' } : runtimeStatus(p));
    await deleteProviderKey(platform, 'minimax');
    expect(await providerAuthStatus(platform, 'minimax')).toEqual({ type: 'providerAuthStatusChanged', provider: 'minimax', configured: false, external: 'environment' });
  });

  it.each([['stored'], ['models_json_key'], ['models_json_command'], ['fallback']])('names a %s credential as pi\'s configuration, not the environment', async (source) => {
    const platform = installFakePlatform();
    const { fake } = startedRuntime(() => ({}));
    fake.getProviderAuthStatus = (p: string) => (p === 'xai' ? { configured: true, source } : { configured: false, source: 'runtime' });
    expect(await providerAuthStatus(platform, 'xai')).toEqual({ type: 'providerAuthStatusChanged', provider: 'xai', configured: false, external: 'piConfig' });
  });

  it('answers nothing when the secret store fails, so the status last posted stands', async () => {
    const platform = createFakePlatform();
    vi.spyOn(platform.secrets, 'get').mockRejectedValue(new Error('keyring is locked'));
    expect(await providerAuthStatus(platform, 'deepseek')).toBeUndefined();
  });

  it.each(KEY_PROVIDER_IDS)('resolves a %s store and delete only after the resync', async (provider) => {
    const platform = installFakePlatform();
    const runtime = PiRuntime.get();
    let finishSync = (): void => {};
    vi.spyOn(runtime, 'syncCustomProviders').mockImplementation(
      () => new Promise((resolve) => { finishSync = () => resolve({ wired: [], notWired: [], timedOut: false }); }),
    );
    for (const run of [() => storeProviderKey(platform, provider, 'k'), () => deleteProviderKey(platform, provider)]) {
      let settled = false;
      const done = run().then(() => { settled = true; });
      await vi.waitFor(() => expect(runtime.syncCustomProviders).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      finishSync();
      await done;
      vi.mocked(runtime.syncCustomProviders).mockClear();
    }
  });

  it.each(KEY_PROVIDER_IDS)('resets the %s classifier breaker on every save, the same key included', async (provider) => {
    const platform = installFakePlatform();
    const runtime = PiRuntime.get();
    vi.spyOn(runtime, 'syncCustomProviders').mockResolvedValue({ wired: [], notWired: [], timedOut: false });
    const reset = vi.spyOn(runtime, 'resetClassifierBreaker');
    await storeProviderKey(platform, provider, 'k');
    await storeProviderKey(platform, provider, 'k');
    expect(reset.mock.calls).toEqual([[provider], [provider]]);
  });

  it('saving the same TypeSafe key again clears its refusal at once', async () => {
    const platform = installFakePlatform();
    const { runtime } = startedRuntime(() => ({ stopReason: 'error', errorMessage: 'System One API error (402): {}' }));
    await storeProviderKey(platform, 'typesafe', 'ts-key');
    expect(runtime.hasClassifier()).toBe(true);
    await runtime.runClassification(REQ);
    expect(runtime.hasClassifier()).toBe(false);

    await storeProviderKey(platform, 'typesafe', 'ts-key');
    expect(runtime.hasClassifier()).toBe(true);
  });
});
