import { describe, it, expect } from 'vitest';
import type { Model, Api } from '@earendil-works/pi-ai';
import { piSupportedModels, type ModelLookup } from '../pi-models';
import type { OpenAIAuthStatus } from '../openai-auth';
import { buildAccountInfo } from '../account-billing';
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
 * key + model; an unset slot runs the active model or blocks when it cannot run; and effort coerces to a thinkingLevel
 * against the resolved model's supported levels (unsupported → none).
 */

const ANTHROPIC_ACTIVE = 'claude-opus-5-5';
const OPENAI_ACTIVE = 'gpt-6-luna';

function fakeModel(provider: string, id: string): Model<Api> {
  return { provider, id, name: id } as unknown as Model<Api>;
}

/** A registry where only the listed canonical providers resolve, and Anthropic auth is toggleable. */
function mockRegistry(opts: {
  anthropicAuthed: boolean;
  openaiResolves: boolean;
  deepseekResolves?: boolean;
  stepfunResolves?: boolean;
  minimaxResolves?: boolean;
  xaiResolves?: boolean;
}): ModelLookup {
  return {
    getModel: (provider, modelId) => {
      if (provider === 'anthropic') return fakeModel(provider, modelId);
      if ((provider === 'openai' || provider === 'openai-codex') && opts.openaiResolves) {
        return fakeModel(provider, modelId);
      }
      if (provider === 'deepseek' && opts.deepseekResolves) return fakeModel(provider, modelId);
      if (provider === 'stepfun' && opts.stepfunResolves) return fakeModel(provider, modelId);
      if (provider === 'minimax' && opts.minimaxResolves) return fakeModel(provider, modelId);
      if (provider === 'xai' && opts.xaiResolves) return fakeModel(provider, modelId);
      return undefined;
    },
    hasConfiguredAuth: (providerId) =>
      (providerId === 'anthropic' && opts.anthropicAuthed) || ['deepseek', 'stepfun', 'minimax', 'xai'].includes(providerId),
    planModelIds: () => undefined,
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
    claudeAuthMode: 'allowance',
    supportedModels: piSupportedModels(),
    flatFeeKeyProviders: new Set(),
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
      roleSettings: roles({ reviewer: { model: 'gpt-6.1-sol', effort: null } }),
    });
    const res = resolveRoleModel('reviewer', d);
    expect(res.error).toBeUndefined();
    expect(res.model?.id).toBe('gpt-6.1-sol');
    expect(res.model?.provider).toBe('openai-codex');
    expect(res.modelLabel).toBe('GPT-6.1 Sol');
  });

  it('(b) blocks with an error naming the setting key + model when configured but its provider is unauthed', () => {
    const d = deps({
      // openai does not resolve at all → gpt-6.1-sol is unavailable.
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
      roleSettings: roles({ reviewer: { model: 'gpt-6.1-sol', effort: null } }),
    });
    const res = resolveRoleModel('reviewer', d);
    expect(res.model).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error).toContain('damocles.team.reviewerModel');
    expect(res.error).toContain('gpt-6.1-sol');
    expect(res.error).toContain('reviewer');
  });

  it('(b2) blocks a configured-but-unauthed Anthropic model (resolves but no auth)', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
      roleSettings: roles({ lead: { model: 'claude-sonnet-5-5', effort: null } }),
    });
    const res = resolveRoleModel('lead', d);
    expect(res.error).toContain('damocles.team.leadModel');
    expect(res.error).toContain('claude-sonnet-5-5');
  });
});

describe('resolveRoleModel — unset slots (the active model)', () => {
  it('(c) unset → active model when authed', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
    });
    const res = resolveRoleModel('implementor', d);
    expect(res.error).toBeUndefined();
    expect(res.model?.id).toBe(ANTHROPIC_ACTIVE);
    expect(res.modelLabel).toBe('Opus 5.5');
  });

  // A member spawned with no model runs on whatever pi picks itself, so the role is refused instead.
  it('(c) unset → blocks the role, naming the chat\'s model, when the active model is unauthed', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
    });
    const res = resolveRoleModel('lead', d);
    expect(res.model).toBeUndefined();
    expect(res.error).toBe('Team role "lead" cannot run: this chat\'s model, Opus 5.5, is not signed in. Pick another model for the chat, or set damocles.team.leadModel.');
    // The agent card shows the curated display name, not the raw value ("claude-opus-5-5").
    expect(res.modelLabel).toBe('Opus 5.5');
    expect(res.thinkingLevel).toBeUndefined();
  });

  it('(c) unset → blocks the role when the chat has no model pi serves', () => {
    const d = deps({ activeModel: 'step-5-preview' });
    expect(resolveRoleModel('reviewer', d).error).toBe('Team role "reviewer" cannot run: this chat has no model it can run. Pick another model for the chat, or set damocles.team.reviewerModel.');
  });
});

describe('resolveRoleModel — plan gating', () => {
  const copilot = (plan: readonly string[]): ModelLookup => ({
    getModel: (provider, modelId) => (provider === 'github-copilot' || provider === 'anthropic' ? fakeModel(provider, modelId) : undefined),
    hasConfiguredAuth: (provider) => provider === 'github-copilot',
    planModelIds: (provider) => (provider === 'github-copilot' ? new Set(plan) : undefined),
  });

  it('blocks a configured model the plan does not include, by the provider\'s name and the model\'s label', () => {
    const d = deps({ registry: copilot(['gpt-6-luna']), roleSettings: roles({ implementor: { model: 'github-copilot/claude-opus-5.5', effort: null } }) });
    const res = resolveRoleModel('implementor', d);
    expect(res.model).toBeUndefined();
    expect(res.error).toBe('Team role "implementor" cannot run: your GitHub Copilot plan does not include Opus 5.5 (GitHub Copilot), the model damocles.team.implementorModel names. Change the setting to another model.');
  });

  // The plan can shrink after the chat adopted its model; an unset role then refuses rather than spawning without one.
  it('blocks an unset role whose chat model the plan no longer includes', () => {
    const d = deps({ registry: copilot(['gpt-6-luna']), activeModel: 'github-copilot/gpt-6.1-sol' });
    const res = resolveRoleModel('lead', d);
    expect(res.model).toBeUndefined();
    expect(res.error).toBe('Team role "lead" cannot run: your GitHub Copilot plan does not include GPT-6.1 Sol (GitHub Copilot), this chat\'s model. Pick another model for the chat, or set damocles.team.leadModel.');
  });

  it('runs a configured model the plan includes', () => {
    const d = deps({ registry: copilot(['gpt-6-luna']), roleSettings: roles({ implementor: { model: 'github-copilot/gpt-6-luna', effort: null } }) });
    expect(resolveRoleModel('implementor', d)).toMatchObject({ model: { provider: 'github-copilot', id: 'gpt-6-luna' } });
  });
});

describe('resolveRoleModel — effort → thinkingLevel coercion', () => {
  it('(d) configured Claude model + ultracode effort → thinkingLevel max', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
      roleSettings: roles({ reviewer: { model: 'claude-sonnet-5-5', effort: 'ultracode' } }),
    });
    const res = resolveRoleModel('reviewer', d);
    expect(res.model?.id).toBe('claude-sonnet-5-5');
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

  it('(d3) an unset effort takes the resolved model catalog default', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
      roleSettings: roles({ implementor: { model: ANTHROPIC_ACTIVE, effort: null } }),
    });
    // Opus 5.5 carries `defaultEffort: 'high'`; DeepSeek V4 Pro carries none, so its slot stays unset.
    expect(resolveRoleModel('implementor', d).thinkingLevel).toBe('high');

    const deepseek = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false, deepseekResolves: true }),
      activeModel: ANTHROPIC_ACTIVE,
      roleSettings: roles({ implementor: { model: 'deepseek-v4-pro', effort: null } }),
    });
    expect(resolveRoleModel('implementor', deepseek).thinkingLevel).toBeUndefined();
  });

  // Matches the panel: an unsupported stored level falls back to the catalog default, not to pi's own.
  it('(d4) an unsupported stored effort takes the resolved model catalog default', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false }),
      activeModel: ANTHROPIC_ACTIVE,
      roleSettings: roles({ implementor: { model: ANTHROPIC_ACTIVE, effort: 'none' } }),
    });
    expect(resolveRoleModel('implementor', d).thinkingLevel).toBe('high');
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
      // gpt-6.1-sol supportedEffortLevels lacks 'none'.
      roleSettings: roles({ implementor: { model: 'gpt-6.1-sol', effort: 'none' } }),
    });
    const res = resolveRoleModel('implementor', d);
    expect(res.model?.id).toBe('gpt-6.1-sol');
    expect(res.thinkingLevel).toBeUndefined();
  });

  // GPT-6 Luna lists `none`, which a chat may run at and a role never does; a hand-edited `none` reaches here unfiltered.
  it('(e3) a role never runs at None, even on a model that lists it', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: true }),
      openai: { apiKey: false, codex: true } as OpenAIAuthStatus,
      activeModel: OPENAI_ACTIVE,
      roleSettings: roles({ implementor: { model: 'gpt-6-luna', effort: 'none' }, reviewer: { model: '', effort: 'none' } }),
    });
    expect(resolveRoleModel('implementor', d)).toMatchObject({ model: { id: 'gpt-6-luna' } });
    expect(resolveRoleModel('implementor', d).thinkingLevel).toBeUndefined();
    expect(resolveRoleModel('reviewer', d).thinkingLevel).toBeUndefined();
  });

  it('(f) unset effort (null) → no thinkingLevel on a configured model with no catalog default', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false, deepseekResolves: true }),
      activeModel: ANTHROPIC_ACTIVE,
      roleSettings: roles({ reviewer: { model: 'deepseek-v4-pro', effort: null } }),
    });
    const res = resolveRoleModel('reviewer', d);
    expect(res.model?.id).toBe('deepseek-v4-pro');
    expect(res.thinkingLevel).toBeUndefined();
  });

  it('(f2) supported effort maps directly (high → high on deepseek)', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: false, deepseekResolves: true }),
      activeModel: 'deepseek-flash',
      roleSettings: roles({ implementor: { model: 'deepseek-v4-pro', effort: 'high' } }),
    });
    const res = resolveRoleModel('implementor', d);
    expect(res.model?.id).toBe('deepseek-v4-pro');
    expect(res.thinkingLevel).toBe('high');
  });

  // Slice 2: step-5-preview advertises supportedEffortLevels ['low','medium','high']. Supported levels
  // pass through to the matching thinkingLevel; levels above the cap (xhigh/max/ultracode) coerce away.
  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
  ] as const)('(g) StepFun slot + %s effort → thinkingLevel %s', (effort, thinkingLevel) => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: false, stepfunResolves: true }),
      activeModel: 'step-5-preview',
      roleSettings: roles({ implementor: { model: 'step-5-preview', effort } }),
    });
    const res = resolveRoleModel('implementor', d);
    expect(res.model?.id).toBe('step-5-preview');
    expect(res.thinkingLevel).toBe(thinkingLevel);
  });

  it.each(['xhigh', 'max', 'ultracode'] as const)(
    '(h) StepFun slot + %s effort (above the low|medium|high cap) → no thinkingLevel',
    (effort) => {
      const d = deps({
        registry: mockRegistry({ anthropicAuthed: false, openaiResolves: false, stepfunResolves: true }),
        activeModel: 'step-5-preview',
        roleSettings: roles({ implementor: { model: 'step-5-preview', effort } }),
      });
      const res = resolveRoleModel('implementor', d);
      expect(res.model?.id).toBe('step-5-preview');
      expect(res.thinkingLevel).toBeUndefined();
    },
  );
});

/**
 * A role can be pointed at a model the panel does not run, so billing follows the role's own model. The
 * rule is account-billing's, reused, so these cases pin the wiring rather than the rule.
 */
describe('resolveRoleModel dollar billing', () => {
  it('(i) unset slot on a Claude subscription is not dollar billed', () => {
    const res = resolveRoleModel('lead', deps({ claudeAuthMode: 'allowance' }));
    expect(res.dollarBilled).toBe(false);
  });

  it('(i2) unset slot on a Claude API key is dollar billed', () => {
    const res = resolveRoleModel('lead', deps({ claudeAuthMode: 'apikey' }));
    expect(res.dollarBilled).toBe(true);
  });

  it('(i3) a metered role model inside a subscription panel is dollar billed', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false, deepseekResolves: true }),
      claudeAuthMode: 'allowance',
      roleSettings: roles({ implementor: { model: 'deepseek-v4-pro', effort: null } }),
    });
    const res = resolveRoleModel('implementor', d);
    expect(res.model?.id).toBe('deepseek-v4-pro');
    expect(res.dollarBilled).toBe(true);
    // The panel is on a flat subscription, so a panel-derived label would call this real charge an estimate.
    expect(resolveRoleModel('lead', d).dollarBilled).toBe(false);
  });

  it('(i4) a flat-fee role model inside an API-key panel is not dollar billed', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false, stepfunResolves: true }),
      claudeAuthMode: 'apikey',
      roleSettings: roles({ reviewer: { model: 'step-5-preview', effort: null } }),
    });
    const res = resolveRoleModel('reviewer', d);
    expect(res.model?.id).toBe('step-5-preview');
    expect(res.dollarBilled).toBe(false);
  });

  it('(i6) a GPT model outside the Codex catalog bills the API key it resolves to, as the account state does', () => {
    const registry: ModelLookup = {
      getModel: (provider, modelId) => (provider === 'anthropic' || provider === 'openai' ? fakeModel(provider, modelId) : undefined),
      hasConfiguredAuth: (providerId) => providerId === 'anthropic',
      planModelIds: () => undefined,
    };
    const openai = { apiKey: true, chatgpt: false, codex: true } as OpenAIAuthStatus;
    const d = deps({ registry, openai, preferApiKey: false, roleSettings: roles({ implementor: { model: OPENAI_ACTIVE, effort: null } }) });
    const res = resolveRoleModel('implementor', d);
    expect(res.model?.provider).toBe('openai');
    expect(res.dollarBilled).toBe(true);
    const account = buildAccountInfo({
      modelValue: OPENAI_ACTIVE,
      modelInfo: d.supportedModels.find((m) => m.value === OPENAI_ACTIVE),
      claudeAuthMode: d.claudeAuthMode,
      openaiAuthStatus: openai,
      preferApiKey: false,
      resolvedProvider: res.model?.provider,
      flatFeeKeyProviders: d.flatFeeKeyProviders,
    });
    expect(account.dollarBilled).toBe(res.dollarBilled);
  });

  it('(i7) a MiniMax role bills flat only while its applied key is a Token Plan key, and xAI is metered', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: true, openaiResolves: false, minimaxResolves: true, xaiResolves: true }),
      claudeAuthMode: 'apikey',
      roleSettings: roles({ reviewer: { model: 'MiniMax-M3.1-Flash', effort: null }, implementor: { model: 'grok-4.7', effort: null } }),
    });
    const flat = resolveRoleModel('reviewer', { ...d, flatFeeKeyProviders: new Set(['minimax']) });
    expect(flat.model).toMatchObject({ provider: 'minimax', id: 'MiniMax-M3.1-Flash' });
    expect(flat.dollarBilled).toBe(false);
    expect(resolveRoleModel('reviewer', d).dollarBilled).toBe(true);
    expect(resolveRoleModel('implementor', d)).toMatchObject({ model: { provider: 'xai', id: 'grok-4.7' }, dollarBilled: true });
  });

  it('(i5) the blocking error return still carries billing', () => {
    const d = deps({
      registry: mockRegistry({ anthropicAuthed: false, openaiResolves: false }),
      claudeAuthMode: 'apikey',
      roleSettings: roles({ lead: { model: 'claude-sonnet-5-5', effort: null } }),
    });
    const res = resolveRoleModel('lead', d);
    expect(res.error).toBeDefined();
    expect(res.dollarBilled).toBe(true);
  });
});
