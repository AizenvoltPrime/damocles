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

  it('drops an effort stored under a retired id of the model when its default effort is set or cleared', async () => {
    const { platform, manager } = setup();
    await platform.settings.update('damocles.effortByModel', { 'step-3.7-flash': 'high', 'deepseek-v4-flash': 'max', 'claude-opus-5-5': 'low' }, 'user');
    await manager.handleSetDefaultEffort(null, 'step-5-preview', undefined);
    await manager.handleSetDefaultEffort('low', 'deepseek-flash', undefined);
    expect(platform.settings.inspect('damocles.effortByModel')).toStrictEqual({ userValue: { 'claude-opus-5-5': 'low', 'deepseek-flash': 'low' } });
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

describe('subagent, notice, source, memory and browser setters', () => {
  const permissionHandler = { getPermissionMode: () => 'default', getDangerouslySkipPermissions: () => false } as never;

  it('saves the per-chat keys in the chat folder\'s local layer, and refuses them in an untrusted folder', async () => {
    const { platform, manager } = setup();
    await manager.handleSetSubagentsMaxConcurrent(8, folderA);
    await manager.handleSetShowCacheMissNotices(true, folderA);
    await manager.handleSetShowThinkingDroppedNotices(false, folderA);
    expect(platform.settings.inspect('damocles.subagents.maxConcurrent', folderA)).toStrictEqual({ localValue: 8 });
    expect(platform.settings.inspect('damocles.showCacheMissNotices', folderA)).toStrictEqual({ localValue: true });
    expect(platform.settings.inspect('damocles.showThinkingDroppedNotices', folderA)).toStrictEqual({ localValue: false });

    platform.trust.setTrusted(false);
    await expect(manager.handleSetSubagentsMaxConcurrent(2, folderA)).rejects.toThrow('not trusted');
    await expect(manager.handleSetShowCacheMissNotices(false, folderA)).rejects.toThrow('not trusted');
    await expect(manager.handleSetShowThinkingDroppedNotices(true, folderA)).rejects.toThrow('not trusted');
  });

  it('saves the window-level keys in user settings', async () => {
    const { platform, manager } = setup();
    await manager.handleSetAssetSourcePrecedence('codex');
    await manager.handleSetMemoryAutoExtract(false);
    await manager.handleSetMemoryProfile(false);
    await manager.handleSetBrowserHeadless(false);
    expect(platform.settings.inspect('damocles.assetSourcePrecedence')).toStrictEqual({ userValue: 'codex' });
    expect(platform.settings.inspect('damocles.memory.autoExtract.enabled')).toStrictEqual({ userValue: false });
    expect(platform.settings.inspect('damocles.memory.profile.enabled')).toStrictEqual({ userValue: false });
    expect(platform.settings.inspect('damocles.browser.headless')).toStrictEqual({ userValue: false });
  });

  it('saves the source and checkpoint retention in user settings even where a project file holds them, since both are user-only', async () => {
    const { platform, manager } = setup({}, { 'damocles.assetSourcePrecedence': 'claude', 'damocles.checkpoints.retentionDays': 7 });
    expect(await manager.handleSetAssetSourcePrecedence('codex')).toStrictEqual({ key: 'damocles.assetSourcePrecedence', home: 'user' });
    expect(await manager.handleSetCheckpointRetentionDays(3)).toStrictEqual({ key: 'damocles.checkpoints.retentionDays', home: 'user' });
    expect(platform.settings.inspect('damocles.assetSourcePrecedence')).toMatchObject({ userValue: 'codex', projectValue: 'claude' });
    expect(platform.settings.inspect('damocles.checkpoints.retentionDays')).toMatchObject({ userValue: 3, projectValue: 7 });
  });

  it('refuses a switch value that is not a boolean and writes nothing', async () => {
    const { platform, manager } = setup();
    const switches: [string, (value: never) => Promise<unknown>][] = [
      ['damocles.showCacheMissNotices', (v) => manager.handleSetShowCacheMissNotices(v, folderA)],
      ['damocles.showThinkingDroppedNotices', (v) => manager.handleSetShowThinkingDroppedNotices(v, folderA)],
      ['damocles.memory.autoExtract.enabled', (v) => manager.handleSetMemoryAutoExtract(v)],
      ['damocles.memory.profile.enabled', (v) => manager.handleSetMemoryProfile(v)],
      ['damocles.browser.headless', (v) => manager.handleSetBrowserHeadless(v)],
      ['damocles.dangerouslySkipPermissions', (v) => manager.handleSetDefaultDangerouslySkipPermissions(v, folderA)],
      ['damocles.thinkingDisabled', (v) => manager.handleSetDefaultThinkingDisabled(v, folderA)],
      ['damocles.ideContext.enabled', (v) => manager.handleSetIdeContextEnabled(v)],
      ['damocles.pinnedHeaderHidden', (v) => manager.handleSetPinnedHeaderHidden(v)],
    ];
    for (const [key, set] of switches) {
      for (const bad of ['false', 1, null, undefined, {}]) await expect(set(bad as never)).rejects.toThrow('A switch setting must be true or false');
      expect(platform.settings.inspect(key, folderA)).toStrictEqual({});
    }
  });

  it('rejects a subagent limit outside 1 to 16 or not whole, and an unknown source', async () => {
    const { platform, manager } = setup();
    for (const bad of [0, 17, 1.5, Number.NaN]) await expect(manager.handleSetSubagentsMaxConcurrent(bad, folderA)).rejects.toThrow(/whole number from 1 to 16/);
    await expect(manager.handleSetAssetSourcePrecedence('pi')).rejects.toThrow(/not a skill and command source/);
    expect(platform.settings.inspect('damocles.subagents.maxConcurrent', folderA)).toStrictEqual({});
    expect(platform.settings.inspect('damocles.assetSourcePrecedence')).toStrictEqual({});
  });

  it('sends the per-chat keys for the chat\'s folder and the defaults when nothing is set', async () => {
    const sent = async (folders: Parameters<typeof setup>[0]) => {
      const { manager, posted } = setup(folders);
      await manager.sendCurrentSettings({} as never, permissionHandler, folderA);
      const update = posted.find((m) => m.type === 'settingsUpdate');
      if (update?.type !== 'settingsUpdate') throw new Error('no settingsUpdate posted');
      const { subagentsMaxConcurrent, showCacheMissNotices, showThinkingDroppedNotices, assetSourcePrecedence, memoryAutoExtract, memoryProfile, browserHeadless } = update.settings;
      return { subagentsMaxConcurrent, showCacheMissNotices, showThinkingDroppedNotices, assetSourcePrecedence, memoryAutoExtract, memoryProfile, browserHeadless };
    };
    expect(await sent({})).toStrictEqual({
      subagentsMaxConcurrent: 4,
      showCacheMissNotices: false,
      showThinkingDroppedNotices: true,
      assetSourcePrecedence: 'claude',
      memoryAutoExtract: true,
      memoryProfile: true,
      browserHeadless: true,
    });
    expect(await sent({ [A]: { local: { 'damocles.subagents.maxConcurrent': 9, 'damocles.showCacheMissNotices': true } } })).toMatchObject({
      subagentsMaxConcurrent: 9,
      showCacheMissNotices: true,
    });
    // The row shows the limit the engine runs with, not a stored value outside it.
    expect(await sent({ [A]: { local: { 'damocles.subagents.maxConcurrent': 32 } } })).toMatchObject({ subagentsMaxConcurrent: 16 });
    expect(await sent({ [A]: { local: { 'damocles.subagents.maxConcurrent': '8' } } })).toMatchObject({ subagentsMaxConcurrent: 4 });
  });
});

describe('Background model setters', () => {
  it('saves the model and effort in user settings', async () => {
    const { platform, manager } = setup();
    expect(await manager.handleSetBackgroundModel('claude-sonnet-5-5')).toStrictEqual({ key: 'damocles.background.model', home: 'user' });
    expect(await manager.handleSetBackgroundEffort('high')).toStrictEqual({ key: 'damocles.background.effort', home: 'user' });
    expect(platform.settings.inspect('damocles.background.model')).toStrictEqual({ userValue: 'claude-sonnet-5-5' });
    expect(platform.settings.inspect('damocles.background.effort')).toStrictEqual({ userValue: 'high' });
  });

  it('clears an effort the new model does not support, and keeps one it does', async () => {
    const { platform, manager } = setup();
    await manager.handleSetBackgroundModel('claude-sonnet-5-5');
    await manager.handleSetBackgroundEffort('ultracode');
    await manager.handleSetBackgroundModel('claude-haiku-5-5');
    expect(platform.settings.get('damocles.background.effort')).toBe('ultracode');
    await manager.handleSetBackgroundModel('gpt-6-luna');
    expect(platform.settings.inspect('damocles.background.effort')).toStrictEqual({});
  });

  it('removes both keys when the model goes back to Automatic', async () => {
    const { platform, manager } = setup();
    await manager.handleSetBackgroundModel('step-5-preview');
    await manager.handleSetBackgroundEffort('medium');
    await manager.handleSetBackgroundModel('');
    expect(platform.settings.inspect('damocles.background.model')).toStrictEqual({});
    expect(platform.settings.inspect('damocles.background.effort')).toStrictEqual({});
  });

  it('rejects an effort on Automatic, an effort the model lacks and a model outside the catalog', async () => {
    const { platform, manager } = setup();
    await expect(manager.handleSetBackgroundEffort('low')).rejects.toThrow('Automatic sets the effort of each job itself.');
    await manager.handleSetBackgroundModel('step-5-preview');
    await expect(manager.handleSetBackgroundEffort('max')).rejects.toThrow(/not supported/);
    await expect(manager.handleSetBackgroundModel('claude-3-opus')).rejects.toThrow(/not a known model/);
    expect(platform.settings.inspect('damocles.background.effort')).toStrictEqual({});
    expect(platform.settings.get('damocles.background.model')).toBe('step-5-preview');
  });

  it('sends the stored Background pair with a retired id mapped and an unsupported effort dropped', async () => {
    const permissionHandler = { getPermissionMode: () => 'default', getDangerouslySkipPermissions: () => false } as never;
    const sent = async (user: Record<string, unknown>) => {
      const posted: ExtensionToWebviewMessage[] = [];
      const manager = new ConfigManager((_host, message) => posted.push(message), createFakePlatform({ settings: { user } }));
      await manager.sendCurrentSettings({} as never, permissionHandler, folderA);
      const update = posted.find((m) => m.type === 'settingsUpdate');
      return update?.type === 'settingsUpdate' ? update.settings.background : undefined;
    };
    expect(await sent({})).toStrictEqual({ model: '', effort: null });
    expect(await sent({ 'damocles.background.model': 'step-3.7-flash', 'damocles.background.effort': 'high' })).toStrictEqual({ model: 'step-5-preview', effort: 'high' });
    expect(await sent({ 'damocles.background.model': 'step-5-preview', 'damocles.background.effort': 'max' })).toStrictEqual({ model: 'step-5-preview', effort: null });
  });
});

describe('Memory judge setters', () => {
  it('saves a chosen model and its effort in user settings', async () => {
    const { platform, manager } = setup();
    expect(await manager.handleSetMemoryJudge('claude-sonnet-5-5')).toStrictEqual({ key: 'damocles.memory.judge', home: 'user' });
    expect(await manager.handleSetMemoryJudgeEffort('high')).toStrictEqual({ key: 'damocles.memory.judgeEffort', home: 'user' });
    expect(platform.settings.inspect('damocles.memory.judge')).toStrictEqual({ userValue: 'claude-sonnet-5-5' });
    expect(platform.settings.inspect('damocles.memory.judgeEffort')).toStrictEqual({ userValue: 'high' });
  });

  it('clears the effort on a classifier, on Automatic and on a model without that level', async () => {
    const { platform, manager } = setup();
    await manager.handleSetMemoryJudge('claude-sonnet-5-5');
    await manager.handleSetMemoryJudgeEffort('ultracode');
    await manager.handleSetMemoryJudge('claude-haiku-5-5');
    expect(platform.settings.get('damocles.memory.judgeEffort')).toBe('ultracode');
    await manager.handleSetMemoryJudge('gpt-6-luna-classifier');
    expect(platform.settings.inspect('damocles.memory.judgeEffort')).toStrictEqual({});
    expect(platform.settings.inspect('damocles.memory.judge')).toStrictEqual({ userValue: 'gpt-6-luna-classifier' });

    await manager.handleSetMemoryJudge('step-5-preview');
    await manager.handleSetMemoryJudgeEffort('medium');
    await manager.handleSetMemoryJudge('');
    expect(platform.settings.inspect('damocles.memory.judge')).toStrictEqual({});
    expect(platform.settings.inspect('damocles.memory.judgeEffort')).toStrictEqual({});
  });

  it('rejects an effort unless a model is chosen, an effort the model lacks and an unknown judge', async () => {
    const { platform, manager } = setup();
    await expect(manager.handleSetMemoryJudgeEffort('low')).rejects.toThrow('Only a model chosen as the memory judge takes an effort.');
    await manager.handleSetMemoryJudge('jev-typesafe');
    await expect(manager.handleSetMemoryJudgeEffort('low')).rejects.toThrow('Only a model chosen as the memory judge takes an effort.');
    await manager.handleSetMemoryJudge('step-5-preview');
    await expect(manager.handleSetMemoryJudgeEffort('max')).rejects.toThrow(/not supported/);
    await expect(manager.handleSetMemoryJudge('jev-somewhere')).rejects.toThrow(/not a known memory judge/);
    expect(platform.settings.inspect('damocles.memory.judgeEffort')).toStrictEqual({});
    expect(platform.settings.get('damocles.memory.judge')).toBe('step-5-preview');
  });

  it('sends the stored judge pair with a retired id mapped and an effort the choice does not take dropped', async () => {
    const permissionHandler = { getPermissionMode: () => 'default', getDangerouslySkipPermissions: () => false } as never;
    const sent = async (user: Record<string, unknown>) => {
      const posted: ExtensionToWebviewMessage[] = [];
      const manager = new ConfigManager((_host, message) => posted.push(message), createFakePlatform({ settings: { user } }));
      await manager.sendCurrentSettings({} as never, permissionHandler, folderA);
      const update = posted.find((m) => m.type === 'settingsUpdate');
      return update?.type === 'settingsUpdate' ? update.settings.judge : undefined;
    };
    expect(await sent({})).toStrictEqual({ choice: '', effort: null });
    expect(await sent({ 'damocles.memory.judge': 'step-3.7-flash', 'damocles.memory.judgeEffort': 'high' })).toStrictEqual({ choice: 'step-5-preview', effort: 'high' });
    expect(await sent({ 'damocles.memory.judge': 'jev-openrouter', 'damocles.memory.judgeEffort': 'high' })).toStrictEqual({ choice: 'jev-openrouter', effort: null });
  });
});

describe('Explore model setters', () => {
  const explore = (platform: ReturnType<typeof setup>['platform']) => new ExploreManager(platform);

  it('saves a picked model and its effort in user settings', async () => {
    const { platform } = setup();
    expect(await explore(platform).setModel('claude-sonnet-5-5')).toStrictEqual({ key: 'damocles.explore.model', home: 'user' });
    expect(await explore(platform).setEffort('high')).toStrictEqual({ key: 'damocles.explore.effort', home: 'user' });
    expect(platform.settings.inspect('damocles.explore.model')).toStrictEqual({ userValue: 'claude-sonnet-5-5' });
    expect(platform.settings.inspect('damocles.explore.effort')).toStrictEqual({ userValue: 'high' });
  });

  it('writes user settings even where a project file holds a value, which never applies to these keys', async () => {
    const { platform } = setup({}, { 'damocles.explore.model': 'claude-haiku-5-5', 'damocles.explore.effort': 'low' });
    await explore(platform).setModel('gpt-6-luna');
    await explore(platform).setEffort('high');
    expect(platform.settings.inspect('damocles.explore.model')).toStrictEqual({ userValue: 'gpt-6-luna', projectValue: 'claude-haiku-5-5' });
    expect(platform.settings.inspect('damocles.explore.effort')).toStrictEqual({ userValue: 'high', projectValue: 'low' });
  });

  it('clears an effort the new model does not support, and every effort on Default', async () => {
    const { platform } = setup();
    await explore(platform).setModel('claude-sonnet-5-5');
    await explore(platform).setEffort('xhigh');
    await explore(platform).setModel('claude-opus-5-5');
    expect(platform.settings.get('damocles.explore.effort')).toBe('xhigh');
    await explore(platform).setModel('step-5-preview');
    expect(platform.settings.inspect('damocles.explore.effort')).toStrictEqual({});
    await explore(platform).setEffort('high');
    await explore(platform).setModel('');
    expect(platform.settings.inspect('damocles.explore.model')).toStrictEqual({});
    expect(platform.settings.inspect('damocles.explore.effort')).toStrictEqual({});
  });

  it('rejects an effort on Default, an unsupported effort and an unknown model', async () => {
    const { platform } = setup();
    await expect(explore(platform).setEffort('low')).rejects.toThrow('Default runs Explore at medium effort.');
    await explore(platform).setModel('step-5-preview');
    await expect(explore(platform).setEffort('max')).rejects.toThrow(/not supported/);
    await expect(explore(platform).setModel('gemini-3-flash-preview')).rejects.toThrow(/not a known model/);
    expect(platform.settings.inspect('damocles.explore.effort')).toStrictEqual({});
    expect(platform.settings.get('damocles.explore.model')).toBe('step-5-preview');
  });

  it('refuses none on GPT-6 Luna, which offers it to chats only', async () => {
    const { platform } = setup();
    await explore(platform).setModel('gpt-6-luna');
    await expect(explore(platform).setEffort('none')).rejects.toThrow(/not supported/);
    expect(platform.settings.inspect('damocles.explore.effort')).toStrictEqual({});
  });

  it('sends the stored Explore pair with a retired id mapped and an unsupported effort dropped', async () => {
    const permissionHandler = { getPermissionMode: () => 'default', getDangerouslySkipPermissions: () => false } as never;
    const sent = async (user: Record<string, unknown>) => {
      const posted: ExtensionToWebviewMessage[] = [];
      const manager = new ConfigManager((_host, message) => posted.push(message), createFakePlatform({ settings: { user } }));
      await manager.sendCurrentSettings({} as never, permissionHandler, folderA);
      const update = posted.find((m) => m.type === 'settingsUpdate');
      return update?.type === 'settingsUpdate' ? update.settings.explore : undefined;
    };
    expect(await sent({})).toStrictEqual({ model: '', effort: null });
    expect(await sent({ 'damocles.explore.model': 'step-3.7-flash', 'damocles.explore.effort': 'high' })).toStrictEqual({ model: 'step-5-preview', effort: 'high' });
    expect(await sent({ 'damocles.explore.model': 'step-5-preview', 'damocles.explore.effort': 'max' })).toStrictEqual({ model: 'step-5-preview', effort: null });
    expect(await sent({ 'damocles.explore.model': 'gpt-6-luna', 'damocles.explore.effort': 'none' })).toStrictEqual({ model: 'gpt-6-luna', effort: null });
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
    await platform.settings.update('damocles.explore.model', 'step-5-preview', 'user');
    await platform.settings.update('damocles.explore.effort', 'high', 'user');
    const explore = new ExploreManager(platform);
    const deps = { platform, postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message) };
    const saved = await writeSetting(deps, ctx(targetA), 'damocles.explore.effort', (d) => d, () => explore.setEffort(null));
    expect(saved).toBe(true);
    expect(platform.settings.inspect('damocles.explore.effort')).toStrictEqual({});
    expect(posted).toStrictEqual([{ type: 'settingWriteResult', key: 'damocles.explore.effort', ok: true, scope: 'user' }]);
  });

  it('reports where a window-level write landed, the project file that held the value', async () => {
    const { platform, manager, posted } = setup({}, { 'damocles.ideContext.enabled': true });
    const deps = { platform, postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message) };
    await writeSetting(deps, ctx(targetA), 'damocles.ideContext.enabled', (d) => d, () => manager.handleSetIdeContextEnabled(false));
    expect(platform.settings.inspect('damocles.ideContext.enabled')).toStrictEqual({ projectValue: false });
    expect(posted).toStrictEqual([{ type: 'settingWriteResult', key: 'damocles.ideContext.enabled', ok: true, scope: 'project', file: `${A}/.damocles/settings.json` }]);
  });

  it('settles an invalid value as a failed write instead of throwing', async () => {
    const { platform, posted } = setup();
    const explore = new ExploreManager(platform);
    const deps = { platform, postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message) };
    await expect(writeSetting(deps, ctx(targetA), 'damocles.explore.model', (d) => d, () => explore.setModel('nowhere'))).resolves.toBe(false);
    expect(posted.filter((m) => m.type === 'settingWriteResult')).toStrictEqual([
      { type: 'settingWriteResult', key: 'damocles.explore.model', ok: false, error: { message: 'Model "{0}" is not a known model', args: ['nowhere'] } },
    ]);
  });

  it('reports a failed write with its reason and tells the chat', async () => {
    const { platform, manager, posted } = setup();
    const deps = { platform, postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message) };
    const saved = await writeSetting(deps, ctx(targetA), 'damocles.checkpoints.retentionDays', (d) => ({ message: 'failed: {0}', args: [d] }), () => manager.handleSetCheckpointRetentionDays(-1));
    expect(saved).toBe(false);
    expect(posted).toContainEqual(expect.objectContaining({ type: 'settingWriteResult', key: 'damocles.checkpoints.retentionDays', ok: false }));
    expect(posted).toContainEqual(expect.objectContaining({ type: 'notification', notificationType: 'error' }));
  });
});
