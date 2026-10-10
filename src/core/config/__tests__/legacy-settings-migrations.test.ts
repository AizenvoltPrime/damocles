import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_MODELS, LEGACY_MODEL_MAP, migrateLegacyModelValue } from '../../../shared/types/constants';
import { migrateExploreSettings, migrateLegacyEffortSetting, migrateLegacyModelSetting, removeMaxThinkingTokensSetting, runLegacySettingsMigrations } from '../legacy-settings-migrations';
import type { SettingsScope, SettingsStore } from '../../../platform/settings-store';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { installLogSink } from '../../logger';

/**
 * Migration coverage for retired model ids.
 *
 * `migrateLegacyModelValue` is a pure lookup — asserted directly.
 *
 * `migrateLegacyModelSetting` reads/writes through `SettingsStore.inspect`/`update`. We drive it with a
 * layered fake store that (a) returns seeded per-scope `inspect` values, absent where unseeded, and (b) records every
 * `update(key, value, scope)` call, so each test asserts the ACTUAL rewrite the function performs.
 *
 * Scope independence: the model-value migration and the `effortByModel` re-key run independently per
 * scope — a scope with legacy effort entries but NO model value still gets its effort re-keyed (see the
 * dedicated test below). Effort-only cases here seed a non-legacy `model` value only to keep the
 * model-update assertions clean; they do not rely on it to open any gate.
 */

type Scoped<T> = { global?: T; workspace?: T; workspaceFolder?: T };
type EffortMap = Record<string, string | null>;
interface UpdateCall {
  key: string;
  value: unknown;
  target: SettingsScope;
}

const G = 'user';
const W = 'project';

interface Seed {
  model?: Scoped<string>;
  effortByModel?: Scoped<EffortMap>;
  team?: Record<string, Scoped<string>>;
}

// Seeds the fake store's user/project/local layers and records each update without the `damocles.`
// prefix, so expectations read as the setting names.
function stub(seed: Seed): { settings: SettingsStore; updates: UpdateCall[] } {
  const layer = (pick: <T>(scoped: Scoped<T>) => T | undefined): Record<string, unknown> => {
    const entries: Array<[string, Scoped<unknown> | undefined]> = [
      ['model', seed.model],
      ['effortByModel', seed.effortByModel],
      ...Object.entries(seed.team ?? {}),
    ];
    return Object.fromEntries(entries.map(([key, scoped]) => [`damocles.${key}`, scoped ? pick(scoped) : undefined]));
  };
  const { settings } = createFakePlatform({
    settings: {
      user: layer((s) => s.global),
      project: layer((s) => s.workspace),
      local: layer((s) => s.workspaceFolder),
    },
  });
  const updates: UpdateCall[] = [];
  const update = settings.update.bind(settings);
  vi.spyOn(settings, 'update').mockImplementation((key, value, target) => {
    updates.push({ key: key.replace(/^damocles\./, ''), value, target });
    return update(key, value, target);
  });
  return { settings, updates };
}

describe('migrateLegacyModelValue', () => {
  it('maps every legacy GPT id to its GPT-6 successor', () => {
    expect(migrateLegacyModelValue('gpt-5.5')).toBe('gpt-6.1-sol');
    expect(migrateLegacyModelValue('gpt-5.3-codex')).toBe('gpt-6.1-sol');
    expect(migrateLegacyModelValue('gpt-5.4')).toBe('gpt-6.1-sol');
    expect(migrateLegacyModelValue('gpt-5.4-mini')).toBe('gpt-6-luna');
    expect(migrateLegacyModelValue('gpt-5.2')).toBe('gpt-6-luna');
    expect(migrateLegacyModelValue('gpt-5.6-sol')).toBe('gpt-6.1-sol');
    expect(migrateLegacyModelValue('gpt-5.6-luna')).toBe('gpt-6-luna');
    expect(migrateLegacyModelValue('gpt-6-sol')).toBe('gpt-6.1-sol');
  });

  // The map is resolved in one lookup, so a target that is itself retired would strand the user on it.
  it('maps every retired id straight to a model the catalog offers', () => {
    const offered = new Set(DEFAULT_MODELS.map((m) => m.value));
    for (const [retired, successor] of Object.entries(LEGACY_MODEL_MAP)) {
      expect(offered.has(successor), `${retired} -> ${successor}`).toBe(true);
    }
  });

  it('maps every retired Anthropic id to its successor', () => {
    expect(migrateLegacyModelValue('claude-fable-5')).toBe('claude-fable-5-1');
    expect(migrateLegacyModelValue('claude-opus-5')).toBe('claude-opus-5-5');
    expect(migrateLegacyModelValue('claude-opus-4-8')).toBe('claude-opus-5-5');
    expect(migrateLegacyModelValue('claude-sonnet-5')).toBe('claude-sonnet-5-5');
    expect(migrateLegacyModelValue('claude-haiku-4-5-20251001')).toBe('claude-haiku-5-5');
  });

  it('maps the retired DeepSeek and StepFun ids to their successors', () => {
    expect(migrateLegacyModelValue('deepseek-v4-flash')).toBe('deepseek-flash');
    expect(migrateLegacyModelValue('step-3.7-flash')).toBe('step-5-preview');
  });

  it('covers exactly the fifteen retired ids and nothing else', () => {
    expect(Object.keys(LEGACY_MODEL_MAP).sort()).toEqual(
      ['claude-fable-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'deepseek-v4-flash', 'gpt-5.2', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-sol', 'step-3.7-flash'],
    );
  });

  it('is identity for non-legacy values (new ids, Anthropic, empty string)', () => {
    expect(migrateLegacyModelValue('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    // No GPT-6 Terra exists and Terra is deliberately left unmapped.
    expect(migrateLegacyModelValue('gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(migrateLegacyModelValue('gpt-6-luna')).toBe('gpt-6-luna');
    expect(migrateLegacyModelValue('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(migrateLegacyModelValue('')).toBe('');
  });
});

describe('migrateLegacyModelSetting — damocles.model rewrite', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('rewrites a legacy model value to its mapped id at the scope where it lives', async () => {
    const { settings, updates } = stub({ model: { global: 'gpt-5.5' } });
    await migrateLegacyModelSetting(settings);

    const modelUpdates = updates.filter((u) => u.key === 'model');
    expect(modelUpdates).toEqual([{ key: 'model', value: 'gpt-6.1-sol', target: G }]);
  });

  it('rewrites stored Sonnet 5 and GPT-6 Sol selections, and their effort entries, to Sonnet 5.5 and GPT-6.1 Sol', async () => {
    const { settings, updates } = stub({
      model: { global: 'claude-sonnet-5', workspace: 'gpt-6-sol' },
      team: { 'team.reviewerModel': { global: 'gpt-6-sol' } },
      effortByModel: { global: { 'claude-sonnet-5': 'ultracode', 'gpt-6-sol': 'max' } },
    });
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([
      { key: 'model', value: 'claude-sonnet-5-5', target: G },
      { key: 'team.reviewerModel', value: 'gpt-6.1-sol', target: G },
      { key: 'effortByModel', value: { 'claude-sonnet-5-5': 'ultracode', 'gpt-6.1-sol': 'max' }, target: G },
      { key: 'model', value: 'gpt-6.1-sol', target: W },
    ]);
  });

  it('rewrites independently per scope (Global + Workspace both migrated)', async () => {
    const { settings, updates } = stub({ model: { global: 'gpt-5.4', workspace: 'gpt-5.2' } });
    await migrateLegacyModelSetting(settings);

    const modelUpdates = updates.filter((u) => u.key === 'model');
    expect(modelUpdates).toEqual([
      { key: 'model', value: 'gpt-6.1-sol', target: G },
      { key: 'model', value: 'gpt-6-luna', target: W },
    ]);
  });

  // Desktop reports a local value for a trusted project's settings.local.json; VS Code never reports one.
  it('rewrites a legacy model value and effort entry in the local scope, where a store reports one', async () => {
    const { settings, updates } = stub({ model: { workspaceFolder: 'gpt-5.5' }, effortByModel: { workspaceFolder: { 'gpt-5.5': 'high' } } });
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([
      { key: 'model', value: 'gpt-6.1-sol', target: 'local' },
      { key: 'effortByModel', value: { 'gpt-6.1-sol': 'high' }, target: 'local' },
    ]);
  });

  it('leaves an already-current (non-legacy) model value untouched — no writes at all', async () => {
    const { settings, updates } = stub({ model: { global: 'gpt-6.1-sol' } });
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([]);
  });

  it('no-ops entirely when no model value is set in any scope', async () => {
    const { settings, updates } = stub({});
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([]);
  });
});

describe('migrateLegacyModelSetting — damocles.team.*Model rewrite', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('rewrites each legacy team role model at the scope where it lives', async () => {
    const { settings, updates } = stub({
      team: {
        'team.leadModel': { global: 'claude-opus-5' },
        'team.reviewerModel': { workspace: 'gpt-5.6-sol' },
      },
    });
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([
      { key: 'team.leadModel', value: 'claude-opus-5-5', target: G },
      { key: 'team.reviewerModel', value: 'gpt-6.1-sol', target: W },
    ]);
  });

  // Terra has no successor, so the stored value stays for the user to replace.
  it('leaves current, unset and unmapped team role models untouched', async () => {
    const { settings, updates } = stub({
      team: {
        'team.leadModel': { global: 'gpt-6.1-sol' },
        'team.implementorModel': { global: '' },
        'team.reviewerModel': { global: 'gpt-5.6-terra' },
      },
    });
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([]);
  });
});

describe('migrateLegacyModelSetting — effortByModel re-keying', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('re-keys a legacy effort entry to the mapped id, preserving a supported effort level', async () => {
    // Non-legacy model value opens the scope gate without a model rewrite; 'high' is supported by sol.
    const { settings, updates } = stub({
      model: { global: 'gpt-6.1-sol' },
      effortByModel: { global: { 'gpt-5.5': 'high' } },
    });
    await migrateLegacyModelSetting(settings);

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.target).toBe(G);
    expect(effortUpdate?.value).toEqual({ 'gpt-6.1-sol': 'high' });
    // The legacy key must be gone.
    expect(effortUpdate?.value).not.toHaveProperty('gpt-5.5');
  });

  it("clamps an unsupported carried effort ('none') to the target model's lowest level ('low')", async () => {
    const { settings, updates } = stub({
      model: { global: 'gpt-6.1-sol' },
      effortByModel: { global: { 'gpt-5.2': 'none' } }, // gpt-5.2 → luna; 'none' unsupported → 'low'
    });
    await migrateLegacyModelSetting(settings);

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.value).toEqual({ 'gpt-6-luna': 'low' });
  });

  it('does NOT clobber an existing entry for the mapped id (drops the legacy key, keeps the current effort)', async () => {
    const { settings, updates } = stub({
      model: { global: 'gpt-6.1-sol' },
      // gpt-5.4 → gpt-6.1-sol, but gpt-6.1-sol already has an effort; the existing 'low' must survive, not become 'xhigh'.
      effortByModel: { global: { 'gpt-5.4': 'xhigh', 'gpt-6.1-sol': 'low' } },
    });
    await migrateLegacyModelSetting(settings);

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.value).toEqual({ 'gpt-6.1-sol': 'low' });
    expect(effortUpdate?.value).not.toHaveProperty('gpt-5.4');
  });

  it('two legacy ids mapping to the same successor: first-wins deterministically (no last-wins clobber)', async () => {
    // gpt-5.5 AND gpt-5.3-codex both → gpt-6.1-sol. The non-clobber check tests the in-progress
    // nextMap, so the first-iterated legacy id (gpt-5.5, insertion order) wins and the second is
    // dropped without overwriting it. Regression for M1 (checking currentMap gave order-dependent
    // last-wins, since neither collides in the STORED map).
    const { settings, updates } = stub({
      effortByModel: { global: { 'gpt-5.5': 'high', 'gpt-5.3-codex': 'low' } },
    });
    await migrateLegacyModelSetting(settings);

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.value).toEqual({ 'gpt-6.1-sol': 'high' });
    expect(effortUpdate?.value).not.toHaveProperty('gpt-5.5');
    expect(effortUpdate?.value).not.toHaveProperty('gpt-5.3-codex');
  });

  it('preserves an unrelated (non-legacy) effort entry while re-keying a legacy sibling', async () => {
    const { settings, updates } = stub({
      model: { global: 'gpt-6.1-sol' },
      effortByModel: { global: { 'gpt-5.4-mini': 'medium', 'claude-sonnet-5-5': 'xhigh' } },
    });
    await migrateLegacyModelSetting(settings);

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    // gpt-5.4-mini → gpt-6-luna (medium is supported); the Anthropic entry is untouched.
    expect(effortUpdate?.value).toEqual({ 'gpt-6-luna': 'medium', 'claude-sonnet-5-5': 'xhigh' });
  });

  it('re-keys both retired Opus ids onto Opus 5.5, first id winning the collision', async () => {
    const { settings, updates } = stub({
      model: { global: 'claude-opus-5' },
      effortByModel: { global: { 'claude-opus-5': 'xhigh', 'claude-opus-4-8': 'low' } },
    });
    await migrateLegacyModelSetting(settings);

    expect(updates.find((u) => u.key === 'model')?.value).toBe('claude-opus-5-5');
    expect(updates.find((u) => u.key === 'effortByModel')?.value).toEqual({ 'claude-opus-5-5': 'xhigh' });
  });

  it('does not write effortByModel when there is nothing legacy to re-key', async () => {
    const { settings, updates } = stub({
      model: { global: 'gpt-6.1-sol' },
      effortByModel: { global: { 'gpt-6-luna': 'high', 'claude-sonnet-5-5': 'low' } },
    });
    await migrateLegacyModelSetting(settings);

    expect(updates.some((u) => u.key === 'effortByModel')).toBe(false);
  });

  it('re-keys a legacy effort entry even when NO model value is set at that scope', async () => {
    // Regression: the re-key must not be gated behind a present model value. A scope can carry legacy
    // effort entries with the model setting unset (e.g. per-panel selection only) — those must migrate.
    const { settings, updates } = stub({
      effortByModel: { global: { 'gpt-5.5': 'high' } },
    });
    await migrateLegacyModelSetting(settings);

    expect(updates.filter((u) => u.key === 'model')).toEqual([]);
    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.target).toBe(G);
    expect(effortUpdate?.value).toEqual({ 'gpt-6.1-sol': 'high' });
  });

  it('re-keys effortByModel even when the scope model itself is a legacy id (both migrations run)', async () => {
    const { settings, updates } = stub({
      model: { global: 'gpt-5.4' },
      effortByModel: { global: { 'gpt-5.4': 'none' } },
    });
    await migrateLegacyModelSetting(settings);

    expect(updates.filter((u) => u.key === 'model')).toEqual([
      { key: 'model', value: 'gpt-6.1-sol', target: G },
    ]);
    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.value).toEqual({ 'gpt-6.1-sol': 'low' });
  });
});

describe('migrateLegacyModelSetting — DeepSeek effort-value migration (xhigh → max)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('value-migrates a stored DeepSeek xhigh to max (pi 0.80.6 thinkingLevelMap rename)', async () => {
    const { settings, updates } = stub({ effortByModel: { global: { 'deepseek-v4-pro': 'xhigh' } } });
    await migrateLegacyModelSetting(settings);

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.target).toBe(G);
    expect(effortUpdate?.value).toEqual({ 'deepseek-v4-pro': 'max' });
  });

  it('migrates both DeepSeek ids per scope, independently', async () => {
    const { settings, updates } = stub({
      effortByModel: {
        global: { 'deepseek-v4-pro': 'xhigh' },
        workspace: { 'deepseek-flash': 'xhigh' },
      },
    });
    await migrateLegacyModelSetting(settings);

    const effortUpdates = updates.filter((u) => u.key === 'effortByModel');
    expect(effortUpdates).toEqual([
      { key: 'effortByModel', value: { 'deepseek-v4-pro': 'max' }, target: G },
      { key: 'effortByModel', value: { 'deepseek-flash': 'max' }, target: W },
    ]);
  });

  // DeepSeek V4.1 Flash offers low|high|max, so clamping xhigh before the rename would land on low.
  it('renames a retired deepseek-v4-flash xhigh to max before re-keying it to deepseek-flash', async () => {
    const { settings, updates } = stub({
      model: { global: 'deepseek-v4-flash' },
      effortByModel: { global: { 'deepseek-v4-flash': 'xhigh' } },
    });
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([
      { key: 'model', value: 'deepseek-flash', target: G },
      { key: 'effortByModel', value: { 'deepseek-flash': 'max' }, target: G },
    ]);
  });

  it('leaves a supported DeepSeek level (high) untouched — no write', async () => {
    const { settings, updates } = stub({ effortByModel: { global: { 'deepseek-v4-pro': 'high' } } });
    await migrateLegacyModelSetting(settings);

    expect(updates.some((u) => u.key === 'effortByModel')).toBe(false);
  });

  it('is idempotent: an already-migrated DeepSeek max entry is not rewritten', async () => {
    const { settings, updates } = stub({ effortByModel: { global: { 'deepseek-flash': 'max' } } });
    await migrateLegacyModelSetting(settings);

    expect(updates.some((u) => u.key === 'effortByModel')).toBe(false);
  });

  it('migrates a legacy GPT key AND a DeepSeek xhigh in a single write', async () => {
    const { settings, updates } = stub({
      effortByModel: { global: { 'gpt-5.5': 'high', 'deepseek-v4-pro': 'xhigh' } },
    });
    await migrateLegacyModelSetting(settings);

    const effortUpdates = updates.filter((u) => u.key === 'effortByModel');
    expect(effortUpdates).toHaveLength(1);
    expect(effortUpdates[0]!.value).toEqual({ 'gpt-6.1-sol': 'high', 'deepseek-v4-pro': 'max' });
  });

  it('does not write when a scope has only a non-migrating DeepSeek entry alongside a legacy GPT key in another scope', async () => {
    const { settings, updates } = stub({
      effortByModel: {
        global: { 'gpt-5.4': 'medium' }, // migrates → gpt-6.1-sol
        workspace: { 'deepseek-v4-pro': 'high' }, // supported, no change
      },
    });
    await migrateLegacyModelSetting(settings);

    const effortUpdates = updates.filter((u) => u.key === 'effortByModel');
    expect(effortUpdates).toEqual([
      { key: 'effortByModel', value: { 'gpt-6.1-sol': 'medium' }, target: G },
    ]);
  });
});

describe('migrateLegacyModelSetting: Fable 5 to Fable 5.1', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('rewrites a stored damocles.model of claude-fable-5 to claude-fable-5-1', async () => {
    const { settings, updates } = stub({ model: { global: 'claude-fable-5' } });
    await migrateLegacyModelSetting(settings);

    expect(updates.filter((u) => u.key === 'model')).toEqual([
      { key: 'model', value: 'claude-fable-5-1', target: G },
    ]);
  });

  it('re-keys the effortByModel entry to claude-fable-5-1 with its value intact', async () => {
    const { settings, updates } = stub({
      model: { global: 'claude-fable-5' },
      effortByModel: { global: { 'claude-fable-5': 'high' } },
    });
    await migrateLegacyModelSetting(settings);

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.target).toBe(G);
    expect(effortUpdate?.value).toEqual({ 'claude-fable-5-1': 'high' });
    expect(effortUpdate?.value).not.toHaveProperty('claude-fable-5');
  });

  it('carries a stored ultracode through the clamp unchanged', async () => {
    // Fable 5.1 advertises the same six levels as Fable 5, so nothing needs a value rename.
    const { settings, updates } = stub({ effortByModel: { global: { 'claude-fable-5': 'ultracode' } } });
    await migrateLegacyModelSetting(settings);

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.value).toEqual({ 'claude-fable-5-1': 'ultracode' });
  });

  it('carries a stored xhigh through the clamp unchanged', async () => {
    const { settings, updates } = stub({ effortByModel: { global: { 'claude-fable-5': 'xhigh' } } });
    await migrateLegacyModelSetting(settings);

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.value).toEqual({ 'claude-fable-5-1': 'xhigh' });
  });

  it('leaves an already-migrated claude-fable-5-1 entry alone, with no writes at all', async () => {
    const { settings, updates } = stub({
      model: { global: 'claude-fable-5-1' },
      effortByModel: { global: { 'claude-fable-5-1': 'ultracode' } },
    });
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([]);
  });
});

describe('migrateLegacyModelSetting: Haiku 4.5 and Step 3.7 Flash successors', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('rewrites stored Haiku 4.5 selections in damocles.model and the team roles to Haiku 5.5', async () => {
    const { settings, updates } = stub({
      model: { global: 'claude-haiku-4-5-20251001' },
      team: { 'team.implementorModel': { workspace: 'claude-haiku-4-5-20251001' } },
      effortByModel: { global: { 'claude-haiku-4-5-20251001': 'high' } },
    });
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([
      { key: 'model', value: 'claude-haiku-5-5', target: G },
      { key: 'effortByModel', value: { 'claude-haiku-5-5': 'high' }, target: G },
      { key: 'team.implementorModel', value: 'claude-haiku-5-5', target: W },
    ]);
  });

  it('moves a stored step-3.7-flash selection and its effort entry to step-5-preview', async () => {
    const { settings, updates } = stub({
      model: { global: 'step-3.7-flash' },
      team: { 'team.reviewerModel': { global: 'step-3.7-flash' } },
      effortByModel: { global: { 'step-3.7-flash': 'medium' } },
    });
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([
      { key: 'model', value: 'step-5-preview', target: G },
      { key: 'team.reviewerModel', value: 'step-5-preview', target: G },
      { key: 'effortByModel', value: { 'step-5-preview': 'medium' }, target: G },
    ]);
  });

  it('rewrites a retired id stored in damocles.background.model', async () => {
    const { settings, updates } = stub({ team: { 'background.model': { global: 'claude-haiku-4-5-20251001' } } });
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([{ key: 'background.model', value: 'claude-haiku-5-5', target: G }]);
  });

  it('rewrites a retired id stored in damocles.memory.judge and leaves a classifier choice alone', async () => {
    const { settings, updates } = stub({ team: { 'memory.judge': { global: 'claude-haiku-4-5-20251001', workspace: 'jev-typesafe' } } });
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([{ key: 'memory.judge', value: 'claude-haiku-5-5', target: G }]);
  });

  it('rewrites a retired id stored in damocles.explore.model', async () => {
    const { settings, updates } = stub({ team: { 'explore.model': { workspace: 'step-3.7-flash' } } });
    await migrateLegacyModelSetting(settings);

    expect(updates).toEqual([{ key: 'explore.model', value: 'step-5-preview', target: W }]);
  });
});

describe('migrateExploreSettings', () => {
  afterEach(() => vi.restoreAllMocks());

  const keyed = async (): Promise<boolean> => true;
  const unkeyed = async (): Promise<boolean> => false;
  const retired = ['enabled', 'provider', 'modelByProvider'];

  it('moves an enabled StepFun Explore at High to Step 5 Preview at High, and removes the retired keys', async () => {
    const { settings } = createFakePlatform({
      settings: { user: { 'damocles.explore.enabled': true, 'damocles.explore.provider': 'stepfun', 'damocles.explore.modelByProvider': { stepfun: 'step-3.7-flash' }, 'damocles.explore.effort': 'high' } },
    });
    await migrateExploreSettings(settings, keyed);

    expect(settings.inspect('damocles.explore.model')).toStrictEqual({ userValue: 'step-5-preview' });
    expect(settings.inspect('damocles.explore.effort')).toStrictEqual({ userValue: 'high' });
    for (const key of retired) expect(settings.inspect(`damocles.explore.${key}`)).toStrictEqual({});
  });

  it.each([
    ['Gemini', { 'damocles.explore.enabled': true, 'damocles.explore.provider': 'gemini' }],
    ['OpenRouter', { 'damocles.explore.enabled': true, 'damocles.explore.provider': 'openrouter', 'damocles.explore.modelByProvider': { openrouter: 'x/y' } }],
    ['a disabled StepFun', { 'damocles.explore.enabled': false, 'damocles.explore.provider': 'stepfun' }],
    ['an enabled Explore with the default provider, OpenRouter', { 'damocles.explore.enabled': true }],
  ])('moves %s to Default, which takes no effort, without asking for the StepFun key', async (_name, user) => {
    const { settings } = createFakePlatform({ settings: { user: { ...user, 'damocles.explore.effort': 'high' } } });
    const stepfunKeyStored = vi.fn(keyed);
    await migrateExploreSettings(settings, stepfunKeyStored);

    expect(stepfunKeyStored).not.toHaveBeenCalled();
    expect(settings.inspect('damocles.explore.model')).toStrictEqual({});
    expect(settings.inspect('damocles.explore.effort')).toStrictEqual({});
    for (const key of retired) expect(settings.inspect(`damocles.explore.${key}`)).toStrictEqual({});
  });

  // Before the move an unkeyed StepFun Explore ran on Default, so Step 5 Preview would turn every spawn into an error.
  it('moves an enabled StepFun Explore with no StepFun key stored to Default', async () => {
    const { settings } = createFakePlatform({ settings: { user: { 'damocles.explore.enabled': true, 'damocles.explore.provider': 'stepfun', 'damocles.explore.effort': 'low' } } });
    await migrateExploreSettings(settings, unkeyed);

    expect(settings.inspect('damocles.explore.model')).toStrictEqual({});
    expect(settings.inspect('damocles.explore.effort')).toStrictEqual({});
    for (const key of retired) expect(settings.inspect(`damocles.explore.${key}`)).toStrictEqual({});
  });

  it('leaves every setting for a later launch when the key store does not answer', async () => {
    const { settings } = createFakePlatform({ settings: { user: { 'damocles.explore.enabled': true, 'damocles.explore.provider': 'stepfun', 'damocles.explore.effort': 'low' } } });
    const update = vi.spyOn(settings, 'update');
    await migrateExploreSettings(settings, async () => undefined);

    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ['a project that only repeats enabled', { 'damocles.explore.enabled': true }, undefined],
    ['a project that turns Explore off', { 'damocles.explore.enabled': false }, undefined],
    ['a project with another provider', { 'damocles.explore.provider': 'gemini' }, { 'damocles.explore.modelByProvider': { stepfun: 'step-3.7-flash' } }],
  ])("keeps the user's StepFun choice in user settings over %s, and removes the retired keys from every file", async (_name, project, local) => {
    const { settings } = createFakePlatform({
      settings: { user: { 'damocles.explore.enabled': true, 'damocles.explore.provider': 'stepfun' }, project, ...(local ? { local } : {}) },
    });
    await migrateExploreSettings(settings, keyed);

    expect(settings.inspect('damocles.explore.model')).toStrictEqual({ userValue: 'step-5-preview' });
    for (const key of retired) expect(settings.inspect(`damocles.explore.${key}`)).toStrictEqual({});
  });

  it("drops a project's StepFun choice, which the user-only Explore model cannot carry", async () => {
    const { settings } = createFakePlatform({
      settings: { user: { 'damocles.explore.provider': 'stepfun' }, project: { 'damocles.explore.enabled': true, 'damocles.explore.provider': 'stepfun' } },
    });
    await migrateExploreSettings(settings, keyed);

    expect(settings.inspect('damocles.explore.model')).toStrictEqual({});
    for (const key of retired) expect(settings.inspect(`damocles.explore.${key}`)).toStrictEqual({});
  });

  it('keeps an Explore model already set in user settings and only removes the retired keys', async () => {
    const { settings } = createFakePlatform({
      settings: { user: { 'damocles.explore.model': 'claude-sonnet-5-5', 'damocles.explore.effort': 'xhigh', 'damocles.explore.enabled': true, 'damocles.explore.provider': 'stepfun' } },
    });
    await migrateExploreSettings(settings, keyed);

    expect(settings.inspect('damocles.explore.model')).toStrictEqual({ userValue: 'claude-sonnet-5-5' });
    expect(settings.inspect('damocles.explore.effort')).toStrictEqual({ userValue: 'xhigh' });
    expect(settings.inspect('damocles.explore.enabled')).toStrictEqual({});
  });

  it('keeps the effort and the retired keys when the model cannot be written, so the next launch moves them again', async () => {
    const { settings } = createFakePlatform({ settings: { user: { 'damocles.explore.enabled': true, 'damocles.explore.provider': 'stepfun', 'damocles.explore.effort': 'max' } } });
    const update = settings.update.bind(settings);
    vi.spyOn(settings, 'update').mockImplementation((key, value, scope) => (key === 'damocles.explore.model' ? Promise.reject(new Error('read-only')) : update(key, value, scope)));
    await expect(migrateExploreSettings(settings, keyed)).resolves.toBeUndefined();

    expect(settings.inspect('damocles.explore.effort')).toStrictEqual({ userValue: 'max' });
    expect(settings.inspect('damocles.explore.enabled')).toStrictEqual({ userValue: true });
    expect(settings.inspect('damocles.explore.provider')).toStrictEqual({ userValue: 'stepfun' });
  });

  it('still removes the retired keys from the other files when one refuses the write', async () => {
    const { settings } = createFakePlatform({
      settings: { user: { 'damocles.explore.enabled': true }, project: { 'damocles.explore.provider': 'stepfun' }, local: { 'damocles.explore.enabled': false } },
    });
    const update = settings.update.bind(settings);
    vi.spyOn(settings, 'update').mockImplementation((key, value, scope) => (scope === 'project' ? Promise.reject(new Error('untrusted')) : update(key, value, scope)));
    await expect(migrateExploreSettings(settings, keyed)).resolves.toBeUndefined();

    expect(settings.inspect('damocles.explore.enabled')).toStrictEqual({});
    expect(settings.inspect('damocles.explore.provider')).toStrictEqual({ projectValue: 'stepfun' });
  });

  it('is a no-op on a second run', async () => {
    const { settings } = createFakePlatform({ settings: { user: { 'damocles.explore.enabled': true, 'damocles.explore.provider': 'stepfun', 'damocles.explore.effort': 'low' } } });
    await migrateExploreSettings(settings, keyed);
    const update = vi.spyOn(settings, 'update');
    await migrateExploreSettings(settings, keyed);

    expect(update).not.toHaveBeenCalled();
    expect(settings.inspect('damocles.explore.model')).toStrictEqual({ userValue: 'step-5-preview' });
    expect(settings.inspect('damocles.explore.effort')).toStrictEqual({ userValue: 'low' });
  });

  it('runs as part of the startup migrations', async () => {
    const { settings } = createFakePlatform({ settings: { user: { 'damocles.explore.enabled': true, 'damocles.explore.provider': 'stepfun' } } });
    await runLegacySettingsMigrations(settings, keyed);

    expect(settings.inspect('damocles.explore.model')).toStrictEqual({ userValue: 'step-5-preview' });
  });
});

describe('removeMaxThinkingTokensSetting', () => {
  it('removes a stored damocles.maxThinkingTokens at every scope that holds one', async () => {
    const { settings } = createFakePlatform({
      settings: {
        user: { 'damocles.maxThinkingTokens': 32000 },
        project: { 'damocles.maxThinkingTokens': 8000 },
        local: { 'damocles.maxThinkingTokens': 1000 },
      },
    });
    await removeMaxThinkingTokensSetting(settings);

    expect(settings.inspect('damocles.maxThinkingTokens')).toStrictEqual({});
  });

  it('writes nothing when no scope holds the setting', async () => {
    const { settings } = createFakePlatform({ settings: { user: { 'damocles.model': 'claude-haiku-5-5' } } });
    const update = vi.spyOn(settings, 'update');
    await removeMaxThinkingTokensSetting(settings);

    expect(update).not.toHaveBeenCalled();
  });
});

describe('migrateLegacyEffortSetting', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('moves damocles.effort into effortByModel under the active model, per scope, and removes it', async () => {
    const { settings } = createFakePlatform({
      settings: {
        user: { 'damocles.model': 'gpt-6.1-sol', 'damocles.effort': 'high', 'damocles.effortByModel': { 'gpt-6-luna': 'low' } },
        local: { 'damocles.effort': 'max' },
      },
    });
    await migrateLegacyEffortSetting(settings);

    expect(settings.inspect('damocles.effort')).toStrictEqual({});
    expect(settings.inspect('damocles.effortByModel')).toStrictEqual({
      userValue: { 'gpt-6-luna': 'low', 'gpt-6.1-sol': 'high' },
      localValue: { 'gpt-6.1-sol': 'max' },
    });
  });

  it('keeps an effortByModel entry the active model already has and still removes damocles.effort', async () => {
    const { settings } = createFakePlatform({
      settings: { user: { 'damocles.model': 'gpt-6.1-sol', 'damocles.effort': 'high', 'damocles.effortByModel': { 'gpt-6.1-sol': 'low' } } },
    });
    await migrateLegacyEffortSetting(settings);

    expect(settings.inspect('damocles.effort')).toStrictEqual({});
    expect(settings.inspect('damocles.effortByModel')).toStrictEqual({ userValue: { 'gpt-6.1-sol': 'low' } });
  });
});

describe('runLegacySettingsMigrations', () => {
  const logLines: string[] = [];
  beforeEach(() => {
    logLines.length = 0;
    installLogSink({ appendLine: (line: string) => void logLines.push(line), show: () => {}, dispose: () => {} });
  });
  afterEach(() => vi.restoreAllMocks());

  const keyed = async (): Promise<boolean> => true;

  it('resolves when a scope refuses the write, so startup goes on', async () => {
    const { settings } = createFakePlatform({ settings: { project: { 'damocles.model': 'gpt-5.5' } } });
    const update = vi.spyOn(settings, 'update').mockRejectedValue(new Error('read-only scope'));

    await expect(runLegacySettingsMigrations(settings, keyed)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledWith('damocles.model', 'gpt-6.1-sol', 'project');
  });

  it('runs every later migration when one fails, and logs the failure', async () => {
    const { settings } = createFakePlatform({
      settings: { user: { 'damocles.effort': 'high', 'damocles.maxThinkingTokens': 1000, 'damocles.explore.enabled': true, 'damocles.explore.provider': 'stepfun' } },
    });
    const update = settings.update.bind(settings);
    vi.spyOn(settings, 'update').mockImplementation((key, value, scope) => (key === 'damocles.effortByModel' ? Promise.reject(new Error('file has errors')) : update(key, value, scope)));
    await runLegacySettingsMigrations(settings, keyed);

    expect(settings.inspect('damocles.maxThinkingTokens')).toStrictEqual({});
    expect(settings.inspect('damocles.explore.model')).toStrictEqual({ userValue: 'step-5-preview' });
    expect(logLines.join('\n')).toContain('file has errors');
  });

  it('migrates the other scopes when one refuses the write, and logs that scope', async () => {
    const { settings } = createFakePlatform({
      settings: {
        user: { 'damocles.maxThinkingTokens': 32000 },
        project: { 'damocles.maxThinkingTokens': 8000, 'damocles.model': 'gpt-5.5' },
        local: { 'damocles.maxThinkingTokens': 1000, 'damocles.model': 'gpt-5.5' },
      },
    });
    const update = settings.update.bind(settings);
    vi.spyOn(settings, 'update').mockImplementation((key, value, scope) => (scope === 'project' ? Promise.reject(new Error('untrusted folder')) : update(key, value, scope)));
    await runLegacySettingsMigrations(settings, keyed);

    expect(settings.inspect('damocles.maxThinkingTokens')).toStrictEqual({ projectValue: 8000 });
    expect(settings.inspect('damocles.model')).toStrictEqual({ projectValue: 'gpt-5.5', localValue: 'gpt-6.1-sol' });
    expect(logLines.join('\n')).toMatch(/scope=project.*untrusted folder/);
  });
});
