// A daemon's core: the default model is a user-layer setting, so each device's views show its own and a new chat takes
// the default of the device that opened it, whichever device acted last.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { parseContributedConfiguration } from '../../../core/config/contributed-configuration';
import { ModelManager } from '../../../core/chat-panel/settings-manager/managers/model-manager';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { Platform } from '../../../platform/platform';
import type { PanelHost } from '../../../platform/window-service';
import type { TrustService } from '../../../platform/trust-service';
import { DesktopSettingsStore } from '../../local-services/settings-store';
import { remoteSettings } from '../local';

const contributed = parseContributedConfiguration({ contributes: { configuration: { properties: { 'damocles.model': { default: '' } } } } });
const trustAll: TrustService = { isTrusted: () => true, onDidGrantTrust: () => ({ dispose: () => undefined }), requestTrust: () => Promise.resolve(true) };

let dir: string | undefined;
const disposables: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Device-a's default is claude-opus-5-5, device-b's gpt-6.1-sol; a panel view-a and view-b show, one per device. */
function twoDevices() {
  const remote = createFakeRemoteHost();
  for (const [device, model] of [['device-a', 'claude-opus-5-5'], ['device-b', 'gpt-6.1-sol']] as const) {
    remote.set('clientAuth', device, { providers: {} });
    remote.set('clientUser', device, { settings: { 'damocles.model': model }, permissionRules: [] });
  }
  remote.setActing('device-a');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-default-model-'));
  const fake = createFakePlatform();
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
  const platform = { ...fake, settings: store, remote: remote.remote } as unknown as Platform;
  const toView = new Map<string, ExtensionToWebviewMessage[]>([['view-a', []], ['view-b', []]]);
  const views = [{ viewKey: 'view-a', clientId: 'device-a' }, { viewKey: 'view-b', clientId: 'device-b' }];
  const panel = {
    postMessage: async (message: ExtensionToWebviewMessage) => { for (const posted of toView.values()) posted.push(message); },
    views: () => views,
    viewHost: (viewKey: string) => ({ postMessage: async (message: ExtensionToWebviewMessage) => void toView.get(viewKey)!.push(message) }),
  } as unknown as PanelHost;
  const models = new ModelManager((host, message) => void host.postMessage(message), platform);
  disposables.push(models, store);
  const defaults = (viewKey: string) => toView.get(viewKey)!.flatMap((m) => (m.type === 'modelUpdate' ? [m.defaultModel] : []));
  return { remote, models, panel, defaults };
}

describe('the default model on a daemon\'s core', () => {
  it('reaches each device\'s views as that device set it, after the other device acted', () => {
    const { remote, models, panel, defaults } = twoDevices();
    models.initPanelModel('panel-1');
    remote.setActing('device-b');

    models.sendModelForPanel(panel, 'panel-1');

    expect([defaults('view-a'), defaults('view-b')]).toEqual([['claude-opus-5-5'], ['gpt-6.1-sol']]);
  });

  it('starts a new chat on the default of the device that opened it', () => {
    const { remote, models } = twoDevices();

    remote.setActor('device-b');
    models.initPanelModel('panel-b');
    remote.setActor(undefined);

    expect(models.getConfiguredModelForPanel('panel-b')).toBe('gpt-6.1-sol');
  });
});
