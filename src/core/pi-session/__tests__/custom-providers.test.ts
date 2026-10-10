import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { getEventListeners } from 'node:events';
import { installLogSink } from '../../logger';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { CUSTOM_PROVIDER_DEFS, providerKeyStored, syncCustomProviders } from '../custom-providers';

/**
 * Guards the StepFun wire behavior (Slice 2): step_plan takes reasoning effort as adaptive
 * `output_config.effort` and rejects the token-budget `thinking.budget_tokens` shape, so the registered
 * model MUST carry `compat: { forceAdaptiveThinking: true }`. This test fails if that flag is dropped.
 */
describe('CUSTOM_PROVIDER_DEFS — StepFun adaptive-thinking compat', () => {
  it('registers step-5-preview with compat.forceAdaptiveThinking', () => {
    const stepfun = CUSTOM_PROVIDER_DEFS.find((d) => d.provider === 'stepfun');
    expect(stepfun?.registerConfig?.models?.[0]).toHaveProperty('compat', { forceAdaptiveThinking: true });
  });

  // StepFun has no way to disable thinking, so `off` must clamp up to low rather than reach the wire.
  it('registers Step 5 Preview with low, medium and high only, as its own cheap model', () => {
    const stepfun = CUSTOM_PROVIDER_DEFS.find((d) => d.provider === 'stepfun');
    expect(stepfun?.cheapModelId).toBe('step-5-preview');
    expect(stepfun?.registerConfig?.models).toEqual([
      expect.objectContaining({
        id: 'step-5-preview',
        name: 'StepFun Step 5 Preview',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 64_000,
        thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null },
      }),
    ]);
  });

  it('names DeepSeek V4.1 Flash as the DeepSeek cheap model', () => {
    expect(CUSTOM_PROVIDER_DEFS.find((d) => d.provider === 'deepseek')?.cheapModelId).toBe('deepseek-flash');
  });
});

describe('CUSTOM_PROVIDER_DEFS: the OpenRouter and StepFun keys', () => {
  it('registers no Gemini provider, so a stored Gemini key wires nothing', () => {
    expect(CUSTOM_PROVIDER_DEFS.map((d) => d.provider)).toEqual(['stepfun', 'deepseek', 'openrouter', 'typesafe']);
  });

  // The stored names predate the keys' current uses; renaming one would drop every user's saved key.
  it('reads the OpenRouter and StepFun keys from their stored names', () => {
    expect(CUSTOM_PROVIDER_DEFS.find((d) => d.provider === 'openrouter')?.secretKey).toBe('damocles.explore.apiKey.openrouter');
    expect(CUSTOM_PROVIDER_DEFS.find((d) => d.provider === 'stepfun')?.secretKey).toBe('damocles.explore.apiKey.stepfun');
  });

  it('gives OpenRouter no cheap model, so the Explore default never runs on it', () => {
    expect(CUSTOM_PROVIDER_DEFS.find((d) => d.provider === 'openrouter')?.cheapModelId).toBeUndefined();
  });

  it('wires OpenRouter from its key, which image generation and Jev read as the openrouter runtime key', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const result = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({ 'damocles.explore.apiKey.openrouter': 'sk-or' }) });
    expect(result.wired).toEqual(['openrouter']);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('openrouter', 'sk-or', {});
  });

  it('registers StepFun from its key, which StepFun chats run on', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const result = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({ 'damocles.explore.apiKey.stepfun': 'sf' }) });
    expect(result.wired).toEqual(['stepfun']);
    expect(runtime.registerProvider).toHaveBeenCalledWith('stepfun', expect.objectContaining({ apiKey: 'sf', baseUrl: 'https://api.stepfun.ai/step_plan' }));
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('stepfun', 'sf', {});
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

/**
 * Capture what `logger.ts` ACTUALLY writes, not the format-string arguments. The leak this guards was
 * invisible at the argument level: `log('… %O', provider, err)` looks innocent until `node:util.format`
 * inspects the error's own enumerable `credential` property into the channel.
 */
const logLines: string[] = [];
beforeAll(() => {
  installLogSink({
    appendLine: (line: string) => void logLines.push(line),
    show: () => {},
    dispose: () => {},
  });
});
beforeEach(() => {
  logLines.length = 0;
});

const SENTINEL = 'sk-SENTINEL-MUST-NEVER-BE-LOGGED';

/** The shape pi's `CredentialSynchronizationError` (`@earendil-works/pi-coding-agent`) actually has:
 *  `credential` is an OWN ENUMERABLE property holding the raw key. */
function credentialSyncError(name = 'CredentialSynchronizationError'): Error {
  return Object.assign(new Error('failed to synchronize credential state'), {
    name,
    providerId: 'deepseek',
    operation: 'setRuntimeApiKey',
    credential: { type: 'api_key', key: SENTINEL },
    cause: new Error('lock compromised'),
  });
}

describe('syncCustomProviders', () => {
  it('registers + authenticates providers whose secret is present, forwarding the caller signal', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const controller = new AbortController();
    const result = await syncCustomProviders({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key', [DEEPSEEK_SECRET]: 'ds-key' }),
      signal: controller.signal,
    });

    expect(result).toEqual({ wired: ['stepfun', 'deepseek'], aborted: false, notWired: [], changed: ['stepfun', 'deepseek'] });
    expect(runtime.registerProvider).toHaveBeenCalledTimes(1); // only StepFun is mode:'register'
    expect(runtime.registerProvider.mock.calls[0]![0]).toBe('stepfun');
    expect(runtime.registerProvider.mock.calls[0]![1]).toMatchObject({ apiKey: 'sf-key' });
    // Signal IDENTITY, not `expect.anything()`: `{}` matches `expect.anything()`, so deleting the
    // options argument entirely — the whole cancellation mechanism — would keep this green.
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('stepfun', 'sf-key', { signal: controller.signal });
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('deepseek', 'ds-key', { signal: controller.signal });
  });

  it('skips the refresh-triggering re-apply when a key is unchanged, and re-applies on change', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const controller = new AbortController();
    const deps = {
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }),
      signal: controller.signal,
    };

    expect((await syncCustomProviders(deps)).changed).toEqual(['deepseek']);
    const unchanged = await syncCustomProviders(deps);
    expect(unchanged.wired).toEqual(['deepseek']); // still reported wired…
    expect(unchanged.changed).toEqual([]);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(1); // …but not re-applied

    const changed = { ...deps, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key-2' }) };
    expect(await syncCustomProviders(changed)).toMatchObject({ wired: ['deepseek'], changed: ['deepseek'] });
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(2);
    expect(runtime.setRuntimeApiKey).toHaveBeenLastCalledWith('deepseek', 'ds-key-2', { signal: controller.signal });
  });

  it('deauthenticates a previously-wired provider when its secret is deleted', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const controller = new AbortController();
    await syncCustomProviders({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key', [DEEPSEEK_SECRET]: 'ds-key' }),
      signal: controller.signal,
    });

    const result = await syncCustomProviders({
      modelRuntime: asModelRuntime,
      getSecret: secrets({}),
      signal: controller.signal,
    });

    expect(result).toEqual({ wired: [], aborted: false, notWired: [], changed: ['stepfun', 'deepseek'] });
    expect(runtime.unregisterProvider).toHaveBeenCalledWith('stepfun'); // fresh-registered → dropped entirely
    expect(runtime.unregisterProvider).not.toHaveBeenCalledWith('deepseek'); // built-in → only deauthed
    // The deauth path is cancellable too — same signal-identity assertion.
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('stepfun', { signal: controller.signal });
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('deepseek', { signal: controller.signal });
    expect(runtime.logout).toHaveBeenCalledWith('stepfun', { signal: controller.signal });
    expect(runtime.logout).toHaveBeenCalledWith('deepseek', { signal: controller.signal });
  });

  it('sweeps a legacy ≤2.6 stored auth.json credential when the secret is absent', async () => {
    // Fresh process (no cached override) but pi reports a stored credential — the ≤2.6 plaintext key.
    const { runtime, asModelRuntime } = makeRuntime({ deepseek: { configured: true, source: 'stored' } });
    const controller = new AbortController();

    await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({}), signal: controller.signal });

    expect(runtime.logout).toHaveBeenCalledWith('deepseek', { signal: controller.signal });
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('deepseek', { signal: controller.signal });
  });

  it('leaves ambient environment auth alone when the secret is absent', async () => {
    const { runtime, asModelRuntime } = makeRuntime({
      typesafe: { configured: true, source: 'environment', label: 'TYPESAFE_API_KEY' },
    });

    await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({}) });

    expect(runtime.logout).not.toHaveBeenCalledWith('typesafe', expect.anything());
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalledWith('typesafe', expect.anything());
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
  });

  it('is a no-op for providers that were never configured', async () => {
    const { runtime, asModelRuntime } = makeRuntime();

    const result = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({}) });

    expect(result).toEqual({ wired: [], aborted: false, notWired: [], changed: [] });
    expect(runtime.logout).not.toHaveBeenCalled();
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it('wires nothing when the signal is already aborted, and reports only known-configured providers', async () => {
    // A4: nothing has been read yet and nothing is cached, so the only provider Damocles can honestly
    // call "configured but not live" is the one pi already reports a credential for.
    const { runtime, asModelRuntime } = makeRuntime({ typesafe: { configured: true, source: 'stored' } });

    const result = await syncCustomProviders({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key', [DEEPSEEK_SECRET]: 'ds-key' }),
      signal: AbortSignal.abort(),
    });

    expect(result).toEqual({ wired: [], aborted: true, notWired: ['typesafe'], changed: [] });
    expect(runtime.registerProvider).not.toHaveBeenCalled();
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it('cuts short MID-LOOP, keeping what it already wired and omitting no-secret providers from notWired', async () => {
    // A4 + A7: only abort-at-index-0 was covered before, so the `slice(cutShortAt)` tail was never
    // exercised with a non-empty `wired`. On a StepFun-only machine the remaining three have no secret
    // at all and must appear in NEITHER list — otherwise the fallback warning fires for a provider the
    // user never configured.
    const { runtime, asModelRuntime } = makeRuntime();
    const controller = new AbortController();
    runtime.setRuntimeApiKey.mockImplementationOnce(async () => {
      controller.abort();
    });

    const result = await syncCustomProviders({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key' }),
      signal: controller.signal,
    });

    expect(result).toEqual({ wired: ['stepfun'], aborted: true, notWired: [], changed: ['stepfun'] });
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(1);
  });

  it('keeps an unreached provider in notWired when the runtime already reports it configured', async () => {
    const { runtime, asModelRuntime } = makeRuntime({
      openrouter: { configured: true, source: 'stored' },
      typesafe: { configured: true, source: 'environment', label: 'TYPESAFE_API_KEY' },
    });
    const controller = new AbortController();
    runtime.setRuntimeApiKey.mockImplementationOnce(async () => {
      controller.abort();
    });

    const result = await syncCustomProviders({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key' }),
      signal: controller.signal,
    });

    expect(result).toEqual({ wired: ['stepfun'], aborted: true, notWired: ['openrouter', 'typesafe'], changed: ['stepfun'] });
  });

  it('reports a CredentialSynchronizationError provider as wired and caches its key (pi commits the key first)', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    runtime.setRuntimeApiKey.mockImplementationOnce(async () => {
      throw credentialSyncError();
    });
    const deps = { modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }) };

    expect(await syncCustomProviders(deps)).toEqual({ wired: ['deepseek'], aborted: false, notWired: [], changed: ['deepseek'] });
    // Cached despite the throw: the key IS live on the runtime, so re-applying it is pure cost.
    expect((await syncCustomProviders(deps)).wired).toEqual(['deepseek']);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(1);
  });

  it('reports a deauth that pi committed before a CredentialSynchronizationError as changed', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }) });
    runtime.removeRuntimeApiKey.mockImplementationOnce(async () => {
      throw credentialSyncError();
    });

    const result = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({}) });

    expect(result.changed).toEqual(['deepseek']);
  });

  it('classifies an abort ahead of CredentialSynchronizationError', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const controller = new AbortController();
    runtime.setRuntimeApiKey.mockImplementationOnce(async () => {
      controller.abort();
      throw credentialSyncError();
    });

    const result = await syncCustomProviders({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }),
      signal: controller.signal,
    });

    // deepseek's secret WAS read this sync, so it is known-configured even though it never applied;
    // openrouter/typesafe were never read and have no key, so they stay out of both lists.
    expect(result).toEqual({ wired: [], aborted: true, notWired: ['deepseek'], changed: [] });
    // …and the key was NOT cached, so an un-aborted resync re-applies it.
    const retry = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }) });
    expect(retry.wired).toEqual(['deepseek']);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(2);
  });
});

/** A1 — the blocker: pi attaches the raw API key to the error it throws on lock contention. */
describe('syncCustomProviders — credential redaction (A1)', () => {
  it('never writes the key carried by a CredentialSynchronizationError to the output channel', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    runtime.setRuntimeApiKey.mockImplementationOnce(async () => {
      throw credentialSyncError();
    });

    await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }) });

    const output = logLines.join('\n');
    expect(output).toContain('could not resynchronize');
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain('api_key');
    // Still diagnosable: name, message and the cause survive the redaction.
    expect(output).toContain('CredentialSynchronizationError: failed to synchronize credential state');
    expect(output).toContain('cause: Error: lock compromised');
  });

  it('never writes a key carried by a failure out of the apply path to the output channel', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    // `registerProvider` receives `{ ...registerConfig, apiKey: key }`, so anything it throws can carry it.
    runtime.registerProvider.mockImplementationOnce(() => {
      throw credentialSyncError('ProviderCompositionError');
    });

    const result = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({ [STEPFUN_SECRET]: SENTINEL }) });

    expect(result.notWired).toEqual(['stepfun']);
    const output = logLines.join('\n');
    expect(output).toContain('failed to wire stepfun');
    expect(output).not.toContain(SENTINEL);
  });

  it('never writes a key carried by a secret-read failure to the output channel', async () => {
    const { asModelRuntime } = makeRuntime();
    const getSecret = () => Promise.reject(credentialSyncError());

    await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret });

    expect(logLines.join('\n')).not.toContain(SENTINEL);
  });
});

/** A2 — the unbounded leg Damocles owns: VS Code `SecretStorage.get` takes no signal. */
describe('syncCustomProviders — the secret read is bounded by the signal (A2)', () => {
  it('cuts short a getSecret that never settles instead of hanging forever', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const controller = new AbortController();
    const getSecret = (): PromiseLike<string | undefined> => {
      // Aborts only AFTER the read is pending and the race is armed, so this exercises the race
      // itself rather than the loop-top `signal.aborted` pre-check.
      queueMicrotask(() => controller.abort());
      return new Promise<string | undefined>(() => {});
    };

    const result = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret, signal: controller.signal });

    expect(result).toEqual({ wired: [], aborted: true, notWired: [], changed: [] });
    // A lost race is an ABORT, never "secret absent" — collapsing the two is what deletes credentials.
    expect(runtime.logout).not.toHaveBeenCalled();
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
  });

  it('leaves no abort listener behind on the long-lived sync signal', async () => {
    // `_syncAbort.signal` outlives every sync on a PiRuntime, so a listener per provider per sync
    // would accumulate for the whole process lifetime.
    const { asModelRuntime } = makeRuntime();
    const controller = new AbortController();
    const deps = { modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }), signal: controller.signal };

    await syncCustomProviders(deps);
    await syncCustomProviders(deps);

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

/** A3 — a failed read is not an absent secret, and must never delete a stored credential. */
describe('syncCustomProviders — a failed secret read never deauthenticates (A3)', () => {
  it('leaves a provider with a stored credential entirely untouched and reports it notWired', async () => {
    const { runtime, asModelRuntime } = makeRuntime({ deepseek: { configured: true, source: 'stored' } });
    const getSecret = (key: string): PromiseLike<string | undefined> =>
      key === DEEPSEEK_SECRET ? Promise.reject(new Error('keyring is locked')) : Promise.resolve(undefined);

    const result = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret });

    expect(result).toEqual({ wired: [], aborted: false, notWired: ['deepseek'], changed: [] });
    expect(runtime.logout).not.toHaveBeenCalled();
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
    const output = logLines.join('\n');
    expect(output).toContain('could not read the stored secret for deepseek');
    expect(output).not.toContain('deauthenticated deepseek');
  });

  it('keeps the read-failure, absent-secret and failed-to-apply cases distinguishable', async () => {
    const { runtime, asModelRuntime } = makeRuntime({ typesafe: { configured: true, source: 'stored' } });
    runtime.setRuntimeApiKey.mockImplementationOnce(async () => {
      throw new Error('provider rejected the key');
    });
    const getSecret = (key: string): PromiseLike<string | undefined> => {
      if (key === STEPFUN_SECRET) return Promise.resolve('sf-key'); // bad key → failed to apply
      if (key === DEEPSEEK_SECRET) return Promise.reject(new Error('keyring is locked')); // unreadable
      return Promise.resolve(undefined); // genuinely absent
    };

    const result = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret });

    expect(result).toEqual({ wired: [], aborted: false, notWired: ['stepfun', 'deepseek'], changed: ['typesafe'] });
    const output = logLines.join('\n');
    expect(output).toContain('failed to wire stepfun');
    expect(output).toContain('could not read the stored secret for deepseek');
    expect(output).toContain('deauthenticated typesafe (secret absent)');
    expect(runtime.logout).toHaveBeenCalledWith('typesafe', {});
    expect(runtime.logout).not.toHaveBeenCalledWith('deepseek', expect.anything());
  });
});

describe('providerKeyStored', () => {
  it('answers whether a non-empty key is stored', async () => {
    expect(await providerKeyStored(async () => 'sk-step', 'k')).toBe(true);
    expect(await providerKeyStored(async () => '', 'k')).toBe(false);
    expect(await providerKeyStored(async () => undefined, 'k')).toBe(false);
  });

  it('answers undefined when the read fails or the store does not answer in time', async () => {
    expect(await providerKeyStored(() => Promise.reject(new Error('keyring is locked')), 'k')).toBeUndefined();
    vi.useFakeTimers();
    try {
      const read = providerKeyStored(() => new Promise<never>(() => undefined), 'k');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await read).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
