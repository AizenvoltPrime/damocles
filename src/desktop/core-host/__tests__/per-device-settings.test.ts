// A daemon's core's chat that two devices show: state read from the user layer reaches each device's views as that
// device's client reads it, never one device's copy on the other's views.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { ASSET_SOURCE_PRECEDENCE_SETTING } from '../../../core/asset-sources';
import { parseContributedConfiguration, type ContributedConfiguration } from '../../../core/config/contributed-configuration';
import { readContributedConfiguration } from '../../../core/config/read-contributed-configuration';
import { ConfigManager } from '../../../core/chat-panel/settings-manager/managers/config-manager';
import type { PermissionHandler } from '../../../core/permission-handler';
import type { Platform } from '../../../platform/platform';
import type { TrustService } from '../../../platform/trust-service';
import { processActor, type CoreEndpoint } from '../../core-protocol';
import { DesktopSettingsStore } from '../../local-services/settings-store';
import { remoteSettings } from '../local';
import { createCorePanels } from '../platform/panels';

const contributed = parseContributedConfiguration({
  contributes: { configuration: { properties: { 'damocles.showCacheMissNotices': { default: false } } } },
});
// the shipped package.json, whose scopes decide where a daemon's core reads each key
const shipped = readContributedConfiguration(fileURLToPath(new URL('../../../../', import.meta.url)));
const trustAll: TrustService = {
  isTrusted: () => true,
  onDidGrantTrust: () => ({ dispose: () => undefined }),
  requestTrust: () => Promise.resolve(true),
};

let dir: string | undefined;
const stores: DesktopSettingsStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * A settings store over `<tmp>/.damocles/settings.json`, which holds `file`: a daemon's core's (its host's machine file,
 * with the clients' layers from `remote`) or, without `remote`, a local core's user file.
 */
function storeOver(fake: ReturnType<typeof createFakePlatform>, settings: ContributedConfiguration, file: Record<string, unknown>, remote?: ReturnType<typeof createFakeRemoteHost>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-per-device-'));
  const settingsFile = path.join(dir, '.damocles', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(file));
  const store = new DesktopSettingsStore({
    userFile: settingsFile,
    contributed: settings,
    fileWatchers: fake.fileWatchers,
    projects: fake.workspaceFolders,
    trust: trustAll,
    chatFolders: { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) },
    notifications: undefined,
    log: () => undefined,
    ...(remote !== undefined
      ? { remote: remoteSettings(remote.remote) }
      : { defaultProject: { folder: () => undefined, onDidChange: () => ({ dispose: () => undefined }) } }),
  });
  stores.push(store);
  const rewrite = (next: Record<string, unknown>): void => {
    fs.writeFileSync(settingsFile, JSON.stringify(next));
    fake.fileWatchers.watcher(path.dirname(settingsFile), 'settings.json').fireChange(settingsFile);
  };
  return { store, settingsFile, rewrite };
}

/** A core panel proxy whose views main reports: view-a from device-a, view-b from device-b. */
function twoDeviceChat() {
  const posted: Array<{ readonly viewKey?: string; readonly message: { type: string; settings?: Record<string, unknown> } }> = [];
  let listener: ((panelId: string, envelope: unknown) => void) | undefined;
  const endpoint = {
    postPanel: (_id: string, op: string, payload: { json?: string; viewKey?: string }) => {
      if (op === 'post') posted.push({ ...(payload.viewKey !== undefined ? { viewKey: payload.viewKey } : {}), message: JSON.parse(payload.json!) });
    },
    request: () => Promise.resolve(),
    onPanel: (next: (panelId: string, envelope: unknown) => void) => {
      listener = next;
      return { dispose: () => undefined };
    },
    onMirror: () => ({ dispose: () => undefined }),
    emit: () => undefined,
  } as unknown as CoreEndpoint;
  const host = createCorePanels({ endpoint, resourceRoot: '/app' }).attach('view-1');
  for (const [device, viewKey] of [['device-a', 'view-a'], ['device-b', 'view-b']] as const) {
    processActor.run(device, () => listener!('view-1', { op: 'message', payload: { message: { type: 'ready' }, viewKey } }));
  }
  return { host, posted };
}

describe('settings a handler posts to a chat two devices show', () => {
  it('reach each device\'s views read from that device\'s user layer, with the chat\'s own mode in both', async () => {
    const remote = createFakeRemoteHost();
    remote.set('clientUser', 'device-a', { settings: { 'damocles.showCacheMissNotices': true }, permissionRules: [] });
    remote.set('clientUser', 'device-b', { settings: { 'damocles.showCacheMissNotices': false }, permissionRules: [] });
    remote.setActing('device-a');
    const fake = createFakePlatform({ capabilities: { settingsSources: false } });
    const { store } = storeOver(fake, contributed, {}, remote);
    const platform = { ...fake, settings: store, remote: remote.remote } as unknown as Platform;
    const { host, posted } = twoDeviceChat();
    const permissionHandler = { getPermissionMode: () => 'plan', getDangerouslySkipPermissions: () => false } as unknown as PermissionHandler;

    await new ConfigManager((target, message) => void target.postMessage(message), platform).sendCurrentSettings(host, permissionHandler, undefined);

    expect(posted.map(({ viewKey, message }) => [viewKey, message.type, message.settings?.showCacheMissNotices, message.settings?.permissionMode])).toEqual([
      ['view-a', 'settingsUpdate', true, 'plan'],
      ['view-b', 'settingsUpdate', false, 'plan'],
    ]);
  });
});

const PRECEDENCE = ASSET_SOURCE_PRECEDENCE_SETTING;
const WAKE_WORD = 'damocles.voice.wakeWord';
const permissionHandler = { getPermissionMode: () => 'plan', getDangerouslySkipPermissions: () => false } as unknown as PermissionHandler;

/** Device-a and device-b with these user layers, device-a acting, over a daemon's core's store of the shipped settings. */
function daemonOf(hostFile: Record<string, unknown>, layers: Readonly<Record<'device-a' | 'device-b', Record<string, unknown>>>) {
  const remote = createFakeRemoteHost();
  for (const device of ['device-a', 'device-b'] as const) remote.set('clientUser', device, { settings: layers[device], permissionRules: [] });
  remote.setActing('device-a');
  const fake = createFakePlatform({ capabilities: { settingsSources: false } });
  return { remote, fake, ...storeOver(fake, shipped, hostFile, remote) };
}

describe('the skill and command source precedence', () => {
  it('devices with different user values both read the host file\'s precedence', async () => {
    const { remote, fake, store, rewrite } = daemonOf({}, { 'device-a': { [PRECEDENCE]: 'codex' }, 'device-b': { [PRECEDENCE]: 'claude' } });
    const platform = { ...fake, settings: store, remote: remote.remote } as unknown as Platform;
    const { host, posted } = twoDeviceChat();
    const sent = async (): Promise<unknown[][]> => {
      posted.length = 0;
      await new ConfigManager((target, message) => void target.postMessage(message), platform).sendCurrentSettings(host, permissionHandler, undefined);
      return posted.map(({ viewKey, message }) => [viewKey, message.settings?.assetSourcePrecedence]);
    };

    expect(await sent()).toEqual([['view-a', 'claude'], ['view-b', 'claude']]);

    rewrite({ [PRECEDENCE]: 'codex' });

    expect(await sent()).toEqual([['view-a', 'codex'], ['view-b', 'codex']]);
    for (const device of ['device-a', 'device-b']) {
      remote.setActing(device);
      expect(store.inspect(PRECEDENCE), device).toEqual({ defaultValue: 'claude', machineValue: 'codex' });
    }
  });

  it('a local core reads the user file as before', async () => {
    const fake = createFakePlatform({ capabilities: { settingsSources: false } });
    const { store, settingsFile, rewrite } = storeOver(fake, shipped, { [PRECEDENCE]: 'codex' });
    const changes = vi.fn();
    store.onDidChange(PRECEDENCE, changes);

    expect(store.inspect(PRECEDENCE)).toEqual({ defaultValue: 'claude', userValue: 'codex' });
    rewrite({ [PRECEDENCE]: 'claude' });
    expect([changes.mock.calls.length, store.get(PRECEDENCE)]).toEqual([1, 'claude']);

    await store.update(PRECEDENCE, 'codex', 'user');
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toEqual({ [PRECEDENCE]: 'codex' });
  });
});

describe('a voice key on a daemon\'s core', () => {
  it('is still read from no layer', () => {
    const { remote, store } = daemonOf({ [WAKE_WORD]: 'hey host' }, { 'device-a': { [WAKE_WORD]: 'hey device' }, 'device-b': {} });
    const changes = vi.fn();
    store.onDidChange(WAKE_WORD, changes);

    expect([store.inspect(WAKE_WORD), store.get(WAKE_WORD)]).toEqual([{ defaultValue: 'hey jarvis' }, 'hey jarvis']);
    remote.set('clientUser', 'device-b', { settings: { [WAKE_WORD]: 'hey other' }, permissionRules: [] });
    remote.setActing('device-b');
    expect([store.get(WAKE_WORD), changes.mock.calls.length]).toEqual(['hey jarvis', 0]);
  });
});
