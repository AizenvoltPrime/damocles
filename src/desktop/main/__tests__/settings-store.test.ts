import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform, type FakeFileWatcherFactory, type FakeNotificationService, type FakeWorkspaceFolders } from '../../../__mocks__/fake-platform';
import type { Disposable } from '../../../platform/disposable';
import type { TrustService } from '../../../platform/trust-service';
import type { SettingsFolder } from '../../../platform/settings-store';
import { parseContributedConfiguration, readContributedConfiguration } from '../../../core/config/contributed-configuration';
import { updateConfigAtEffectiveScope } from '../../../core/chat-panel/settings-manager/utils';
import { DesktopSettingsStore, EMPTY_SETTINGS_RETRY_MS } from '../platform/settings-store';
import { DESKTOP_CONFIGURATION, RESTORE_LAYOUT_SETTING, THEME_SETTING } from '../desktop-configuration';

const PROJECT_GLOB = '.damocles/{settings.json,settings.local.json}';

const contributed = parseContributedConfiguration({
  capabilities: { untrustedWorkspaces: { restrictedConfigurations: ['damocles.permissionMode', 'damocles.compass.enabled'] } },
  contributes: {
    configuration: {
      properties: {
        'damocles.model': { default: 'default-model' },
        'damocles.debug': { default: false },
        'damocles.maxTurns': { default: 100 },
        'damocles.permissionMode': { default: 'default' },
        'damocles.compass.enabled': { default: false },
        'damocles.voice.runtimePath': { default: '', scope: 'machine' },
        'damocles.cacheWarming': { default: 'off', scope: 'application' },
        'damocles.voice.mode': { default: 'push-to-talk', scope: 'machine-overridable' },
      },
    },
  },
});

let dir: string;
let userFile: string;
let projectA: string;
let projectB: string;

class FolderTrust implements TrustService {
  readonly trusted = new Set<string>();
  private readonly listeners = new Set<(folders: readonly string[]) => void>();
  isTrusted(folderPath: string): boolean {
    return this.trusted.has(folderPath);
  }
  onDidGrantTrust(cb: (folders: readonly string[]) => void): Disposable {
    this.listeners.add(cb);
    return { dispose: () => { this.listeners.delete(cb); } };
  }
  requestTrust(): Promise<boolean> {
    throw new Error('unused');
  }
  grant(folder: string): void {
    this.trusted.add(folder);
    for (const cb of [...this.listeners]) cb([folder]);
  }
}

interface Harness {
  readonly store: DesktopSettingsStore;
  readonly trust: FolderTrust;
  readonly folders: FakeWorkspaceFolders;
  readonly watchers: FakeFileWatcherFactory;
  readonly notifications: FakeNotificationService;
  setDefault(folder: string | undefined): void;
  // the folders the loaded chats use, as main reports them
  setChatFolders(folders: readonly SettingsFolder[]): void;
}

function harness(opts: { trusted?: readonly string[]; projects?: readonly string[]; defaultFolder?: string } = {}): Harness {
  const fake = createFakePlatform({ folders: (opts.projects ?? [projectA]).map((fsPath) => ({ fsPath, name: path.basename(fsPath) })) });
  const trust = new FolderTrust();
  for (const folder of opts.trusted ?? []) trust.trusted.add(folder);
  // null follows the first open project, as the registry does with no stored default
  let chosen: string | undefined | null = opts.defaultFolder ?? null;
  const defaultListeners = new Set<() => void>();
  let chatFolders: readonly SettingsFolder[] = [];
  const chatFolderListeners = new Set<() => void>();
  const store = new DesktopSettingsStore({
    userFile,
    contributed,
    fileWatchers: fake.fileWatchers,
    projects: fake.workspaceFolders,
    trust,
    defaultProject: {
      folder: () => (chosen === null ? fake.workspaceFolders.folders()[0]?.fsPath : chosen),
      onDidChange: (cb) => {
        defaultListeners.add(cb);
        return { dispose: () => { defaultListeners.delete(cb); } };
      },
    },
    chatFolders: {
      folders: () => chatFolders,
      onDidChange: (cb) => {
        chatFolderListeners.add(cb);
        return { dispose: () => { chatFolderListeners.delete(cb); } };
      },
    },
    notifications: fake.notifications,
    localization: fake.localization,
    log: () => undefined,
  });
  return {
    store,
    trust,
    folders: fake.workspaceFolders,
    watchers: fake.fileWatchers,
    notifications: fake.notifications,
    setDefault: (folder) => {
      chosen = folder;
      for (const cb of [...defaultListeners]) cb();
    },
    setChatFolders: (folders) => {
      chatFolders = folders;
      for (const cb of [...chatFolderListeners]) cb();
    },
  };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

const projectFile = (folder: string): string => path.join(folder, '.damocles', 'settings.json');
const localFile = (folder: string): string => path.join(folder, '.damocles', 'settings.local.json');
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-set-'));
  userFile = path.join(dir, 'home', '.damocles', 'settings.json');
  projectA = path.join(dir, 'a');
  projectB = path.join(dir, 'b');
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DesktopSettingsStore user scope', () => {
  it('reads flat damocles.* keys beside permissions, falling back to package defaults then the caller default', () => {
    writeJson(userFile, { permissions: { allow: ['Read'] }, 'damocles.model': 'user-model', 'damocles.nothing': null });
    const { store } = harness();
    expect(store.get('damocles.model')).toBe('user-model');
    expect(store.get('damocles.debug', true)).toBe(false);
    expect(store.get('damocles.unknown', 7)).toBe(7);
    expect(store.get('damocles.nothing', 'x')).toBeNull();
  });

  it('answers the damocles.desktop.* defaults, which package.json never declares', () => {
    const { store } = harness();
    expect(store.get(THEME_SETTING)).toBe('system');
    expect(store.get(RESTORE_LAYOUT_SETTING)).toBe(true);
    for (const [key, property] of Object.entries(DESKTOP_CONFIGURATION)) {
      expect(contributed.keys).not.toContain(key);
      expect(store.get(key)).toBe(property.default);
      expect(store.inspect(key)).toStrictEqual({ defaultValue: property.default });
    }
  });

  it('answers the VS Code search defaults so ripgrep keeps honoring ignore files', () => {
    const { store } = harness();
    expect(store.get('search.useIgnoreFiles', false)).toBe(true);
    expect(store.get('search.useGlobalIgnoreFiles', false)).toBe(true);
    expect(store.get('search.useParentIgnoreFiles', false)).toBe(true);
  });

  it('writes the user file through the shared writer, preserving permissions and removing undefined', async () => {
    writeJson(userFile, { permissions: { deny: ['Bash(rm:*)'] }, 'damocles.effort': 'high' });
    const { store } = harness();
    const changes: string[][] = [];
    store.onDidChange('damocles', (change) => changes.push(['damocles.model', 'damocles.effort'].filter((k) => change.affects(k))));
    await store.update('damocles.model', 'next', 'user');
    await store.update('damocles.effort', undefined, 'user');
    expect(readJson(userFile)).toEqual({ permissions: { deny: ['Bash(rm:*)'] }, 'damocles.model': 'next' });
    expect(store.get('damocles.model')).toBe('next');
    expect(changes).toEqual([['damocles.model'], ['damocles.effort']]);
  });

  it('refuses to overwrite a user file that does not parse', async () => {
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '{ "permissions": ');
    const { store } = harness();
    await expect(store.update('damocles.model', 'x', 'user')).rejects.toThrow();
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{ "permissions": ');
  });

  it('reloads on an external edit of the user file and reports the changed keys', () => {
    const { store, watchers } = harness();
    const listener = vi.fn();
    store.onDidChange('damocles.voice', listener);
    writeJson(userFile, { 'damocles.voice.mode': 'wake-word' });
    watchers.watcher(path.dirname(userFile), 'settings.json').fireChange(userFile);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].affects('damocles.voice.mode')).toBe(true);
    expect(store.get('damocles.voice.mode')).toBe('wake-word');
  });

  it('tells every listener of a change when one throws, and still resolves the write', async () => {
    const { store } = harness();
    const second = vi.fn();
    store.onDidChange('damocles.voice', () => {
      throw new Error('listener bug');
    });
    store.onDidChange('damocles.voice', second);
    await expect(store.update('damocles.voice.mode', 'wake-word', 'user')).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('DesktopSettingsStore project and local scopes', () => {
  it('applies local over project over user over the default for a trusted default project, and inspect reports every layer', () => {
    writeJson(userFile, { 'damocles.model': 'user', 'damocles.maxTurns': 5 });
    writeJson(projectFile(projectA), { 'damocles.model': 'project', 'damocles.debug': true });
    writeJson(localFile(projectA), { 'damocles.model': 'local' });
    const { store } = harness({ trusted: [projectA] });
    expect(store.inspect('damocles.model')).toStrictEqual({ defaultValue: 'default-model', userValue: 'user', projectValue: 'project', localValue: 'local' });
    expect(store.get('damocles.model')).toBe('local');
    expect(store.get('damocles.debug')).toBe(true);
    expect(store.get('damocles.maxTurns')).toBe(5);
    expect(store.inspect('damocles.maxTurns')).toStrictEqual({ defaultValue: 100, userValue: 5 });
    expect(store.scopeFile('project')).toBe(projectFile(projectA));
    expect(store.scopeFile('local')).toBe(localFile(projectA));
    expect(store.scopeFile('user')).toBe(userFile);
  });

  it('ignores an untrusted folder\'s project and local files entirely', () => {
    writeJson(userFile, { 'damocles.model': 'user' });
    writeJson(projectFile(projectA), { 'damocles.model': 'project' });
    writeJson(localFile(projectA), { 'damocles.debug': true });
    const { store } = harness();
    expect(store.inspect('damocles.model')).toStrictEqual({ defaultValue: 'default-model', userValue: 'user' });
    expect(store.get('damocles.model')).toBe('user');
    expect(store.get('damocles.debug')).toBe(false);
  });

  it.each([
    ['restricted', 'damocles.permissionMode', 'plan'],
    ['restricted', 'damocles.compass.enabled', true],
    ['machine-scoped', 'damocles.voice.runtimePath', '/evil/python'],
    ['application-scoped', 'damocles.cacheWarming', '1h'],
  ])('never reads a %s key (%s) from a project or local file, trusted or not', (_kind, key, value) => {
    writeJson(projectFile(projectA), { [key]: value });
    writeJson(localFile(projectA), { [key]: value });
    for (const trusted of [[], [projectA]]) {
      const { store } = harness({ trusted });
      expect('projectValue' in store.inspect(key)).toBe(false);
      expect('localValue' in store.inspect(key)).toBe(false);
      expect(store.get(key)).toBe(contributed.defaults.get(key));
    }
  });

  it.each([
    [THEME_SETTING, 'light', 'dark'],
    [RESTORE_LAYOUT_SETTING, false, true],
  ])('never reads the desktop-only %s from a project or local file, trusted or not', (key, userValue, fileValue) => {
    writeJson(userFile, { [key]: userValue });
    writeJson(projectFile(projectA), { [key]: fileValue });
    writeJson(localFile(projectA), { [key]: fileValue });
    for (const trusted of [[], [projectA]]) {
      const { store } = harness({ trusted });
      expect(store.inspect(key)).toStrictEqual({ defaultValue: DESKTOP_CONFIGURATION[key]!.default, userValue });
      expect(store.get(key)).toBe(userValue);
    }
  });

  it('drops a project entry that is an object prefix of a user-only key', () => {
    writeJson(projectFile(projectA), { 'damocles.compass': { enabled: true }, 'damocles.voice': { runtimePath: '/evil' } });
    const { store } = harness({ trusted: [projectA] });
    expect(store.inspect('damocles.compass')).toStrictEqual({});
    expect(store.inspect('damocles.voice')).toStrictEqual({});
  });

  it('ignores a project settings path it cannot read, so a trust grant still applies the rest', () => {
    fs.mkdirSync(projectFile(projectA), { recursive: true });
    writeJson(localFile(projectA), { 'damocles.model': 'local' });
    const { store, trust } = harness();
    trust.grant(projectA);
    expect(store.inspect('damocles.model')).toStrictEqual({ defaultValue: 'default-model', localValue: 'local' });
  });

  it('reads a machine-overridable key from a trusted project file', () => {
    writeJson(projectFile(projectA), { 'damocles.voice.mode': 'wake-word' });
    const { store } = harness({ trusted: [projectA] });
    expect(store.get('damocles.voice.mode')).toBe('wake-word');
  });

  it('writes project and local values into the default project\'s files', async () => {
    writeJson(projectFile(projectA), { permissions: { allow: ['Read'] } });
    const { store } = harness({ trusted: [projectA] });
    await store.update('damocles.model', 'p', 'project');
    await store.update('damocles.model', 'l', 'local');
    expect(readJson(projectFile(projectA))).toEqual({ permissions: { allow: ['Read'] }, 'damocles.model': 'p' });
    expect(readJson(localFile(projectA))).toEqual({ 'damocles.model': 'l' });
    expect(store.inspect('damocles.model')).toStrictEqual({ defaultValue: 'default-model', projectValue: 'p', localValue: 'l' });
    await store.update('damocles.model', undefined, 'local');
    expect(readJson(localFile(projectA))).toEqual({});
  });

  it('refuses project and local writes of user-only keys, to an untrusted folder, and with no project open', async () => {
    const trusted = harness({ trusted: [projectA] }).store;
    await expect(trusted.update('damocles.permissionMode', 'plan', 'project')).rejects.toThrow(/user settings only/);
    await expect(trusted.update('damocles.cacheWarming', '1h', 'local')).rejects.toThrow(/user settings only/);
    await expect(harness().store.update('damocles.model', 'x', 'project')).rejects.toThrow(/not trusted/);
    await expect(harness({ projects: [] }).store.update('damocles.model', 'x', 'local')).rejects.toThrow(/No project is open/);
    expect(fs.existsSync(projectFile(projectA))).toBe(false);
    expect(fs.existsSync(localFile(projectA))).toBe(false);
  });

  it('keeps UI toggles of user-only keys and of keys in an untrusted folder on the user file', async () => {
    writeJson(projectFile(projectA), { 'damocles.permissionMode': 'plan', 'damocles.maxTurns': 3 });
    const trustedFolder = harness({ trusted: [projectA] });
    const platform = { settings: trustedFolder.store };
    await updateConfigAtEffectiveScope(platform, 'damocles.permissionMode', 'acceptEdits');
    expect(readJson(userFile)).toEqual({ 'damocles.permissionMode': 'acceptEdits' });
    await updateConfigAtEffectiveScope(platform, 'damocles.maxTurns', 9);
    expect(readJson(projectFile(projectA))).toMatchObject({ 'damocles.maxTurns': 9 });

    const untrusted = harness();
    await updateConfigAtEffectiveScope({ settings: untrusted.store }, 'damocles.maxTurns', 4);
    expect(readJson(userFile)).toEqual({ 'damocles.permissionMode': 'acceptEdits', 'damocles.maxTurns': 4 });
  });

  it('writes a UI toggle to the local file that supplies the value, with two projects open', async () => {
    writeJson(localFile(projectA), { 'damocles.maxTurns': 3 });
    const { store } = harness({ trusted: [projectA, projectB], projects: [projectA, projectB] });
    await updateConfigAtEffectiveScope({ settings: store }, 'damocles.maxTurns', 9);
    expect(readJson(localFile(projectA))).toEqual({ 'damocles.maxTurns': 9 });
    expect(store.get('damocles.maxTurns')).toBe(9);
    expect(fs.existsSync(userFile)).toBe(false);
  });

  it('applies a trust grant live and reports the keys whose layers changed', () => {
    writeJson(userFile, { 'damocles.model': 'user' });
    writeJson(projectFile(projectA), { 'damocles.model': 'project', 'damocles.permissionMode': 'plan' });
    const { store, trust } = harness();
    const listener = vi.fn();
    store.onDidChange('damocles', listener);
    trust.grant(projectB);
    expect(listener).not.toHaveBeenCalled();
    trust.grant(projectA);
    expect(listener).toHaveBeenCalledTimes(1);
    const change = listener.mock.calls[0]![0] as { affects(key: string): boolean };
    expect(change.affects('damocles.model')).toBe(true);
    expect(change.affects('damocles.permissionMode')).toBe(false);
    expect(store.get('damocles.model')).toBe('project');
  });

  it('follows the default project and reports the keys whose layers changed', () => {
    writeJson(projectFile(projectA), { 'damocles.model': 'a', 'damocles.debug': true });
    writeJson(projectFile(projectB), { 'damocles.model': 'b', 'damocles.debug': true });
    const { store, setDefault } = harness({ trusted: [projectA, projectB], projects: [projectA, projectB] });
    const listener = vi.fn();
    store.onDidChange('damocles', listener);
    setDefault(projectB);
    expect(store.get('damocles.model')).toBe('b');
    const change = listener.mock.calls[0]![0] as { affects(key: string): boolean };
    expect(change.affects('damocles.model')).toBe(true);
    expect(change.affects('damocles.debug')).toBe(false);
    setDefault(undefined);
    expect(store.get('damocles.model')).toBe('default-model');
  });

  it('reloads on an external edit of a project or local file', () => {
    const { store, watchers } = harness({ trusted: [projectA] });
    const listener = vi.fn();
    store.onDidChange('damocles.maxTurns', listener);
    writeJson(localFile(projectA), { 'damocles.maxTurns': 12 });
    watchers.watcher(projectA, PROJECT_GLOB).fireCreate(localFile(projectA));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get('damocles.maxTurns')).toBe(12);
  });

  it('reads the project layer again when the project list changes', () => {
    writeJson(projectFile(projectB), { 'damocles.model': 'b' });
    const { store, folders } = harness({ trusted: [projectB], projects: [] });
    const listener = vi.fn();
    store.onDidChange('damocles.model', listener);
    expect(store.get('damocles.model')).toBe('default-model');
    folders.setFolders([{ fsPath: projectB, name: 'b' }]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops listening when disposed', () => {
    const { store, watchers } = harness();
    store.dispose();
    expect(watchers.watchers.every((w) => w.disposed)).toBe(true);
  });
});

describe('DesktopSettingsStore object values', () => {
  it('merges an object setting across the default, user, project and local layers, keeping inspect per layer', () => {
    writeJson(userFile, { 'damocles.effortByModel': { a: 'low', b: 'low' } });
    writeJson(projectFile(projectA), { 'damocles.effortByModel': { b: 'high' } });
    writeJson(localFile(projectA), { 'damocles.effortByModel': { c: 'max' } });
    const { store } = harness({ trusted: [projectA] });
    expect(store.get('damocles.effortByModel')).toStrictEqual({ a: 'low', b: 'high', c: 'max' });
    expect(store.inspect('damocles.effortByModel')).toStrictEqual({
      userValue: { a: 'low', b: 'low' },
      projectValue: { b: 'high' },
      localValue: { c: 'max' },
    });
  });

  it('lets a non-object value in a higher layer replace an object below it', () => {
    writeJson(userFile, { 'damocles.effortByModel': { a: 'low' } });
    writeJson(projectFile(projectA), { 'damocles.effortByModel': null });
    const { store } = harness({ trusted: [projectA] });
    expect(store.get('damocles.effortByModel', {})).toBeNull();
  });
});

describe('DesktopSettingsStore host defaults', () => {
  it('reports the VS Code search defaults as defaults, so a user value overrides them', async () => {
    const { store } = harness();
    expect(store.inspect('search.useIgnoreFiles')).toStrictEqual({ defaultValue: true });
    await store.update('search.useIgnoreFiles', false, 'user');
    expect(store.get('search.useIgnoreFiles')).toBe(false);
    expect(store.inspect('search.useIgnoreFiles')).toStrictEqual({ defaultValue: true, userValue: false });
  });
});

describe('DesktopSettingsStore file problems', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a file that starts with a BOM', () => {
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '\uFEFF{ "damocles.model": "bom" }');
    expect(harness().store.get('damocles.model')).toBe('bom');
  });

  it('keeps the settings a file last parsed while it does not parse, and tells the user once, naming the file', () => {
    writeJson(userFile, { 'damocles.permissionMode': 'acceptEdits', 'damocles.model': 'user' });
    const { store, watchers, notifications } = harness();
    const listener = vi.fn();
    store.onDidChange('damocles', listener);
    const fire = (): void => watchers.watcher(path.dirname(userFile), 'settings.json').fireChange(userFile);

    fs.writeFileSync(userFile, '{ "damocles.permissionMode": "acceptEdits", "damocles.model": "user", }');
    fire();
    fire();
    expect(store.get('damocles.permissionMode')).toBe('acceptEdits');
    expect(listener).not.toHaveBeenCalled();
    expect(notifications.calls).toHaveLength(1);
    expect(notifications.calls[0]).toMatchObject({ level: 'warn', message: expect.stringContaining(userFile) });

    writeJson(userFile, { 'damocles.permissionMode': 'acceptEdits', 'damocles.model': 'fixed' });
    fire();
    expect(store.get('damocles.model')).toBe('fixed');
    fs.writeFileSync(userFile, '{');
    fire();
    expect(notifications.calls).toHaveLength(2);
  });

  it('treats an existing file read empty as mid-write and reads it again before applying it', () => {
    vi.useFakeTimers();
    writeJson(userFile, { 'damocles.permissionMode': 'acceptEdits' });
    const { store, watchers } = harness();
    const listener = vi.fn();
    store.onDidChange('damocles', listener);
    const fire = (): void => watchers.watcher(path.dirname(userFile), 'settings.json').fireChange(userFile);

    fs.writeFileSync(userFile, '');
    fire();
    expect(store.get('damocles.permissionMode')).toBe('acceptEdits');
    writeJson(userFile, { 'damocles.permissionMode': 'acceptEdits' });
    vi.advanceTimersByTime(EMPTY_SETTINGS_RETRY_MS);
    expect(listener).not.toHaveBeenCalled();

    fs.writeFileSync(userFile, '');
    fire();
    vi.advanceTimersByTime(EMPTY_SETTINGS_RETRY_MS);
    expect(store.get('damocles.permissionMode')).toBe('default');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the user layer when the user file becomes unreadable during a reload', () => {
    writeJson(userFile, { 'damocles.model': 'user' });
    const { store, watchers } = harness();
    fs.rmSync(userFile);
    fs.mkdirSync(userFile);
    expect(() => watchers.watcher(path.dirname(userFile), 'settings.json').fireChange(userFile)).not.toThrow();
    expect(store.get('damocles.model')).toBe('user');
  });

  it('refuses a project write that a symlinked settings file would send into another tool\'s file', async () => {
    const claudeFile = path.join(projectA, '.claude', 'settings.json');
    writeJson(claudeFile, {});
    fs.mkdirSync(path.join(projectA, '.damocles'));
    fs.symlinkSync(claudeFile, projectFile(projectA), 'file');
    const { store } = harness({ trusted: [projectA] });
    await expect(store.update('damocles.model', 'p', 'project')).rejects.toThrow(/resolves outside/);
    expect(readJson(claudeFile)).toEqual({});
  });
});

describe('DesktopSettingsStore per-folder reads (D38)', () => {
  it('reads a folder\'s own project and local layers whichever project is the default', () => {
    writeJson(projectFile(projectA), { 'damocles.maxTurns': 1 });
    writeJson(projectFile(projectB), { 'damocles.maxTurns': 2 });
    writeJson(localFile(projectB), { 'damocles.model': 'b-local' });
    const { store } = harness({ trusted: [projectA, projectB], projects: [projectA, projectB], defaultFolder: projectA });
    expect(store.get('damocles.maxTurns')).toBe(1);
    expect(store.get('damocles.maxTurns', 100, { path: projectB })).toBe(2);
    expect(store.inspect('damocles.model', { path: projectB })).toStrictEqual({ defaultValue: 'default-model', localValue: 'b-local' });
    expect(store.scopeFile('project', { path: projectB })).toBe(projectFile(projectB));
    expect(store.scopeFile('local', { path: projectB })).toBe(localFile(projectB));
  });

  it('applies a folder\'s layers only while that folder is trusted, never by a trusted parent', () => {
    const child = path.join(projectA, 'child');
    writeJson(projectFile(child), { 'damocles.maxTurns': 7 });
    writeJson(projectFile(projectB), { 'damocles.maxTurns': 8 });
    const { store, trust } = harness({ trusted: [projectA], projects: [projectA, projectB] });
    expect(store.get('damocles.maxTurns', 100, { path: child })).toBe(100);
    expect(store.get('damocles.maxTurns', 100, { path: projectB })).toBe(100);
    const listener = vi.fn();
    store.onDidChange('damocles.maxTurns', listener);
    trust.grant(projectB);
    expect(store.get('damocles.maxTurns', 100, { path: projectB })).toBe(8);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('splits a worktree chat: the project layer from the worktree, the local layer and trust from the project folder (D34)', async () => {
    const worktree = path.join(dir, 'worktree');
    writeJson(projectFile(worktree), { 'damocles.model': 'worktree-project' });
    writeJson(localFile(worktree), { 'damocles.maxTurns': 99 });
    writeJson(localFile(projectA), { 'damocles.maxTurns': 4 });
    const folder = { path: worktree, personalPath: projectA };
    const untrusted = harness({ trusted: [worktree] });
    expect(untrusted.store.inspect('damocles.model', folder)).toStrictEqual({ defaultValue: 'default-model' });

    const { store } = harness({ trusted: [projectA] });
    expect(store.get('damocles.model', undefined, folder)).toBe('worktree-project');
    expect(store.inspect('damocles.maxTurns', folder)).toStrictEqual({ defaultValue: 100, localValue: 4 });
    await store.update('damocles.maxTurns', 5, 'local', folder);
    expect(readJson(localFile(projectA))).toEqual({ 'damocles.maxTurns': 5 });
    expect(readJson(localFile(worktree))).toEqual({ 'damocles.maxTurns': 99 });
    expect(store.scopeFile('project', folder)).toBe(projectFile(worktree));
    expect(store.scopeFile('local', folder)).toBe(localFile(projectA));
  });

  it('writes a folder\'s local value into that folder, and refuses one for an untrusted folder', async () => {
    const { store } = harness({ trusted: [projectA], projects: [projectA, projectB], defaultFolder: projectA });
    await store.update('damocles.maxTurns', 6, 'local', { path: projectA });
    expect(readJson(localFile(projectA))).toEqual({ 'damocles.maxTurns': 6 });
    await expect(store.update('damocles.maxTurns', 6, 'local', { path: projectB })).rejects.toThrow(/not trusted/);
    expect(fs.existsSync(localFile(projectB))).toBe(false);
  });

  it('watches a loaded folder, fires for its edits, and drops its watcher once no chat uses it', () => {
    const { store, watchers, setChatFolders } = harness({ trusted: [projectA, projectB], projects: [projectA, projectB], defaultFolder: projectA });
    setChatFolders([{ path: projectB }]);
    expect(store.get('damocles.maxTurns', 100, { path: projectB })).toBe(100);
    const listener = vi.fn();
    store.onDidChange('damocles.maxTurns', listener);
    writeJson(localFile(projectB), { 'damocles.maxTurns': 3 });
    const watcherB = watchers.watcher(projectB, PROJECT_GLOB);
    watcherB.fireChange(localFile(projectB));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get('damocles.maxTurns', 100, { path: projectB })).toBe(3);

    setChatFolders([]);
    expect(() => watchers.watcher(projectB, PROJECT_GLOB)).toThrow();
    expect(watchers.watcher(projectA, PROJECT_GLOB)).toBeDefined();
    writeJson(localFile(projectB), { 'damocles.maxTurns': 4 });
    expect(store.get('damocles.maxTurns', 100, { path: projectB })).toBe(4);
  });
});


describe('readContributedConfiguration', () => {
  it('derives defaults and the user-only keys from package.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } };
      contributes: { configuration: { properties: Record<string, { scope?: string }> } };
    };
    const expected = new Set([
      ...manifest.capabilities.untrustedWorkspaces.restrictedConfigurations,
      ...Object.entries(manifest.contributes.configuration.properties)
        .filter(([, schema]) => schema.scope === 'machine' || schema.scope === 'application')
        .map(([key]) => key),
    ]);
    const read = readContributedConfiguration(process.cwd());
    expect(read.userOnlyKeys).toEqual(expected);
    expect(read.userOnlyKeys).toContain('damocles.dangerouslySkipPermissions');
    expect(read.userOnlyKeys).toContain('damocles.voice.runtimePath');
    expect(read.defaults.get('damocles.browser.devToolsPort')).toBe(false);
    expect(read.keys.length).toBeGreaterThan(20);
  });
});
