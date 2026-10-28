// A daemon's core's chat that two devices show: state read from the user layer reaches each device's views as that
// device's client reads it, never one device's copy on the other's views.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { parseContributedConfiguration } from '../../../core/config/contributed-configuration';
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-per-device-'));
    const fake = createFakePlatform({ capabilities: { settingsSources: false } });
    const store = new DesktopSettingsStore({
      userFile: path.join(dir, '.damocles', 'settings.json'),
      contributed,
      fileWatchers: fake.fileWatchers,
      projects: fake.workspaceFolders,
      trust: trustAll,
      chatFolders: { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) },
      notifications: undefined,
      localization: fake.localization,
      log: () => undefined,
      remote: remoteSettings(remote.remote),
    });
    stores.push(store);
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
