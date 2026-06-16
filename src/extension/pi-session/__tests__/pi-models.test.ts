import { describe, it, expect } from 'vitest';
import type { Model, Api } from '@earendil-works/pi-ai';
import {
  mapPiToolName,
  piModelToModelInfo,
  sdkAnthropicModels,
  resolvePiModel,
  effortToThinkingLevel,
  type ModelLookup,
} from '../pi-models';

function model(provider: string, id: string, api: Api = 'openai-responses'): Model<Api> {
  return { id, name: id, api, provider, contextWindow: 200_000 } as unknown as Model<Api>;
}

/** Registry seeded with explicit (provider,id) pairs; `find` is an exact lookup, `getAll` the union. */
function registry(pairs: Array<[string, string, Api?]>): ModelLookup {
  const models = pairs.map(([p, id, api]) => model(p, id, api));
  return {
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
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
});

describe('piModelToModelInfo', () => {
  it('inherits rich display from DEFAULT_MODELS for a known anthropic model', () => {
    const info = piModelToModelInfo(model('anthropic', 'claude-opus-4-8', 'anthropic-messages'));
    expect(info.value).toBe('claude-opus-4-8');
    expect(info.displayName).toBe('Opus 4.8');
  });

  it('reconciles a codex model id back to its Damocles value', () => {
    const info = piModelToModelInfo(model('openai-codex', 'gpt-5.4'));
    expect(info.value).toBe('gpt-5.4');
    expect(info.backend).toBe('openai');
  });

  it('synthesizes a minimal entry for an unknown model', () => {
    const info = piModelToModelInfo(model('openai', 'gpt-custom-9'));
    expect(info.value).toBe('gpt-custom-9');
    expect(info.backend).toBe('openai');
  });
});

describe('effortToThinkingLevel', () => {
  it('maps Damocles effort levels to pi thinking levels (max/ultracode → xhigh)', () => {
    expect(effortToThinkingLevel({ thinkingDisabled: true, effort: 'high' })).toBe('off');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: null })).toBe('medium');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: 'none' })).toBe('off');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: 'low' })).toBe('low');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: 'high' })).toBe('high');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: 'xhigh' })).toBe('xhigh');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: 'max' })).toBe('xhigh');
    expect(effortToThinkingLevel({ thinkingDisabled: false, effort: 'ultracode' })).toBe('xhigh');
  });
});

describe('resolvePiModel — GPT two-namespace routing (US-P1-7)', () => {
  it('codex-only: gpt-5.4 resolves to openai-codex; gpt-5.2 and gpt-5.3-codex are unavailable', () => {
    const reg = registry([
      ['openai-codex', 'gpt-5.5'],
      ['openai-codex', 'gpt-5.4'],
      ['openai-codex', 'gpt-5.4-mini'],
      ['openai-codex', 'gpt-5.3-codex-spark'],
    ]);
    const status = { apiKey: false, codex: true };

    expect(resolvePiModel('gpt-5.4', reg, status).model?.provider).toBe('openai-codex');
    expect(resolvePiModel('gpt-5.2', reg, status)).toEqual({ authRequired: true });
    expect(resolvePiModel('gpt-5.3-codex', reg, status)).toEqual({ authRequired: true });
  });

  it('api-key: every GPT value resolves to the openai provider', () => {
    const reg = registry([
      ['openai', 'gpt-5.5'],
      ['openai', 'gpt-5.4'],
      ['openai', 'gpt-5.4-mini'],
      ['openai', 'gpt-5.3-codex'],
      ['openai', 'gpt-5.2'],
    ]);
    const status = { apiKey: true, codex: false };

    for (const value of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2']) {
      expect(resolvePiModel(value, reg, status).model?.provider).toBe('openai');
    }
  });

  it('prefers codex over api-key when both are configured and the id exists in codex', () => {
    const reg = registry([
      ['openai', 'gpt-5.4'],
      ['openai-codex', 'gpt-5.4'],
    ]);
    expect(resolvePiModel('gpt-5.4', reg, { apiKey: true, codex: true }).model?.provider).toBe('openai-codex');
  });

  it('resolves an anthropic value by model id', () => {
    const reg = registry([['anthropic', 'claude-opus-4-8', 'anthropic-messages']]);
    expect(resolvePiModel('claude-opus-4-8', reg, { apiKey: false, codex: false }).model?.id).toBe('claude-opus-4-8');
  });
});
