import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { TrustService } from '../../../platform/trust-service';
import { parseContributedConfiguration } from '../../../core/config/contributed-configuration';
import { updateConfigAtEffectiveScope } from '../../../core/chat-panel/settings-manager/utils';
import { settingsViewScope, withSettingsViewScope, writableKeysOf } from '../../../core/chat-panel/settings-view-scope';
import { readContributedConfiguration } from '../../../core/config/read-contributed-configuration';
import { createHarness, folderEntry, makeFakeHost } from '../../../core/chat-panel/__tests__/panel-manager-harness';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { DesktopSettingsStore } from '../settings-store';

// A daemon's core reads its host's ~/.damocles/settings.json as the machine layer: the user layer is the client's, and a
// user-home setter writes the machine file only from the settings overlay's host tab.
const contributed = parseContributedConfiguration({
  contributes: {
    configuration: {
      properties: {
        'damocles.model': { default: 'default-model' },
        'damocles.permissionMode': { default: 'default', scope: 'resource' },
        'damocles.maxBudgetUsd': { scope: 'resource' },
        'damocles.voice.mode': { default: 'push-to-talk' },
        'damocles.voice.wakeWord': { default: 'jarvis', scope: 'machine' },
        'damocles.cacheWarming': { default: 'off', scope: 'application' },
      },
    },
  },
});

let dir: string;
let machineFile: string;
let project: string;

const trustAll: TrustService = {
  isTrusted: () => true,
  onDidGrantTrust: () => ({ dispose: () => undefined }),
  requestTrust: () => Promise.resolve(true),
};

function store(remote: boolean): DesktopSettingsStore {
  const fake = createFakePlatform({ folders: [{ fsPath: project, name: 'project' }] });
  return new DesktopSettingsStore({
    userFile: machineFile,
    contributed,
    fileWatchers: fake.fileWatchers,
    projects: fake.workspaceFolders,
    trust: trustAll,
    chatFolders: { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) },
    notifications: undefined,
    log: () => undefined,
    ...(remote
      ? { remote: { fromHostTab: () => settingsViewScope() === 'machine', clientSettings: () => ({}), onDidChangeClientSettings: () => ({ dispose: () => undefined }) } }
      : { defaultProject: { folder: () => project, onDidChange: () => ({ dispose: () => undefined }) } }),
  });
}

const readMachine = (): Record<string, unknown> => JSON.parse(fs.readFileSync(machineFile, 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-settings-scope-'));
  machineFile = path.join(dir, 'home', '.damocles', 'settings.json');
  project = path.join(dir, 'project');
  fs.mkdirSync(path.dirname(machineFile), { recursive: true });
  fs.mkdirSync(path.join(project, '.damocles'), { recursive: true });
  fs.writeFileSync(machineFile, JSON.stringify({ 'damocles.model': 'host-model', 'damocles.voice.wakeWord': 'computer', 'damocles.cacheWarming': 'on' }));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('settings scope on a daemon\'s core', () => {
  it('reads the host file as machineValue, never as the user\'s value, and never for a key that applies only on the client', () => {
    const settings = store(true);
    expect(settings.inspect('damocles.model')).toEqual({ defaultValue: 'default-model', machineValue: 'host-model' });
    expect(settings.get('damocles.model')).toBe('host-model');
    // the voice machine keys and application keys run on the client
    expect(settings.inspect('damocles.voice.wakeWord')).toEqual({ defaultValue: 'jarvis' });
    expect(settings.get('damocles.voice.wakeWord')).toBe('jarvis');
    expect(settings.get('damocles.cacheWarming')).toBe('off');
    settings.dispose();
  });

  it('writes a user-home setter to the machine file from the host tab, and refuses it from anywhere else', async () => {
    const settings = store(true);
    await withSettingsViewScope('machine', () => updateConfigAtEffectiveScope({ settings }, 'damocles.model', 'picked-on-host'));
    expect(readMachine()['damocles.model']).toBe('picked-on-host');
    await expect(updateConfigAtEffectiveScope({ settings }, 'damocles.model', 'from-chat')).rejects.toThrow('User tab');
    await expect(withSettingsViewScope('project', () => updateConfigAtEffectiveScope({ settings }, 'damocles.model', 'from-project-tab'))).rejects.toThrow('User tab');
    await expect(withSettingsViewScope('user', () => settings.update('damocles.model', 'x', 'user'))).rejects.toThrow('User tab');
    expect(readMachine()['damocles.model']).toBe('picked-on-host');
    settings.dispose();
  });

  it('refuses a client-only key even from the host tab', async () => {
    const settings = store(true);
    await expect(withSettingsViewScope('machine', () => settings.update('damocles.voice.wakeWord', 'hey', 'user'))).rejects.toThrow('only on this computer');
    await expect(withSettingsViewScope('machine', () => settings.update('damocles.cacheWarming', 'on', 'user'))).rejects.toThrow('only on this computer');
    settings.dispose();
  });

  it('still writes project scope from the project tab, to the chat\'s folder', async () => {
    const settings = store(true);
    await withSettingsViewScope('project', () => settings.update('damocles.permissionMode', 'plan', 'project', { path: project }));
    expect(JSON.parse(fs.readFileSync(path.join(project, '.damocles', 'settings.json'), 'utf8'))).toEqual({ 'damocles.permissionMode': 'plan' });
    settings.dispose();
  });

  it('leaves a local core as it was: the file is the user layer, and every scope tab writes it', async () => {
    const settings = store(false);
    expect(settings.inspect('damocles.model')).toEqual({ defaultValue: 'default-model', userValue: 'host-model' });
    expect(settings.get('damocles.voice.wakeWord')).toBe('computer');
    await updateConfigAtEffectiveScope({ settings }, 'damocles.model', 'local');
    expect(readMachine()['damocles.model']).toBe('local');
    settings.dispose();
  });

  it('lists for each tab the keys its scope writes: user all, the host tab no client-only or voice key, the project tab the resource keys a project file holds', () => {
    expect(writableKeysOf('user', contributed)).toEqual(['damocles.model', 'damocles.permissionMode', 'damocles.maxBudgetUsd', 'damocles.voice.mode', 'damocles.voice.wakeWord', 'damocles.cacheWarming']);
    expect(writableKeysOf('machine', contributed)).toEqual(['damocles.model', 'damocles.permissionMode', 'damocles.maxBudgetUsd']);
    expect(writableKeysOf('project', contributed)).toEqual(['damocles.permissionMode', 'damocles.maxBudgetUsd']);
    const shipped = readContributedConfiguration(path.resolve(__dirname, '..', '..', '..', '..'));
    const machine = writableKeysOf('machine', shipped);
    expect(machine.filter((key) => key.startsWith('damocles.voice.'))).toEqual([]);
    const project = writableKeysOf('project', shipped);
    expect(project.every((key) => machine.includes(key))).toBe(true);
    // restricted keys are read from user settings only, so the Project tab cannot write them
    expect(project).toContain('damocles.maxBudgetUsd');
    expect(project).not.toContain('damocles.permissionMode');
    expect(project).not.toContain('damocles.dangerouslySkipPermissions');
  });

  it("writes each scope tab's rows to the file its banner names, whatever the setter's home or the file holding the value", async () => {
    const settings = store(true);
    const local = path.join(project, '.damocles', 'settings.local.json');
    const projectFile = path.join(project, '.damocles', 'settings.json');
    fs.writeFileSync(local, JSON.stringify({ 'damocles.maxBudgetUsd': 1 }));
    const folder = { path: project };
    await withSettingsViewScope('machine', () => updateConfigAtEffectiveScope({ settings }, 'damocles.maxBudgetUsd', 2, { home: 'local', folder }));
    expect(readMachine()['damocles.maxBudgetUsd']).toBe(2);
    await withSettingsViewScope('project', () => updateConfigAtEffectiveScope({ settings }, 'damocles.maxBudgetUsd', 3, { home: 'local', folder }));
    expect(JSON.parse(fs.readFileSync(projectFile, 'utf8'))).toEqual({ 'damocles.maxBudgetUsd': 3 });
    expect(JSON.parse(fs.readFileSync(local, 'utf8'))).toEqual({ 'damocles.maxBudgetUsd': 1 });
    settings.dispose();
    // the User tab is this computer's core, whose user file is the one store(false) reads
    const user = store(false);
    await withSettingsViewScope('user', () => updateConfigAtEffectiveScope({ settings: user }, 'damocles.maxBudgetUsd', 4, { home: 'local', folder }));
    expect(readMachine()['damocles.maxBudgetUsd']).toBe(4);
    expect(JSON.parse(fs.readFileSync(local, 'utf8'))).toEqual({ 'damocles.maxBudgetUsd': 1 });
    user.dispose();
  });

  it('refuses a voice key from the host tab and never reads one from the host file', async () => {
    fs.writeFileSync(machineFile, JSON.stringify({ 'damocles.voice.mode': 'wake-word' }));
    const settings = store(true);
    expect(settings.inspect('damocles.voice.mode')).toEqual({ defaultValue: 'push-to-talk' });
    await expect(withSettingsViewScope('machine', () => updateConfigAtEffectiveScope({ settings }, 'damocles.voice.mode', 'off'))).rejects.toThrow('only on this computer');
    settings.dispose();
  });

  it('sends a view attached with a scope tab its writable keys on each settingsUpdate, and an unscoped view none', async () => {
    const h = createHarness([folderEntry(project)]);
    const host = makeFakeHost();
    const panelId = await h.manager.initializeHost(host);
    const scoped: ExtensionToWebviewMessage[] = [];
    const handle = h.manager.attachView(panelId, { post: (message) => scoped.push(message), detached: () => undefined, scope: 'project' });
    const update: ExtensionToWebviewMessage = { type: 'settingsUpdate', settings: {} as never, workspaceWritable: true };
    h.manager.postMessage(host, update);
    const shipped = readContributedConfiguration(path.resolve(__dirname, '..', '..', '..', '..'));
    expect(scoped.at(-1)).toEqual({ ...update, writableKeys: [...shipped.resourceKeys].filter((key) => !shipped.userOnlyKeys.has(key)) });
    expect(host.posted.at(-1)).toEqual(update);
    handle.dispose();
    const plain: ExtensionToWebviewMessage[] = [];
    h.manager.attachView(panelId, { post: (message) => plain.push(message), detached: () => undefined });
    h.manager.postMessage(host, update);
    expect(plain.at(-1)).toEqual(update);
    h.dispose();
  });
});
