import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '../../../shared/types/settings';
import type { OpenAIAuthStatus } from '../openai-auth';
import {
  apiKeySource,
  openaiTokenSource,
  buildAccountInfo,
  dollarBilled,
  modelDollarBilled,
  piModelDollarBilled,
  type AccountBillingDeps,
  type ModelBillingDeps,
} from '../account-billing';

/**
 * Account/billing credential resolution extracted from pi-session.ts. Each case fabricates the deps
 * snapshot the class assembles from live auth state.
 */

const openaiModel: ModelInfo = { value: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', description: '', backend: 'openai' };
const stepfunModel: ModelInfo = { value: 'step-2', displayName: 'Step 2', description: '', piProvider: 'stepfun', flatFee: true };
const deepseekModel: ModelInfo = { value: 'deepseek-v4-pro', displayName: 'DeepSeek', description: '', piProvider: 'deepseek' };
const anthropicModel: ModelInfo = { value: 'claude-opus-4-8', displayName: 'Opus', description: '' };

function deps(overrides: Partial<AccountBillingDeps>): AccountBillingDeps {
  return {
    modelValue: 'claude-opus-4-8',
    modelInfo: anthropicModel,
    claudeAuthMode: 'allowance',
    openaiAuthStatus: { apiKey: false, chatgpt: false, codex: false } as OpenAIAuthStatus,
    preferApiKey: false,
    ...overrides,
  };
}

describe('openaiTokenSource', () => {
  it('codex-oauth when a codex grant exists and API key is not preferred', () => {
    expect(openaiTokenSource(deps({ openaiAuthStatus: { apiKey: true, chatgpt: false, codex: true } }))).toBe('codex-oauth');
  });

  it('openai-api-key when prefer-API-key is set and a key is configured', () => {
    expect(openaiTokenSource(deps({ preferApiKey: true, openaiAuthStatus: { apiKey: true, chatgpt: false, codex: true } }))).toBe('openai-api-key');
  });

  it('chatgpt-oauth when a ChatGPT grant exists, over a Codex grant and an unpreferred key', () => {
    expect(openaiTokenSource(deps({ openaiAuthStatus: { apiKey: true, chatgpt: true, codex: true } }))).toBe('chatgpt-oauth');
    expect(openaiTokenSource(deps({ preferApiKey: true, openaiAuthStatus: { apiKey: false, chatgpt: true, codex: false } }))).toBe('chatgpt-oauth');
  });

  it('a preferred key wins over a ChatGPT grant', () => {
    expect(openaiTokenSource(deps({ preferApiKey: true, openaiAuthStatus: { apiKey: true, chatgpt: true, codex: false } }))).toBe('openai-api-key');
  });

  it('falls back to openai-api-key when no codex grant exists', () => {
    expect(openaiTokenSource(deps({ openaiAuthStatus: { apiKey: true, chatgpt: false, codex: false } }))).toBe('openai-api-key');
  });

  // A GPT model outside the Codex catalog resolves to `openai` on the key although a Codex grant exists.
  it('names the key when the model resolved to openai despite a Codex grant, and bills dollars', () => {
    const status = { apiKey: true, chatgpt: false, codex: true };
    const resolved = deps({ modelInfo: openaiModel, openaiAuthStatus: status, resolvedProvider: 'openai' });
    expect(openaiTokenSource(resolved)).toBe('openai-api-key');
    expect(dollarBilled(resolved)).toBe(true);
    expect(openaiTokenSource({ ...resolved, resolvedProvider: 'openai-codex' })).toBe('codex-oauth');
  });

  it('names ChatGPT on openai only while the runtime key rule does not want the key', () => {
    const status = { apiKey: true, chatgpt: true, codex: false };
    expect(openaiTokenSource(deps({ openaiAuthStatus: status, resolvedProvider: 'openai' }))).toBe('chatgpt-oauth');
    expect(openaiTokenSource(deps({ openaiAuthStatus: status, resolvedProvider: 'openai', preferApiKey: true }))).toBe('openai-api-key');
  });
});

describe('apiKeySource', () => {
  it('openai backend → the openai token source', () => {
    expect(apiKeySource(deps({ modelInfo: openaiModel, openaiAuthStatus: { apiKey: false, chatgpt: false, codex: true } }))).toBe('codex-oauth');
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
    expect(apiKeySource(deps({ modelInfo: openaiModel, preferApiKey: true, openaiAuthStatus: { apiKey: false, chatgpt: false, codex: true } }))).toBe('codex-oauth');
  });
});

describe('buildAccountInfo', () => {
  it('openai backend sets tokenSource, no subscriptionType', () => {
    const info = buildAccountInfo(deps({ modelValue: 'gpt-6.1-sol', modelInfo: openaiModel, openaiAuthStatus: { apiKey: true, chatgpt: false, codex: false } }));
    expect(info).toEqual({ model: 'gpt-6.1-sol', tokenSource: 'openai-api-key', dollarBilled: true });
  });

  it('piProvider model sets tokenSource = provider id (no Claude chip)', () => {
    const info = buildAccountInfo(deps({ modelValue: 'deepseek-v4-pro', modelInfo: deepseekModel }));
    expect(info).toEqual({ model: 'deepseek-v4-pro', tokenSource: 'deepseek', dollarBilled: true });
  });

  it('anthropic model sets subscriptionType = Claude auth mode', () => {
    const info = buildAccountInfo(deps({ modelValue: 'claude-opus-4-8', modelInfo: anthropicModel, claudeAuthMode: 'allowance' }));
    expect(info).toEqual({ model: 'claude-opus-4-8', subscriptionType: 'allowance', dollarBilled: false });
  });

  it('undefined modelInfo falls to the Claude subscription chip (no backend/piProvider)', () => {
    const info = buildAccountInfo(deps({ modelValue: 'mystery', modelInfo: undefined, claudeAuthMode: 'extra' }));
    expect(info).toEqual({ model: 'mystery', subscriptionType: 'extra', dollarBilled: true });
  });
});

describe('dollarBilled', () => {
  it('openai under ChatGPT is not dollar-metered until the key is preferred', () => {
    const status = { apiKey: true, chatgpt: true, codex: false };
    expect(dollarBilled(deps({ modelInfo: openaiModel, openaiAuthStatus: status }))).toBe(false);
    expect(dollarBilled(deps({ modelInfo: openaiModel, openaiAuthStatus: status, preferApiKey: true }))).toBe(true);
  });

  it('openai with an API key is dollar-metered', () => {
    expect(dollarBilled(deps({ modelInfo: openaiModel, openaiAuthStatus: { apiKey: true, chatgpt: false, codex: false }, preferApiKey: true }))).toBe(true);
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

describe('piModelDollarBilled', () => {
  const billing = (over: Partial<ModelBillingDeps> = {}): ModelBillingDeps => ({
    supportedModels: [openaiModel, stepfunModel, deepseekModel, anthropicModel],
    claudeAuthMode: 'allowance',
    openai: { apiKey: true, chatgpt: false, codex: true } as OpenAIAuthStatus,
    preferApiKey: false,
    registry: undefined,
    ...over,
  });

  it('bills an OpenAI model by the provider it resolved to, whatever the panel prefers', () => {
    // The panel prefers Codex OAuth here, so the catalog rule alone would call the API-key model flat.
    expect(modelDollarBilled('gpt-6.1-sol', billing())).toBe(false);
    expect(piModelDollarBilled({ provider: 'openai', id: 'gpt-6.1-sol' }, billing())).toBe(true);
    expect(piModelDollarBilled({ provider: 'openai-codex', id: 'gpt-6.1-sol' }, billing({ preferApiKey: true }))).toBe(false);
  });

  it('bills openai only while the runtime key is wanted over a ChatGPT grant', () => {
    const chatgpt = (apiKey: boolean) => ({ apiKey, chatgpt: true, codex: false });
    const sol = { provider: 'openai', id: 'gpt-6.1-sol' };
    expect(piModelDollarBilled(sol, billing({ openai: chatgpt(false) }))).toBe(false);
    expect(piModelDollarBilled(sol, billing({ openai: chatgpt(true) }))).toBe(false);
    expect(piModelDollarBilled(sol, billing({ openai: chatgpt(true), preferApiKey: true }))).toBe(true);
    expect(piModelDollarBilled(sol, billing({ openai: chatgpt(false), preferApiKey: true }))).toBe(false);
    // With neither credential Damocles cannot tell, so it reads as a charge.
    expect(piModelDollarBilled(sol, billing({ openai: { apiKey: false, chatgpt: false, codex: false } }))).toBe(true);
  });

  it('bills an Anthropic model by the Claude auth mode, curated or not', () => {
    expect(piModelDollarBilled({ provider: 'anthropic', id: 'claude-opus-4-8' }, billing())).toBe(false);
    expect(piModelDollarBilled({ provider: 'anthropic', id: 'claude-legacy' }, billing({ claudeAuthMode: 'extra' }))).toBe(true);
  });

  it('bills a catalog provider model by its flat-fee flag', () => {
    expect(piModelDollarBilled({ provider: 'stepfun', id: 'step-2' }, billing())).toBe(false);
    expect(piModelDollarBilled({ provider: 'deepseek', id: 'deepseek-v4-pro' }, billing())).toBe(true);
  });

  it('reads a provider outside the catalog as a charge, even for an id the catalog knows elsewhere', () => {
    expect(piModelDollarBilled({ provider: 'openrouter', id: 'step-2' }, billing())).toBe(true);
    expect(piModelDollarBilled({ provider: 'my-gateway', id: 'mystery' }, billing())).toBe(true);
  });
});
