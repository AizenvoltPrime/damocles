import { describe, it, expect } from 'vitest';
import type { Model, Api } from '@earendil-works/pi-ai';
import {
  mapPiToolName,
  piModelToModelInfo,
  sdkAnthropicModels,
  resolvePiModel,
  providerDisplayName,
  isDollarBilled,
  effortToThinkingLevel,
  type ModelLookup,
} from '../pi-models';
import { DEFAULT_MODELS } from '../../../shared/types/constants';

function model(provider: string, id: string, api: Api = 'openai-responses'): Model<Api> {
  return { id, name: id, api, provider, contextWindow: 200_000 } as unknown as Model<Api>;
}

/** Registry seeded with explicit (provider,id) pairs; `getModel` is an exact lookup. */
function registry(pairs: Array<[string, string, Api?]>): ModelLookup {
  const models = pairs.map(([p, id, api]) => model(p, id, api));
  return {
    getModel: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
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
    expect(models.some((m) => m.value === 'claude-opus-4-8')).toBe(true);
    expect(models.some((m) => m.value.startsWith('gpt-'))).toBe(false);
  });

  it('excludes piProvider (StepFun/DeepSeek) entries — the SDK harness is Anthropic-only', () => {
    const models = sdkAnthropicModels();
    expect(models.every((m) => !m.piProvider)).toBe(true);
    expect(models.some((m) => m.value === 'step-3.7-flash')).toBe(false);
    expect(models.some((m) => m.value === 'deepseek-v4-pro')).toBe(false);
  });
});

describe('piModelToModelInfo', () => {
  it('inherits rich display from DEFAULT_MODELS for a known anthropic model', () => {
    const info = piModelToModelInfo(model('anthropic', 'claude-opus-4-8', 'anthropic-messages'));
    expect(info.value).toBe('claude-opus-4-8');
    expect(info.displayName).toBe('Opus 4.8');
  });

  it('reconciles a codex model id back to its Damocles value', () => {
    const info = piModelToModelInfo(model('openai-codex', 'gpt-5.6-terra'));
    expect(info.value).toBe('gpt-5.6-terra');
    expect(info.backend).toBe('openai');
  });

  it('synthesizes a minimal entry for an unknown model', () => {
    const info = piModelToModelInfo(model('openai', 'gpt-custom-9'));
    expect(info.value).toBe('gpt-custom-9');
    expect(info.backend).toBe('openai');
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

describe('resolvePiModel — GPT two-namespace routing (US-P1-7)', () => {
  it('codex-only: a seeded 5.6 id resolves to openai-codex; a catalog id absent from the codex seed is unavailable', () => {
    // Only sol + terra are registered on the codex namespace here; luna is a real catalog id that the
    // subscription hasn't provisioned. With codex auth and no api key, that gap must surface as
    // authRequired (the bare {authRequired:true} branch), NOT a soft {} — preserving auth-gate coverage.
    const reg = registry([
      ['openai-codex', 'gpt-5.6-sol'],
      ['openai-codex', 'gpt-5.6-terra'],
    ]);
    const status = { apiKey: false, codex: true };

    expect(resolvePiModel('gpt-5.6-terra', reg, status).model?.provider).toBe('openai-codex');
    expect(resolvePiModel('gpt-5.6-luna', reg, status)).toEqual({ authRequired: true });
  });

  it('api-key: every GPT value resolves to the openai provider', () => {
    const reg = registry([
      ['openai', 'gpt-5.6-sol'],
      ['openai', 'gpt-5.6-terra'],
      ['openai', 'gpt-5.6-luna'],
    ]);
    const status = { apiKey: true, codex: false };

    for (const value of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(resolvePiModel(value, reg, status).model?.provider).toBe('openai');
    }
  });

  it('prefers codex over api-key when both are configured and the id exists in codex', () => {
    const reg = registry([
      ['openai', 'gpt-5.6-terra'],
      ['openai-codex', 'gpt-5.6-terra'],
    ]);
    expect(resolvePiModel('gpt-5.6-terra', reg, { apiKey: true, codex: true }).model?.provider).toBe('openai-codex');
  });

  it('resolves an anthropic value by model id', () => {
    const reg = registry([['anthropic', 'claude-opus-4-8', 'anthropic-messages']]);
    expect(resolvePiModel('claude-opus-4-8', reg, { apiKey: false, codex: false }).model?.id).toBe('claude-opus-4-8');
  });
});

describe('resolvePiModel — piProvider routing (StepFun/DeepSeek)', () => {
  it('routes step-3.7-flash to the stepfun provider, authed per hasConfiguredAuth', () => {
    const reg = registry([['stepfun', 'step-3.7-flash', 'anthropic-messages']]);
    const res = resolvePiModel('step-3.7-flash', reg, { apiKey: false, codex: false });
    expect(res.model?.provider).toBe('stepfun');
    expect(res.authed).toBe(true);
    expect(res.authRequired).toBeUndefined();
  });

  it('routes deepseek-v4-pro to the deepseek provider, authed=false when unkeyed', () => {
    const models = [model('deepseek', 'deepseek-v4-pro', 'openai-completions')];
    const reg: ModelLookup = {
      getModel: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
      hasConfiguredAuth: () => false,
    };
    const res = resolvePiModel('deepseek-v4-pro', reg, { apiKey: false, codex: false });
    expect(res.model?.provider).toBe('deepseek');
    expect(res.authed).toBe(false);
    expect(res.authRequired).toBeUndefined();
  });

  it('returns {} for a piProvider value missing from the registry (StepFun pre-key)', () => {
    const reg = registry([]);
    expect(resolvePiModel('step-3.7-flash', reg, { apiKey: false, codex: false })).toEqual({});
  });
});

describe('DEFAULT_MODELS — step-3.7-flash effort catalog (Slice 2)', () => {
  const step = DEFAULT_MODELS.find((m) => m.value === 'step-3.7-flash');

  it('advertises low|medium|high adaptive-thinking effort', () => {
    expect(step?.supportsAdaptiveThinking).toBe(true);
    expect(step?.supportsEffort).toBe(true);
    expect(step?.supportedEffortLevels).toEqual(['low', 'medium', 'high']);
  });
});

describe('providerDisplayName', () => {
  it('maps each backend/piProvider to its display name', () => {
    expect(providerDisplayName(DEFAULT_MODELS.find((m) => m.value === 'gpt-5.6-sol'))).toBe('OpenAI');
    expect(providerDisplayName(DEFAULT_MODELS.find((m) => m.value === 'step-3.7-flash'))).toBe('StepFun');
    expect(providerDisplayName(DEFAULT_MODELS.find((m) => m.value === 'deepseek-v4-pro'))).toBe('DeepSeek');
    expect(providerDisplayName(DEFAULT_MODELS.find((m) => m.value === 'claude-opus-4-8'))).toBe('Anthropic');
    expect(providerDisplayName(undefined)).toBe('Anthropic');
  });
});

describe('isDollarBilled', () => {
  const find = (v: string) => DEFAULT_MODELS.find((m) => m.value === v);

  it('treats metered DeepSeek as dollar-billed regardless of apiKeySource label', () => {
    // apiKeySource for a piProvider model is the provider id ('deepseek'), not a first-party label.
    expect(isDollarBilled(find('deepseek-v4-pro'), 'deepseek')).toBe(true);
    expect(isDollarBilled(find('deepseek-v4-flash'), 'deepseek')).toBe(true);
  });

  it('treats flat-fee StepFun as NOT dollar-billed', () => {
    expect(isDollarBilled(find('step-3.7-flash'), 'stepfun')).toBe(false);
  });

  it('classifies first-party credentials by their source label', () => {
    expect(isDollarBilled(find('claude-opus-4-8'), 'apikey')).toBe(true);
    expect(isDollarBilled(find('claude-opus-4-8'), 'extra')).toBe(true);
    expect(isDollarBilled(find('claude-opus-4-8'), 'allowance')).toBe(false);
    expect(isDollarBilled(find('gpt-5.6-sol'), 'openai-api-key')).toBe(true);
    expect(isDollarBilled(find('gpt-5.6-sol'), 'codex-oauth')).toBe(false);
  });
});
