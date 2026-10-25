import { describe, it, expect } from 'vitest';
import type { Model, Api } from '@earendil-works/pi-ai';
import { resolveCheapModelFor } from '../subagents/cheap-model';
import { cheapModelValueForProvider } from '../custom-providers';
import { PI_SMALL_FAST_ANTHROPIC, PI_SMALL_FAST_OPENAI, type ModelLookup } from '../pi-models';

const ANTHROPIC_OK = { codex: false, chatgpt: false, apiKey: false } as const;
const OPENAI_OK = { codex: true, chatgpt: false, apiKey: false } as const;

const CUSTOM = new Set(['stepfun', 'deepseek', 'minimax', 'xai', 'kimi-coding', 'meta', 'openrouter', 'google']);

/** A registry that resolves first-party models only — custom providers are NOT registered (return undefined),
 *  mirroring a session with no explore keys set. */
function makeRegistry(): ModelLookup {
  return {
    getModel: (provider: string, modelId: string) =>
      CUSTOM.has(provider) ? undefined : ({ provider, id: modelId, name: modelId, contextWindow: 200_000 } as unknown as Model<Api>),
    hasConfiguredAuth: () => true,
    planModelIds: () => undefined,
  };
}

describe('resolveCheapModelFor (§4.9)', () => {
  it('an Anthropic main model resolves to the Anthropic cheap model (Haiku)', () => {
    const res = resolveCheapModelFor('claude-opus-4-8', makeRegistry(), ANTHROPIC_OK, false);
    expect(res.value).toBe(PI_SMALL_FAST_ANTHROPIC);
    expect(res.model?.id).toBe(PI_SMALL_FAST_ANTHROPIC);
  });

  it('an OpenAI main model resolves to the OpenAI cheap model (gpt-6-luna)', () => {
    const res = resolveCheapModelFor('gpt-6.1-sol', makeRegistry(), OPENAI_OK, false);
    expect(res.value).toBe(PI_SMALL_FAST_OPENAI);
  });

  // A Copilot GPT value is no OpenAI value, and its spend stays on the Copilot plan, never on Anthropic's or OpenAI's account.
  it("a GitHub Copilot main model, GPT included, resolves to Copilot's Haiku 5.5 only while the plan includes it", () => {
    const copilot = (plan: readonly string[]): ModelLookup => ({ ...makeRegistry(), planModelIds: (provider) => (provider === 'github-copilot' ? new Set(plan) : undefined) });
    for (const main of ['github-copilot/gpt-6.1-sol', 'github-copilot/claude-opus-5.5']) {
      expect(resolveCheapModelFor(main, copilot(['claude-haiku-5.5']), OPENAI_OK, false)).toMatchObject({ value: 'github-copilot/claude-haiku-5.5', model: { provider: 'github-copilot', id: 'claude-haiku-5.5' } });
      expect(resolveCheapModelFor(main, copilot(['gpt-6.1-sol']), OPENAI_OK, false)).toEqual({ value: 'github-copilot/claude-haiku-5.5' });
    }
  });
});

describe('cheapModelValueForProvider', () => {
  it('returns undefined for a curated (non-custom-provider) main model', () => {
    const reg: ModelLookup = { getModel: () => undefined, hasConfiguredAuth: () => false, planModelIds: () => undefined };
    expect(cheapModelValueForProvider('claude-opus-4-8', reg)).toBeUndefined();
  });

  it('returns the provider cheap-model id when the main value is that provider cheap model', () => {
    const reg: ModelLookup = { getModel: () => undefined, hasConfiguredAuth: () => false, planModelIds: () => undefined };
    expect(cheapModelValueForProvider('step-5-preview', reg)).toBe('step-5-preview');
  });

  it('maps both DeepSeek main models to the DeepSeek cheap model (deepseek-flash)', () => {
    const reg: ModelLookup = {
      getModel: (provider, id) =>
        provider === 'deepseek' ? ({ provider, id, name: id, contextWindow: 1_000_000 } as unknown as Model<Api>) : undefined,
      hasConfiguredAuth: () => true,
      planModelIds: () => undefined,
    };
    expect(cheapModelValueForProvider('deepseek-v4-pro', reg)).toBe('deepseek-flash');
    expect(cheapModelValueForProvider('deepseek-flash', reg)).toBe('deepseek-flash');
  });

  it.each([
    ['minimax', 'MiniMax-M3.1-Flash'],
    ['xai', 'grok-4.7'],
    ['kimi-coding', 'kimi-for-coding'],
    ['meta', 'muse-spark-1.3'],
  ])('maps a %s main model to its own cheap model', (provider, cheap) => {
    const reg: ModelLookup = {
      getModel: (p, id) => (p === provider && id === cheap ? ({ provider: p, id, name: id, contextWindow: 500_000 } as unknown as Model<Api>) : undefined),
      hasConfiguredAuth: () => true,
      planModelIds: () => undefined,
    };
    expect(cheapModelValueForProvider(cheap, reg)).toBe(cheap);
    expect(resolveCheapModelFor(cheap, reg, ANTHROPIC_OK, false)).toMatchObject({ value: cheap, model: { provider, id: cheap } });
  });
});
