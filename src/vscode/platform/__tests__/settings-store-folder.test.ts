import { beforeEach, describe, expect, it } from 'vitest';
import { __config } from 'vscode';
import { VsCodeSettingsStore } from '../settings-store';

// The vscode mock applies the folder layer only to a configuration scoped to a resource, as VS Code does.
beforeEach(() => {
  __config.reset();
});

describe('VsCodeSettingsStore with a folder (D38)', () => {
  it('reads and writes a folder value through the folder as the configuration resource', async () => {
    const store = new VsCodeSettingsStore();
    const folder = { path: '/ws/b' };
    await store.update('damocles.maxBudgetUsd', 5, 'user');
    await store.update('damocles.maxBudgetUsd', 2, 'local', folder);
    expect(store.get('damocles.maxBudgetUsd', null, folder)).toBe(2);
    expect(store.inspect('damocles.maxBudgetUsd', folder)).toStrictEqual({ userValue: 5, localValue: 2 });
    expect(store.get('damocles.maxBudgetUsd', null)).toBe(5);
    expect(store.inspect('damocles.maxBudgetUsd')).toStrictEqual({ userValue: 5 });
  });

  it('cannot write folder settings without a folder, as VS Code refuses a WorkspaceFolder target with no resource', async () => {
    const store = new VsCodeSettingsStore();
    await expect(store.update('damocles.maxBudgetUsd', 2, 'local')).rejects.toThrow(/no resource/);
  });
});
