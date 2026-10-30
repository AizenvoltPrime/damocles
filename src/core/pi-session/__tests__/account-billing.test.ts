import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelInfo } from '../../../shared/types/settings';
import { DEFAULT_MODELS } from '../../../shared/types/constants';
import type { OpenAIAuthStatus } from '../openai-auth';
import { flatFeeKeyProviders, providerBillsFlat, syncCustomProviders } from '../custom-providers';
import {
  apiKeySource,
  openaiTokenSource,
  buildAccountInfo,
  dollarBilled,
  modelDollarBilled,
  piModelDollarBilled,
  subscriptionProvider,
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
const minimaxModel: ModelInfo = { value: 'MiniMax-M3.1-Flash', displayName: 'MiniMax M3.1 Flash', description: '', piProvider: 'minimax' };
const TOKEN_PLAN: ReadonlySet<string> = new Set(['minimax']);

function deps(overrides: Partial<AccountBillingDeps>): AccountBillingDeps {
  return {
    modelValue: 'claude-opus-4-8',
    modelInfo: anthropicModel,
    claudeAuthMode: 'allowance',
    openaiAuthStatus: { apiKey: false, chatgpt: false, codex: false } as OpenAIAuthStatus,
    preferApiKey: false,
    flatFeeKeyProviders: new Set(),
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
  it('carries the model and whether its credential is dollar-metered', () => {
    expect(buildAccountInfo(deps({ modelValue: 'gpt-6.1-sol', modelInfo: openaiModel, openaiAuthStatus: { apiKey: true, chatgpt: false, codex: false } }))).toEqual({ model: 'gpt-6.1-sol', dollarBilled: true });
    expect(buildAccountInfo(deps({ modelValue: 'deepseek-v4-pro', modelInfo: deepseekModel }))).toEqual({ model: 'deepseek-v4-pro', dollarBilled: true });
    expect(buildAccountInfo(deps({ modelValue: 'claude-opus-4-8', modelInfo: anthropicModel, claudeAuthMode: 'allowance' }))).toEqual({ model: 'claude-opus-4-8', dollarBilled: false });
    expect(buildAccountInfo(deps({ modelValue: 'mystery', modelInfo: undefined, claudeAuthMode: 'extra' }))).toEqual({ model: 'mystery', dollarBilled: true });
  });
});

describe('subscriptionProvider', () => {
  it('names the subscription the active credential bills, and none for a key or a custom provider', () => {
    const chatgpt = { apiKey: true, chatgpt: true, codex: false };
    expect(subscriptionProvider(deps({ claudeAuthMode: 'allowance' }))).toBe('anthropic');
    expect(subscriptionProvider(deps({ claudeAuthMode: 'extra' }))).toBe('anthropic');
    expect(subscriptionProvider(deps({ claudeAuthMode: 'apikey' }))).toBeUndefined();
    expect(subscriptionProvider(deps({ modelInfo: openaiModel, openaiAuthStatus: chatgpt }))).toBe('openai');
    expect(subscriptionProvider(deps({ modelInfo: openaiModel, openaiAuthStatus: chatgpt, preferApiKey: true }))).toBeUndefined();
    expect(subscriptionProvider(deps({ modelInfo: stepfunModel }))).toBeUndefined();
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

  it('MiniMax bills flat only while its applied key is a Token Plan key, which leaves StepFun and DeepSeek as they are', () => {
    const minimax = deps({ modelValue: minimaxModel.value, modelInfo: minimaxModel });
    expect(dollarBilled({ ...minimax, flatFeeKeyProviders: TOKEN_PLAN })).toBe(false);
    expect(buildAccountInfo({ ...minimax, flatFeeKeyProviders: TOKEN_PLAN })).toEqual({ model: minimaxModel.value, dollarBilled: false });
    expect(dollarBilled(minimax)).toBe(true);
    expect(subscriptionProvider({ ...minimax, flatFeeKeyProviders: TOKEN_PLAN })).toBeUndefined();
    expect(dollarBilled(deps({ modelInfo: stepfunModel, flatFeeKeyProviders: TOKEN_PLAN }))).toBe(false);
    expect(dollarBilled(deps({ modelInfo: deepseekModel, flatFeeKeyProviders: TOKEN_PLAN }))).toBe(true);
    // A first-party model is never in the set's reach.
    expect(dollarBilled(deps({ modelInfo: anthropicModel, claudeAuthMode: 'apikey', flatFeeKeyProviders: TOKEN_PLAN }))).toBe(true);
  });

  it('undefined modelInfo: billing classified purely from the Claude auth mode', () => {
    // No piProvider → isDollarBilled uses the credential label: apikey/extra are metered, allowance isn't.
    expect(dollarBilled(deps({ modelInfo: undefined, claudeAuthMode: 'apikey' }))).toBe(true);
    expect(dollarBilled(deps({ modelInfo: undefined, claudeAuthMode: 'allowance' }))).toBe(false);
  });
});

describe('piModelDollarBilled', () => {
  const billing = (over: Partial<ModelBillingDeps> = {}): ModelBillingDeps => ({
    supportedModels: [openaiModel, stepfunModel, deepseekModel, anthropicModel, minimaxModel],
    claudeAuthMode: 'allowance',
    openai: { apiKey: true, chatgpt: false, codex: true } as OpenAIAuthStatus,
    preferApiKey: false,
    registry: undefined,
    flatFeeKeyProviders: new Set(),
    ...over,
  });

  it('bills a MiniMax model by its applied key kind, agreeing with modelDollarBilled', () => {
    const flash = { provider: 'minimax', id: 'MiniMax-M3.1-Flash' };
    expect(piModelDollarBilled(flash, billing({ flatFeeKeyProviders: TOKEN_PLAN }))).toBe(false);
    expect(modelDollarBilled(flash.id, billing({ flatFeeKeyProviders: TOKEN_PLAN }))).toBe(false);
    expect(piModelDollarBilled(flash, billing())).toBe(true);
    expect(modelDollarBilled(flash.id, billing())).toBe(true);
  });

  // Whether a Token Plan covers a template pin outside the catalog is unknown, so it reads as a charge.
  it('bills a MiniMax model outside the catalog whatever the key', () => {
    expect(piModelDollarBilled({ provider: 'minimax', id: 'MiniMax-M3' }, billing({ flatFeeKeyProviders: TOKEN_PLAN }))).toBe(true);
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

  // A Copilot entry's value is not its pi id, so billing must compare the pi id it resolves to.
  it('bills every GitHub Copilot model flat, by its pi id, while the same id on OpenAI bills as OpenAI does', () => {
    const copilot = DEFAULT_MODELS.filter((m) => m.piProvider === 'github-copilot');
    const all = billing({ supportedModels: DEFAULT_MODELS });
    expect(copilot).toHaveLength(8);
    for (const info of copilot) {
      expect(piModelDollarBilled({ provider: 'github-copilot', id: info.piModelId! }, all)).toBe(false);
      expect(modelDollarBilled(info.value, all)).toBe(false);
      expect(dollarBilled(deps({ modelValue: info.value, modelInfo: info }))).toBe(false);
    }
    expect(piModelDollarBilled({ provider: 'openai', id: 'gpt-6-luna' }, all)).toBe(true);
  });

  // Copilot and Kimi Code bill a flat plan with every credential, so a template pin outside the catalog bills no dollars.
  it.each([['github-copilot', 'gpt-5-mini'], ['kimi-coding', 'kimi-k3-preview']])('bills a %s model outside the catalog flat', (provider, id) => {
    const all = billing({ supportedModels: DEFAULT_MODELS });
    expect(DEFAULT_MODELS.some((m) => m.piProvider === provider && (m.piModelId ?? m.value) === id)).toBe(false);
    expect(piModelDollarBilled({ provider, id }, all)).toBe(false);
  });

  it('agrees with the catalog: a provider bills flat with every credential exactly when each of its catalog models is flatFee', () => {
    const providers = new Set(DEFAULT_MODELS.flatMap((m) => (m.piProvider ? [m.piProvider] : [])));
    for (const provider of providers) {
      const models = DEFAULT_MODELS.filter((m) => m.piProvider === provider);
      expect([provider, providerBillsFlat(provider)]).toEqual([provider, models.every((m) => m.flatFee === true)]);
    }
  });

  it('reads a provider outside the catalog as a charge, even for an id the catalog knows elsewhere', () => {
    expect(piModelDollarBilled({ provider: 'openrouter', id: 'step-2' }, billing())).toBe(true);
    expect(piModelDollarBilled({ provider: 'my-gateway', id: 'mystery' }, billing())).toBe(true);
  });

  // Each provider bills one way with every credential, its sign-in included, so which one the key sync leaves active never changes billing.
  it.each([
    ['xai', true],
    ['kimi-coding', false],
    ['meta', true],
  ] as const)('bills every %s model the same whether the sign-in or the saved key is active (per token: %s)', async (provider, metered) => {
    const providerModels = DEFAULT_MODELS.filter((m) => m.piProvider === provider);
    expect(providerModels.length).toBeGreaterThan(0);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-billing-`));
    fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ [provider]: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }));
    const sweepMarkerPath = path.join(agentDir, 'swept.json');
    fs.writeFileSync(sweepMarkerPath, '{}');
    const runtime = {
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      setRuntimeApiKey: vi.fn(async () => {}),
      removeRuntimeApiKey: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      getProviderAuthStatus: vi.fn(() => ({ configured: true, source: 'stored' })),
    } as unknown as ModelRuntime;
    for (const preferApiKey of [false, true]) {
      const result = await syncCustomProviders({
        modelRuntime: runtime,
        getSecret: async (key) => (key === `damocles.${provider}.apiKey` ? `${provider}-key` : undefined),
        agentDir,
        preferApiKey: () => preferApiKey,
        sweepMarkerPath,
        ownAuthFileChange: (_providers, op) => op(),
      });
      expect(result.wired.includes(provider)).toBe(preferApiKey);
      const flat = flatFeeKeyProviders(runtime);
      for (const model of providerModels) {
        expect(piModelDollarBilled({ provider, id: model.value }, billing({ supportedModels: DEFAULT_MODELS, flatFeeKeyProviders: flat }))).toBe(metered);
        expect(dollarBilled(deps({ modelValue: model.value, modelInfo: model, flatFeeKeyProviders: flat }))).toBe(metered);
      }
    }
  });
});
