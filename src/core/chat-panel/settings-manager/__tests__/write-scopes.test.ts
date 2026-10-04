import { describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { ConfigManager } from '../managers/config-manager';
import { ExploreManager } from '../managers/explore-manager';
import { writeSetting } from '../../message-router/setting-write';
import type { HandlerContext } from '../../message-router/types';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';
import type { FolderTarget } from '../../../workspace-folders/folder-registry';

const A = '/ws/a';
const folderA = { path: A };
const targetA: FolderTarget = { key: A, fsPath: A, name: 'a', label: 'a', projectScope: true };
const home: FolderTarget = { key: '~', fsPath: '/home/me', name: 'me', label: 'me', projectScope: false };

function setup(folders: Record<string, { project?: Record<string, unknown>; local?: Record<string, unknown> }> = {}, project: Record<string, unknown> = {}) {
  const platform = createFakePlatform({
    settings: { project, folders, scopeFiles: { user: '/home/me/.damocles/settings.json', project: `${A}/.damocles/settings.json`, local: `${A}/.damocles/settings.local.json` } },
  });
  const posted: ExtensionToWebviewMessage[] = [];
  const manager = new ConfigManager((_host, message) => posted.push(message), platform);
  return { platform, manager, posted };
}

describe('D37 write scopes', () => {
  it('saves a Workspace value in the chat folder\'s local layer, and a chat with no folder in user settings', async () => {
    const { platform, manager } = setup();
    await manager.handleSetBudgetLimit(5, folderA);
    await manager.handleSetTaskBudget(3, folderA);
    await manager.handleSetAutoCompact({ enabled: true, triggerPercent: 70 }, folderA);
    expect(platform.settings.inspect('damocles.maxBudgetUsd', folderA)).toStrictEqual({ localValue: 5 });
    expect(platform.settings.inspect('damocles.taskBudget', folderA)).toStrictEqual({ localValue: 3 });
    expect(platform.settings.inspect('damocles.autoCompact', folderA)).toStrictEqual({ localValue: { enabled: true, triggerPercent: 70 } });
    expect(platform.settings.inspect('damocles.maxBudgetUsd')).toStrictEqual({});

    await manager.handleSetBudgetLimit(9, undefined);
    expect(platform.settings.inspect('damocles.maxBudgetUsd')).toStrictEqual({ userValue: 9 });
  });

  it('saves a Defaults value in user settings', async () => {
    const { platform, manager } = setup();
    await manager.handleSetDefaultPermissionMode('plan', folderA);
    await manager.handleSetDefaultThinkingDisabled(true, folderA);
    await manager.handleSetIdeContextEnabled(false);
    expect(platform.settings.inspect('damocles.permissionMode', folderA)).toStrictEqual({ userValue: 'plan' });
    expect(platform.settings.inspect('damocles.thinkingDisabled', folderA)).toStrictEqual({ userValue: true });
    expect(platform.settings.inspect('damocles.ideContext.enabled')).toStrictEqual({ userValue: false });
  });

  it('writes to the file of higher precedence that already holds the value, for the chat\'s folder', async () => {
    const { platform, manager } = setup({ [A]: { project: { 'damocles.thinkingDisabled': false } } }, { 'damocles.ideContext.enabled': true });
    await manager.handleSetDefaultThinkingDisabled(true, folderA);
    expect(platform.settings.inspect('damocles.thinkingDisabled', folderA)).toStrictEqual({ projectValue: true });
    await manager.handleSetIdeContextEnabled(false);
    expect(platform.settings.inspect('damocles.ideContext.enabled')).toStrictEqual({ projectValue: false });
  });

  it('refuses a Workspace write in an untrusted folder with a reason, and still saves a chat with no folder to user settings', async () => {
    const { platform, manager } = setup();
    platform.trust.setTrusted(false);
    await expect(manager.handleSetBudgetLimit(5, folderA)).rejects.toThrow('This folder is not trusted, so its workspace settings cannot be saved.');
    await expect(manager.handleSetAutoCompact({ enabled: true, triggerPercent: 70 }, folderA)).rejects.toThrow('not trusted');
    expect(platform.settings.inspect('damocles.maxBudgetUsd', folderA)).toStrictEqual({});
    await manager.handleSetTaskBudget(3, undefined);
    expect(platform.settings.inspect('damocles.taskBudget')).toStrictEqual({ userValue: 3 });
  });

  it('tells the settings view whether the Workspace section can be written', async () => {
    const { platform, manager, posted } = setup();
    const permissionHandler = { getPermissionMode: () => 'default', getDangerouslySkipPermissions: () => false } as never;
    await manager.sendCurrentSettings({} as never, permissionHandler, folderA);
    platform.trust.setTrusted(false);
    await manager.sendCurrentSettings({} as never, permissionHandler, folderA);
    await manager.sendCurrentSettings({} as never, permissionHandler, undefined);
    expect(posted.map((m) => m.type === 'settingsUpdate' && m.workspaceWritable)).toStrictEqual([true, false, true]);
  });

  it('checks the checkpoint retention is a whole number of days in range', async () => {
    const { platform, manager } = setup();
    await manager.handleSetCheckpointRetentionDays(0);
    expect(platform.settings.get('damocles.checkpoints.retentionDays')).toBe(0);
    for (const bad of [-1, 1.5, Number.NaN, 1e9]) await expect(manager.handleSetCheckpointRetentionDays(bad)).rejects.toThrow(/whole number/);
  });
});

describe('settingWriteResult', () => {
  const ctx = (folder: FolderTarget): HandlerContext => ({ host: {} as never, folder } as unknown as HandlerContext);

  it('names the scope and file the value now comes from, the folder\'s for a per-chat key', async () => {
    const { platform, manager, posted } = setup({ [A]: { project: { 'damocles.thinkingDisabled': false } } });
    const deps = { platform, postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message) };
    await writeSetting(deps, ctx(targetA), 'damocles.maxBudgetUsd', (d) => d, () => manager.handleSetBudgetLimit(5, folderA));
    await writeSetting(deps, ctx(targetA), 'damocles.thinkingDisabled', (d) => d, () => manager.handleSetDefaultThinkingDisabled(true, folderA));
    await writeSetting(deps, ctx(home), 'damocles.maxBudgetUsd', (d) => d, () => manager.handleSetBudgetLimit(7, undefined));
    expect(posted.filter((m) => m.type === 'settingWriteResult')).toStrictEqual([
      { type: 'settingWriteResult', key: 'damocles.maxBudgetUsd', ok: true, scope: 'local', file: `${A}/.damocles/settings.local.json` },
      { type: 'settingWriteResult', key: 'damocles.thinkingDisabled', ok: true, scope: 'project', file: `${A}/.damocles/settings.json` },
      { type: 'settingWriteResult', key: 'damocles.maxBudgetUsd', ok: true, scope: 'user', file: '/home/me/.damocles/settings.json' },
    ]);
  });

  it('reports a write that leaves its key at the default as saved to the home scope, with no file', async () => {
    const { platform, posted } = setup();
    await platform.settings.update('damocles.explore.effort', 'high', 'user');
    const explore = new ExploreManager((_host, message) => posted.push(message), platform);
    const deps = { platform, postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message) };
    const saved = await writeSetting(deps, ctx(targetA), 'damocles.explore.effort', (d) => d, () => explore.setEffort(''));
    expect(saved).toBe(true);
    expect(platform.settings.inspect('damocles.explore.effort')).toStrictEqual({});
    expect(posted).toStrictEqual([{ type: 'settingWriteResult', key: 'damocles.explore.effort', ok: true, scope: 'user' }]);
  });

  it('reports where the key a setter actually wrote landed, under the key of the row that asked', async () => {
    const { platform, posted } = setup({}, { 'damocles.explore.enabled': true });
    const explore = new ExploreManager((_host, message) => posted.push(message), platform);
    const deps = { platform, postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message) };
    await writeSetting(deps, ctx(targetA), 'damocles.explore.provider', (d) => d, () => explore.setProvider('default'));
    expect(platform.settings.inspect('damocles.explore.enabled')).toStrictEqual({ projectValue: false });
    expect(posted).toStrictEqual([{ type: 'settingWriteResult', key: 'damocles.explore.provider', ok: true, scope: 'project', file: `${A}/.damocles/settings.json` }]);
  });

  it('settles an invalid value as a failed write instead of throwing', async () => {
    const { platform, posted } = setup();
    const explore = new ExploreManager((_host, message) => posted.push(message), platform);
    const deps = { platform, postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message) };
    await expect(writeSetting(deps, ctx(targetA), 'damocles.explore.effort', (d) => d, () => explore.setEffort('loud'))).resolves.toBe(false);
    await expect(writeSetting(deps, ctx(targetA), 'damocles.explore.provider', (d) => d, () => explore.setProvider('nowhere'))).resolves.toBe(false);
    expect(posted.filter((m) => m.type === 'settingWriteResult')).toStrictEqual([
      { type: 'settingWriteResult', key: 'damocles.explore.effort', ok: false, error: 'loud is not an effort level.' },
      { type: 'settingWriteResult', key: 'damocles.explore.provider', ok: false, error: 'nowhere is not an Explore provider.' },
    ]);
  });

  it('reports a failed write with its reason and tells the chat', async () => {
    const { platform, manager, posted } = setup();
    const deps = { platform, postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message) };
    const saved = await writeSetting(deps, ctx(targetA), 'damocles.checkpoints.retentionDays', (d) => `failed: ${d}`, () => manager.handleSetCheckpointRetentionDays(-1));
    expect(saved).toBe(false);
    expect(posted).toContainEqual(expect.objectContaining({ type: 'settingWriteResult', key: 'damocles.checkpoints.retentionDays', ok: false }));
    expect(posted).toContainEqual(expect.objectContaining({ type: 'notification', notificationType: 'error' }));
  });
});
