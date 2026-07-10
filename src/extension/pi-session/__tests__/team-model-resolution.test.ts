import { describe, it, expect } from 'vitest';
import type { Model, Api } from '@earendil-works/pi-ai';
import { piSupportedModels, type ModelLookup } from '../pi-models';
import type { OpenAIAuthStatus } from '../openai-auth';
import {
  resolveRoleModel,
  type TeamModelDeps,
  type TeamRole,
  type TeamRoleSetting,
} from '../team-model-resolution';

/**
 * Settings-driven team role model/effort resolution (Slice 1). A mock `ModelLookup` returns a fake
 * `Model` per canonical provider so we can assert: a configured slot resolves the exact model (cross
 * provider) when authed; a configured-but-unauthed/unknown slot blocks with an error naming the setting
 * key + model; an unset slot fails soft to the active model; and effort coerces to a thinkingLevel
 * against the resolved model's supported levels (unsupported → none).
 */

const ANTHROPIC_ACTIVE = 'claude-opus-4-8';
const OPENAI_ACTIVE = 'gpt-5.6-terra';

function fakeModel(provider: string, id: string): Model<Api> {
  return { provider, id, name: id } as unknown as Model<Api>;
}

/** A registry where only the listed canonical providers resolve, and Anthropic auth is toggleable. */
function mockRegistry(opts: { anthropicAuthed: boolean; openaiResolves: boolean; deepseekResolves?: boolean }): ModelLookup {
  return {
    find: (provider, modelId) => {
      if (provider === 'anthropic') return fakeModel(provider, modelId);
      if ((provider === 'openai' || provider === 'openai-codex') && opts.openaiResolves) {
        return fakeModel(provider, modelId);
      }
      if (provider === 'deepseek' && opts.deepseekResolves) return fakeModel(provider, modelId);
      return undefined;
    },
    hasConfiguredAuth: (model) =>
      (model.provider === 'anthropic' && opts.anthropicAuthed) || model.provider === 'deepseek',
  };
}

/** Build a `roleSettings` record with all slots unset, overriding specific roles. */
function roles(overrides: Partial<Record<TeamRole, TeamRoleSetting>>): Record<TeamRole, TeamRoleSetting> {
  const unset: TeamRoleSetting = { model: '', effort: null };
  return {
    lead: unset,
    implementor: unset,
    reviewer: unset,
    ...overrides,
  };
}

function deps(overrides: Partial<TeamModelDeps>): TeamModelDeps {
  return {
    registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
    openai: { apiKey: false, codex: false } as OpenAIAuthStatus,
    preferApiKey: false,
    activeModel: ANTHROPIC_ACTIVE,
    supportedModels: piSupportedModels(),
    roleSettings: roles({}),
    ...overrides,
  };
}

describe('resolveRoleModel — configured slots', () => {
  it('(a) resolves a configured cross-provider model under openai when authed', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: true }),
      openai: { apiKey: false, codex: true } as OpenAIAuthStatus,
      activeModel: OPENAI_ACTIVE,
      roleSettings: roles({ reviewer: { model: 'gpt-5.6-sol', effort: null } }),
    });
    const res = resolveRoleModel('reviewer', d);
    expect(res.error).toBeUndefined();
    expect(res.model?.id).toBe('gpt-5.6-sol');
    expect(res.model?.provider).toBe('openai-codex');
    expect(res.modelLabel).toBe('GPT-5.6 Sol');
  });

  it('(b) blocks with an error naming the setting key + model when configured but its provider is unauthed', () => {
    const d = deps({
      // openai does not resolve at all → gpt-5.6-sol is unavailable.
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
      roleSettings: roles({ reviewer: { model: 'gpt-5.6-sol', effort: null } }),
    });
    const res = resolveRoleModel('reviewer', d);
    expect(res.model).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error).toContain('damocles.team.reviewerModel');
    expect(res.error).toContain('gpt-5.6-sol');
    expect(res.error).toContain('reviewer');
  });

  it('(b2) blocks a configured-but-unauthed Anthropic model (resolves but no auth)', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
      roleSettings: roles({ lead: { model: 'claude-sonnet-5', effort: null } }),
    });
    const res = resolveRoleModel('lead', d);
    expect(res.error).toContain('damocles.team.leadModel');
    expect(res.error).toContain('claude-sonnet-5');
  });
});

describe('resolveRoleModel — unset slots (active model fail-soft)', () => {
  it('(c) unset → active model when authed', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
    });
    const res = resolveRoleModel('implementor', d);
    expect(res.error).toBeUndefined();
    expect(res.model?.id).toBe(ANTHROPIC_ACTIVE);
    expect(res.modelLabel).toBe('Opus 4.8');
  });

  it('(c) unset → no model but label = active model display name when the active model is unauthed', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
    });
    const res = resolveRoleModel('lead', d);
    expect(res.error).toBeUndefined();
    expect(res.model).toBeUndefined();
    // The agent card shows the curated display name ("Opus 4.8"), not the raw value ("claude-opus-4-8").
    expect(res.modelLabel).toBe('Opus 4.8');
    expect(res.thinkingLevel).toBeUndefined();
  });
});

describe('resolveRoleModel — effort → thinkingLevel coercion', () => {
  it('(d) configured Claude model + ultracode effort → thinkingLevel max', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
      roleSettings: roles({ reviewer: { model: 'claude-sonnet-5', effort: 'ultracode' } }),
    });
    const res = resolveRoleModel('reviewer', d);
    expect(res.model?.id).toBe('claude-sonnet-5');
    expect(res.thinkingLevel).toBe('max');
  });

  it('(d2) unset slot + effort applies against the active model', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE, // Opus supports xhigh
      roleSettings: roles({ implementor: { model: '', effort: 'xhigh' } }),
    });
    const res = resolveRoleModel('implementor', d);
    expect(res.model?.id).toBe(ANTHROPIC_ACTIVE);
    expect(res.thinkingLevel).toBe('xhigh');
  });

  it('(e) unsupported effort coerces to null (no thinkingLevel) — xhigh on deepseek', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: false, deepseekResolves: true }),
      activeModel: 'deepseek-v4-pro',
      // deepseek-v4-pro supportedEffortLevels = ['high','max']; xhigh is unsupported.
      roleSettings: roles({ reviewer: { model: 'deepseek-v4-pro', effort: 'xhigh' } }),
    });
    const res = resolveRoleModel('reviewer', d);
    expect(res.model?.id).toBe('deepseek-v4-pro');
    expect(res.thinkingLevel).toBeUndefined();
  });

  it('(e2) unsupported effort on a GPT model (none not in supported levels) → no thinkingLevel', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: true }),
      openai: { apiKey: false, codex: true } as OpenAIAuthStatus,
      activeModel: OPENAI_ACTIVE,
      // gpt-5.6-sol supportedEffortLevels lacks 'none'.
      roleSettings: roles({ implementor: { model: 'gpt-5.6-sol', effort: 'none' } }),
    });
    const res = resolveRoleModel('implementor', d);
    expect(res.model?.id).toBe('gpt-5.6-sol');
    expect(res.thinkingLevel).toBeUndefined();
  });

  it('(f) unset effort (null) → no thinkingLevel even on a configured model', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
      roleSettings: roles({ reviewer: { model: 'claude-sonnet-5', effort: null } }),
    });
    const res = resolveRoleModel('reviewer', d);
    expect(res.model?.id).toBe('claude-sonnet-5');
    expect(res.thinkingLevel).toBeUndefined();
  });

  it('(f2) supported effort maps directly (high → high on deepseek)', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: false, deepseekResolves: true }),
      activeModel: 'deepseek-v4-flash',
      roleSettings: roles({ implementor: { model: 'deepseek-v4-pro', effort: 'high' } }),
    });
    const res = resolveRoleModel('implementor', d);
    expect(res.model?.id).toBe('deepseek-v4-pro');
    expect(res.thinkingLevel).toBe('high');
  });
});
