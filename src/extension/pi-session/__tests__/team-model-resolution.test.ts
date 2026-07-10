import { describe, it, expect } from 'vitest';
import type { Model, Api } from '@earendil-works/pi-ai';
import { piSupportedModels, type ModelLookup } from '../pi-models';
import type { OpenAIAuthStatus } from '../openai-auth';
import {
  resolveLeadModel,
  resolveSpecialistModel,
  allowedSpecialistModels,
  isSpecialistModelForced,
  type TeamModelDeps,
} from '../team-model-resolution';

/**
 * Multi-provider team model resolution (US-024c). A mock `ModelLookup` returns a fake `Model` per
 * canonical provider so we can assert: a Claude panel → lead = flagship Claude + specialists = active;
 * a Codex (GPT) panel → lead = flagship GPT + specialists = active; an explicit authed per-agent model
 * is honored; an unauthed explicit model fails soft to the active model.
 */

const ANTHROPIC_FLAGSHIP = 'claude-fable-5';
const ANTHROPIC_PREFERRED_LEAD = 'claude-opus-4-8';
const ANTHROPIC_ACTIVE = 'claude-opus-4-8';
const OPENAI_FLAGSHIP = 'gpt-5.6-sol';
const OPENAI_ACTIVE = 'gpt-5.6-terra';

function fakeModel(provider: string, id: string): Model<Api> {
  return { provider, id, name: id } as unknown as Model<Api>;
}

/** A registry where only the listed canonical providers resolve, and Anthropic auth is toggleable. */
function mockRegistry(opts: { anthropicAuthed: boolean; openaiResolves: boolean }): ModelLookup {
  return {
    find: (provider, modelId) => {
      if (provider === 'anthropic') return fakeModel(provider, modelId);
      if ((provider === 'openai' || provider === 'openai-codex') && opts.openaiResolves) {
        return fakeModel(provider, modelId);
      }
      return undefined;
    },
    hasConfiguredAuth: (model) => model.provider === 'anthropic' && opts.anthropicAuthed,
  };
}

function deps(overrides: Partial<TeamModelDeps>): TeamModelDeps {
  return {
    registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
    openai: { apiKey: false, codex: false } as OpenAIAuthStatus,
    preferApiKey: false,
    activeModel: ANTHROPIC_ACTIVE,
    supportedModels: piSupportedModels(),
    ...overrides,
  };
}

describe('team model resolution — lead is preferred/flagship-per-provider, specialists default to active', () => {
  it('Claude panel: lead = preferred Claude (Opus 4.8) at xhigh, specialists = forced Opus at high', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
    });
    const lead = resolveLeadModel(d);
    expect(lead.model?.id).toBe(ANTHROPIC_PREFERRED_LEAD);
    expect(lead.model?.id).not.toBe(ANTHROPIC_FLAGSHIP);
    expect(lead.thinkingLevel).toBe('xhigh');

    // On Anthropic, the default-kind specialist is forced to Opus (here = the active model) at `high`.
    const spec = resolveSpecialistModel(undefined, d);
    expect(spec.model?.id).toBe('claude-opus-4-8');
    expect(spec.thinkingLevel).toBe('high');
  });

  it('GPT (codex) panel: lead = flagship GPT, specialists = active', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: true }),
      openai: { apiKey: false, codex: true } as OpenAIAuthStatus,
      activeModel: OPENAI_ACTIVE,
    });
    const lead = resolveLeadModel(d);
    expect(lead.model?.id).toBe(OPENAI_FLAGSHIP);
    expect(lead.model?.provider).toBe('openai-codex');

    const spec = resolveSpecialistModel(undefined, d);
    expect(spec.model?.id).toBe(OPENAI_ACTIVE);
  });

  it('Anthropic: ignores an explicit specialist model (forced to Opus 4.8)', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
    });
    // Explicit Haiku is ignored on Anthropic — the specialist is pinned to Opus 4.8.
    const spec = resolveSpecialistModel('claude-haiku-4-5-20251001', d);
    expect(spec.model?.id).toBe('claude-opus-4-8');
  });

  it('non-Anthropic (GPT): honors an explicit specialist model when its provider is authed', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: true }),
      openai: { apiKey: false, codex: true } as OpenAIAuthStatus,
      activeModel: OPENAI_ACTIVE,
    });
    const spec = resolveSpecialistModel(OPENAI_FLAGSHIP, d);
    expect(spec.model?.id).toBe(OPENAI_FLAGSHIP);
    expect(spec.thinkingLevel).toBeUndefined();
  });

  it('fails soft to the active model when an explicit specialist model is unauthed', () => {
    const d = deps({
      // Anthropic resolves but is NOT authed → an explicit Claude model can't be used.
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: true }),
      openai: { apiKey: false, codex: true } as OpenAIAuthStatus,
      activeModel: OPENAI_ACTIVE,
    });
    const spec = resolveSpecialistModel('claude-haiku-4-5-20251001', d);
    // Unauthed explicit → fall back to the active (authed GPT) model.
    expect(spec.model?.id).toBe(OPENAI_ACTIVE);
  });

  it('lead falls back to the active model when no flagship of the provider is authed', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
    });
    const lead = resolveLeadModel(d);
    // No authed flagship AND the active model is unauthed → no resolved `model` (the caller degrades to
    // the engine default), but the label still reflects the active model for the card.
    expect(lead.modelLabel).toBeDefined();
    expect(lead.model).toBeUndefined();
  });

  it('allowedSpecialistModels is Opus-only on Anthropic, catalog (flagship-first) elsewhere', () => {
    // Anthropic policy: the specialist whitelist collapses to Opus 4.8 only.
    const claude = allowedSpecialistModels(deps({ activeModel: ANTHROPIC_ACTIVE }));
    expect(claude).toEqual(['claude-opus-4-8']);

    const gpt = allowedSpecialistModels(deps({ activeModel: OPENAI_ACTIVE }));
    expect(gpt[0]).toBe(OPENAI_FLAGSHIP);
    expect(gpt.every((v) => v.startsWith('gpt'))).toBe(true);
  });

  it('Anthropic specialist kind:implementor → Opus at high', () => {
    const d = deps({ activeModel: ANTHROPIC_ACTIVE });
    const spec = resolveSpecialistModel(undefined, d, 'implementor');
    expect(spec.model?.id).toBe('claude-opus-4-8');
    expect(spec.thinkingLevel).toBe('high');
  });

  it('Anthropic specialist kind:reviewer → Opus at xhigh', () => {
    const d = deps({ activeModel: ANTHROPIC_ACTIVE });
    const spec = resolveSpecialistModel(undefined, d, 'reviewer');
    expect(spec.model?.id).toBe('claude-opus-4-8');
    expect(spec.thinkingLevel).toBe('xhigh');
  });

  it('Anthropic specialist with an explicit model is still forced to Opus (model arg ignored)', () => {
    const d = deps({ activeModel: ANTHROPIC_ACTIVE });
    const spec = resolveSpecialistModel('claude-sonnet-5', d, 'implementor');
    expect(spec.model?.id).toBe('claude-opus-4-8');
  });

  it('Anthropic specialist with Opus UNAUTHED fails soft to the active model but keeps the thinkingLevel', () => {
    // The one branch where model fail-soft and thinking-level retention interact: Opus is forced but
    // unauthed → no resolved `model` (caller degrades to the engine default), yet the kind's thinking
    // depth must still ride along so the degraded session reasons at the policy level.
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
    });
    const reviewer = resolveSpecialistModel(undefined, d, 'reviewer');
    expect(reviewer.model).toBeUndefined();
    expect(reviewer.modelLabel).toBe(ANTHROPIC_ACTIVE);
    expect(reviewer.thinkingLevel).toBe('xhigh');

    const implementor = resolveSpecialistModel(undefined, d, 'implementor');
    expect(implementor.model).toBeUndefined();
    expect(implementor.thinkingLevel).toBe('high');
  });

  it('non-Anthropic (GPT) specialist kind:reviewer → no thinkingLevel, model = active', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: true }),
      openai: { apiKey: false, codex: true } as OpenAIAuthStatus,
      activeModel: OPENAI_ACTIVE,
    });
    const spec = resolveSpecialistModel(undefined, d, 'reviewer');
    expect(spec.model?.id).toBe(OPENAI_ACTIVE);
    expect(spec.thinkingLevel).toBeUndefined();
  });

  it('isSpecialistModelForced is true on Anthropic, false on GPT/DeepSeek', () => {
    expect(isSpecialistModelForced(deps({ activeModel: ANTHROPIC_ACTIVE }))).toBe(true);
    expect(isSpecialistModelForced(deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: true }),
      openai: { apiKey: false, codex: true } as OpenAIAuthStatus,
      activeModel: OPENAI_ACTIVE,
    }))).toBe(false);
  });
});

describe('team model resolution — DeepSeek (piProvider) bucket (guards item E)', () => {
  /** Registry where only the `deepseek` provider resolves and is authed. */
  function deepseekRegistry(): ModelLookup {
    return {
      find: (provider, modelId) => (provider === 'deepseek' ? fakeModel(provider, modelId) : undefined),
      hasConfiguredAuth: (model) => model.provider === 'deepseek',
    };
  }

  function deepseekDeps(activeModel: string): TeamModelDeps {
    return {
      registry: deepseekRegistry(),
      openai: { apiKey: false, codex: false } as OpenAIAuthStatus,
      preferApiKey: false,
      activeModel,
      supportedModels: piSupportedModels(),
    };
  }

  it('lead = strongest authed DeepSeek model (flagship-first within the DeepSeek subset)', () => {
    const lead = resolveLeadModel(deepseekDeps('deepseek-v4-flash'));
    expect(lead.model?.provider).toBe('deepseek');
    expect(lead.model?.id).toBe('deepseek-v4-pro');
  });

  it('specialist whitelist is the DeepSeek subset only (no Claude/GPT leakage)', () => {
    const allowed = allowedSpecialistModels(deepseekDeps('deepseek-v4-pro'));
    expect(allowed).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash']);
  });

  it('DeepSeek specialists are not policy-forced (no thinkingLevel, model = active)', () => {
    expect(isSpecialistModelForced(deepseekDeps('deepseek-v4-pro'))).toBe(false);
    const spec = resolveSpecialistModel(undefined, deepseekDeps('deepseek-v4-pro'), 'reviewer');
    expect(spec.model?.id).toBe('deepseek-v4-pro');
    expect(spec.thinkingLevel).toBeUndefined();
  });
});
