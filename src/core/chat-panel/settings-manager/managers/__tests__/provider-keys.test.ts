import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createFakePlatform, installFakePlatform } from '../../../../../__mocks__/fake-platform';
import { deleteProviderKey, providerAuthStatus, setProviderPreferApiKey, storeProviderKey } from '../provider-keys';
import { PiRuntime } from '../../../../pi-session/pi-runtime';
import { PI_AGENT_DIR } from '../../../../pi-session/agent-dir';
import { KEY_PROVIDER_IDS } from '../../../../../shared/settings-sections';

const SECRET_NAMES = {
  deepseek: 'damocles.deepseek.apiKey',
  stepfun: 'damocles.explore.apiKey.stepfun',
  minimax: 'damocles.minimax.apiKey',
  xai: 'damocles.xai.apiKey',
  'kimi-coding': 'damocles.kimi-coding.apiKey',
  meta: 'damocles.meta.apiKey',
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
    getProviderAuthStatus: (p: string): { configured: boolean; source?: string } => (keys.has(p) ? { configured: true, source: 'runtime' } : { configured: false }),
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
  (runtime as unknown as { _initPromise: Promise<void> })._initPromise = Promise.resolve();
  return { runtime, fake };
}

/** The key sync a started runtime's secrets listener runs on the change a store or delete raises. */
const syncOnSecretChange = (runtime: PiRuntime, platform: ReturnType<typeof installFakePlatform>) =>
  runtime.syncCustomProviders((key) => platform.secrets.get(key));

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
    const base = { type: 'providerAuthStatusChanged', provider, external: null, signedIn: false, preferApiKey: false };
    expect(await providerAuthStatus(platform, provider)).toEqual({ ...base, configured: false, active: 'none' });

    await storeProviderKey(platform, provider, '  the-key  ');
    expect(await platform.secrets.get(SECRET_NAMES[provider])).toBe('the-key');
    expect(await providerAuthStatus(platform, provider)).toEqual({ ...base, configured: true, active: 'apiKey' });

    await deleteProviderKey(platform, provider);
    expect(await platform.secrets.get(SECRET_NAMES[provider])).toBeUndefined();
    expect(await providerAuthStatus(platform, provider)).toEqual({ ...base, configured: false, active: 'none' });
  });

  it('marks a credential pi holds that Damocles did not apply, never the key Damocles applied', async () => {
    const platform = installFakePlatform();
    const { runtime, fake } = startedRuntime(() => ({}));
    const base = { type: 'providerAuthStatusChanged', provider: 'minimax', signedIn: false, preferApiKey: false };
    await storeProviderKey(platform, 'minimax', 'sk-cp-x');
    await syncOnSecretChange(runtime, platform);
    expect(fake.setRuntimeApiKey).toHaveBeenCalledWith('minimax', 'sk-cp-x', expect.anything());
    expect(await providerAuthStatus(platform, 'minimax')).toEqual({ ...base, configured: true, external: null, active: 'apiKey' });

    // pi reports its runtime key ahead of an environment key (model-runtime.js:441-450), so the environment shows once the stored key is gone.
    const runtimeStatus = fake.getProviderAuthStatus;
    fake.getProviderAuthStatus = (p: string) => (p === 'minimax' && !runtimeStatus(p).configured ? { configured: true, source: 'environment' } : runtimeStatus(p));
    await deleteProviderKey(platform, 'minimax');
    await syncOnSecretChange(runtime, platform);
    expect(await providerAuthStatus(platform, 'minimax')).toEqual({ ...base, configured: false, external: 'environment', active: 'external' });
  });

  it.each([['stored'], ['models_json_key'], ['models_json_command'], ['fallback']])('names a %s credential as pi\'s configuration, not the environment', async (source) => {
    const platform = installFakePlatform();
    const { fake } = startedRuntime(() => ({}));
    fake.getProviderAuthStatus = (p: string) => (p === 'xai' ? { configured: true, source } : { configured: false, source: 'runtime' });
    expect(await providerAuthStatus(platform, 'xai')).toEqual({
      type: 'providerAuthStatusChanged', provider: 'xai', configured: false, external: 'piConfig', signedIn: false, preferApiKey: false, active: 'external',
    });
  });

  it.each([['environment', 'environment'], ['models_json_key', 'piConfig']])('reports GitHub Copilot\'s %s credential, which no sign-in made, as external', async (source, external) => {
    const platform = installFakePlatform();
    const { fake } = startedRuntime(() => ({}));
    fake.getProviderAuthStatus = (p: string) => (p === 'github-copilot' ? { configured: true, source } : { configured: false });
    expect(await providerAuthStatus(platform, 'github-copilot')).toEqual({
      type: 'providerAuthStatusChanged', provider: 'github-copilot', configured: false, external, signedIn: false, preferApiKey: false, active: 'external',
    });
  });

  it('reads auth.json once per key status, and hands that read to the external-key check', async () => {
    const platform = installFakePlatform();
    const { runtime } = startedRuntime(() => ({}));
    const external = vi.spyOn(runtime, 'externalKeySource');
    await providerAuthStatus(platform, 'xai');
    await providerAuthStatus(platform, 'github-copilot');
    expect(external.mock.calls).toEqual([['xai', {}], ['github-copilot', {}]]);
  });

  describe('beside a stored sign-in', () => {
    const authPath = path.join(PI_AGENT_DIR, 'auth.json');
    beforeEach(() => {
      fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
      fs.writeFileSync(authPath, JSON.stringify({ xai: { type: 'oauth', access: 'a', refresh: 'r', expires: 7_000 } }));
    });
    afterEach(() => {
      fs.rmSync(authPath, { force: true });
    });

    it('reads the sign-in from auth.json, and the sign-in is active until prefer is on', async () => {
      const platform = installFakePlatform();
      const { runtime, fake } = startedRuntime(() => ({}));
      await storeProviderKey(platform, 'xai', 'xai-key');
      await syncOnSecretChange(runtime, platform);
      expect(fake.setRuntimeApiKey).not.toHaveBeenCalled();
      const signedIn = { type: 'providerAuthStatusChanged', provider: 'xai', configured: true, external: null, signedIn: true, signedInExpiresAt: 7_000 };
      expect(await providerAuthStatus(platform, 'xai')).toEqual({ ...signedIn, preferApiKey: false, active: 'signIn' });

      await setProviderPreferApiKey('xai', true);
      expect(fake.setRuntimeApiKey).toHaveBeenCalledWith('xai', 'xai-key', expect.anything());
      expect(await providerAuthStatus(platform, 'xai')).toEqual({ ...signedIn, preferApiKey: true, active: 'apiKey' });

      await setProviderPreferApiKey('xai', false);
      expect(fake.removeRuntimeApiKey).toHaveBeenCalledWith('xai', expect.anything());
      expect(await providerAuthStatus(platform, 'xai')).toEqual({ ...signedIn, preferApiKey: false, active: 'signIn' });
      expect(fake.logout).not.toHaveBeenCalled();
    });

    it('reports an environment key beside the sign-in as the sign-in, which pi resolves first', async () => {
      const platform = installFakePlatform();
      const { fake } = startedRuntime(() => ({}));
      fake.getProviderAuthStatus = (p: string) => (p === 'xai' ? { configured: true, source: 'environment' } : { configured: false, source: 'runtime' });
      expect(await providerAuthStatus(platform, 'xai')).toEqual({
        type: 'providerAuthStatusChanged', provider: 'xai', configured: false, external: null, signedIn: true, signedInExpiresAt: 7_000, preferApiKey: false, active: 'signIn',
      });
    });

    it('reports GitHub Copilot\'s sign-in, which pi resolves before COPILOT_GITHUB_TOKEN', async () => {
      fs.writeFileSync(authPath, JSON.stringify({ 'github-copilot': { type: 'oauth', access: 'a', refresh: 'r', expires: 9_000 } }));
      const platform = installFakePlatform();
      const { fake } = startedRuntime(() => ({}));
      fake.getProviderAuthStatus = (p: string) => (p === 'github-copilot' ? { configured: true, source: 'environment' } : { configured: false });
      expect(await providerAuthStatus(platform, 'github-copilot')).toEqual({
        type: 'providerAuthStatusChanged', provider: 'github-copilot', configured: false, external: null, signedIn: true, signedInExpiresAt: 9_000, preferApiKey: false, active: 'signIn',
      });
    });

    it('leaves the sign-in in auth.json when the key is deleted', async () => {
      const platform = installFakePlatform();
      const { runtime, fake } = startedRuntime(() => ({}));
      await storeProviderKey(platform, 'xai', 'xai-key');
      await syncOnSecretChange(runtime, platform);
      await deleteProviderKey(platform, 'xai');
      await syncOnSecretChange(runtime, platform);
      expect(fake.logout).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(authPath, 'utf8')).xai.type).toBe('oauth');
    });
  });

  it('answers nothing when the secret store fails, so the status last posted stands', async () => {
    const platform = createFakePlatform();
    vi.spyOn(platform.secrets, 'get').mockRejectedValue(new Error('keyring is locked'));
    expect(await providerAuthStatus(platform, 'deepseek')).toBeUndefined();
  });

  // The secret's change event runs the runtime's key sync; one here too would sync every save and clear twice.
  it.each(KEY_PROVIDER_IDS)('starts no key sync of its own for a %s store or delete', async (provider) => {
    const platform = installFakePlatform();
    const runtime = PiRuntime.get();
    const sync = vi.spyOn(runtime, 'syncCustomProviders').mockResolvedValue({ wired: [], notWired: [], timedOut: false });
    await storeProviderKey(platform, provider, 'k');
    await deleteProviderKey(platform, provider);
    expect(sync).not.toHaveBeenCalled();
  });

  it.each(KEY_PROVIDER_IDS)('resets the %s classifier breaker on every save, the same key included', async (provider) => {
    const platform = installFakePlatform();
    const runtime = PiRuntime.get();
    const reset = vi.spyOn(runtime, 'resetClassifierBreaker');
    await storeProviderKey(platform, provider, 'k');
    await storeProviderKey(platform, provider, 'k');
    expect(reset.mock.calls).toEqual([[provider], [provider]]);
  });

  it('saving the same TypeSafe key again clears its refusal at once', async () => {
    const platform = installFakePlatform();
    const { runtime } = startedRuntime(() => ({ stopReason: 'error', errorMessage: 'System One API error (402): {}' }));
    await storeProviderKey(platform, 'typesafe', 'ts-key');
    await syncOnSecretChange(runtime, platform);
    expect(runtime.hasClassifier()).toBe(true);
    await runtime.runClassification(REQ);
    expect(runtime.hasClassifier()).toBe(false);

    await storeProviderKey(platform, 'typesafe', 'ts-key');
    expect(runtime.hasClassifier()).toBe(true);
  });
});
