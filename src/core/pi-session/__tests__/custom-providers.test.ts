import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { getEventListeners } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installLogSink } from '../../logger';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AuthOperationOptions } from '@earendil-works/pi-ai';
import {
  CUSTOM_PROVIDER_DEFS,
  KEYED_PROVIDER_DEFS,
  accountProviderDef,
  cheapModelValueForProvider,
  customProviderDef,
  flatFeeKeyProviders,
  providerLimitsModelsByPlan,
  providerPickedOnly,
  providerSignInDef,
  keyProviderOfSecret,
  providerKeyStored,
  syncCustomProviders,
  type SyncCustomProvidersDeps,
  type SyncCustomProvidersResult,
} from '../custom-providers';
import { providerCredentialActive } from '../provider-auth';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { runPinnedTurn } from '../../client-snapshots';
import { DEFAULT_MODELS } from '../../../shared/types/constants';

/**
 * Guards the StepFun wire behavior (Slice 2): step_plan takes reasoning effort as adaptive
 * `output_config.effort` and rejects the token-budget `thinking.budget_tokens` shape, so the registered
 * model MUST carry `compat: { forceAdaptiveThinking: true }`. This test fails if that flag is dropped.
 */
describe('CUSTOM_PROVIDER_DEFS — StepFun adaptive-thinking compat', () => {
  it('registers step-5-preview with compat.forceAdaptiveThinking', () => {
    const stepfun = customProviderDef('stepfun');
    expect(stepfun.key.registerConfig?.models?.[0]).toHaveProperty('compat', { forceAdaptiveThinking: true });
  });

  // StepFun has no way to disable thinking, so `off` must clamp up to low rather than reach the wire.
  it('registers Step 5 Preview with low, medium and high only, as its own cheap model', () => {
    const stepfun = customProviderDef('stepfun');
    expect(stepfun.cheapModel).toBe('step-5-preview');
    expect(stepfun.key.registerConfig?.models).toEqual([
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
    expect(customProviderDef('deepseek').cheapModel).toBe('deepseek-flash');
  });

  // Explore and Background Automatic resolve a cheap model through the catalog; one outside it, or on another provider, never runs.
  it('names a curated model of its own provider as every cheap model', () => {
    for (const def of CUSTOM_PROVIDER_DEFS) {
      if (def.cheapModel === undefined) continue;
      expect(DEFAULT_MODELS.find((m) => m.value === def.cheapModel)?.piProvider, def.provider).toBe(def.provider);
    }
    expect(Object.fromEntries(CUSTOM_PROVIDER_DEFS.map((d) => [d.provider, d.cheapModel]))).toMatchObject({
      minimax: 'MiniMax-M3.1-Flash',
      xai: 'grok-4.7',
      'kimi-coding': 'kimi-for-coding',
      meta: 'muse-spark-1.3',
    });
  });
});

describe('CUSTOM_PROVIDER_DEFS: GitHub Copilot', () => {
  it('signs in only, answers the enterprise domain prompt, and limits its models by plan', () => {
    const copilot = accountProviderDef('github-copilot');
    expect(copilot.key).toBeUndefined();
    expect(providerSignInDef('github-copilot')).toEqual({ textPrompt: 'enterpriseDomain' });
    expect(providerLimitsModelsByPlan('github-copilot')).toBe(true);
    expect(CUSTOM_PROVIDER_DEFS.filter((def) => def.plan).map((def) => def.provider)).toEqual(['github-copilot']);
  });

  // Its cheap model serves only a chat already on Copilot; a new chat's fallback and Automatic skip the provider.
  it('names Haiku 5.5 as its cheap model, is picked only, and its key sync covers only the key providers', () => {
    expect(accountProviderDef('github-copilot').cheapModel).toBe('github-copilot/claude-haiku-5.5');
    expect(DEFAULT_MODELS.some((m) => m.value === accountProviderDef('github-copilot').cheapModel)).toBe(true);
    expect(providerPickedOnly('github-copilot')).toBe(true);
    expect(CUSTOM_PROVIDER_DEFS.filter((def) => def.pickedOnly).map((def) => def.provider)).toEqual(['github-copilot']);
    expect(KEYED_PROVIDER_DEFS.map((d) => d.provider)).not.toContain('github-copilot');
  });
});

describe('cheapModelValueForProvider', () => {
  const lookup = (served: Record<string, readonly string[]>) => ({
    getModel: (provider: string, id: string) => (served[provider]?.includes(id) ? ({ provider, id } as never) : undefined),
    hasConfiguredAuth: () => true,
    planModelIds: () => undefined,
  });

  // pi's Copilot provider also serves gpt-6-luna; a probe by pi id would hand an OpenAI chat a Copilot cheap model.
  it('reads a catalog value\'s own provider, never another provider that serves the same pi id', () => {
    const registry = lookup({ 'github-copilot': ['gpt-6-astra', 'gpt-6-luna'], openai: ['gpt-6-astra'] });
    expect(cheapModelValueForProvider('gpt-6-astra', registry)).toBeUndefined();
    expect(cheapModelValueForProvider('claude-opus-5-5', registry)).toBeUndefined();
    expect(cheapModelValueForProvider('step-5-preview', registry)).toBe('step-5-preview');
    expect(cheapModelValueForProvider('k3', registry)).toBe('kimi-for-coding');
  });

  it('gives a GitHub Copilot main model, a GPT one included, Copilot\'s Haiku 5.5', () => {
    const registry = lookup({ 'github-copilot': ['gpt-6-luna', 'claude-haiku-5.5'] });
    expect(cheapModelValueForProvider('github-copilot/gpt-6-luna', registry)).toBe('github-copilot/claude-haiku-5.5');
    expect(cheapModelValueForProvider('github-copilot/claude-opus-5.5', registry)).toBe('github-copilot/claude-haiku-5.5');
  });

  it('probes pi\'s registry only for a value outside the catalog', () => {
    expect(cheapModelValueForProvider('grok-4.2-mini', lookup({ xai: ['grok-4.2-mini'] }))).toBe('grok-4.7');
    expect(cheapModelValueForProvider('nobody', lookup({}))).toBeUndefined();
  });

  // A value outside the catalog runs on first-party Anthropic, so pi's Copilot serving the same id never names its cheap model.
  it('never probes a picked-only provider for a value outside the catalog', () => {
    expect(cheapModelValueForProvider('claude-sonnet-4', lookup({ 'github-copilot': ['claude-sonnet-4'] }))).toBeUndefined();
  });
});

describe('CUSTOM_PROVIDER_DEFS: the OpenRouter and StepFun keys', () => {
  // The order is Background Automatic's order after the first-party small models.
  it('registers no Gemini provider, so a stored Gemini key wires nothing', () => {
    expect(KEYED_PROVIDER_DEFS.map((d) => d.provider)).toEqual(['stepfun', 'deepseek', 'minimax', 'xai', 'kimi-coding', 'meta', 'openrouter', 'typesafe']);
    expect(CUSTOM_PROVIDER_DEFS.map((d) => d.provider)).toEqual(['stepfun', 'deepseek', 'minimax', 'xai', 'kimi-coding', 'meta', 'openrouter', 'typesafe', 'github-copilot']);
  });

  // The stored names predate the keys' current uses; renaming one would drop every user's saved key.
  it('reads every key from its stored name, and maps each name back to its provider', () => {
    expect(Object.fromEntries(KEYED_PROVIDER_DEFS.map((d) => [d.provider, d.key.secretKey]))).toEqual({
      stepfun: 'damocles.explore.apiKey.stepfun',
      deepseek: 'damocles.deepseek.apiKey',
      minimax: 'damocles.minimax.apiKey',
      xai: 'damocles.xai.apiKey',
      'kimi-coding': 'damocles.kimi-coding.apiKey',
      meta: 'damocles.meta.apiKey',
      openrouter: 'damocles.explore.apiKey.openrouter',
      typesafe: 'damocles.typesafe.apiKey',
    });
    for (const def of KEYED_PROVIDER_DEFS) {
      expect(keyProviderOfSecret(def.key.secretKey)).toBe(def.provider);
      expect(customProviderDef(def.provider)).toBe(def);
    }
    expect(keyProviderOfSecret('damocles.openai.apiKey')).toBeUndefined();
  });

  it('gives OpenRouter no cheap model, so the Explore default never runs on it', () => {
    expect(customProviderDef('openrouter').cheapModel).toBeUndefined();
  });

  it('wires OpenRouter from its key, which image generation and Jev read as the openrouter runtime key', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const result = await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ 'damocles.explore.apiKey.openrouter': 'sk-or' }) });
    expect(result.wired).toEqual(['openrouter']);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('openrouter', 'sk-or', {});
  });

  it('registers StepFun from its key, which StepFun chats run on', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const result = await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ 'damocles.explore.apiKey.stepfun': 'sf' }) });
    expect(result.wired).toEqual(['stepfun']);
    expect(runtime.registerProvider).toHaveBeenCalledWith('stepfun', expect.objectContaining({ apiKey: 'sf', baseUrl: 'https://api.stepfun.ai/step_plan' }));
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('stepfun', 'sf', {});
  });
});

type AuthStatus = ReturnType<ModelRuntime['getProviderAuthStatus']>;

/** pi's runtime key overlay: a runtime key reports `runtime` ahead of anything else, and `logout` drops it (runtime-credentials.js). */
function makeRuntime(authStatus: Partial<Record<string, AuthStatus>> = {}) {
  const runtimeKeys = new Map<string, string>();
  const runtime = {
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    setRuntimeApiKey: vi.fn(async (providerId: string, apiKey: string, _options?: AuthOperationOptions) => {
      runtimeKeys.set(providerId, apiKey);
    }),
    removeRuntimeApiKey: vi.fn(async (providerId: string, _options?: AuthOperationOptions) => {
      runtimeKeys.delete(providerId);
    }),
    logout: vi.fn(async (providerId: string, _options?: AuthOperationOptions) => {
      runtimeKeys.delete(providerId);
    }),
    getProviderAuthStatus: vi.fn((providerId: string): AuthStatus =>
      runtimeKeys.has(providerId) ? { configured: true, source: 'runtime' } : (authStatus[providerId] ?? { configured: false })),
  };
  // Each makeRuntime call is a distinct object, so the module-level WeakMap cache starts empty per test.
  return { runtime, asModelRuntime: runtime as unknown as ModelRuntime, runtimeKeys };
}

/** A temporary agent dir holding `auth` as auth.json, or no auth.json. */
function agentDirWith(auth?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-providers-'));
  if (auth) fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth));
  return dir;
}

/** pi's logout: deletes the provider's auth.json entry and drops its runtime key (runtime-credentials.js:33-37). */
function logoutFrom(agentDir: string, runtimeKeys: Map<string, string>) {
  return async (provider: string): Promise<void> => {
    const file = path.join(agentDir, 'auth.json');
    const auth = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete auth[provider];
    fs.writeFileSync(file, JSON.stringify(auth));
    runtimeKeys.delete(provider);
  };
}

/** A marker path whose sweep already ran, unless `swept` is false. */
function sweepMarker(swept = true): string {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-key-sweep-')), 'provider-key-sweep.json');
  if (swept) fs.writeFileSync(marker, '{}');
  return marker;
}

type LocalDeps = Omit<SyncCustomProvidersDeps, 'agentDir' | 'preferApiKey' | 'sweepMarkerPath'> & Partial<SyncCustomProvidersDeps>;

/** A local core's sync with no auth.json, every prefer flag off, and the legacy sweep already run. */
function sync(deps: LocalDeps): Promise<SyncCustomProvidersResult> {
  return syncCustomProviders({ agentDir: NO_AUTH_FILE, preferApiKey: () => false, sweepMarkerPath: SWEPT, ...deps });
}

const NO_AUTH_FILE = agentDirWith();
const SWEPT = sweepMarker();

/**
 * pi 1.4.0's runtime key operations (model-runtime.js:384-437): one the signal stops before it starts throws the abort
 * and commits nothing; once started it commits the key or its removal, then its snapshot sync wraps every failure, an
 * abort included, as a CredentialSynchronizationError. `onCommit` runs between the two steps.
 */
function committingRuntime(onCommit: (provider: string) => void) {
  const { runtime, asModelRuntime } = makeRuntime();
  const runtimeKeys = new Map<string, string>();
  const operation = async (provider: string, options: AuthOperationOptions | undefined, commit: () => void): Promise<void> => {
    options?.signal?.throwIfAborted();
    commit();
    onCommit(provider);
    if (options?.signal?.aborted) throw credentialSyncError();
  };
  runtime.setRuntimeApiKey.mockImplementation((provider, key, options) => operation(provider, options, () => void runtimeKeys.set(provider, key)));
  runtime.removeRuntimeApiKey.mockImplementation((provider, options) => operation(provider, options, () => void runtimeKeys.delete(provider)));
  runtime.getProviderAuthStatus.mockImplementation((provider) => (runtimeKeys.has(provider) ? { configured: true, source: 'runtime' } : { configured: false }));
  return { runtime, asModelRuntime, runtimeKeys };
}

function secrets(map: Record<string, string | undefined>) {
  return (key: string): PromiseLike<string | undefined> => Promise.resolve(map[key]);
}

const STEPFUN_SECRET = 'damocles.explore.apiKey.stepfun';
const DEEPSEEK_SECRET = 'damocles.deepseek.apiKey';
const MINIMAX_SECRET = 'damocles.minimax.apiKey';
const XAI_SECRET = 'damocles.xai.apiKey';
const OPENROUTER_SECRET = 'damocles.explore.apiKey.openrouter';

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
  it('leaves a provider whose sign-in is running untouched and syncs the others', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const result = await sync({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [XAI_SECRET]: 'xai-key', [DEEPSEEK_SECRET]: 'ds-key' }),
      signingIn: new Set(['xai']),
    });

    expect(result).toMatchObject({ wired: ['deepseek'], aborted: false, notWired: [], changed: ['deepseek'] });
    expect(runtime.setRuntimeApiKey.mock.calls.map((call) => call[0])).toEqual(['deepseek']);
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
    expect(runtime.logout).not.toHaveBeenCalled();
  });

  it('defers the legacy sweep marker while a provider holding a plain-text key is signing in', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const marker = sweepMarker(false);
    await sync({
      modelRuntime: asModelRuntime,
      getSecret: secrets({}),
      agentDir: agentDirWith({ openrouter: { type: 'api_key', key: 'legacy' } }),
      sweepMarkerPath: marker,
      signingIn: new Set(['openrouter']),
    });

    expect(runtime.logout).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(false);
  });

  // pi serializes each provider's credential operations, so a logout or key change queued behind the login would stall the sync.
  it('leaves a provider alone when its sign-in starts during the secret read, and sweeps it at a later sync', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const marker = sweepMarker(false);
    const agentDir = agentDirWith({ openrouter: { type: 'api_key', key: 'legacy' } });
    const signingIn = new Set<'openrouter'>();
    const getSecret = (key: string): PromiseLike<string | undefined> => {
      if (key === OPENROUTER_SECRET) signingIn.add('openrouter');
      return Promise.resolve(key === OPENROUTER_SECRET ? 'or-key' : undefined);
    };

    await sync({ modelRuntime: asModelRuntime, getSecret, agentDir, sweepMarkerPath: marker, signingIn });

    expect(runtime.logout).not.toHaveBeenCalled();
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(false);

    signingIn.clear();
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [OPENROUTER_SECRET]: 'or-key' }), agentDir, sweepMarkerPath: marker, signingIn });
    expect(runtime.logout).toHaveBeenCalledWith('openrouter', {});
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('openrouter', 'or-key', {});
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('registers + authenticates providers whose secret is present, forwarding the caller signal', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const controller = new AbortController();
    const result = await sync({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key', [DEEPSEEK_SECRET]: 'ds-key' }),
      signal: controller.signal,
    });

    expect(result).toMatchObject({ wired: ['stepfun', 'deepseek'], aborted: false, notWired: [], changed: ['stepfun', 'deepseek'] });
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

    expect((await sync(deps)).changed).toEqual(['deepseek']);
    const unchanged = await sync(deps);
    expect(unchanged.wired).toEqual(['deepseek']); // still reported wired…
    expect(unchanged.changed).toEqual([]);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(1); // …but not re-applied

    const changed = { ...deps, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key-2' }) };
    expect(await sync(changed)).toMatchObject({ wired: ['deepseek'], changed: ['deepseek'] });
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(2);
    expect(runtime.setRuntimeApiKey).toHaveBeenLastCalledWith('deepseek', 'ds-key-2', { signal: controller.signal });
  });

  it('removes the runtime key of a provider whose secret is deleted, and never logs out', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    const controller = new AbortController();
    await sync({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key', [DEEPSEEK_SECRET]: 'ds-key' }),
      signal: controller.signal,
    });

    const result = await sync({
      modelRuntime: asModelRuntime,
      getSecret: secrets({}),
      signal: controller.signal,
    });

    expect(result).toMatchObject({ wired: [], aborted: false, notWired: [], changed: ['stepfun', 'deepseek'] });
    expect(runtime.unregisterProvider).toHaveBeenCalledWith('stepfun'); // fresh-registered → dropped entirely
    expect(runtime.unregisterProvider).not.toHaveBeenCalledWith('deepseek'); // built-in → only its runtime key goes
    // The removal is cancellable too: same signal-identity assertion.
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('stepfun', { signal: controller.signal });
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('deepseek', { signal: controller.signal });
    expect(runtime.logout).not.toHaveBeenCalled();
  });

  it('never logs out a stored sign-in, with or without a saved key, before or after the sweep', async () => {
    const agentDir = agentDirWith({ xai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } });
    const { runtime, asModelRuntime } = makeRuntime({ xai: { configured: true, source: 'stored' } });
    for (const sweepMarkerPath of [sweepMarker(false), SWEPT]) {
      await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [XAI_SECRET]: 'xai-key' }), agentDir, sweepMarkerPath });
      await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}), agentDir, sweepMarkerPath });
    }
    expect(runtime.logout).not.toHaveBeenCalled();
  });

  it('lets a sign-in outrank the saved key unless prefer is on, counting an outranked key neither wired nor not wired', async () => {
    const agentDir = agentDirWith({ xai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } });
    const { runtime, asModelRuntime, runtimeKeys } = makeRuntime({ xai: { configured: true, source: 'stored' } });
    let prefer = false;
    const deps = { modelRuntime: asModelRuntime, getSecret: secrets({ [XAI_SECRET]: 'xai-key' }), agentDir, preferApiKey: () => prefer };

    const outranked = await sync(deps);
    expect(outranked).toMatchObject({ wired: [], aborted: false, notWired: [], changed: [] });
    expect(outranked.keysSaved.get('xai')).toBe(true);
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();

    prefer = true;
    expect(await sync(deps)).toMatchObject({ wired: ['xai'], aborted: false, notWired: [], changed: ['xai'] });
    expect(runtimeKeys.get('xai')).toBe('xai-key');

    prefer = false;
    expect(await sync(deps)).toMatchObject({ wired: [], aborted: false, notWired: [], changed: ['xai'] });
    expect(runtimeKeys.has('xai')).toBe(false);
    expect(runtime.logout).not.toHaveBeenCalled();
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
  });

  it('applies the saved key when the sign-in is gone', async () => {
    const { asModelRuntime, runtimeKeys } = makeRuntime();
    const result = await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [XAI_SECRET]: 'xai-key' }), agentDir: agentDirWith({}) });
    expect(result.wired).toEqual(['xai']);
    expect(runtimeKeys.get('xai')).toBe('xai-key');
  });

  it('keeps a signed-in StepFun registered while it holds a saved key the sign-in outranks', async () => {
    const agentDir = agentDirWith({ stepfun: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } });
    const { runtime, asModelRuntime } = makeRuntime();
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [STEPFUN_SECRET]: 'sf' }), preferApiKey: () => true, agentDir });
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [STEPFUN_SECRET]: 'sf' }), agentDir });
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('stepfun', {});
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
  });

  it('re-applies a cached key after a logout elsewhere dropped the runtime key', async () => {
    const { runtime, asModelRuntime, runtimeKeys } = makeRuntime();
    const deps = { modelRuntime: asModelRuntime, getSecret: secrets({ [XAI_SECRET]: 'xai-key' }) };
    await sync(deps);
    runtimeKeys.delete('xai'); // pi's logout drops the runtime key along with the stored credential

    expect(await sync(deps)).toMatchObject({ wired: ['xai'], aborted: false, notWired: [], changed: ['xai'] });
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(2);
    expect(runtimeKeys.get('xai')).toBe('xai-key');
  });

  it('sweeps a legacy plain-text auth.json key with no saved key once, then keeps a later one as external', async () => {
    const marker = sweepMarker(false);
    const legacy = agentDirWith({ deepseek: { type: 'api_key', key: 'legacy' }, xai: { type: 'api_key', key: 'kept' }, minimax: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } });
    const { runtime, asModelRuntime } = makeRuntime({ deepseek: { configured: true, source: 'stored' } });
    const controller = new AbortController();

    const first = await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [XAI_SECRET]: 'xai-key' }), agentDir: legacy, sweepMarkerPath: marker, signal: controller.signal });

    expect(runtime.logout).toHaveBeenCalledTimes(1);
    expect(runtime.logout).toHaveBeenCalledWith('deepseek', { signal: controller.signal });
    expect(first.changed).toContain('deepseek');
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({ sweptAt: expect.any(Number) });

    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}), agentDir: legacy, sweepMarkerPath: marker });
    expect(runtime.logout).toHaveBeenCalledTimes(1);
  });

  it('reads auth.json again before the sweep logs out, so a sign-in made since the sync began is kept', async () => {
    const marker = sweepMarker(false);
    const agentDir = agentDirWith({ openrouter: { type: 'api_key', key: 'legacy' } });
    const { runtime, asModelRuntime } = makeRuntime();
    const getSecret = (key: string): PromiseLike<string | undefined> => {
      // `pi login openrouter` lands while the sync reads the earlier providers' secrets
      if (key === MINIMAX_SECRET) fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ openrouter: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }));
      return Promise.resolve(undefined);
    };

    await sync({ modelRuntime: asModelRuntime, getSecret, agentDir, sweepMarkerPath: marker });

    expect(runtime.logout).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('defers the sweep, writing no marker, while a provider with a stored key could not be read', async () => {
    const marker = sweepMarker(false);
    const legacy = agentDirWith({ deepseek: { type: 'api_key', key: 'legacy' } });
    const { runtime, asModelRuntime } = makeRuntime();
    const getSecret = (key: string): PromiseLike<string | undefined> =>
      key === DEEPSEEK_SECRET ? Promise.reject(new Error('keyring is locked')) : Promise.resolve(undefined);

    await sync({ modelRuntime: asModelRuntime, getSecret, agentDir: legacy, sweepMarkerPath: marker });

    expect(runtime.logout).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(false);
  });

  // Damocles 2.6 wrote only the StepFun, DeepSeek, OpenRouter and Gemini keys to auth.json; any other stored key is the user's own.
  it('sweeps only the providers whose keys Damocles 2.6 wrote, keeping a stored key of any other', async () => {
    const marker = sweepMarker(false);
    const stored = Object.fromEntries(KEYED_PROVIDER_DEFS.map((def) => [def.provider, { type: 'api_key', key: `${def.provider}-stored` }]));
    const agentDir = agentDirWith(stored);
    const { runtime, asModelRuntime, runtimeKeys } = makeRuntime();
    runtime.logout.mockImplementation(logoutFrom(agentDir, runtimeKeys));

    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}), agentDir, sweepMarkerPath: marker });

    expect(runtime.logout.mock.calls.map((call) => call[0])).toEqual(['stepfun', 'deepseek', 'openrouter']);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8')) as object)).toEqual(['minimax', 'xai', 'kimi-coding', 'meta', 'typesafe']);
    expect(fs.existsSync(marker)).toBe(true);
  });

  // The saved key outranks the plain-text copy anyway, and clearing the saved key later must not leave the copy serving.
  it('sweeps a legacy plain-text key while a key is saved too, then applies the saved key', async () => {
    const marker = sweepMarker(false);
    const agentDir = agentDirWith({ deepseek: { type: 'api_key', key: 'legacy' } });
    const { runtime, asModelRuntime, runtimeKeys } = makeRuntime();
    runtime.logout.mockImplementation(logoutFrom(agentDir, runtimeKeys));

    const result = await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-saved' }), agentDir, sweepMarkerPath: marker });

    expect(runtime.logout).toHaveBeenCalledWith('deepseek', {});
    // pi's logout drops the runtime key, so the key is applied after it
    expect(runtime.logout.mock.invocationCallOrder[0]).toBeLessThan(runtime.setRuntimeApiKey.mock.invocationCallOrder[0]!);
    expect(runtimeKeys.get('deepseek')).toBe('ds-saved');
    expect(result).toMatchObject({ wired: ['deepseek'], changed: ['deepseek'] });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('counts a sweep logout pi committed before its snapshot sync failed as swept', async () => {
    const marker = sweepMarker(false);
    const agentDir = agentDirWith({ deepseek: { type: 'api_key', key: 'legacy' } });
    const { runtime, asModelRuntime, runtimeKeys } = makeRuntime();
    const logout = logoutFrom(agentDir, runtimeKeys);
    runtime.logout.mockImplementation(async (provider) => {
      await logout(provider);
      throw credentialSyncError();
    });

    const result = await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}), agentDir, sweepMarkerPath: marker });

    expect(result.changed).toEqual(['deepseek']);
    expect(fs.existsSync(marker)).toBe(true);
    expect(logLines.join('\n')).not.toContain(SENTINEL);
  });

  // A marker that cannot be written must not re-run the logouts: a key the user stores with pi afterwards is theirs.
  it('repeats only the marker write after it failed, and never sweeps a provider again in the same process', async () => {
    const marker = sweepMarker(false);
    const agentDir = agentDirWith({ deepseek: { type: 'api_key', key: 'legacy' } });
    const { runtime, asModelRuntime, runtimeKeys } = makeRuntime();
    runtime.logout.mockImplementation(logoutFrom(agentDir, runtimeKeys));
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
    const access = vi.spyOn(fs.promises, 'access');
    try {
      await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}), agentDir, sweepMarkerPath: marker });
      expect(runtime.logout).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(marker)).toBe(false);

      // `pi login deepseek` with a key of the user's own
      fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ deepseek: { type: 'api_key', key: 'users-own' } }));
      await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}), agentDir, sweepMarkerPath: marker });
      await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}), agentDir, sweepMarkerPath: marker });

      expect(runtime.logout).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(marker)).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'))).toEqual({ deepseek: { type: 'api_key', key: 'users-own' } });
      expect(access).toHaveBeenCalledTimes(1);
    } finally {
      rename.mockRestore();
      access.mockRestore();
    }
  });

  it('reports an environment key beside a sign-in as the sign-in, which pi resolves first', () => {
    expect(providerCredentialActive({ key: false, signedIn: true, external: 'environment' }, false)).toBe('signIn');
    expect(providerCredentialActive({ key: false, signedIn: true, external: 'environment' }, true)).toBe('signIn');
    expect(providerCredentialActive({ key: true, signedIn: true, external: null }, false)).toBe('signIn');
    expect(providerCredentialActive({ key: true, signedIn: true, external: null }, true)).toBe('apiKey');
    expect(providerCredentialActive({ key: true, signedIn: false, external: 'environment' }, false)).toBe('apiKey');
    expect(providerCredentialActive({ key: false, signedIn: false, external: 'piConfig' }, false)).toBe('external');
    expect(providerCredentialActive({ key: false, signedIn: false, external: null }, true)).toBe('none');
  });

  it('leaves ambient environment auth alone when the secret is absent', async () => {
    const { runtime, asModelRuntime } = makeRuntime({
      typesafe: { configured: true, source: 'environment', label: 'TYPESAFE_API_KEY' },
    });

    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}) });

    expect(runtime.logout).not.toHaveBeenCalledWith('typesafe', expect.anything());
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalledWith('typesafe', expect.anything());
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
  });

  it('is a no-op for providers that were never configured', async () => {
    const { runtime, asModelRuntime } = makeRuntime();

    const result = await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}) });

    expect(result).toMatchObject({ wired: [], aborted: false, notWired: [], changed: [] });
    expect(runtime.logout).not.toHaveBeenCalled();
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it('wires nothing when the signal is already aborted, and reports only known-configured providers', async () => {
    // A4: nothing has been read yet and nothing is cached, so the only provider Damocles can honestly
    // call "configured but not live" is the one pi already reports a credential for.
    const { runtime, asModelRuntime } = makeRuntime({ typesafe: { configured: true, source: 'stored' } });

    const result = await sync({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key', [DEEPSEEK_SECRET]: 'ds-key' }),
      signal: AbortSignal.abort(),
    });

    expect(result).toMatchObject({ wired: [], aborted: true, notWired: ['typesafe'], changed: [] });
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

    const result = await sync({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key' }),
      signal: controller.signal,
    });

    expect(result).toMatchObject({ wired: ['stepfun'], aborted: true, notWired: [], changed: ['stepfun'] });
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

    const result = await sync({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [STEPFUN_SECRET]: 'sf-key' }),
      signal: controller.signal,
    });

    expect(result).toMatchObject({ wired: ['stepfun'], aborted: true, notWired: ['openrouter', 'typesafe'], changed: ['stepfun'] });
  });

  it('reports a CredentialSynchronizationError provider as wired and caches its key (pi commits the key first)', async () => {
    const { runtime, asModelRuntime, runtimeKeys } = makeRuntime();
    runtime.setRuntimeApiKey.mockImplementationOnce(async (provider, key) => {
      runtimeKeys.set(provider, key);
      throw credentialSyncError();
    });
    const deps = { modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }) };

    expect(await sync(deps)).toMatchObject({ wired: ['deepseek'], aborted: false, notWired: [], changed: ['deepseek'] });
    // Cached despite the throw: the key IS live on the runtime, so re-applying it is pure cost.
    expect((await sync(deps)).wired).toEqual(['deepseek']);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(1);
  });

  it('reports a removal that pi committed before a CredentialSynchronizationError as changed', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }) });
    runtime.removeRuntimeApiKey.mockImplementationOnce(async () => {
      throw credentialSyncError();
    });

    const result = await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}) });

    expect(result.changed).toEqual(['deepseek']);
  });

  it('caches nothing for a key the signal stopped before pi started applying it', async () => {
    const { runtime, asModelRuntime, runtimeKeys } = committingRuntime(() => {});
    const controller = new AbortController();

    const result = await sync({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }),
      signal: controller.signal,
      beforeCredentialChange: () => controller.abort(),
    });

    // deepseek's secret WAS read this sync, so it is known-configured even though it never applied;
    // openrouter/typesafe were never read and have no key, so they stay out of both lists.
    expect(runtimeKeys.size).toBe(0);
    expect(result).toMatchObject({ wired: [], aborted: true, notWired: ['deepseek'], changed: [] });
    // …and the key was NOT cached, so an un-aborted resync re-applies it.
    const retry = await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }) });
    expect(retry.wired).toEqual(['deepseek']);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledTimes(2);
  });

  it('caches a key pi committed before the signal stopped its snapshot sync, so billing follows the key pi sends', async () => {
    const controller = new AbortController();
    const abort: { at?: string } = {};
    const { runtime, asModelRuntime, runtimeKeys } = committingRuntime((provider) => {
      if (provider === abort.at) controller.abort();
    });
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [MINIMAX_SECRET]: 'sk-cp-plan', [XAI_SECRET]: 'xai-key' }) });
    expect([...flatFeeKeyProviders(asModelRuntime)]).toEqual(['minimax']);

    abort.at = 'minimax';
    const result = await sync({
      modelRuntime: asModelRuntime,
      getSecret: secrets({ [MINIMAX_SECRET]: 'sk-api-metered', [XAI_SECRET]: 'xai-key' }),
      signal: controller.signal,
    });

    expect(runtimeKeys.get('minimax')).toBe('sk-api-metered');
    // The cut falls past MiniMax, so only the provider it never reached is not wired.
    expect(result).toMatchObject({ wired: ['minimax'], aborted: true, notWired: ['xai'], changed: ['minimax'] });
    expect(flatFeeKeyProviders(asModelRuntime)).toEqual(new Set());
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [MINIMAX_SECRET]: 'sk-api-metered', [XAI_SECRET]: 'xai-key' }) });
    expect(runtime.setRuntimeApiKey.mock.calls.filter(([provider]) => provider === 'minimax')).toHaveLength(2);
  });

  it('reports a removal pi committed before the signal stopped its snapshot sync as changed', async () => {
    const controller = new AbortController();
    const abort: { at?: string } = {};
    const { asModelRuntime, runtimeKeys } = committingRuntime((provider) => {
      if (provider === abort.at) controller.abort();
    });
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [MINIMAX_SECRET]: 'sk-cp-plan' }) });

    abort.at = 'minimax';
    const result = await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}), signal: controller.signal });

    expect(runtimeKeys.has('minimax')).toBe(false);
    expect(result).toMatchObject({ wired: [], aborted: true, notWired: [], changed: ['minimax'] });
    expect(flatFeeKeyProviders(asModelRuntime)).toEqual(new Set());
  });
});

/** A1 — the blocker: pi attaches the raw API key to the error it throws on lock contention. */
describe('syncCustomProviders — credential redaction (A1)', () => {
  it('never writes the key carried by a CredentialSynchronizationError to the output channel', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    runtime.setRuntimeApiKey.mockImplementationOnce(async () => {
      throw credentialSyncError();
    });

    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [DEEPSEEK_SECRET]: 'ds-key' }) });

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

    const result = await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [STEPFUN_SECRET]: SENTINEL }) });

    expect(result.notWired).toEqual(['stepfun']);
    const output = logLines.join('\n');
    expect(output).toContain('failed to wire stepfun');
    expect(output).not.toContain(SENTINEL);
  });

  it('never writes a key carried by a secret-read failure to the output channel', async () => {
    const { asModelRuntime } = makeRuntime();
    const getSecret = () => Promise.reject(credentialSyncError());

    await sync({ modelRuntime: asModelRuntime, getSecret });

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

    const result = await sync({ modelRuntime: asModelRuntime, getSecret, signal: controller.signal });

    expect(result).toMatchObject({ wired: [], aborted: true, notWired: [], changed: [] });
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

    await sync(deps);
    await sync(deps);

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

/** A3 — a failed read is not an absent secret, and must never delete a stored credential. */
describe('syncCustomProviders — a failed secret read never deauthenticates (A3)', () => {
  it('leaves a provider with a stored credential entirely untouched and reports it notWired', async () => {
    const { runtime, asModelRuntime } = makeRuntime({ deepseek: { configured: true, source: 'stored' } });
    const getSecret = (key: string): PromiseLike<string | undefined> =>
      key === DEEPSEEK_SECRET ? Promise.reject(new Error('keyring is locked')) : Promise.resolve(undefined);

    const result = await sync({ modelRuntime: asModelRuntime, getSecret });

    expect(result).toMatchObject({ wired: [], aborted: false, notWired: ['deepseek'], changed: [] });
    expect(runtime.logout).not.toHaveBeenCalled();
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
    expect(runtime.unregisterProvider).not.toHaveBeenCalled();
    const output = logLines.join('\n');
    expect(output).toContain('could not read the stored secret for deepseek');
    expect(output).not.toContain('removed the deepseek');
  });

  it('keeps the read-failure, absent-secret and failed-to-apply cases distinguishable', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ 'damocles.typesafe.apiKey': 'ts-key' }) });
    runtime.setRuntimeApiKey.mockImplementationOnce(async () => {
      throw new Error('provider rejected the key');
    });
    const getSecret = (key: string): PromiseLike<string | undefined> => {
      if (key === STEPFUN_SECRET) return Promise.resolve('sf-key'); // bad key → failed to apply
      if (key === DEEPSEEK_SECRET) return Promise.reject(new Error('keyring is locked')); // unreadable
      return Promise.resolve(undefined); // genuinely absent
    };

    const result = await sync({ modelRuntime: asModelRuntime, getSecret });

    expect(result).toMatchObject({ wired: [], aborted: false, notWired: ['stepfun', 'deepseek'], changed: ['typesafe'] });
    // an unreadable secret says nothing about whether a key is saved, so it is left out
    expect(result.keysSaved.get('stepfun')).toBe(true);
    expect(result.keysSaved.has('deepseek')).toBe(false);
    expect(result.keysSaved.get('typesafe')).toBe(false);
    const output = logLines.join('\n');
    expect(output).toContain('failed to wire stepfun');
    expect(output).toContain('could not read the stored secret for deepseek');
    expect(output).toContain('removed the typesafe runtime key (secret absent)');
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('typesafe', {});
    expect(runtime.logout).not.toHaveBeenCalled();
  });
});

describe('flatFeeKeyProviders', () => {
  async function flatAfter(key: string | undefined) {
    const { asModelRuntime } = makeRuntime();
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [MINIMAX_SECRET]: key }) });
    return flatFeeKeyProviders(asModelRuntime);
  }

  it('names MiniMax only while its applied key is a Token Plan key', async () => {
    expect([...(await flatAfter('sk-cp-x'))]).toEqual(['minimax']);
    for (const key of ['sk-api-x', 'sk-cpx', 'SK-CP-x', undefined]) expect(await flatAfter(key), String(key)).toEqual(new Set());
  });

  it('is empty for a runtime that never synced', () => {
    expect(flatFeeKeyProviders(makeRuntime().asModelRuntime)).toEqual(new Set());
  });

  it('drops MiniMax once its secret is removed', async () => {
    const { asModelRuntime } = makeRuntime();
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [MINIMAX_SECRET]: 'sk-cp-x' }) });
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}) });
    expect(flatFeeKeyProviders(asModelRuntime)).toEqual(new Set());
  });

  // Only a key Damocles stored is read; an environment key's kind is unknown, so it bills per token.
  it('ignores a MiniMax key pi takes from the environment', async () => {
    const { asModelRuntime } = makeRuntime({ minimax: { configured: true, source: 'environment' } });
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({}) });
    expect(flatFeeKeyProviders(asModelRuntime)).toEqual(new Set());
  });

  // A failed read leaves pi on the key it already holds, so its billing stays.
  it('keeps MiniMax after a failed secret read', async () => {
    const { asModelRuntime } = makeRuntime();
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [MINIMAX_SECRET]: 'sk-cp-x' }) });
    const getSecret = (key: string): PromiseLike<string | undefined> =>
      key === MINIMAX_SECRET ? Promise.reject(new Error('keyring is locked')) : Promise.resolve(undefined);
    await sync({ modelRuntime: asModelRuntime, getSecret });
    expect([...flatFeeKeyProviders(asModelRuntime)]).toEqual(['minimax']);
  });

  it('follows a key pi has not applied only once it applies', async () => {
    const { runtime, asModelRuntime } = makeRuntime();
    runtime.setRuntimeApiKey.mockImplementationOnce(async () => {
      throw new Error('provider rejected the key');
    });
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [MINIMAX_SECRET]: 'sk-cp-x' }) });
    expect(flatFeeKeyProviders(asModelRuntime)).toEqual(new Set());
    await sync({ modelRuntime: asModelRuntime, getSecret: secrets({ [MINIMAX_SECRET]: 'sk-cp-x' }) });
    expect([...flatFeeKeyProviders(asModelRuntime)]).toEqual(['minimax']);
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

describe('flatFeeKeyProviders on a daemon\'s core', () => {
  it('reads the pinned client\'s flatFee flags, since no key is applied there', async () => {
    const host = createFakeRemoteHost();
    host.set('clientAuth', 'client-a', { providers: { minimax: { type: 'api_key', hasKey: true, flatFee: true }, deepseek: { type: 'api_key', hasKey: true, flatFee: false } } });
    host.set('clientAuth', 'client-b', { providers: { minimax: { type: 'api_key', hasKey: true, flatFee: false } } });
    const runtime = {} as ModelRuntime;
    expect(flatFeeKeyProviders(runtime, host.remote)).toEqual(new Set(['minimax']));
    const pinned = runPinnedTurn(host.remote, 'p1', async () => {
      await Promise.resolve();
      host.setActing('client-b');
      return flatFeeKeyProviders(runtime, host.remote);
    });
    expect(await pinned).toEqual(new Set(['minimax']));
    expect(flatFeeKeyProviders(runtime, host.remote)).toEqual(new Set());
  });
});
