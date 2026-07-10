import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '../../../shared/types/settings';
import type { OpenAIAuthStatus } from '../openai-auth';
import {
  apiKeySource,
  openaiTokenSource,
  buildAccountInfo,
  dollarBilled,
  type AccountBillingDeps,
} from '../account-billing';

/**
 * Account/billing credential resolution extracted from pi-session.ts. Each case fabricates the deps
 * snapshot the class assembles from live auth state.
 */

const openaiModel: ModelInfo = { value: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: '', backend: 'openai' };
const stepfunModel: ModelInfo = { value: 'step-2', displayName: 'Step 2', description: '', piProvider: 'stepfun', flatFee: true };
const deepseekModel: ModelInfo = { value: 'deepseek-v4-pro', displayName: 'DeepSeek', description: '', piProvider: 'deepseek' };
const anthropicModel: ModelInfo = { value: 'claude-opus-4-8', displayName: 'Opus', description: '' };

function deps(overrides: Partial<AccountBillingDeps>): AccountBillingDeps {
  return {
    modelValue: 'claude-opus-4-8',
    modelInfo: anthropicModel,
    claudeAuthMode: 'allowance',
    openaiAuthStatus: { apiKey: false, codex: false } as OpenAIAuthStatus,
    preferApiKey: false,
    ...overrides,
  };
}

describe('openaiTokenSource', () => {
  it('codex-oauth when a codex grant exists and API key is not preferred', () => {
    expect(openaiTokenSource(deps({ openaiAuthStatus: { apiKey: true, codex: true } }))).toBe('codex-oauth');
  });

  it('openai-api-key when prefer-API-key is set and a key is configured', () => {
    expect(openaiTokenSource(deps({ preferApiKey: true, openaiAuthStatus: { apiKey: true, codex: true } }))).toBe('openai-api-key');
  });

  it('falls back to openai-api-key when no codex grant exists', () => {
    expect(openaiTokenSource(deps({ openaiAuthStatus: { apiKey: true, codex: false } }))).toBe('openai-api-key');
  });
});

describe('apiKeySource', () => {
  it('openai backend → the openai token source', () => {
    expect(apiKeySource(deps({ modelInfo: openaiModel, openaiAuthStatus: { apiKey: false, codex: true } }))).toBe('codex-oauth');
  });

  it('piProvider model → its provider id', () => {
    expect(apiKeySource(deps({ modelInfo: stepfunModel }))).toBe('stepfun');
  });

  it('anthropic model → the Claude auth mode', () => {
    expect(apiKeySource(deps({ modelInfo: anthropicModel, claudeAuthMode: 'extra' }))).toBe('extra');
  });

  it('undefined modelInfo (unknown/uncurated model) → falls through to the Claude auth mode', () => {
    expect(apiKeySource(deps({ modelInfo: undefined, claudeAuthMode: 'apikey' }))).toBe('apikey');
  });

  it('openai backend honors prefer-API-key only when a key exists, else codex', () => {
    // preferApiKey set but NO api key configured → must NOT claim openai-api-key; falls to codex.
    expect(apiKeySource(deps({ modelInfo: openaiModel, preferApiKey: true, openaiAuthStatus: { apiKey: false, codex: true } }))).toBe('codex-oauth');
  });
});

describe('buildAccountInfo', () => {
  it('openai backend sets tokenSource, no subscriptionType', () => {
    const info = buildAccountInfo(deps({ modelValue: 'gpt-5.6-sol', modelInfo: openaiModel, openaiAuthStatus: { apiKey: true, codex: false } }));
    expect(info).toEqual({ model: 'gpt-5.6-sol', tokenSource: 'openai-api-key' });
  });

  it('piProvider model sets tokenSource = provider id (no Claude chip)', () => {
    const info = buildAccountInfo(deps({ modelValue: 'deepseek-v4-pro', modelInfo: deepseekModel }));
    expect(info).toEqual({ model: 'deepseek-v4-pro', tokenSource: 'deepseek' });
  });

  it('anthropic model sets subscriptionType = Claude auth mode', () => {
    const info = buildAccountInfo(deps({ modelValue: 'claude-opus-4-8', modelInfo: anthropicModel, claudeAuthMode: 'allowance' }));
    expect(info).toEqual({ model: 'claude-opus-4-8', subscriptionType: 'allowance' });
  });

  it('undefined modelInfo falls to the Claude subscription chip (no backend/piProvider)', () => {
    const info = buildAccountInfo(deps({ modelValue: 'mystery', modelInfo: undefined, claudeAuthMode: 'extra' }));
    expect(info).toEqual({ model: 'mystery', subscriptionType: 'extra' });
  });
});

describe('dollarBilled', () => {
  it('openai with an API key is dollar-metered', () => {
    expect(dollarBilled(deps({ modelInfo: openaiModel, openaiAuthStatus: { apiKey: true, codex: false }, preferApiKey: true }))).toBe(true);
  });

  it('anthropic subscription (allowance) is NOT dollar-metered', () => {
    expect(dollarBilled(deps({ modelInfo: anthropicModel, claudeAuthMode: 'allowance' }))).toBe(false);
  });

  it('anthropic extra-usage IS dollar-metered', () => {
    expect(dollarBilled(deps({ modelInfo: anthropicModel, claudeAuthMode: 'extra' }))).toBe(true);
  });

  it('StepFun (flatFee) is NOT dollar-metered; DeepSeek IS', () => {
    expect(dollarBilled(deps({ modelInfo: stepfunModel }))).toBe(false);
    expect(dollarBilled(deps({ modelInfo: deepseekModel }))).toBe(true);
  });

  it('undefined modelInfo: billing classified purely from the Claude auth mode', () => {
    // No piProvider → isDollarBilled uses the credential label: apikey/extra are metered, allowance isn't.
    expect(dollarBilled(deps({ modelInfo: undefined, claudeAuthMode: 'apikey' }))).toBe(true);
    expect(dollarBilled(deps({ modelInfo: undefined, claudeAuthMode: 'allowance' }))).toBe(false);
  });
});
