import { describe, it, expect, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { CUSTOM_PROVIDER_DEFS, syncCustomProviders, exploreThinkingLevel } from '../custom-providers';

/**
 * Guards the StepFun wire behavior (Slice 2): step_plan takes reasoning effort as adaptive
 * `output_config.effort` and rejects the token-budget `thinking.budget_tokens` shape, so the registered
 * model MUST carry `compat: { forceAdaptiveThinking: true }`. This test fails if that flag is dropped.
 */
describe('CUSTOM_PROVIDER_DEFS — StepFun adaptive-thinking compat', () => {
  it('registers step-3.7-flash with compat.forceAdaptiveThinking', () => {
    const stepfun = CUSTOM_PROVIDER_DEFS.find((d) => d.provider === 'stepfun');
    expect(stepfun?.registerConfig?.models?.[0].compat).toEqual({ forceAdaptiveThinking: true });
  });
});

/**
 * `exploreThinkingLevel` double-match guard: an effort maps to a pi thinking level only when it parses
 * to a valid level AND the model matches a DEFAULT_MODELS entry by BOTH `value` and `piProvider`.
 * effortToPiThinking maps 'low'/'medium'/'high' to the identical pi levels 'low'/'medium'/'high'.
 */
describe('exploreThinkingLevel', () => {
  const model = (provider: string, id: string) => ({ provider, id }) as unknown as Model<Api>;
  const stepFlash = model('stepfun', 'step-3.7-flash');

  it('maps supported effort levels on the matching catalog model', () => {
    expect(exploreThinkingLevel(stepFlash, 'low')).toBe('low');
    expect(exploreThinkingLevel(stepFlash, 'medium')).toBe('medium');
    expect(exploreThinkingLevel(stepFlash, 'high')).toBe('high');
  });

  it('returns undefined for empty or garbage effort', () => {
    expect(exploreThinkingLevel(stepFlash, '')).toBeUndefined();
    expect(exploreThinkingLevel(stepFlash, 'bogus')).toBeUndefined();
  });

  it('returns undefined for a non-catalog model id', () => {
    expect(exploreThinkingLevel(model('openrouter', 'deepseek/deepseek-v4-flash'), 'high')).toBeUndefined();
  });

  it('returns undefined when the catalog value matches but the provider does not (double-match guard)', () => {
    expect(exploreThinkingLevel(model('openrouter', 'deepseek-v4-flash'), 'high')).toBeUndefined();
  });

  it('returns undefined for a valid level the model does not support', () => {
    expect(exploreThinkingLevel(stepFlash, 'max')).toBeUndefined();
  });
});

type AuthStatus = ReturnType<ModelRuntime['getProviderAuthStatus']>;

function makeRuntime(authStatus: Partial<Record<string, AuthStatus>> = {}) {
  const runtime = {
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    setRuntimeApiKey: vi.fn(async () => {}),
    removeRuntimeApiKey: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    getProviderAuthStatus: vi.fn((providerId: string): AuthStatus => authStatus[providerId] ?? { configured: false }),
  };
  // Each makeRuntime call is a distinct object, so the module-level WeakMap cache starts empty per test.
  return { runtime, asModelRuntime: runtime as unknown as ModelRuntime };
}

function secrets(map: Record<string, string | undefined>) {
  return (key: string): PromiseLike<string | undefined> => Promise.resolve(map[key]);
}

const STEPFUN_SECRET = 'damocles.explore.apiKey.stepfun';
const DEEPSEEK_SECRET = 'damocles.deepseek.apiKey';

describe('syncCustomProviders', () => {
  it('registers + authenticates providers whose secret is present', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const wired = await syncCustomProviders({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key', [DEEPSEEK_SECRET]: 'ds-key' }),
    });

    expect(wired).toEqual(['stepfun', 'deepseek']);
    expect(runtime.registerProvider).toHaveBeenCalledTimes(1); // only StepFun is mode:'register'
    expect(runtime.registerProvider.mock.calls[0][0]).toBe('stepfun');
    expect(runtime.registerProvider.mock.calls[0][1]).toMatchObject({ apiKey: 'sf-key' });
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('stepfun', 'sf-key');
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('deepseek', 'ds-key');
  });

  it('skips the refresh-triggering re-apply when a key is unchanged, and re-applies on change', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const deps = { modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }) };

    expect(await syncCustomProviders(deps)).toEqual(['deepseek']);
    expect(await syncCustomProviders(deps)).toEqual(['deepseek']); // still reported wired…
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(1); // …but not re-applied

    const changed = { modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key-2' }) };
    expect(await syncCustomProviders(changed)).toEqual(['deepseek']);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(2);
    expect(runtime.setRuntimeApiKey).toHaveBeenLastCalledWith('deepseek', 'ds-key-2');
  });

  it('deauthenticates a previously-wired provider when its secret is deleted', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    await syncCustomProviders({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key', [DEEPSEEK_SECRET]: 'ds-key' }),
    });

    const wired = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({}) });

    expect(wired).toEqual([]);
    expect(runtime.unregisterProvider).toHaveBeenCalledWith('stepfun'); // fresh-registered → dropped entirely
    expect(runtime.unregisterProvider).not.toHaveBeenCalledWith('deepseek'); // built-in → only deauthed
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('stepfun');
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('deepseek');
    expect(runtime.logout).toHaveBeenCalledWith('stepfun');
    expect(runtime.logout).toHaveBeenCalledWith('deepseek');
  });

  it('sweeps a legacy ≤2.6 stored auth.json credential when the secret is absent', async () => {
    // Fresh process (no cached override) but pi reports a stored credential — the ≤2.6 plaintext key.
    const { runtime, asModelRuntime } = makeRuntime({ deepseek: { configured: true, source: 'stored' } });

    await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({}) });

    expect(runtime.logout).toHaveBeenCalledWith('deepseek');
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('deepseek');
  });

  it('leaves ambient environment auth alone when the secret is absent', async () => {
    const { runtime, asModelRuntime } = makeRuntime({
      google: { configured: true, source: 'environment', label: 'GEMINI_API_KEY' },
    });

    await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({}) });

    expect(runtime.logout).not.toHaveBeenCalledWith('google');
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalledWith('google');
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
  });

  it('is a no-op for providers that were never configured', async () => {
    const { runtime, asModelRuntime } = makeRuntime();

    const wired = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({}) });

    expect(wired).toEqual([]);
    expect(runtime.logout).not.toHaveBeenCalled();
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
  });
});
