import { describe, it, expect } from 'vitest';
import type { Model, Api } from '@earendil-works/pi-ai';
import { piSupportedModels, type ModelLookup } from '../pi-models';
import type { OpenAIAuthStatus } from '../openai-auth';
import {
  resolveLeadModel,
  resolveSpecialistModel,
  allowedSpecialistModels,
  type TeamModelDeps,
} from '../team-model-resolution';

/**
 * Multi-provider team model resolution (US-024c). A mock `ModelLookup` returns a fake `Model` per
 * canonical provider so we can assert: a Claude panel → lead = flagship Claude + specialists = active;
 * a Codex (GPT) panel → lead = flagship GPT + specialists = active; an explicit authed per-agent model
 * is honored; an unauthed explicit model fails soft to the active model.
 */

const ANTHROPIC_FLAGSHIP = 'claude-fable-5';
const ANTHROPIC_ACTIVE = 'claude-opus-4-8';
const OPENAI_FLAGSHIP = 'gpt-5.5';
const OPENAI_ACTIVE = 'gpt-5.4';

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

describe('team model resolution — lead is flagship-per-provider, specialists default to active', () => {
  it('Claude panel: lead = flagship Claude, specialists = active', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
    });
    const lead = resolveLeadModel(d);
    expect(lead.model?.id).toBe(ANTHROPIC_FLAGSHIP);

    const spec = resolveSpecialistModel(undefined, d);
    expect(spec.model?.id).toBe(ANTHROPIC_ACTIVE);
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

  it('honors an explicit specialist model when its provider is authed', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
    });
    const spec = resolveSpecialistModel('claude-haiku-4-5-20251001', d);
    expect(spec.model?.id).toBe('claude-haiku-4-5-20251001');
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

  it('allowedSpecialistModels lists the active backend catalog (flagship-first)', () => {
    const claude = allowedSpecialistModels(deps({ activeModel: ANTHROPIC_ACTIVE }));
    expect(claude[0]).toBe(ANTHROPIC_FLAGSHIP);
    expect(claude).toContain(ANTHROPIC_ACTIVE);
    expect(claude.every((v) => !v.startsWith('gpt'))).toBe(true);

    const gpt = allowedSpecialistModels(deps({ activeModel: OPENAI_ACTIVE }));
    expect(gpt[0]).toBe(OPENAI_FLAGSHIP);
    expect(gpt.every((v) => v.startsWith('gpt'))).toBe(true);
  });
});
