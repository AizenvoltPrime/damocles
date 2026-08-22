import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { LEGACY_MODEL_MAP, migrateLegacyModelValue } from '../../shared/types/constants';
import { migrateLegacyModelSetting } from '../extension';

/**
 * Migration coverage for the GPT-5.6 lineup swap (Slice 2).
 *
 * `migrateLegacyModelValue` is a pure lookup — asserted directly.
 *
 * `migrateLegacyModelSetting` reads/writes the real `vscode` config via `config.inspect`/`config.update`.
 * We drive it by stubbing `vscode.workspace.getConfiguration` with a fake config that (a) returns
 * seeded per-scope `inspect` values and (b) records every `update(key, value, target)` call, so each
 * test asserts the ACTUAL rewrite the function performs — not a re-implementation of it.
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
  target: number;
}

const G = vscode.ConfigurationTarget.Global; // 1
const W = vscode.ConfigurationTarget.Workspace; // 2

function fakeConfig(seed: { model?: Scoped<string>; effortByModel?: Scoped<EffortMap> }) {
  const updates: UpdateCall[] = [];
  const config = {
    get: (_key: string, defaultValue?: unknown) => defaultValue,
    inspect: (key: string) => {
      if (key === 'model') {
        return {
          globalValue: seed.model?.global,
          workspaceValue: seed.model?.workspace,
          workspaceFolderValue: seed.model?.workspaceFolder,
        };
      }
      if (key === 'effortByModel') {
        return {
          globalValue: seed.effortByModel?.global,
          workspaceValue: seed.effortByModel?.workspace,
          workspaceFolderValue: seed.effortByModel?.workspaceFolder,
        };
      }
      return undefined;
    },
    update: (key: string, value: unknown, target: number) => {
      updates.push({ key, value, target });
      return Promise.resolve();
    },
  };
  return { config, updates };
}

function stub(seed: { model?: Scoped<string>; effortByModel?: Scoped<EffortMap> }): UpdateCall[] {
  const { config, updates } = fakeConfig(seed);
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(config as unknown as vscode.WorkspaceConfiguration);
  return updates;
}

describe('migrateLegacyModelValue', () => {
  it('maps every legacy GPT id to its GPT-5.6 successor', () => {
    expect(migrateLegacyModelValue('gpt-5.5')).toBe('gpt-5.6-sol');
    expect(migrateLegacyModelValue('gpt-5.3-codex')).toBe('gpt-5.6-sol');
    expect(migrateLegacyModelValue('gpt-5.4')).toBe('gpt-5.6-terra');
    expect(migrateLegacyModelValue('gpt-5.4-mini')).toBe('gpt-5.6-luna');
    expect(migrateLegacyModelValue('gpt-5.2')).toBe('gpt-5.6-luna');
  });

  it('covers exactly the five legacy ids and nothing else', () => {
    expect(Object.keys(LEGACY_MODEL_MAP).sort()).toEqual(
      ['gpt-5.2', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5'],
    );
  });

  it('is identity for non-legacy values (new ids, Anthropic, empty string)', () => {
    expect(migrateLegacyModelValue('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(migrateLegacyModelValue('gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(migrateLegacyModelValue('gpt-5.6-luna')).toBe('gpt-5.6-luna');
    expect(migrateLegacyModelValue('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(migrateLegacyModelValue('')).toBe('');
  });
});

describe('migrateLegacyModelSetting — damocles.model rewrite', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('rewrites a legacy model value to its mapped id at the scope where it lives', async () => {
    const updates = stub({ model: { global: 'gpt-5.5' } });
    await migrateLegacyModelSetting();

    const modelUpdates = updates.filter((u) => u.key === 'model');
    expect(modelUpdates).toEqual([{ key: 'model', value: 'gpt-5.6-sol', target: G }]);
  });

  it('rewrites independently per scope (Global + Workspace both migrated)', async () => {
    const updates = stub({ model: { global: 'gpt-5.4', workspace: 'gpt-5.2' } });
    await migrateLegacyModelSetting();

    const modelUpdates = updates.filter((u) => u.key === 'model');
    expect(modelUpdates).toEqual([
      { key: 'model', value: 'gpt-5.6-terra', target: G },
      { key: 'model', value: 'gpt-5.6-luna', target: W },
    ]);
  });

  it('ignores a WorkspaceFolder value (window-scoped settings never surface one)', async () => {
    // damocles.model is window-scoped, so a folder value can't exist; the migration must not write it.
    const updates = stub({ model: { workspaceFolder: 'gpt-5.5' } });
    await migrateLegacyModelSetting();

    expect(updates).toEqual([]);
  });

  it('leaves an already-current (non-legacy) model value untouched — no writes at all', async () => {
    const updates = stub({ model: { global: 'gpt-5.6-sol' } });
    await migrateLegacyModelSetting();

    expect(updates).toEqual([]);
  });

  it('no-ops entirely when no model value is set in any scope', async () => {
    const updates = stub({});
    await migrateLegacyModelSetting();

    expect(updates).toEqual([]);
  });
});

describe('migrateLegacyModelSetting — effortByModel re-keying', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('re-keys a legacy effort entry to the mapped id, preserving a supported effort level', async () => {
    // Non-legacy model value opens the scope gate without a model rewrite; 'high' is supported by sol.
    const updates = stub({
      model: { global: 'gpt-5.6-sol' },
      effortByModel: { global: { 'gpt-5.5': 'high' } },
    });
    await migrateLegacyModelSetting();

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.target).toBe(G);
    expect(effortUpdate?.value).toEqual({ 'gpt-5.6-sol': 'high' });
    // The legacy key must be gone.
    expect(effortUpdate?.value).not.toHaveProperty('gpt-5.5');
  });

  it("clamps an unsupported carried effort ('none') to the target model's lowest level ('low')", async () => {
    const updates = stub({
      model: { global: 'gpt-5.6-sol' },
      effortByModel: { global: { 'gpt-5.2': 'none' } }, // gpt-5.2 → luna; 'none' unsupported → 'low'
    });
    await migrateLegacyModelSetting();

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.value).toEqual({ 'gpt-5.6-luna': 'low' });
  });

  it('does NOT clobber an existing entry for the mapped id (drops the legacy key, keeps the current effort)', async () => {
    const updates = stub({
      model: { global: 'gpt-5.6-sol' },
      // gpt-5.4 → terra, but terra already has an effort; the existing 'low' must survive, not become 'xhigh'.
      effortByModel: { global: { 'gpt-5.4': 'xhigh', 'gpt-5.6-terra': 'low' } },
    });
    await migrateLegacyModelSetting();

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.value).toEqual({ 'gpt-5.6-terra': 'low' });
    expect(effortUpdate?.value).not.toHaveProperty('gpt-5.4');
  });

  it('two legacy ids mapping to the same successor: first-wins deterministically (no last-wins clobber)', async () => {
    // gpt-5.5 AND gpt-5.3-codex both → gpt-5.6-sol. The non-clobber check tests the in-progress
    // nextMap, so the first-iterated legacy id (gpt-5.5, insertion order) wins and the second is
    // dropped without overwriting it. Regression for M1 (checking currentMap gave order-dependent
    // last-wins, since neither collides in the STORED map).
    const updates = stub({
      effortByModel: { global: { 'gpt-5.5': 'high', 'gpt-5.3-codex': 'low' } },
    });
    await migrateLegacyModelSetting();

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.value).toEqual({ 'gpt-5.6-sol': 'high' });
    expect(effortUpdate?.value).not.toHaveProperty('gpt-5.5');
    expect(effortUpdate?.value).not.toHaveProperty('gpt-5.3-codex');
  });

  it('preserves an unrelated (non-legacy) effort entry while re-keying a legacy sibling', async () => {
    const updates = stub({
      model: { global: 'gpt-5.6-sol' },
      effortByModel: { global: { 'gpt-5.4-mini': 'medium', 'claude-opus-4-8': 'xhigh' } },
    });
    await migrateLegacyModelSetting();

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    // gpt-5.4-mini → luna (medium is supported); the Anthropic entry is untouched.
    expect(effortUpdate?.value).toEqual({ 'gpt-5.6-luna': 'medium', 'claude-opus-4-8': 'xhigh' });
  });

  it('does not write effortByModel when there is nothing legacy to re-key', async () => {
    const updates = stub({
      model: { global: 'gpt-5.6-sol' },
      effortByModel: { global: { 'gpt-5.6-terra': 'high', 'claude-opus-4-8': 'low' } },
    });
    await migrateLegacyModelSetting();

    expect(updates.some((u) => u.key === 'effortByModel')).toBe(false);
  });

  it('re-keys a legacy effort entry even when NO model value is set at that scope', async () => {
    // Regression: the re-key must not be gated behind a present model value. A scope can carry legacy
    // effort entries with the model setting unset (e.g. per-panel selection only) — those must migrate.
    const updates = stub({
      effortByModel: { global: { 'gpt-5.5': 'high' } },
    });
    await migrateLegacyModelSetting();

    expect(updates.filter((u) => u.key === 'model')).toEqual([]);
    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.target).toBe(G);
    expect(effortUpdate?.value).toEqual({ 'gpt-5.6-sol': 'high' });
  });

  it('re-keys effortByModel even when the scope model itself is a legacy id (both migrations run)', async () => {
    const updates = stub({
      model: { global: 'gpt-5.4' },
      effortByModel: { global: { 'gpt-5.4': 'none' } },
    });
    await migrateLegacyModelSetting();

    expect(updates.filter((u) => u.key === 'model')).toEqual([
      { key: 'model', value: 'gpt-5.6-terra', target: G },
    ]);
    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.value).toEqual({ 'gpt-5.6-terra': 'low' });
  });
});

describe('migrateLegacyModelSetting — DeepSeek effort-value migration (xhigh → max)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('value-migrates a stored DeepSeek xhigh to max (pi 0.80.6 thinkingLevelMap rename)', async () => {
    const updates = stub({ effortByModel: { global: { 'deepseek-v4-pro': 'xhigh' } } });
    await migrateLegacyModelSetting();

    const effortUpdate = updates.find((u) => u.key === 'effortByModel');
    expect(effortUpdate?.target).toBe(G);
    expect(effortUpdate?.value).toEqual({ 'deepseek-v4-pro': 'max' });
  });

  it('migrates both DeepSeek ids per scope, independently', async () => {
    const updates = stub({
      effortByModel: {
        global: { 'deepseek-v4-pro': 'xhigh' },
        workspace: { 'deepseek-v4-flash': 'xhigh' },
      },
    });
    await migrateLegacyModelSetting();

    const effortUpdates = updates.filter((u) => u.key === 'effortByModel');
    expect(effortUpdates).toEqual([
      { key: 'effortByModel', value: { 'deepseek-v4-pro': 'max' }, target: G },
      { key: 'effortByModel', value: { 'deepseek-v4-flash': 'max' }, target: W },
    ]);
  });

  it('leaves a supported DeepSeek level (high) untouched — no write', async () => {
    const updates = stub({ effortByModel: { global: { 'deepseek-v4-pro': 'high' } } });
    await migrateLegacyModelSetting();

    expect(updates.some((u) => u.key === 'effortByModel')).toBe(false);
  });

  it('is idempotent: an already-migrated DeepSeek max entry is not rewritten', async () => {
    const updates = stub({ effortByModel: { global: { 'deepseek-v4-flash': 'max' } } });
    await migrateLegacyModelSetting();

    expect(updates.some((u) => u.key === 'effortByModel')).toBe(false);
  });

  it('migrates a legacy GPT key AND a DeepSeek xhigh in a single write', async () => {
    const updates = stub({
      effortByModel: { global: { 'gpt-5.5': 'high', 'deepseek-v4-pro': 'xhigh' } },
    });
    await migrateLegacyModelSetting();

    const effortUpdates = updates.filter((u) => u.key === 'effortByModel');
    expect(effortUpdates).toHaveLength(1);
    expect(effortUpdates[0]!.value).toEqual({ 'gpt-5.6-sol': 'high', 'deepseek-v4-pro': 'max' });
  });

  it('does not write when a scope has only a non-migrating DeepSeek entry alongside a legacy GPT key in another scope', async () => {
    const updates = stub({
      effortByModel: {
        global: { 'gpt-5.4': 'medium' }, // migrates → terra
        workspace: { 'deepseek-v4-pro': 'high' }, // supported, no change
      },
    });
    await migrateLegacyModelSetting();

    const effortUpdates = updates.filter((u) => u.key === 'effortByModel');
    expect(effortUpdates).toEqual([
      { key: 'effortByModel', value: { 'gpt-5.6-terra': 'medium' }, target: G },
    ]);
  });
});
