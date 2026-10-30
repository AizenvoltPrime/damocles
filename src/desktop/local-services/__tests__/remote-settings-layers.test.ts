import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { parseContributedConfiguration } from '../../../core/config/contributed-configuration';
import type { SettingsObject } from '../../../core/config/settings-file';
import type { TrustService } from '../../../platform/trust-service';
import { DesktopSettingsStore, type ClientSettingsChange, type RemoteSettings } from '../settings-store';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { runPinnedTurn } from '../../../core/client-snapshots';
import { remoteSettings } from '../../core-host/local';

// A daemon's core layers its settings: defaults < the client's user layer (clientUser, memory only) < the target's
// ~/.damocles/settings.json (machine) < the trusted project and local files.
const contributed = parseContributedConfiguration({
  contributes: {
    configuration: {
      properties: {
        'damocles.model': { default: 'default-model' },
        'damocles.permissionMode': { default: 'default', scope: 'resource' },
        'damocles.voice.wakeWord': { default: 'jarvis', scope: 'machine' },
        'damocles.cacheWarming': { default: 'off', scope: 'application' },
      },
    },
  },
});

const trustAll: TrustService = {
  isTrusted: () => true,
  onDidGrantTrust: () => ({ dispose: () => undefined }),
  requestTrust: () => Promise.resolve(true),
};

let dir: string;
let machineFile: string;
let project: string;
let fromHostTab = false;
let client: SettingsObject = {};
const clientListeners = new Set<(change: ClientSettingsChange) => void>();
const stores: DesktopSettingsStore[] = [];

function write(file: string, value: SettingsObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function remoteStore(remote: RemoteSettings = {
  fromHostTab: () => fromHostTab,
  clientSettings: () => client,
  onDidChangeClientSettings: (cb) => {
    clientListeners.add(cb);
    return { dispose: () => { clientListeners.delete(cb); } };
  },
}): DesktopSettingsStore {
  const fake = createFakePlatform({ folders: [{ fsPath: project, name: 'project' }] });
  const store = new DesktopSettingsStore({
    userFile: machineFile,
    contributed,
    fileWatchers: fake.fileWatchers,
    projects: fake.workspaceFolders,
    trust: trustAll,
    chatFolders: { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) },
    notifications: undefined,
    log: () => undefined,
    remote,
  });
  stores.push(store);
  return store;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-remote-layers-'));
  machineFile = path.join(dir, 'target-home', '.damocles', 'settings.json');
  project = path.join(dir, 'project');
  fromHostTab = false;
  client = {};
});

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  clientListeners.clear();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a daemon\'s core\'s settings layers', () => {
  it('read the client\'s user layer, under the machine file, under the trusted project file', () => {
    client = { 'damocles.model': 'client-model', 'damocles.permissionMode': 'plan' };
    write(machineFile, { 'damocles.permissionMode': 'acceptEdits' });
    write(path.join(project, '.damocles', 'settings.json'), {});
    const store = remoteStore();
    expect(store.inspect('damocles.model')).toEqual({ defaultValue: 'default-model', userValue: 'client-model' });
    expect(store.get('damocles.model')).toBe('client-model');
    expect(store.get('damocles.permissionMode')).toBe('acceptEdits');
    write(path.join(project, '.damocles', 'settings.json'), { 'damocles.permissionMode': 'default' });
    expect(remoteStore().get('damocles.permissionMode', undefined, { path: project })).toBe('default');
  });

  it('give a read with no folder no project layer, since every client\'s folders are open there and none is the window\'s', () => {
    write(machineFile, { 'damocles.model': 'machine-model' });
    write(path.join(project, '.damocles', 'settings.json'), { 'damocles.model': 'project-model', 'damocles.permissionMode': 'plan' });
    const store = remoteStore();
    expect(store.inspect('damocles.model')).toEqual({ defaultValue: 'default-model', machineValue: 'machine-model' });
    expect(store.get('damocles.permissionMode')).toBe('default');
    expect(store.get('damocles.permissionMode', undefined, { path: project })).toBe('plan');
    expect(store.scopeFile('project')).toBeUndefined();
  });

  it('take an application key from the client only, never the machine file', () => {
    client = { 'damocles.cacheWarming': 'on' };
    write(machineFile, { 'damocles.cacheWarming': 'aggressive' });
    expect(remoteStore().inspect('damocles.cacheWarming')).toEqual({ defaultValue: 'off', userValue: 'on' });
  });

  it('never read a machine key (voice runs on the client) from any layer', () => {
    client = { 'damocles.voice.wakeWord': 'computer' };
    write(machineFile, { 'damocles.voice.wakeWord': 'target' });
    expect(remoteStore().inspect('damocles.voice.wakeWord')).toEqual({ defaultValue: 'jarvis' });
  });

  it('fire a change for every device when the acting client changes to one with another user layer', () => {
    client = { 'damocles.model': 'one' };
    const store = remoteStore();
    const changed: Array<[boolean, string | undefined]> = [];
    store.onDidChange('damocles.model', (change) => changed.push([change.affects('damocles.model'), change.clientId]));
    client = { 'damocles.model': 'two' };
    for (const cb of clientListeners) cb({});
    expect(changed).toEqual([[true, undefined]]);
    expect(store.get('damocles.model')).toBe('two');
  });

  it('fire a change naming the device whose user layer changed, a device that is not acting included', () => {
    const host = createFakeRemoteHost();
    host.set('clientUser', 'device-a', { settings: { 'damocles.model': 'a-model' }, permissionRules: [] });
    host.set('clientUser', 'device-b', { settings: { 'damocles.model': 'b-model' }, permissionRules: [] });
    host.setActing('device-a');
    const store = remoteStore(remoteSettings(host.remote));
    const changed: Array<string | undefined> = [];
    store.onDidChange('damocles.model', (change) => changed.push(change.clientId));

    host.set('clientUser', 'device-b', { settings: { 'damocles.model': 'b-model-2' }, permissionRules: [] });
    host.set('clientUser', 'device-a', { settings: { 'damocles.model': 'a-model-2' }, permissionRules: [] });
    host.set('clientUser', 'device-b', { settings: { 'damocles.model': 'b-model-2', 'damocles.permissionMode': 'plan' }, permissionRules: [] });

    expect(changed).toEqual(['device-b', 'device-a']);
  });

  it('read the user layer of the client a turn pinned, while another client acts mid-turn', async () => {
    const host = createFakeRemoteHost();
    host.set('clientUser', 'client-a', { settings: { 'damocles.model': 'a-model' }, permissionRules: [] });
    host.set('clientUser', 'client-b', { settings: { 'damocles.model': 'b-model' }, permissionRules: [] });
    host.setActing('client-a');
    const store = remoteStore(remoteSettings(host.remote));
    let resume!: () => void;
    const midTurn = new Promise<void>((resolve) => (resume = resolve));
    const turn = runPinnedTurn(host.remote, 'panel-a', async () => {
      await midTurn;
      return store.get('damocles.model');
    });
    // the other device's action arrives outside the turn's pin
    host.setActing('client-b');
    resume();
    expect(await turn).toBe('a-model');
    expect(store.get('damocles.model')).toBe('b-model');
  });

  it('write a user-home key to the machine file only from the host tab', async () => {
    const store = remoteStore();
    await expect(store.update('damocles.model', 'host-model', 'user')).rejects.toThrow(/User tab/);
    fromHostTab = true;
    await store.update('damocles.model', 'host-model', 'user');
    expect(JSON.parse(fs.readFileSync(machineFile, 'utf8'))).toEqual({ 'damocles.model': 'host-model' });
    await expect(store.update('damocles.cacheWarming', 'on', 'user')).rejects.toThrow(/only on this computer/);
  });
});
