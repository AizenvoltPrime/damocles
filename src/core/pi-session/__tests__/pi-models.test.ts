import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSupportedThinkingLevels, type Model, type Api } from '@earendil-works/pi-ai';
import {
  mapPiToolName,
  piModelToModelInfo,
  sdkAnthropicModels,
  resolvePiModel,
  providerDisplayName,
  isDollarBilled,
  effortToThinkingLevel,
  effortToPiThinking,
  modelValueOfPiModel,
  recordedReasoning,
  recordedModelValue,
  modelInPlan,
  markNotInPlan,
  effortBadgeApplies,
  type ModelLookup,
} from '../pi-models';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MODELS, MODEL_SUBSTITUTES } from '../../../shared/types/constants';

/** A shipped catalog file keyed by api, then by model id, with only its chat models: pi keys each entry `<type>:<id>`. */
function readChatCatalog<T>(file: string): Record<string, Record<string, T>> {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, T>>;
  return Object.fromEntries(
    Object.entries(raw).map(([api, models]) => [
      api,
      Object.fromEntries(Object.entries(models).flatMap(([key, entry]) => (key.startsWith('chat:') ? [[key.slice('chat:'.length), entry]] : []))),
    ]),
  );
}

function model(provider: string, id: string, api: Api = 'openai-responses'): Model<Api> {
  return { id, name: id, api, provider, contextWindow: 200_000 } as unknown as Model<Api>;
}

/** Registry seeded with explicit (provider,id) pairs; `getModel` is an exact lookup. */
function registry(pairs: Array<[string, string, Api?]>): ModelLookup {
  const models = pairs.map(([p, id, api]) => model(p, id, api));
  return {
    getModel: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
    planModelIds: () => undefined,
  };
}

describe('mapPiToolName', () => {
  it('maps pi built-ins to Damocles display names (find→Glob is load-bearing)', () => {
    expect(mapPiToolName('read')).toBe('Read');
    expect(mapPiToolName('grep')).toBe('Grep');
    expect(mapPiToolName('find')).toBe('Glob');
    expect(mapPiToolName('ls')).toBe('Ls');
    expect(mapPiToolName('unknown')).toBe('unknown');
  });
});

describe('sdkAnthropicModels', () => {
  it('excludes every OpenAI-backed model', () => {
    const models = sdkAnthropicModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.backend !== 'openai')).toBe(true);
    expect(models.some((m) => m.value === 'claude-opus-5-5')).toBe(true);
    expect(models.some((m) => m.value.startsWith('gpt-'))).toBe(false);
  });

  it('excludes piProvider (StepFun/DeepSeek) entries — the SDK harness is Anthropic-only', () => {
    const models = sdkAnthropicModels();
    expect(models.every((m) => !m.piProvider)).toBe(true);
    expect(models.some((m) => m.value === 'step-5-preview')).toBe(false);
    expect(models.some((m) => m.value === 'deepseek-v4-pro')).toBe(false);
  });
});

describe('piModelToModelInfo', () => {
  it('inherits rich display from DEFAULT_MODELS for a known anthropic model', () => {
    const info = piModelToModelInfo(model('anthropic', 'claude-opus-5-5', 'anthropic-messages'));
    expect(info.value).toBe('claude-opus-5-5');
    expect(info.displayName).toBe('Opus 5.5');
  });

  it('reconciles a codex model id back to its Damocles value', () => {
    const info = piModelToModelInfo(model('openai-codex', 'gpt-6.1-sol'));
    expect(info.value).toBe('gpt-6.1-sol');
    expect(info.backend).toBe('openai');
  });

  it('synthesizes a minimal entry for an unknown model', () => {
    const info = piModelToModelInfo(model('openai', 'gpt-custom-9'));
    expect(info.value).toBe('gpt-custom-9');
    expect(info.backend).toBe('openai');
  });

  it.each([0, -1, Number.NaN])('takes a window of %s from pi as unknown', (contextWindow) => {
    const info = piModelToModelInfo({ ...model('openai', 'gpt-custom-9'), contextWindow } as Model<Api>);
    expect(info.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe('effortToThinkingLevel', () => {
  it('maps Damocles effort levels to pi thinking levels (max→max native in 0.80.6; ultracode→max)', () => {
    expect(effortToThinkingLevel({ thinkingDisabled: true, effort: 'high' })).toBe('off');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: null })).toBe('medium');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: 'none' })).toBe('off');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: 'low' })).toBe('low');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: 'high' })).toBe('high');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: 'xhigh' })).toBe('xhigh');
    // pi 0.80.6 added a native `max` thinking level; Damocles passes `max` through and maps its own
    // top tier `ultracode` to pi's `max`. pi clamps per-model for models without native max support.
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: 'max' })).toBe('max');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: 'ultracode' })).toBe('max');
  });
});

describe('recordedReasoning', () => {
  it('reads a GPT-6 Luna conversation recorded at off as effort none', () => {
    expect(recordedReasoning('gpt-6-luna', 'off')).toEqual({ effort: 'none' });
  });

  it('leaves the effort of a GPT model without none to the panel', () => {
    expect(recordedReasoning('gpt-6.1-sol', 'off')).toEqual({});
  });
});

describe('resolvePiModel — GPT two-namespace routing (US-P1-7)', () => {
  it('codex-only: a seeded GPT id resolves to openai-codex; a catalog id absent from the codex seed is unavailable', () => {
    // Only sol is registered on the codex namespace here; luna is a real catalog id that the
    // subscription hasn't provisioned. With codex auth and no api key, that gap must surface as
    // authRequired (the bare {authRequired:true} branch), NOT a soft {} — preserving auth-gate coverage.
    const reg = registry([['openai-codex', 'gpt-6.1-sol']]);
    const status = { apiKey: false, chatgpt: false, codex: true };

    expect(resolvePiModel('gpt-6.1-sol', reg, status).model?.provider).toBe('openai-codex');
    expect(resolvePiModel('gpt-6-luna', reg, status)).toEqual({ authRequired: true });
  });

  it('api-key: every GPT value resolves to the openai provider', () => {
    const reg = registry([
      ['openai', 'gpt-6-astra'],
      ['openai', 'gpt-6.1-sol'],
      ['openai', 'gpt-6-luna'],
    ]);
    const status = { apiKey: true, chatgpt: false, codex: false };

    for (const value of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']) {
      expect(resolvePiModel(value, reg, status).model?.provider).toBe('openai');
    }
  });

  it('prefers codex over api-key when both are configured and the id exists in codex', () => {
    const reg = registry([
      ['openai', 'gpt-6.1-sol'],
      ['openai-codex', 'gpt-6.1-sol'],
    ]);
    expect(resolvePiModel('gpt-6.1-sol', reg, { apiKey: true, chatgpt: false, codex: true }).model?.provider).toBe('openai-codex');
  });

  it('orders GPT credentials: preferred key, ChatGPT, Codex, key, then authRequired on openai', () => {
    const reg = registry([
      ['openai', 'gpt-6.1-sol'],
      ['openai-codex', 'gpt-6.1-sol'],
    ]);
    const provider = (status: { apiKey: boolean; chatgpt: boolean; codex: boolean }, prefer: boolean) =>
      resolvePiModel('gpt-6.1-sol', reg, status, prefer);

    expect(provider({ apiKey: true, chatgpt: true, codex: true }, true)).toEqual({ model: expect.objectContaining({ provider: 'openai' }), authed: true });
    expect(provider({ apiKey: true, chatgpt: true, codex: true }, false).model?.provider).toBe('openai');
    expect(provider({ apiKey: false, chatgpt: true, codex: false }, true).model?.provider).toBe('openai');
    expect(provider({ apiKey: true, chatgpt: false, codex: true }, false).model?.provider).toBe('openai-codex');
    expect(provider({ apiKey: true, chatgpt: false, codex: false }, false)).toEqual({ model: expect.objectContaining({ provider: 'openai' }), authed: true });
    expect(provider({ apiKey: false, chatgpt: false, codex: false }, true)).toEqual({ model: expect.objectContaining({ provider: 'openai' }), authRequired: true });
  });

  it('resolves an anthropic value by model id', () => {
    const reg = registry([['anthropic', 'claude-opus-5-5', 'anthropic-messages']]);
    expect(resolvePiModel('claude-opus-5-5', reg, { apiKey: false, chatgpt: false, codex: false }).model?.id).toBe('claude-opus-5-5');
  });
});

describe('modelValueOfPiModel, the model value a recorded pi model names', () => {
  it('inverts resolvePiModel for every catalog model and both OpenAI providers', () => {
    expect(modelValueOfPiModel('anthropic', 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(modelValueOfPiModel('openai', 'gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(modelValueOfPiModel('openai-codex', 'gpt-6-luna')).toBe('gpt-6-luna');
    expect(modelValueOfPiModel('deepseek', 'deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(modelValueOfPiModel('stepfun', 'step-5-preview')).toBe('step-5-preview');
    const openai = { codex: true, chatgpt: true, apiKey: true } as never;
    const all = registry(DEFAULT_MODELS.flatMap((info): Array<[string, string]> => (info.backend === 'openai' ? [['openai', info.openaiModelId ?? info.value]] : [[info.piProvider ?? 'anthropic', info.piModelId ?? info.value]])));
    for (const info of DEFAULT_MODELS) {
      const resolved = resolvePiModel(info.value, all, openai).model!;
      expect(modelValueOfPiModel(resolved.provider, resolved.id)).toBe(info.value);
    }
  });

  it('names no value for a model outside the catalog, or one served by a provider the catalog does not route it through', () => {
    expect(modelValueOfPiModel('openrouter', 'claude-sonnet-5-5')).toBeUndefined();
    expect(modelValueOfPiModel('anthropic', 'claude-sonnet-4-9')).toBeUndefined();
    expect(modelValueOfPiModel('anthropic', 'deepseek-v4-pro')).toBeUndefined();
  });
});

describe('resolvePiModel — piProvider routing (StepFun/DeepSeek)', () => {
  it('routes step-5-preview to the stepfun provider, authed per hasConfiguredAuth', () => {
    const reg = registry([['stepfun', 'step-5-preview', 'anthropic-messages']]);
    const res = resolvePiModel('step-5-preview', reg, { apiKey: false, chatgpt: false, codex: false });
    expect(res.model?.provider).toBe('stepfun');
    expect(res.authed).toBe(true);
    expect(res.authRequired).toBeUndefined();
  });

  it('routes deepseek-v4-pro to the deepseek provider, authed=false when unkeyed', () => {
    const models = [model('deepseek', 'deepseek-v4-pro', 'openai-completions')];
    const reg: ModelLookup = {
      getModel: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
      hasConfiguredAuth: () => false,
      planModelIds: () => undefined,
    };
    const res = resolvePiModel('deepseek-v4-pro', reg, { apiKey: false, chatgpt: false, codex: false });
    expect(res.model?.provider).toBe('deepseek');
    expect(res.authed).toBe(false);
    expect(res.authRequired).toBeUndefined();
  });

  it.each([
    ['MiniMax-M3.1-Flash', 'minimax', 'anthropic-messages'],
    ['grok-4.7', 'xai', 'openai-responses'],
    ['k3', 'kimi-coding', 'openai-completions'],
    ['muse-spark-1.3', 'meta', 'openai-responses'],
  ] as const)('routes %s to the %s provider, signed in only with its key', (value, provider, api) => {
    const models = [model(provider, value, api)];
    const lookup = (authed: boolean): ModelLookup => ({
      getModel: (p, id) => models.find((m) => m.provider === p && m.id === id),
      hasConfiguredAuth: (p) => authed && p === provider,
      planModelIds: () => undefined,
    });
    const none = { apiKey: false, chatgpt: false, codex: false };
    expect(resolvePiModel(value, lookup(true), none)).toEqual({ model: expect.objectContaining({ provider, id: value }), authed: true });
    expect(resolvePiModel(value, lookup(false), none)).toMatchObject({ model: { provider }, authed: false });
  });

  it('returns {} for a piProvider value missing from the registry (StepFun pre-key)', () => {
    const reg = registry([]);
    expect(resolvePiModel('step-5-preview', reg, { apiKey: false, chatgpt: false, codex: false })).toEqual({});
  });
});

describe('DEFAULT_MODELS — step-5-preview effort catalog (Slice 2)', () => {
  const step = DEFAULT_MODELS.find((m) => m.value === 'step-5-preview');

  it('advertises low|medium|high adaptive-thinking effort', () => {
    expect(step?.supportsAdaptiveThinking).toBe(true);
    expect(step?.supportsEffort).toBe(true);
    expect(step?.supportedEffortLevels).toEqual(['low', 'medium', 'high']);
  });

  // StepFun cannot disable thinking, so the switch would do nothing.
  it('always thinks, so the disable-thinking switch is hidden', () => {
    expect(step?.thinkingAlwaysOn).toBe(true);
  });
});

describe('DEFAULT_MODELS: claude-haiku-5-5 effort catalog agrees with the installed pi catalog', () => {
  const anthropicJsonUrl = new URL('../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json', import.meta.url);
  const haiku = readChatCatalog<unknown>(fileURLToPath(anthropicJsonUrl))['anthropic-messages']?.['claude-haiku-5-5'] as Model<'anthropic-messages'> | undefined;
  const info = DEFAULT_MODELS.find((m) => m.value === 'claude-haiku-5-5');

  it('declares pi levels except off plus ultracode, with no catalog default effort', () => {
    expect(haiku).toBeDefined();
    expect(info?.supportedEffortLevels).toEqual([...getSupportedThinkingLevels(haiku!).filter((level) => level !== 'minimal' && level !== 'off'), 'ultracode']);
    expect(info?.defaultEffort).toBeUndefined();
    expect(info?.contextWindow).toBe(haiku?.contextWindow);
  });
});

describe('DEFAULT_MODELS: deepseek-flash effort catalog agrees with the installed pi catalog', () => {
  const deepseekJsonUrl = new URL('../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/deepseek.json', import.meta.url);
  const flash = readChatCatalog<unknown>(fileURLToPath(deepseekJsonUrl))['openai-completions']?.['deepseek-flash'] as Model<Api> | undefined;

  it('offers every level pi supports except off', () => {
    expect(flash).toBeDefined();
    const info = DEFAULT_MODELS.find((m) => m.value === 'deepseek-flash');
    expect(info?.displayName).toBe('DeepSeek V4.1 Flash');
    expect(info?.supportedEffortLevels).toEqual(getSupportedThinkingLevels(flash!).filter((level) => level !== 'off'));
  });
});

describe.each([
  ['MiniMax-M3.1-Flash', 'MiniMax M3.1 Flash', 'minimax.json', 'anthropic-messages'],
  ['grok-4.7', 'Grok 4.7', 'xai.json', 'openai-responses'],
])('DEFAULT_MODELS: %s agrees with the installed pi catalog', (value, displayName, file, api) => {
  const url = new URL(`../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/${file}`, import.meta.url);
  const entry = readChatCatalog<unknown>(fileURLToPath(url))[api]?.[value] as Model<Api> | undefined;
  const info = DEFAULT_MODELS.find((m) => m.value === value);

  it('offers every level pi supports except off, at pi\'s context window', () => {
    expect(entry).toBeDefined();
    expect(info?.displayName).toBe(displayName);
    expect(info?.supportedEffortLevels).toEqual(getSupportedThinkingLevels(entry!).filter((level) => level !== 'off'));
    expect(info?.contextWindow).toBe(entry!.contextWindow);
  });

  it('carries thinkingAlwaysOn exactly when pi cannot turn thinking off', () => {
    expect(info?.thinkingAlwaysOn === true).toBe(entry!.thinkingLevelMap?.off === null);
  });
});

// `minimal` has no EffortLevel name, so a model whose pi map serves it offers the levels above it.
describe.each([
  ['k3', 'K3', 'kimi-coding', 'openai-completions'],
  ['kimi-for-coding', 'Kimi for Coding', 'kimi-coding', 'openai-completions'],
  ['muse-spark-1.3', 'Muse Spark 1.3', 'meta', 'openai-responses'],
  ['muse-wonder-1.0', 'Muse Wonder 1.0', 'meta', 'openai-responses'],
] as const)('DEFAULT_MODELS: %s agrees with the installed pi catalog', (value, displayName, provider, api) => {
  const url = new URL(`../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/${provider}.json`, import.meta.url);
  const entry = readChatCatalog<unknown>(fileURLToPath(url))[api]?.[value] as Model<Api> | undefined;
  const info = DEFAULT_MODELS.find((m) => m.value === value);

  it("offers every level pi supports except off and minimal, at pi's context window", () => {
    expect(entry).toBeDefined();
    expect(info?.displayName).toBe(displayName);
    expect(info?.piProvider).toBe(provider);
    expect(info?.supportedEffortLevels).toEqual(getSupportedThinkingLevels(entry!).filter((level) => level !== 'off' && level !== 'minimal'));
    expect(info?.contextWindow).toBe(entry!.contextWindow);
    expect(info?.defaultEffort).toBeUndefined();
    expect(info?.knowledgeCutoff).toBeUndefined();
  });

  it('carries thinkingAlwaysOn exactly when pi cannot turn thinking off', () => {
    expect(info?.thinkingAlwaysOn === true).toBe(entry!.thinkingLevelMap?.off === null);
  });
});

describe('DEFAULT_MODELS: claude-fable-5-1 effort catalog agrees with the installed pi catalog', () => {
  const anthropicJsonUrl = new URL(
    '../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json',
    import.meta.url,
  );
  const catalog = readChatCatalog<unknown>(fileURLToPath(anthropicJsonUrl));
  const fable51 = catalog['anthropic-messages']?.['claude-fable-5-1'] as Model<'anthropic-messages'> | undefined;

  it('declares exactly what pi reports, modulo the minimal and ultracode mappings Damocles owns', () => {
    expect(fable51).toBeDefined();
    const piLevels = getSupportedThinkingLevels(fable51!);
    // Damocles' EffortLevel union has no 'minimal' tier, and 'ultracode' is its own top tier with no pi
    // analogue, so it only exists while pi still accepts 'max'.
    expect(piLevels).toContain('max');
    const expected = [...piLevels.filter((level) => level !== 'minimal'), 'ultracode'];

    expect(DEFAULT_MODELS.find((m) => m.value === 'claude-fable-5-1')?.supportedEffortLevels).toEqual(expected);
    expect(effortToPiThinking('ultracode')).toBe('max');
  });
});

describe('MODEL_SUBSTITUTES', () => {
  it('names only curated targets, so `isCurated` cannot drop a substitution silently', () => {
    const curated = new Set(DEFAULT_MODELS.map((m) => m.value));
    for (const [requested, targets] of Object.entries(MODEL_SUBSTITUTES)) {
      expect(curated.has(requested), `${requested} is not a catalog entry`).toBe(true);
      for (const target of targets) expect(curated.has(target), `${target} is not a catalog entry`).toBe(true);
    }
  });

  it('sends an unresolvable Opus 5.5 to Sonnet 5.5, never to the costlier catalog head', () => {
    // Without this the generic walk starts at DEFAULT_MODELS[0], which is Fable 5.1 at $10/$50.
    expect(MODEL_SUBSTITUTES['claude-opus-5-5']).toEqual(['claude-sonnet-5-5']);
    expect(DEFAULT_MODELS[0]!.value).toBe('claude-fable-5-1');
  });
});

describe('DEFAULT_MODELS: thinkingAlwaysOn agrees with the installed pi metadata', () => {
  /** The two shipped fields that decide whether a "disable thinking" request can reach the wire. */
  interface ThinkingEntry {
    compat?: { supportsMidConvoEffort?: boolean };
    thinkingLevelMap?: Record<string, string | null>;
  }
  const anthropicJsonUrl = new URL(
    '../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json',
    import.meta.url,
  );
  const entries = (
    readChatCatalog<ThinkingEntry>(fileURLToPath(anthropicJsonUrl))
  )['anthropic-messages'] ?? {};

  /** pi's `buildParams` sends `thinking: { type: "disabled" }` for a disabled request unless `thinkingLevelMap.off` is explicitly null. */
  function forcesThinking(entry: ThinkingEntry): boolean {
    return entry.thinkingLevelMap?.off === null;
  }

  const covered = DEFAULT_MODELS.filter((m) => !m.backend && !m.piProvider && entries[m.value]);

  it('is not vacuous: it covers several shipped entries and the predicate separates them', () => {
    expect(covered.length).toBeGreaterThan(2);
    expect(forcesThinking(entries['claude-fable-5-1']!)).toBe(true);
    expect(forcesThinking(entries['claude-sonnet-5-5']!)).toBe(true);
    expect(forcesThinking(entries['claude-haiku-4-5-20251001']!)).toBe(false);
    expect(forcesThinking(entries['claude-haiku-5-5']!)).toBe(false);
  });

  it.each(covered.map((m) => m.value))('%s carries the flag exactly when pi forces thinking', (value) => {
    const info = DEFAULT_MODELS.find((m) => m.value === value)!;
    expect(info.thinkingAlwaysOn === true).toBe(forcesThinking(entries[value]!));
  });

  // `defaultEffort` is a Damocles decision, not pi metadata, so the loop above cannot check it: pi
  // ships no default and Anthropic documents `medium`. High is deliberate (see CHANGELOG), and the
  // levels either side of it must exist for the settings picker to offer a way back.
  it.each(['claude-opus-5-5', 'claude-sonnet-5-5'])('runs %s at high effort by default, on a level pi supports', (value) => {
    expect(DEFAULT_MODELS.find((m) => m.value === value)?.defaultEffort).toBe('high');
    expect(getSupportedThinkingLevels(entries[value] as unknown as Model<Api>)).toContain('high');
  });
});

// `minimal` has no EffortLevel name. pi's `off` is offered as `none` exactly where both catalogs send it as reasoning
// effort `none`; where `off` is null pi clamps it up to a real level, so offering it would mislabel what runs.
describe.each(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'])('DEFAULT_MODELS: %s agrees with both installed OpenAI catalogs', (id) => {
  const info = DEFAULT_MODELS.find((m) => m.value === id);

  function catalogEntry(file: string, api: string): Model<Api> | undefined {
    const url = new URL(`../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/${file}`, import.meta.url);
    const catalog = readChatCatalog<unknown>(fileURLToPath(url));
    return catalog[api]?.[id] as Model<Api> | undefined;
  }

  const apiKeyEntry = catalogEntry('openai.json', 'openai-responses');
  const codexEntry = catalogEntry('openai-codex.json', 'openai-codex-responses');
  const sendsNone = (entry: Model<Api>) => entry.thinkingLevelMap?.off === 'none';
  const offered = (entry: Model<Api>) => [
    ...(sendsNone(apiKeyEntry!) && sendsNone(codexEntry!) ? ['none'] : []),
    ...getSupportedThinkingLevels(entry).filter((level) => level !== 'minimal' && level !== 'off'),
  ];

  it('declares the API-key provider levels, minus the tiers Damocles does not offer', () => {
    expect(apiKeyEntry).toBeDefined();
    expect(info?.supportedEffortLevels).toEqual(offered(apiKeyEntry!));
  });

  it('declares the Codex provider levels, minus the tiers Damocles does not offer', () => {
    expect(codexEntry).toBeDefined();
    expect(info?.supportedEffortLevels).toEqual(offered(codexEntry!));
  });

  it('carries the smaller of the two catalogs\' windows, so the pre-adoption fallback never overstates headroom', () => {
    expect(info?.contextWindow).toBe(Math.min(apiKeyEntry!.contextWindow, codexEntry!.contextWindow));
  });

  it('routes to the id both catalogs key it by, on either auth mode', () => {
    expect(info?.backend).toBe('openai');
    expect(info?.openaiModelId).toBe(apiKeyEntry?.id);
    expect(info?.openaiModelId).toBe(codexEntry?.id);
  });

  // With `off` null, pi clamps a requested off up to the lowest real level, so the model always thinks.
  it('carries thinkingAlwaysOn exactly when neither catalog can turn thinking off', () => {
    const cannotTurnOff = (entry: Model<Api>) => entry.thinkingLevelMap?.off === null;
    expect(cannotTurnOff(apiKeyEntry!)).toBe(cannotTurnOff(codexEntry!));
    expect(info?.thinkingAlwaysOn === true).toBe(cannotTurnOff(apiKeyEntry!));
  });
});

/** One shipped provider catalog file: `{ [api]: { [modelId]: entry } }`. */
type ProviderCatalog = Record<string, Record<string, { compat?: { allowedFallbackModels?: unknown[] } }>>;

const catalogDirUrl = new URL('../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/', import.meta.url);

function loadShippedCatalogs(): Record<string, ProviderCatalog> {
  const dir = fileURLToPath(catalogDirUrl);
  const catalogs: Record<string, ProviderCatalog> = {};
  // `.manifest.json` records how the catalogs were generated; it is not itself a catalog.
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'))) {
    catalogs[file] = readChatCatalog(join(dir, file)) as ProviderCatalog;
  }
  return catalogs;
}

/** Every model id a session can be seated on: an offered value, its OpenAI id, or a substitution target. */
function reachableModelIds(): Set<string> {
  const ids = new Set<string>();
  for (const m of DEFAULT_MODELS) {
    ids.add(m.value);
    if (m.openaiModelId) ids.add(m.openaiModelId);
    if (m.piModelId) ids.add(m.piModelId);
  }
  for (const targets of Object.values(MODEL_SUBSTITUTES)) {
    for (const target of targets) ids.add(target);
  }
  return ids;
}

/** Catalog entries a session can be seated on, each with the fallback list it declares. */
function reachableCatalogEntries(
  catalogs: Record<string, ProviderCatalog>,
): { where: string; fallbacks: unknown[] }[] {
  const reachable = reachableModelIds();
  const found: { where: string; fallbacks: unknown[] }[] = [];
  for (const [file, catalog] of Object.entries(catalogs)) {
    for (const [api, models] of Object.entries(catalog)) {
      for (const [id, entry] of Object.entries(models)) {
        if (reachable.has(id)) {
          found.push({ where: `${file} ${api}/${id}`, fallbacks: entry?.compat?.allowedFallbackModels ?? [] });
        }
      }
    }
  }
  return found;
}

function assertNoServerSideFallback(catalogs: Record<string, ProviderCatalog>): void {
  const offenders = reachableCatalogEntries(catalogs)
    .filter((e) => e.fallbacks.length > 0)
    .map((e) => e.where);
  if (offenders.length === 0) return;
  throw new Error(
    'Damocles must never be server-side downgraded to a less capable model. These catalog entries are ' +
      `reachable from DEFAULT_MODELS and now carry compat.allowedFallbackModels: ${offenders.join(', ')}. ` +
      'A fallback list on a model Damocles offers is a decision to take, not a test to update.',
  );
}

describe('no model Damocles offers carries a server-side fallback list', () => {
  it('holds across every catalog pi ships', () => {
    const catalogs = loadShippedCatalogs();
    // A broken path or id derivation would pass vacuously, so prove the guard is looking at something.
    expect(Object.keys(catalogs).length).toBeGreaterThan(1);
    expect(reachableCatalogEntries(catalogs).length).toBeGreaterThan(0);
    expect(() => assertNoServerSideFallback(catalogs)).not.toThrow();
  });

  it('rejects a fallback list attached to a model DEFAULT_MODELS offers', () => {
    const offered = DEFAULT_MODELS[0]!.value;
    const synthetic: Record<string, ProviderCatalog> = {
      'anthropic.json': {
        'anthropic-messages': {
          [offered]: { compat: { allowedFallbackModels: [{ provider: 'anthropic', model: 'claude-sonnet-5' }] } },
        },
      },
    };
    expect(() => assertNoServerSideFallback(synthetic)).toThrow(
      /never be server-side downgraded to a less capable model/,
    );
    expect(() => assertNoServerSideFallback(synthetic)).toThrow(new RegExp(`anthropic-messages/${offered}`));
  });

  it('ignores a fallback list on a model DEFAULT_MODELS does not offer', () => {
    const unreachable: Record<string, ProviderCatalog> = {
      'anthropic.json': {
        'anthropic-messages': {
          'claude-fable-5': { compat: { allowedFallbackModels: [{ provider: 'anthropic', model: 'claude-opus-5-5' }] } },
        },
      },
    };
    expect(() => assertNoServerSideFallback(unreachable)).not.toThrow();
  });
});

describe('providerDisplayName', () => {
  it('maps each backend/piProvider to its display name', () => {
    expect(providerDisplayName(DEFAULT_MODELS.find((m) => m.value === 'gpt-6.1-sol'))).toBe('OpenAI');
    expect(providerDisplayName(DEFAULT_MODELS.find((m) => m.value === 'step-5-preview'))).toBe('StepFun');
    expect(providerDisplayName(DEFAULT_MODELS.find((m) => m.value === 'deepseek-v4-pro'))).toBe('DeepSeek');
    expect(providerDisplayName(DEFAULT_MODELS.find((m) => m.value === 'MiniMax-M3.1-Flash'))).toBe('MiniMax');
    expect(providerDisplayName(DEFAULT_MODELS.find((m) => m.value === 'grok-4.7'))).toBe('xAI');
    expect(providerDisplayName(DEFAULT_MODELS.find((m) => m.value === 'k3'))).toBe('Kimi Code');
    expect(providerDisplayName(DEFAULT_MODELS.find((m) => m.value === 'muse-spark-1.3'))).toBe('Meta');
    expect(providerDisplayName(DEFAULT_MODELS.find((m) => m.value === 'claude-opus-5-5'))).toBe('Anthropic');
    expect(providerDisplayName(undefined)).toBe('Anthropic');
  });
});

describe('isDollarBilled', () => {
  const find = (v: string) => DEFAULT_MODELS.find((m) => m.value === v);

  it('treats metered DeepSeek as dollar-billed regardless of apiKeySource label', () => {
    // apiKeySource for a piProvider model is the provider id ('deepseek'), not a first-party label.
    expect(isDollarBilled(find('deepseek-v4-pro'), 'deepseek')).toBe(true);
    expect(isDollarBilled(find('deepseek-flash'), 'deepseek')).toBe(true);
  });

  it('treats flat-fee StepFun as NOT dollar-billed', () => {
    expect(isDollarBilled(find('step-5-preview'), 'stepfun')).toBe(false);
  });

  // A MiniMax Token Plan key is decided by `account-billing.ts` from the applied key, never by the catalog.
  it('treats MiniMax and xAI as dollar-billed from the catalog', () => {
    expect(isDollarBilled(find('MiniMax-M3.1-Flash'), 'minimax')).toBe(true);
    expect(isDollarBilled(find('grok-4.7'), 'xai')).toBe(true);
  });

  it('treats Kimi Code as flat and Meta as dollar-billed from the catalog', () => {
    expect(isDollarBilled(find('k3'), 'kimi-coding')).toBe(false);
    expect(isDollarBilled(find('kimi-for-coding'), 'kimi-coding')).toBe(false);
    expect(isDollarBilled(find('muse-spark-1.3'), 'meta')).toBe(true);
    expect(isDollarBilled(find('muse-wonder-1.0'), 'meta')).toBe(true);
  });

  it('classifies first-party credentials by their source label', () => {
    expect(isDollarBilled(find('claude-opus-5-5'), 'apikey')).toBe(true);
    expect(isDollarBilled(find('claude-opus-5-5'), 'extra')).toBe(true);
    expect(isDollarBilled(find('claude-opus-5-5'), 'allowance')).toBe(false);
    expect(isDollarBilled(find('gpt-6.1-sol'), 'openai-api-key')).toBe(true);
    expect(isDollarBilled(find('gpt-6.1-sol'), 'codex-oauth')).toBe(false);
  });
});

const COPILOT = DEFAULT_MODELS.filter((m) => m.piProvider === 'github-copilot');
const NONE = { apiKey: false, chatgpt: false, codex: false };

/** A Copilot registry serving every Copilot pi id, signed in, whose stored sign-in lists `plan` (undefined: no list). */
function copilotRegistry(plan: readonly string[] | undefined): ModelLookup {
  const models = COPILOT.map((info) => model('github-copilot', info.piModelId!));
  return {
    getModel: (provider, id) => models.find((m) => m.provider === provider && m.id === id) ?? (provider === 'github-copilot' && id === 'gpt-5-mini' ? model(provider, id) : undefined),
    hasConfiguredAuth: (provider) => provider === 'github-copilot',
    planModelIds: (provider) => (provider === 'github-copilot' && plan ? new Set(plan) : undefined),
  };
}

describe('GitHub Copilot catalog values', () => {
  it('lists eight flagships, each valued github-copilot/<pi id> and billed flat', () => {
    expect(COPILOT.map((m) => m.piModelId)).toEqual(['claude-opus-5.5', 'claude-sonnet-5.5', 'claude-haiku-5.5', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gemini-4-argon', 'gemini-3.8-flash']);
    for (const info of COPILOT) {
      expect(info.value).toBe(`github-copilot/${info.piModelId}`);
      expect(info.flatFee).toBe(true);
      expect(info.description).toContain('GitHub Copilot');
      expect(info.supportedEffortLevels ?? []).not.toContain('ultracode');
    }
  });

  // A Copilot value equal to a first-party one would route an OpenAI or Anthropic chat to Copilot, or the reverse.
  it('keeps every catalog value unique, and no Copilot value equals another provider\'s value or pi id', () => {
    const values = DEFAULT_MODELS.map((m) => m.value);
    expect(new Set(values).size).toBe(values.length);
    const others = DEFAULT_MODELS.filter((m) => m.piProvider !== 'github-copilot').flatMap((m) => [m.value, m.openaiModelId ?? m.value]);
    for (const info of COPILOT) expect(others, info.value).not.toContain(info.value);
  });

  it('resolves each value to its pi id on github-copilot, and maps that pi model back to the value', () => {
    const reg = copilotRegistry(undefined);
    for (const info of COPILOT) {
      const resolved = resolvePiModel(info.value, reg, NONE);
      expect(resolved).toEqual({ model: expect.objectContaining({ provider: 'github-copilot', id: info.piModelId }), authed: true });
      expect(modelValueOfPiModel('github-copilot', info.piModelId!)).toBe(info.value);
      expect(piModelToModelInfo(resolved.model!)).toBe(info);
    }
    // the same pi id under OpenAI stays OpenAI's value
    expect(modelValueOfPiModel('openai', 'gpt-6-luna')).toBe('gpt-6-luna');
    expect(piModelToModelInfo(model('openai', 'gpt-6-luna')).value).toBe('gpt-6-luna');
  });

  it('copies each Claude and GPT entry\'s knowledge cutoff from its first-party counterpart', () => {
    const counterpart: Record<string, string> = {
      'claude-opus-5.5': 'claude-opus-5-5',
      'claude-sonnet-5.5': 'claude-sonnet-5-5',
      'claude-haiku-5.5': 'claude-haiku-5-5',
      'gpt-6-astra': 'gpt-6-astra',
      'gpt-6.1-sol': 'gpt-6.1-sol',
      'gpt-6-luna': 'gpt-6-luna',
    };
    for (const info of COPILOT) {
      const first = counterpart[info.piModelId!];
      if (first === undefined) expect(info.knowledgeCutoff).toBeUndefined();
      else expect(info.knowledgeCutoff).toBe(DEFAULT_MODELS.find((m) => m.value === first)!.knowledgeCutoff);
    }
  });
});

describe('recordedModelValue', () => {
  it('continues a recorded Copilot pi id on its Copilot value, never on the OpenAI or Anthropic one', () => {
    expect(recordedModelValue('github-copilot', 'gpt-6-luna')).toBe('github-copilot/gpt-6-luna');
    expect(recordedModelValue('github-copilot', 'claude-opus-5.5')).toBe('github-copilot/claude-opus-5.5');
    expect(recordedModelValue('openai', 'gpt-6-luna')).toBe('gpt-6-luna');
  });

  it('migrates a retired value only to a successor the recorded provider serves', () => {
    expect(recordedModelValue('openai', 'gpt-5.5')).toBe('gpt-6.1-sol');
    expect(recordedModelValue('anthropic', 'claude-opus-5')).toBe('claude-opus-5-5');
    expect(recordedModelValue('github-copilot', 'gpt-5.5')).toBeUndefined();
    expect(recordedModelValue('github-copilot', 'gpt-5-mini')).toBeUndefined();
  });
});

describe('plan gating', () => {
  it('resolves a Copilot model outside the stored sign-in\'s list as not in the plan, never signed in', () => {
    const reg = copilotRegistry(['gpt-6-luna', 'claude-haiku-5.5']);
    expect(resolvePiModel('github-copilot/gpt-6-luna', reg, NONE)).toMatchObject({ authed: true });
    expect(resolvePiModel('github-copilot/gpt-6.1-sol', reg, NONE)).toEqual({ model: expect.objectContaining({ id: 'gpt-6.1-sol' }), authed: false, notInPlan: true });
  });

  it('gates nothing while the sign-in lists no models, and never a provider that does not limit by plan', () => {
    expect(resolvePiModel('github-copilot/gpt-6.1-sol', copilotRegistry(undefined), NONE)).toMatchObject({ authed: true });
    const deepseek: ModelLookup = {
      getModel: (provider, id) => (provider === 'deepseek' ? model(provider, id) : undefined),
      hasConfiguredAuth: () => true,
      planModelIds: () => new Set<string>(),
    };
    expect(resolvePiModel('deepseek-v4-pro', deepseek, NONE)).toMatchObject({ authed: true });
    expect(modelInPlan('deepseek', 'deepseek-v4-pro', deepseek)).toBe(true);
  });

  // A template's direct provider/modelId pin resolves outside the catalog; it takes the same check.
  it('refuses a direct pin of a Copilot model outside the plan', () => {
    const reg = copilotRegistry(['gpt-6-luna']);
    expect(modelInPlan('github-copilot', 'gpt-5-mini', reg)).toBe(false);
    expect(modelInPlan('github-copilot', 'gpt-6-luna', reg)).toBe(true);
    expect(modelInPlan('github-copilot', 'gpt-5-mini', copilotRegistry(undefined))).toBe(true);
  });

  it('marks the picker\'s models outside the plan with the provider, and leaves the rest', () => {
    const marked = markNotInPlan(DEFAULT_MODELS, copilotRegistry(['gpt-6-luna']));
    expect(marked.filter((m) => m.unavailable).map((m) => m.value)).toEqual(COPILOT.filter((m) => m.piModelId !== 'gpt-6-luna').map((m) => m.value));
    expect(marked.find((m) => m.value === 'github-copilot/gpt-6.1-sol')?.unavailable).toEqual({ reason: 'not-in-plan', provider: 'github-copilot' });
    expect(markNotInPlan(DEFAULT_MODELS, copilotRegistry(undefined)).some((m) => m.unavailable)).toBe(false);
  });
});

describe('effortBadgeApplies', () => {
  const copilotEntry = (api: Api, id: string) => readChatCatalog<Model<Api>>(fileURLToPath(new URL('../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/github-copilot.json', import.meta.url)))[api]![id]!;

  it('applies to a reasoning model unless its catalog entry offers no effort', () => {
    expect(effortBadgeApplies(copilotEntry('openai-completions', 'gemini-4-argon'))).toBe(false);
    expect(effortBadgeApplies(copilotEntry('openai-completions', 'gemini-3.8-flash'))).toBe(false);
    expect(effortBadgeApplies(copilotEntry('openai-responses', 'gpt-6-luna'))).toBe(true);
    expect(effortBadgeApplies({ provider: 'anthropic', id: 'claude-sonnet-5-5', reasoning: true })).toBe(true);
    expect(effortBadgeApplies({ provider: 'openrouter', id: 'some/reasoner', reasoning: true })).toBe(true);
    expect(effortBadgeApplies({ provider: 'openai', id: 'gpt-4.1-mini', reasoning: false })).toBe(false);
    expect(effortBadgeApplies(undefined)).toBe(false);
  });

  // pi sends no level to a model whose compat says it takes no reasoning effort (openai-completions.js:718-727 in pi-ai 1.4.0).
  it('applies to no model outside the catalog that reasons but takes no effort, by pi\'s own compat', () => {
    const kimiCoding = readChatCatalog<Model<Api>>(fileURLToPath(new URL('../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/kimi-coding.json', import.meta.url)));
    const k3 = copilotEntry('openai-completions', 'kimi-k3');
    const highspeed = kimiCoding['openai-completions']!['kimi-for-coding-highspeed']!;
    expect([k3.reasoning, highspeed.reasoning]).toEqual([true, true]);
    expect(effortBadgeApplies(k3)).toBe(false);
    expect(effortBadgeApplies(highspeed)).toBe(false);
    expect(effortBadgeApplies({ ...k3, compat: { supportsReasoningEffort: true } } as Model<Api>)).toBe(true);
  });
});

describe('piModelToModelInfo for a model outside the catalog', () => {
  // pi's Copilot also serves grok-4.7, which is xAI's catalog value; xAI's label, levels and billing are not Copilot's.
  it('never gives a Copilot model another provider\'s entry', () => {
    const grok = readChatCatalog<Model<Api>>(fileURLToPath(new URL('../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/github-copilot.json', import.meta.url)))['openai-responses']!['grok-4.7']!;
    const info = piModelToModelInfo(grok);
    expect(DEFAULT_MODELS).not.toContain(info);
    expect(info).toMatchObject({ value: 'grok-4.7', description: '' });
    expect(info.piProvider).toBeUndefined();
  });

  it('still names a gateway\'s model by the first-party entry of the same id', () => {
    expect(piModelToModelInfo(model('cloudflare-ai-gateway', 'claude-opus-5-5'))).toBe(DEFAULT_MODELS.find((m) => m.value === 'claude-opus-5-5'));
  });
});

// Each Copilot entry agrees with pi's github-copilot catalog: its window, its levels and whether thinking can be turned off.
describe('DEFAULT_MODELS: GitHub Copilot entries agree with the installed pi catalog', () => {
  interface CopilotEntry extends Model<Api> {
    compat?: { supportsReasoningEffort?: boolean };
  }
  const catalog = readChatCatalog<CopilotEntry>(fileURLToPath(new URL('../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/github-copilot.json', import.meta.url)));
  const entryOf = (id: string): CopilotEntry | undefined => Object.values(catalog).map((models) => models[id]).find((entry) => entry !== undefined);

  it.each(COPILOT.map((m) => m.piModelId!))('%s has pi\'s context window', (id) => {
    const info = COPILOT.find((m) => m.piModelId === id)!;
    expect(info.contextWindow).toBe(entryOf(id)!.contextWindow);
  });

  it.each(COPILOT.filter((m) => m.supportsEffort).map((m) => m.piModelId!))('%s offers pi\'s levels except off and minimal', (id) => {
    const info = COPILOT.find((m) => m.piModelId === id)!;
    expect(info.supportsAdaptiveThinking).toBe(true);
    expect(info.supportedEffortLevels).toEqual(getSupportedThinkingLevels(entryOf(id)!).filter((level) => level !== 'off' && level !== 'minimal'));
  });

  // pi sends a Copilot Gemini model no reasoning parameter (openai-completions.js:718-727 needs compat.supportsReasoningEffort), so no level reaches it.
  it.each(['gemini-4-argon', 'gemini-3.8-flash'])('%s offers no effort, since pi sends it none', (id) => {
    const info = COPILOT.find((m) => m.piModelId === id)!;
    const entry = entryOf(id)!;
    expect(entry.compat?.supportsReasoningEffort).toBe(false);
    expect(entry.thinkingLevelMap).toBeUndefined();
    expect(info.supportsEffort).toBe(false);
    expect(info.supportsAdaptiveThinking).toBe(false);
    expect(info.supportedEffortLevels).toBeUndefined();
    expect(info.thinkingAlwaysOn).toBe(true);
  });

  // Copilot's responses path sends no reasoning for off (openai-responses.js:303), so Luna reasons at its default although pi maps off to none.
  it('marks Copilot GPT-6 Luna always thinking and offers no none, unlike OpenAI\'s', () => {
    const info = COPILOT.find((m) => m.piModelId === 'gpt-6-luna')!;
    expect(entryOf('gpt-6-luna')!.thinkingLevelMap?.off).toBe('none');
    expect(info.thinkingAlwaysOn).toBe(true);
    expect(info.supportedEffortLevels).not.toContain('none');
  });

  it.each(COPILOT.filter((m) => m.supportsEffort && m.piModelId !== 'gpt-6-luna').map((m) => m.piModelId!))('%s carries thinkingAlwaysOn exactly when pi cannot turn thinking off', (id) => {
    const info = COPILOT.find((m) => m.piModelId === id)!;
    expect(info.thinkingAlwaysOn === true).toBe(entryOf(id)!.thinkingLevelMap?.off === null);
  });
});

describe('providerDisplayName and billing for GitHub Copilot', () => {
  it('names GitHub Copilot and bills its models flat', () => {
    const opus = COPILOT.find((m) => m.piModelId === 'claude-opus-5.5');
    expect(providerDisplayName(opus)).toBe('GitHub Copilot');
    expect(isDollarBilled(opus, 'github-copilot')).toBe(false);
  });
});
