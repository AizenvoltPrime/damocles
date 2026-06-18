import { describe, it, expect } from 'vitest';
import type { Model, Api } from '@earendil-works/pi-ai';
import { resolveCheapModelFor } from '../subagents/cheap-model';
import { cheapModelValueForProvider } from '../custom-providers';
import { PI_SMALL_FAST_ANTHROPIC, PI_SMALL_FAST_OPENAI, type ModelLookup } from '../pi-models';

const ANTHROPIC_OK = { codex: false, apiKey: false } as const;
const OPENAI_OK = { codex: true, apiKey: false } as const;

const CUSTOM = new Set(['stepfun', 'openrouter', 'google']);

/** A registry that resolves first-party models only — custom providers are NOT registered (return undefined),
 *  mirroring a session with no explore keys set. */
function makeRegistry(): ModelLookup {
  return {
    find: (provider: string, modelId: string) =>
      CUSTOM.has(provider) ? undefined : ({ provider, id: modelId, name: modelId, contextWindow: 200_000 } as unknown as Model<Api>),
    hasConfiguredAuth: () => true,
  };
}

describe('resolveCheapModelFor (§4.9)', () => {
  it('an Anthropic main model resolves to the Anthropic cheap model (Haiku)', () => {
    const res = resolveCheapModelFor('claude-opus-4-8', makeRegistry(), ANTHROPIC_OK, false);
    expect(res.value).toBe(PI_SMALL_FAST_ANTHROPIC);
    expect(res.model?.id).toBe(PI_SMALL_FAST_ANTHROPIC);
  });

  it('an OpenAI main model resolves to the OpenAI cheap model (gpt-5.4-mini)', () => {
    const res = resolveCheapModelFor('gpt-5.4', makeRegistry(), OPENAI_OK, false);
    expect(res.value).toBe(PI_SMALL_FAST_OPENAI);
  });
});

describe('cheapModelValueForProvider', () => {
  it('returns undefined for a curated (non-custom-provider) main model', () => {
    const reg: ModelLookup = { find: () => undefined, hasConfiguredAuth: () => false };
    expect(cheapModelValueForProvider('claude-opus-4-8', reg)).toBeUndefined();
  });

  it('returns the provider cheap-model id when the main value is that provider cheap model', () => {
    const reg: ModelLookup = { find: () => undefined, hasConfiguredAuth: () => false };
    expect(cheapModelValueForProvider('step-3.7-flash', reg)).toBe('step-3.7-flash');
  });
});
