import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clampThinkingLevel, type Api, type Model } from '@earendil-works/pi-ai';
import {
  AUTOMATIC_BACKGROUND_MODELS,
  SUBCALL_THINKING,
  resolveBackgroundModel,
  subCallLevel,
  subCallReasoning,
  type StructuredSubCallPurpose,
} from '../subcall-model';
import { CUSTOM_PROVIDER_DEFS } from '../custom-providers';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { OpenAIAuthStatus } from '../openai-auth';

/** A chat model from a catalog file pi-ai ships, keyed `<api>` then `chat:<id>`. */
function catalogModel(file: string, api: string, id: string): Model<Api> {
  const url = new URL(`../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/${file}`, import.meta.url);
  const catalog = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as Record<string, Record<string, Model<Api>>>;
  const model = catalog[api]?.[`chat:${id}`];
  if (!model) throw new Error(`${id} is not in pi-ai's ${file}`);
  return model;
}

const haiku = catalogModel('anthropic.json', 'anthropic-messages', 'claude-haiku-5-5');
const luna = catalogModel('openai.json', 'openai-responses', 'gpt-6-luna');
const deepseekPro = catalogModel('deepseek.json', 'openai-completions', 'deepseek-v4-pro');
const nonReasoning = catalogModel('openai.json', 'openai-responses', 'gpt-4.1-mini');
const sonnet = catalogModel('anthropic.json', 'anthropic-messages', 'claude-sonnet-5-5');
const deepseekFlash = catalogModel('deepseek.json', 'openai-completions', 'deepseek-flash');
const stepPreview = CUSTOM_PROVIDER_DEFS.find((d) => d.provider === 'stepfun')!.registerConfig!.models!.find((m) => m.id === 'step-5-preview') as unknown as Model<Api>;

describe('SUBCALL_THINKING', () => {
  it('runs the judging and lookup jobs with thinking off and the writing jobs at low', () => {
    expect(SUBCALL_THINKING).toEqual({
      'session-title': 'off',
      'memory-query-expansion': 'off',
      'memory-rerank': 'off',
      'memory-merge': 'off',
      'memory-extract': 'low',
      'memory-profile': 'low',
      'memory-audit': 'low',
    });
  });
});

describe('subCallReasoning with pi-ai clampThinkingLevel', () => {
  it('sends low on Haiku 5.5 for both off and low, since Haiku 5.5 cannot disable thinking', () => {
    expect(subCallReasoning(clampThinkingLevel, haiku, 'off')).toBe('low');
    expect(subCallReasoning(clampThinkingLevel, haiku, 'low')).toBe('low');
  });

  it('omits reasoning for off on GPT-6 Luna and sends low for low', () => {
    expect(subCallReasoning(clampThinkingLevel, luna, 'off')).toBeUndefined();
    expect(subCallReasoning(clampThinkingLevel, luna, 'low')).toBe('low');
  });

  it('omits reasoning on a non-reasoning model', () => {
    expect(nonReasoning.reasoning).toBe(false);
    expect(subCallReasoning(clampThinkingLevel, nonReasoning, 'low')).toBeUndefined();
  });

  it('raises low to high on DeepSeek V4 Pro, whose lowest level is high', () => {
    expect(subCallReasoning(clampThinkingLevel, deepseekPro, 'low')).toBe('high');
  });

  it('raises off to low on Step 5 Preview and keeps high', () => {
    expect(subCallReasoning(clampThinkingLevel, stepPreview, 'off')).toBe('low');
    expect(subCallReasoning(clampThinkingLevel, stepPreview, 'high')).toBe('high');
  });
});

const PURPOSES = Object.keys(SUBCALL_THINKING) as StructuredSubCallPurpose[];
const SIGNED_OUT: OpenAIAuthStatus = { apiKey: false, chatgpt: false, codex: false };
const CHATGPT: OpenAIAuthStatus = { apiKey: false, chatgpt: true, codex: false };

// The registration config names no provider; pi's registry stamps it on.
const stepfunModel = { ...stepPreview, provider: 'stepfun' } as Model<Api>;

/** A model registry holding the four Automatic candidates and Sonnet 5.5, with sign-in per provider. */
function registry(authed: readonly string[]) {
  const models = [haiku, sonnet, luna, stepfunModel, deepseekFlash];
  return {
    getModel: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: (provider: string) => authed.includes(provider),
  };
}

function settings(user: Record<string, unknown> = {}) {
  return createFakePlatform({ settings: { user } }).settings;
}

describe('resolveBackgroundModel', () => {
  it('tries Haiku 5.5, GPT-6 Luna, Step 5 Preview and DeepSeek V4.1 Flash in that order', () => {
    expect(AUTOMATIC_BACKGROUND_MODELS).toEqual(['claude-haiku-5-5', 'gpt-6-luna', 'step-5-preview', 'deepseek-flash']);
  });

  it('takes the first signed-in candidate on Automatic, and null when none is', () => {
    const pick = (authed: string[], openai: OpenAIAuthStatus) => resolveBackgroundModel(registry(authed), settings(), openai, false)?.model.id ?? null;
    expect(pick(['anthropic', 'stepfun', 'deepseek'], CHATGPT)).toBe('claude-haiku-5-5');
    expect(pick(['stepfun', 'deepseek'], CHATGPT)).toBe('gpt-6-luna');
    expect(pick(['stepfun', 'deepseek'], SIGNED_OUT)).toBe('step-5-preview');
    expect(pick(['deepseek'], SIGNED_OUT)).toBe('deepseek-flash');
    expect(pick([], SIGNED_OUT)).toBeNull();
  });

  it('ignores a stored effort on Automatic', () => {
    expect(resolveBackgroundModel(registry(['anthropic']), settings({ 'damocles.background.effort': 'high' }), SIGNED_OUT, false)).toEqual({ model: haiku });
  });

  it('gives null for a picked model whose provider is signed out, never another provider', () => {
    const user = { 'damocles.background.model': 'step-5-preview' };
    expect(resolveBackgroundModel(registry(['anthropic', 'deepseek']), settings(user), CHATGPT, false)).toBeNull();
    expect(resolveBackgroundModel(registry(['stepfun']), settings(user), SIGNED_OUT, false)).toEqual({ model: stepfunModel });
  });

  it('gives null for a picked value outside the catalog', () => {
    expect(resolveBackgroundModel(registry(['anthropic']), settings({ 'damocles.background.model': 'claude-3-opus' }), SIGNED_OUT, false)).toBeNull();
  });

  it('reads a retired id as its successor', () => {
    const user = { 'damocles.background.model': 'step-3.7-flash', 'damocles.background.effort': 'high' };
    expect(resolveBackgroundModel(registry(['stepfun']), settings(user), SIGNED_OUT, false)).toEqual({ model: stepfunModel, effort: 'high' });
  });

  it('keeps a supported effort for a picked model and drops one the model lacks', () => {
    expect(resolveBackgroundModel(registry(['anthropic']), settings({ 'damocles.background.model': 'claude-sonnet-5-5', 'damocles.background.effort': 'high' }), SIGNED_OUT, false))
      .toEqual({ model: sonnet, effort: 'high' });
    expect(resolveBackgroundModel(registry(['stepfun']), settings({ 'damocles.background.model': 'step-5-preview', 'damocles.background.effort': 'max' }), SIGNED_OUT, false))
      .toEqual({ model: stepfunModel });
  });
});

describe('subCallLevel', () => {
  it('runs every purpose at an explicit effort, clamped by pi', () => {
    for (const purpose of PURPOSES) {
      expect(subCallReasoning(clampThinkingLevel, sonnet, subCallLevel(purpose, 'high')), purpose).toBe('high');
      expect(subCallReasoning(clampThinkingLevel, stepPreview, subCallLevel(purpose, 'ultracode')), purpose).toBe('high');
      expect(subCallReasoning(clampThinkingLevel, deepseekFlash, subCallLevel(purpose, 'medium')), purpose).toBe('high');
    }
  });

  it('uses the per-job table, clamped, on Per job', () => {
    for (const purpose of PURPOSES) {
      expect(subCallLevel(purpose, undefined), purpose).toBe(SUBCALL_THINKING[purpose]);
      expect(subCallReasoning(clampThinkingLevel, stepPreview, subCallLevel(purpose, undefined)), purpose).toBe('low');
    }
  });
});
