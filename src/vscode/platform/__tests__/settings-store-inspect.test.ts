import { beforeEach, describe, expect, it } from 'vitest';
import { __config } from 'vscode';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { migrateLegacyEffortSetting, migrateLegacyModelSetting } from '../../../core/config/legacy-settings-migrations';
import type { SettingsScope, SettingsStore } from '../../../platform/settings-store';
import { VsCodeSettingsStore } from '../settings-store';

// Every key migrateLegacyEffortSetting and migrateLegacyModelSetting inspect.
const MIGRATION_INPUTS = [
  'damocles.effort',
  'damocles.effortByModel',
  'damocles.model',
  'damocles.team.leadModel',
  'damocles.team.implementorModel',
  'damocles.team.reviewerModel',
] as const;

type Defaults = Readonly<Record<string, unknown>>;

const IMPLS: ReadonlyArray<readonly [string, (defaults?: Defaults) => SettingsStore]> = [
  ['fake platform', (defaults = {}) => createFakePlatform({ settings: { defaults } }).settings],
  [
    'VS Code (vscode mock)',
    (defaults = {}) => {
      for (const [key, value] of Object.entries(defaults)) __config.defaults.set(key, value);
      return new VsCodeSettingsStore();
    },
  ],
];

const SAMPLE: Readonly<Record<(typeof MIGRATION_INPUTS)[number], unknown>> = {
  'damocles.effort': 'high',
  'damocles.effortByModel': { 'gpt-5.5': 'low' },
  'damocles.model': 'gpt-5.5',
  'damocles.team.leadModel': 'gpt-5.4',
  'damocles.team.implementorModel': 'gpt-5.2',
  'damocles.team.reviewerModel': 'claude-fable-5',
};

beforeEach(() => {
  __config.reset();
});

describe.each(IMPLS)('SettingsStore.inspect over the migration inputs: %s', (_name, make) => {
  it.each(MIGRATION_INPUTS)('%s: no value at any scope inspects as an empty object', (key) => {
    const store = make();
    expect(Object.keys(store.inspect(key))).toEqual([]);
  });

  it.each(MIGRATION_INPUTS)('%s: only the scopes holding a value are present', async (key) => {
    const store = make();
    await store.update(key, SAMPLE[key], 'user');
    const userOnly = store.inspect(key);
    expect(Object.keys(userOnly)).toEqual(['userValue']);
    expect(userOnly).toStrictEqual({ userValue: SAMPLE[key] });

    await store.update(key, SAMPLE[key], 'project');
    expect(store.inspect(key)).toStrictEqual({ userValue: SAMPLE[key], projectValue: SAMPLE[key] });

    await store.update(key, undefined, 'user');
    const projectOnly = store.inspect(key);
    expect('userValue' in projectOnly).toBe(false);
    expect(projectOnly).toStrictEqual({ projectValue: SAMPLE[key] });
  });

  it.each(MIGRATION_INPUTS)('%s: a stored null is present, not absent', async (key) => {
    const store = make();
    await store.update(key, null, 'user');
    const result = store.inspect(key);
    expect('userValue' in result).toBe(true);
    expect(result).toStrictEqual({ userValue: null });
  });

  it('merges an object value with disjoint keys across the default, user and project scopes', async () => {
    const store = make({ 'damocles.effortByModel': { 'gpt-6-luna': 'low' } });
    await store.update('damocles.effortByModel', { 'gpt-6.1-sol': 'high' }, 'user');
    await store.update('damocles.effortByModel', { 'gpt-6-nova': 'max' }, 'project');
    expect(store.get('damocles.effortByModel')).toStrictEqual({ 'gpt-6-luna': 'low', 'gpt-6.1-sol': 'high', 'gpt-6-nova': 'max' });
  });

  it.each(MIGRATION_INPUTS)('%s: a registered default appears only as defaultValue', (key) => {
    const store = make({ [key]: SAMPLE[key] });
    expect(store.inspect(key)).toStrictEqual({ defaultValue: SAMPLE[key] });
  });
});

async function seed(store: SettingsStore, values: ReadonlyArray<readonly [string, unknown, SettingsScope]>): Promise<void> {
  for (const [key, value, scope] of values) await store.update(key, value, scope);
}

function snapshot(store: SettingsStore): Record<string, unknown> {
  return Object.fromEntries(MIGRATION_INPUTS.map((key) => [key, store.inspect(key)]));
}

describe('migrations produce the same scopes on both SettingsStore implementations', () => {
  const SEED: ReadonlyArray<readonly [string, unknown, SettingsScope]> = [
    ['damocles.effort', 'high', 'user'],
    ['damocles.model', 'gpt-5.5', 'project'],
    ['damocles.effortByModel', { 'gpt-5.4': 'low' }, 'project'],
    ['damocles.team.leadModel', 'gpt-5.2', 'user'],
  ];

  it('migrateLegacyEffortSetting then migrateLegacyModelSetting leave identical inspections', async () => {
    const results: Record<string, unknown>[] = [];
    for (const [, make] of IMPLS) {
      __config.reset();
      const store = make();
      await seed(store, SEED);
      await migrateLegacyEffortSetting(store);
      await migrateLegacyModelSetting(store);
      results.push(snapshot(store));
    }
    const [fake, vscode] = results;
    expect(fake).toStrictEqual(vscode);
    // The migrated-away effort is removed at user scope, not left as a present undefined.
    expect(fake!['damocles.effort']).toStrictEqual({});
    expect(fake!['damocles.team.reviewerModel']).toStrictEqual({});
    expect(fake!['damocles.team.leadModel']).toStrictEqual({ userValue: 'gpt-6-luna' });
    expect(fake!['damocles.model']).toStrictEqual({ projectValue: 'gpt-6.1-sol' });
  });
});
