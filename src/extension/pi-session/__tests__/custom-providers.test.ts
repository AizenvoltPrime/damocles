import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { getEventListeners } from 'node:events';
import * as vscode from 'vscode';
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
    expect(stepfun?.registerConfig?.models?.[0]?.compat).toEqual({ forceAdaptiveThinking: true });
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

/**
 * Capture what `logger.ts` ACTUALLY writes, not the format-string arguments. The leak this guards was
 * invisible at the argument level: `log('… %O', provider, err)` looks innocent until `node:util.format`
 * inspects the error's own enumerable `credential` property into the channel.
 */
const logLines: string[] = [];
beforeAll(() => {
  vi.spyOn(vscode.window, 'createOutputChannel').mockReturnValue({
    appendLine: (line: string) => void logLines.push(line),
    show: () => {},
    dispose: () => {},
  } as unknown as vscode.LogOutputChannel);
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

    expect(result).toEqual({ wired: ['stepfun', 'deepseek'], aborted: false, notWired: [] });
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

    expect((await syncCustomProviders(deps)).wired).toEqual(['deepseek']);
    expect((await syncCustomProviders(deps)).wired).toEqual(['deepseek']); // still reported wired…
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(1); // …but not re-applied

    const changed = { ...deps, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key-2' }) };
    expect((await syncCustomProviders(changed)).wired).toEqual(['deepseek']);
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

    expect(result).toEqual({ wired: [], aborted: false, notWired: [] });
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
      google: { configured: true, source: 'environment', label: 'GEMINI_API_KEY' },
    });

    await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({}) });

    expect(runtime.logout).not.toHaveBeenCalledWith('google', expect.anything());
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalledWith('google', expect.anything());
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
  });

  it('is a no-op for providers that were never configured', async () => {
    const { runtime, asModelRuntime } = makeRuntime();

    const result = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret: secrets({}) });

    expect(result).toEqual({ wired: [], aborted: false, notWired: [] });
    expect(runtime.logout).not.toHaveBeenCalled();
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it('wires nothing when the signal is already aborted, and reports only known-configured providers', async () => {
    // A4: nothing has been read yet and nothing is cached, so the only provider Damocles can honestly
    // call "configured but not live" is the one pi already reports a credential for.
    const { runtime, asModelRuntime } = makeRuntime({ google: { configured: true, source: 'stored' } });

    const result = await syncCustomProviders({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key', [DEEPSEEK_SECRET]: 'ds-key' }),
      signal: AbortSignal.abort(),
    });

    expect(result).toEqual({ wired: [], aborted: true, notWired: ['google'] });
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

    expect(result).toEqual({ wired: ['stepfun'], aborted: true, notWired: [] });
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(1);
  });

  it('keeps an unreached provider in notWired when the runtime already reports it configured', async () => {
    const { runtime, asModelRuntime } = makeRuntime({
      openrouter: { configured: true, source: 'stored' },
      google: { configured: true, source: 'environment', label: 'GEMINI_API_KEY' },
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

    expect(result).toEqual({ wired: ['stepfun'], aborted: true, notWired: ['openrouter', 'google'] });
  });

  it('reports a CredentialSynchronizationError provider as wired and caches its key (pi commits the key first)', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    runtime.setRuntimeApiKey.mockImplementationOnce(async () => {
      throw credentialSyncError();
    });
    const deps = { modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }) };

    expect(await syncCustomProviders(deps)).toEqual({ wired: ['deepseek'], aborted: false, notWired: [] });
    // Cached despite the throw: the key IS live on the runtime, so re-applying it is pure cost.
    expect((await syncCustomProviders(deps)).wired).toEqual(['deepseek']);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(1);
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
    // openrouter/google were never read and have no key, so they stay out of both lists.
    expect(result).toEqual({ wired: [], aborted: true, notWired: ['deepseek'] });
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

    expect(result).toEqual({ wired: [], aborted: true, notWired: [] });
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

    expect(result).toEqual({ wired: [], aborted: false, notWired: ['deepseek'] });
    expect(runtime.logout).not.toHaveBeenCalled();
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
    const output = logLines.join('\n');
    expect(output).toContain('could not read the stored secret for deepseek');
    expect(output).not.toContain('deauthenticated deepseek');
  });

  it('keeps the read-failure, absent-secret and failed-to-apply cases distinguishable', async () => {
    const { runtime, asModelRuntime } = makeRuntime({ google: { configured: true, source: 'stored' } });
    runtime.setRuntimeApiKey.mockImplementationOnce(async () => {
      throw new Error('provider rejected the key');
    });
    const getSecret = (key: string): PromiseLike<string | undefined> => {
      if (key === STEPFUN_SECRET) return Promise.resolve('sf-key'); // bad key → failed to apply
      if (key === DEEPSEEK_SECRET) return Promise.reject(new Error('keyring is locked')); // unreadable
      return Promise.resolve(undefined); // genuinely absent
    };

    const result = await syncCustomProviders({ modelRuntime: asModelRuntime, getSecret });

    expect(result).toEqual({ wired: [], aborted: false, notWired: ['stepfun', 'deepseek'] });
    const output = logLines.join('\n');
    expect(output).toContain('failed to wire stepfun');
    expect(output).toContain('could not read the stored secret for deepseek');
    expect(output).toContain('deauthenticated google (secret absent)');
    expect(runtime.logout).toHaveBeenCalledWith('google', {});
    expect(runtime.logout).not.toHaveBeenCalledWith('deepseek', expect.anything());
  });
});
