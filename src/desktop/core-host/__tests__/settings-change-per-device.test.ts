// A daemon's core whose chat two devices show: a change to one device's user layer, while the other device acts, re-sends
// the state built from that layer to that device's views alone.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-settings-per-device-'));
  return { tmpRoot: root, fakeHome: nodePath.join(root, 'home'), fakeWorkspace: nodePath.join(root, 'home', 'workspace') };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

import { ChatPanelProvider } from '../../../core/chat-panel';
import { ConfigManager } from '../../../core/chat-panel/settings-manager/managers/config-manager';
import { withSettingsViewScope } from '../../../core/chat-panel/settings-view-scope';
import { ASSET_SOURCE_PRECEDENCE_SETTING } from '../../../core/asset-sources';
import { PiRuntime } from '../../../core/pi-session/pi-runtime';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { parseContributedConfiguration } from '../../../core/config/contributed-configuration';
import { readContributedConfiguration } from '../../../core/config/read-contributed-configuration';
import { createHarness, folderEntry, makeMultiViewHost } from '../../../core/chat-panel/__tests__/panel-manager-harness';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { installFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { Disposable } from '../../../platform/disposable';
import type { PanelHost } from '../../../platform/window-service';
import type { TrustService } from '../../../platform/trust-service';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { DesktopSettingsStore } from '../../local-services/settings-store';
import { remoteSettings } from '../local';

const contributed = parseContributedConfiguration({
  contributes: {
    configuration: {
      properties: {
        'damocles.model': { default: '' },
        'damocles.thinkingDisabled': { default: false },
        'damocles.memory.judge': { default: 'auto' },
        'damocles.modelPicker.providers': { default: {} },
      },
    },
  },
});
const trustAll: TrustService = { isTrusted: () => true, onDidGrantTrust: () => ({ dispose: () => undefined }), requestTrust: () => Promise.resolve(true) };

const disposables: Disposable[] = [];
afterEach(async () => {
  for (const disposable of disposables.splice(0).reverse()) disposable.dispose();
  await PiRuntime.disposeInstance();
});
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Device-a and device-b each with a user layer, device-a acting, and a settings store reading them as a daemon's core does. */
function twoDevices(platform: Pick<FakePlatform, 'fileWatchers' | 'workspaceFolders' | 'localization'>) {
  const remote = createFakeRemoteHost();
  for (const [device, model] of [['device-a', 'claude-opus-5-5'], ['device-b', 'gpt-6.1-sol']] as const) {
    remote.set('clientAuth', device, { providers: {} });
    remote.set('clientUser', device, { settings: { 'damocles.model': model }, permissionRules: [] });
  }
  remote.setActing('device-a');
  const store = new DesktopSettingsStore({
    userFile: path.join(tmpRoot, 'machine', '.damocles', 'settings.json'),
    contributed,
    fileWatchers: platform.fileWatchers,
    projects: platform.workspaceFolders,
    trust: trustAll,
    chatFolders: { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) },
    notifications: undefined,
    log: () => undefined,
    remote: remoteSettings(remote.remote),
  });
  disposables.push(store);
  // device-b changes its own layer while device-a stays the acting client
  const changeOnB = (settings: Record<string, unknown>) =>
    remote.set('clientUser', 'device-b', { settings: { 'damocles.model': 'gpt-6.1-sol', ...settings }, permissionRules: [] });
  return { remote, store, changeOnB };
}

const VIEWS = [{ viewKey: 'view-a', clientId: 'device-a' }, { viewKey: 'view-b', clientId: 'device-b' }];

describe('a chat\'s settings and thinking state', () => {
  it('re-send to the views of the device whose user layer changed, built as that device', async () => {
    const settingsSends: PanelHost[] = [];
    const thinkingSends: PanelHost[] = [];
    const h = createHarness([folderEntry(fakeWorkspace)], {
      sendCurrentSettings: async (host) => void settingsSends.push(host),
      sendThinkingForPanel: (host) => void thinkingSends.push(host),
    });
    disposables.push({ dispose: () => h.dispose() });
    const { remote, store, changeOnB } = twoDevices(h.platform);
    Object.assign(h.platform, { settings: store, remote: remote.remote });
    const host = makeMultiViewHost();
    Object.assign(host, { views: () => VIEWS });
    await h.manager.restorePanel(host, folderKey(fakeWorkspace));
    settingsSends.length = 0;
    thinkingSends.length = 0;

    changeOnB({ 'damocles.thinkingDisabled': true });

    expect([settingsSends.map((sent) => sent.clientId), thinkingSends.map((sent) => sent.clientId)]).toEqual([['device-b'], ['device-b']]);
    await settingsSends[0]!.postMessage({ type: 'settingsUpdate' });
    expect([...host.toView.keys()]).toEqual(['view-b']);
    expect(host.posted.filter((m) => m.type === 'settingsUpdate')).toEqual([]);
  });
});

describe('the default model, the memory judge and the account state of a chat', () => {
  let platform: FakePlatform;
  let subscriptions: Disposable[];

  beforeEach(() => {
    fs.mkdirSync(fakeWorkspace, { recursive: true });
    for (const name of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) vi.stubEnv(name, '');
    platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: 'workspace' }] });
    subscriptions = [];
    disposables.push({ dispose: () => { for (const subscription of subscriptions) subscription.dispose(); vi.unstubAllEnvs(); } });
  });

  /** A ChatPanelProvider over the two devices' settings, with one chat view-a and view-b show. */
  function provider() {
    const { remote, store, changeOnB } = twoDevices(platform);
    Object.assign(platform, { settings: store, remote: remote.remote });
    const chat = new ChatPanelProvider(platform, {
      subscriptions,
      createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
    });
    const panels = (chat as unknown as { panelManager: { getPanels: () => Map<string, unknown> } }).panelManager.getPanels();
    const toView = new Map<string, ExtensionToWebviewMessage[]>([['view-a', []], ['view-b', []]]);
    const publishAccountInfo = vi.fn();
    panels.set('p1', {
      host: {
        views: () => VIEWS,
        viewHost: (viewKey: string) => ({ postMessage: async (m: ExtensionToWebviewMessage) => { toView.get(viewKey)!.push(m); return true; } }),
        postMessage: async (m: ExtensionToWebviewMessage) => { for (const shown of toView.values()) shown.push(m); return true; },
      },
      session: { publishAccountInfo, publishAvailableModels: vi.fn(), getToolStatus: () => ({}) },
      folder: { key: folderKey(fakeWorkspace), fsPath: fakeWorkspace, name: 'workspace', label: 'workspace', projectScope: true },
      permissionHandler: {},
      ideContextManager: {},
      disposables: [],
    });
    const of = <T extends ExtensionToWebviewMessage['type']>(viewKey: string, type: T) =>
      toView.get(viewKey)!.filter((m): m is Extract<ExtensionToWebviewMessage, { type: T }> => m.type === type);
    return { changeOnB, of, publishAccountInfo };
  }

  it('re-send device-b\'s new default model to its views alone', () => {
    const { changeOnB, of } = provider();

    changeOnB({ 'damocles.model': 'gpt-7' });

    expect([of('view-a', 'modelUpdate'), of('view-b', 'modelUpdate').map((m) => m.defaultModel)]).toEqual([[], ['gpt-7']]);
    expect(of('view-a', 'panelThinkingUpdate')).toEqual([]);
  });

  it('re-send device-b\'s memory judge status to its views alone, without dropping a broadcast to every device already reading', async () => {
    const { changeOnB, of } = provider();

    changeOnB({ 'damocles.memory.judge': 'jev-typesafe' });
    await vi.waitFor(() => expect(of('view-b', 'memoryJudgeStatus')).toHaveLength(1));
    expect(of('view-a', 'memoryJudgeStatus')).toEqual([]);

    PiRuntime.notifyMemoryJudgeChange();
    changeOnB({ 'damocles.memory.judge': 'auto' });
    await vi.waitFor(() => expect(of('view-a', 'memoryJudgeStatus')).toHaveLength(1));
  });

  it('republish device-b\'s account state alone when its model picker changes', () => {
    const { changeOnB, publishAccountInfo } = provider();

    changeOnB({ 'damocles.modelPicker.providers': { openai: false } });

    expect(publishAccountInfo.mock.calls).toEqual([['device-b']]);
  });
});

describe('the skill and command source precedence of a daemon\'s core', () => {
  const PRECEDENCE = ASSET_SOURCE_PRECEDENCE_SETTING;
  const hostFile = path.join(tmpRoot, 'host', '.damocles', 'settings.json');
  let platform: FakePlatform;

  beforeEach(() => {
    fs.mkdirSync(fakeWorkspace, { recursive: true });
    fs.mkdirSync(path.dirname(hostFile), { recursive: true });
    fs.writeFileSync(hostFile, '{}');
    platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: 'workspace' }] });
  });

  /** Two devices that both chose codex, device-a acting, over the shipped settings, and pi's runtime with one folder loaded. */
  async function daemon() {
    const remote = createFakeRemoteHost();
    for (const device of ['device-a', 'device-b']) {
      remote.set('clientAuth', device, { providers: {} });
      remote.set('clientUser', device, { settings: { [PRECEDENCE]: 'codex' }, permissionRules: [] });
    }
    remote.setActing('device-a');
    const store = new DesktopSettingsStore({
      userFile: hostFile,
      contributed: readContributedConfiguration(fileURLToPath(new URL('../../../../', import.meta.url))),
      fileWatchers: platform.fileWatchers,
      projects: platform.workspaceFolders,
      trust: trustAll,
      chatFolders: { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) },
      notifications: undefined,
      log: () => undefined,
      remote: remoteSettings(remote.remote),
    });
    disposables.push(store);
    Object.assign(platform, { settings: store, remote: remote.remote });
    const runtime = PiRuntime.get();
    await runtime.init();
    const reloads = vi.spyOn(await runtime.folder(fakeWorkspace), 'reloadBare');
    const changes = vi.fn();
    disposables.push(store.onDidChange(PRECEDENCE, changes));
    return { remote, store, reloads, changes };
  }

  // longer than pi-runtime's folder reload debounce
  const debounced = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600));

  it('a device\'s user change fires no change and reloads no folder', async () => {
    const { remote, store, reloads, changes } = await daemon();

    remote.set('clientUser', 'device-b', { settings: { [PRECEDENCE]: 'claude' }, permissionRules: [] });
    remote.set('clientUser', 'device-a', { settings: { [PRECEDENCE]: 'claude' }, permissionRules: [] });
    remote.setActing('device-b');
    await debounced();

    expect([changes.mock.calls.length, reloads.mock.calls.length, store.get(PRECEDENCE)]).toEqual([0, 0, 'claude']);
  }, 60_000);

  it('a host-tab write lands in the host file', async () => {
    const { remote, store, reloads, changes } = await daemon();
    const config = new ConfigManager(() => undefined, platform);

    await expect(config.handleSetAssetSourcePrecedence('codex')).rejects.toThrow('only in the User tab');
    await withSettingsViewScope('machine', () => config.handleSetAssetSourcePrecedence('codex'));
    await debounced();

    expect(JSON.parse(fs.readFileSync(hostFile, 'utf8'))).toEqual({ [PRECEDENCE]: 'codex' });
    expect([changes.mock.calls.length, reloads.mock.calls.length]).toEqual([1, 1]);
    expect([remote.remote.clients.user('device-a')?.settings, store.inspect(PRECEDENCE)]).toEqual([{ [PRECEDENCE]: 'codex' }, { defaultValue: 'claude', machineValue: 'codex' }]);
  }, 60_000);
});
