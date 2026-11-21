import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { FileWatcherFactory } from '../../platform/file-watcher';
import type { NotificationService } from '../../platform/notification-service';
import type { SettingInspection, SettingsChange, SettingsFolder, SettingsScope, SettingsStore } from '../../platform/settings-store';
import type { TrustService } from '../../platform/trust-service';
import type { WorkspaceFolders } from '../../platform/workspace-folders';
import { settingTypeFits, type ContributedConfiguration } from '../../core/config/contributed-configuration';
import { stripBom } from '../../core/config/bom';
import { checkConfigPathSync, noticeRefusedConfigRead } from '../../core/config/local-config-path';
import { jsonConfigWritesSettled, writeJsonConfig } from '../../core/config/json-config-write';
import { mergeSettingValues, parseSettingsText, type SettingsObject } from '../../core/config/settings-file';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { settingsFileTrusted } from '../../core/worktrees/personal-config';
import { DESKTOP_CONFIGURATION } from './desktop-configuration';
import { Emitter } from './emitter';
import { l } from '../../core/l10n';
import { LocalizedError } from '../../shared/localized-text';

const PROJECT_FILE = 'settings.json';
const LOCAL_FILE = 'settings.local.json';
const PROJECT_GLOB = `.damocles/{${PROJECT_FILE},${LOCAL_FILE}}`;
// An editor that truncates before it writes leaves the file empty for a moment; it is read again after this.
export const EMPTY_SETTINGS_RETRY_MS = 300;

type FileScope = Exclude<SettingsScope, 'user'>;

export interface DefaultProject {
  // absolute path of the registry's default project; undefined when no project is open
  folder(): string | undefined;
  // fires whenever folder() may answer differently
  onDidChange(cb: () => void): Disposable;
}

/** The folders the loaded chats read settings for; a folder no chat uses has its cache and watchers dropped. */
export interface ChatFolders {
  folders(): readonly SettingsFolder[];
  onDidChange(cb: () => void): Disposable;
}

/** One device's user layer changed (its layer before and after), or, without a clientId, the acting client did. */
export type ClientSettingsChange =
  | { readonly clientId: string; readonly before: SettingsObject | undefined; readonly after: SettingsObject | undefined }
  | { readonly clientId?: undefined };

export interface RemoteSettings {
  readonly fromHostTab: () => boolean;
  readonly clientSettings: () => SettingsObject | undefined;
  readonly onDidChangeClientSettings: (cb: (change: ClientSettingsChange) => void) => Disposable;
}

interface StoreDeps {
  readonly userFile: string;
  readonly contributed: ContributedConfiguration;
  readonly fileWatchers: FileWatcherFactory;
  readonly projects: WorkspaceFolders;
  readonly trust: TrustService;
  readonly chatFolders: ChatFolders;
  // where a file that stops parsing is reported, once until it parses again; undefined only logs it. One process of the
  // app reports, so one typo is one toast.
  readonly notifications: NotificationService | undefined;
  readonly log: (line: string) => void;
}

// The app's own core reads with no folder from the window's default project. A daemon's core has no window and every
// client's folders open, so it takes no default project: userFile is its host's machine layer, and the user layer is the
// acting client's clientUser settings, which it never writes and never reads for a machine scoped key. A user-scope write
// lands in the machine file only from the settings overlay's host tab.
export type DesktopSettingsStoreDeps = StoreDeps & (
  | { readonly defaultProject: DefaultProject; readonly remote?: undefined }
  | { readonly remote: RemoteSettings; readonly defaultProject?: undefined }
);

interface Layers {
  readonly user: SettingsObject;
  // each present only while settingsFileTrusted admits its file
  readonly project?: SettingsObject;
  readonly local?: SettingsObject;
}

/** One folder's project and local layers, each read only while settingsFileTrusted admitted its file. */
interface FolderEntry {
  // the working folder, whose .damocles/settings.json is the project layer and whose trust gates both
  readonly path: string;
  // the folder whose .damocles/settings.local.json is the local layer, which its trust gates too (D34)
  readonly personalPath: string;
  project?: SettingsObject;
  local?: SettingsObject;
  readonly watchers: Disposable[];
}

function affects(changedKeys: readonly string[], key: string): boolean {
  return changedKeys.some((changed) => changed === key || changed.startsWith(`${key}.`) || key.startsWith(`${changed}.`));
}

// A key that is, contains or sits under one of keys, so an object value cannot smuggle one in.
function overlaps(key: string, keys: ReadonlySet<string>): boolean {
  for (const other of keys) {
    if (key === other || other.startsWith(`${key}.`) || key.startsWith(`${other}.`)) return true;
  }
  return false;
}

function layerValue(layer: SettingsObject | undefined, key: string): string | undefined {
  return layer !== undefined && Object.hasOwn(layer, key) ? JSON.stringify(layer[key]) : undefined;
}

/** The keys whose value in any layer differs between two snapshots of the same folder's layers. */
function changedKeys(before: Layers, after: Layers): string[] {
  const keys = new Set<string>();
  for (const layers of [before, after]) {
    for (const layer of [layers.user, layers.project, layers.local]) {
      if (layer !== undefined) for (const key of Object.keys(layer)) keys.add(key);
    }
  }
  return [...keys].filter((key) =>
    layerValue(before.user, key) !== layerValue(after.user, key)
    || layerValue(before.project, key) !== layerValue(after.project, key)
    || layerValue(before.local, key) !== layerValue(after.local, key));
}

/** The contributed settings plus the desktop-only ones, which package.json never declares; `application` scope is user-only. */
export function withDesktopConfiguration(contributed: ContributedConfiguration): ContributedConfiguration {
  const desktop = Object.entries(DESKTOP_CONFIGURATION).filter(([key]) => !contributed.keys.includes(key));
  return {
    keys: [...contributed.keys, ...desktop.map(([key]) => key)],
    defaults: new Map([...contributed.defaults, ...desktop.map(([key, property]) => [key, property.default] as const)]),
    userOnlyKeys: new Set([...contributed.userOnlyKeys, ...desktop.filter(([, property]) => property.scope === 'application').map(([key]) => key)]),
    clientOnlyKeys: new Set([...contributed.clientOnlyKeys, ...desktop.filter(([, property]) => property.scope === 'application').map(([key]) => key)]),
    resourceKeys: contributed.resourceKeys,
    clientMachineKeys: contributed.clientMachineKeys,
    hostKeys: contributed.hostKeys,
    types: new Map([...contributed.types, ...desktop.map(([key, property]) => [key, property.type] as const)]),
  };
}

function isBlank(text: string): boolean {
  return stripBom(text).trim() === '';
}

function entryKey(folder: { readonly path: string; readonly personalPath: string }): string {
  return `${folderKey(folder.path)}\n${folderKey(folder.personalPath)}`;
}

function resolved(folder: SettingsFolder): { path: string; personalPath: string } {
  return { path: folder.path, personalPath: folder.personalPath ?? folder.path };
}

/**
 * `damocles.*` keys, flat beside the `permissions` object, in three files: user `~/.damocles/settings.json` always, and
 * for a folder its project `<path>/.damocles/settings.json` while `path` is trusted and local
 * `<personalPath>/.damocles/settings.local.json` while `path` and `personalPath` both are. A read with no folder uses the
 * default project's, and a daemon's core has none, so there it reads no project file. Precedence local > project >
 * user > package.json default, with object values merged across layers; user-only keys never come from a project or
 * local file. A file that stops parsing keeps the layer it last parsed. Each folder's layers are cached and watched
 * while the default project or a loaded chat uses it. See docs/invariants.md "Desktop host".
 */
export class DesktopSettingsStore implements SettingsStore, Disposable {
  private readonly deps: DesktopSettingsStoreDeps;
  private readonly listeners: Emitter<[readonly string[], string | undefined]>;
  private readonly subscriptions: Disposable[] = [];
  // the last text that parsed, per file, which a file that no longer parses keeps serving
  private readonly lastParsed = new Map<string, SettingsObject>();
  // files the user has been told do not parse, until they parse again
  private readonly reportedBroken = new Set<string>();
  // the user-only keys last logged as ignored, per project file, until that list changes
  private readonly reportedIgnored = new Map<string, string>();
  // the keys last reported as holding a value of the wrong type, per file, until that list changes
  private readonly reportedMistyped = new Map<string, string>();
  private readonly folders = new Map<string, FolderEntry>();
  // every file update wrote, kept after its folder's entry is released so a quit still waits for it
  private readonly written = new Set<string>();
  private emptyRetry: NodeJS.Timeout | undefined;
  private user: SettingsObject;
  // a daemon's core: the acting client's user layer at the last change notice, which the next acting change diffs against
  private notifiedClient: SettingsObject = {};
  private disposed = false;
  // the entry window-level reads used at the last default-project change
  private windowKey: string | undefined;

  constructor(deps: DesktopSettingsStoreDeps) {
    this.deps = { ...deps, contributed: withDesktopConfiguration(deps.contributed) };
    this.listeners = new Emitter('settings', deps.log);
    this.user = this.readLayer(path.dirname(deps.userFile), deps.userFile, true);
    const windowChange = (): void => this.windowFolderChanged();
    this.subscriptions.push(
      this.watchConfig(path.dirname(deps.userFile), path.basename(deps.userFile), () => this.reloadUser(false)),
      deps.projects.onDidChange(windowChange),
      deps.chatFolders.onDidChange(() => this.releaseUnused()),
      deps.trust.onDidChangeTrust(() => this.reloadAll(false)),
    );
    if (deps.defaultProject !== undefined) this.subscriptions.push(deps.defaultProject.onDidChange(windowChange));
    const remote = deps.remote;
    if (remote !== undefined) {
      this.notifiedClient = { ...remote.clientSettings() };
      const clientChanged = (before: SettingsObject, after: SettingsObject): string[] =>
        changedKeys({ user: before }, { user: after }).filter((key) => this.readsFromClient(key));
      this.subscriptions.push(remote.onDidChangeClientSettings((change) => {
        const before = this.notifiedClient;
        this.notifiedClient = { ...remote.clientSettings() };
        if (change.clientId !== undefined) this.fire(clientChanged(change.before ?? {}, change.after ?? {}), change.clientId);
        else this.fire(clientChanged(before, this.notifiedClient));
      }));
    }
    const windowEntry = this.windowEntry();
    this.windowKey = windowEntry === undefined ? undefined : entryKey(windowEntry);
  }

  get<T>(key: string, defaultValue?: undefined, folder?: SettingsFolder): T | undefined;
  get<T>(key: string, defaultValue: T, folder?: SettingsFolder): T;
  get<T>(key: string, defaultValue?: T, folder?: SettingsFolder): T | undefined {
    const inspection = this.inspect<T>(key, folder);
    const values = (['defaultValue', 'userValue', 'machineValue', 'projectValue', 'localValue'] as const)
      .filter((layer) => layer in inspection)
      .map((layer) => inspection[layer]);
    return values.length === 0 ? defaultValue : (mergeSettingValues(values) as T);
  }

  inspect<T>(key: string, folder?: SettingsFolder): SettingInspection<T> {
    const { user, project, local } = this.layersFor(folder);
    const defaultValue = this.deps.contributed.defaults.get(key);
    const own = Object.hasOwn(user, key);
    // read per call, since a pinned turn reads its own client's layer whoever acts later
    const client = this.deps.remote?.clientSettings() ?? {};
    const file = this.deps.remote === undefined
      ? (own ? { userValue: user[key] as T } : {})
      : {
          // an app that predates the type check relays its file's values unchecked
          ...(Object.hasOwn(client, key) && this.readsFromClient(key) && this.typeFits(key, client[key]) ? { userValue: client[key] as T } : {}),
          ...(own && !this.isClientOnly(key) ? { machineValue: user[key] as T } : {}),
        };
    return {
      ...(defaultValue !== undefined ? { defaultValue: defaultValue as T } : {}),
      ...file,
      ...(project !== undefined && Object.hasOwn(project, key) ? { projectValue: project[key] as T } : {}),
      ...(local !== undefined && Object.hasOwn(local, key) ? { localValue: local[key] as T } : {}),
    };
  }

  scopeFile(scope: SettingsScope, folder?: SettingsFolder): string | undefined {
    if (scope === 'user') return this.deps.userFile;
    const target = this.targetFolder(folder);
    return target === undefined ? undefined : projectFile(target, scope);
  }

  async update(key: string, value: unknown, scope: SettingsScope, folder?: SettingsFolder): Promise<void> {
    if (scope === 'user' && this.deps.remote !== undefined) this.checkMachineWrite(key);
    const filePath = scope === 'user' ? this.deps.userFile : this.writableProjectFile(key, scope, folder);
    this.written.add(filePath);
    // a project or local file is <folder>/.damocles/<file> (projectFile), whose folder is its scope root
    const options = scope === 'user' ? { baseFolder: path.dirname(filePath) } : { confineTo: path.dirname(filePath), baseFolder: path.dirname(path.dirname(filePath)) };
    await writeJsonConfig(filePath, (current) => {
      // A file that does not parse is the user's to fix; overwriting it would lose every other setting in it.
      const settings = current === undefined ? {} : parseSettingsText(current, filePath);
      if (value === undefined) delete settings[key];
      else settings[key] = value;
      return `${JSON.stringify(settings, null, 2)}\n`;
    }, options);
    this.reloadAll(false);
  }

  /** Settles once every write to the files the store serves or wrote, one queued meanwhile included, has landed or failed; a quit awaits it. */
  flush(): Promise<void> {
    return jsonConfigWritesSettled(() => [
      this.deps.userFile,
      ...this.written,
      ...[...this.folders.values()].flatMap((entry) => [projectFile(entry, 'project'), projectFile(entry, 'local')]),
    ]);
  }

  onDidChange(section: string, cb: (change: SettingsChange) => void): Disposable {
    return this.listeners.add((keys, clientId) => {
      if (affects(keys, section)) cb({ affects: (key) => affects(keys, key), ...(clientId !== undefined ? { clientId } : {}) });
    });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.emptyRetry);
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    for (const entry of this.folders.values()) for (const watcher of entry.watchers) watcher.dispose();
    this.folders.clear();
    this.listeners.clear();
  }

  private targetFolder(folder: SettingsFolder | undefined): { path: string; personalPath: string } | undefined {
    if (folder !== undefined) return resolved(folder);
    const fallback = this.deps.defaultProject?.folder();
    return fallback === undefined ? undefined : { path: fallback, personalPath: fallback };
  }

  private windowEntry(): FolderEntry | undefined {
    const target = this.targetFolder(undefined);
    return target === undefined ? undefined : this.entry(target);
  }

  private layersFor(folder: SettingsFolder | undefined): Layers {
    const target = this.targetFolder(folder);
    if (target === undefined) return { user: this.user };
    return this.applying(this.entry(target));
  }

  // Checked on every read as well as at load: a layer read while trusted applies only while its folders still are.
  private applying(entry: FolderEntry | undefined): Layers {
    if (entry === undefined) return { user: this.user };
    return {
      user: this.user,
      ...(entry.project !== undefined && this.fileTrusted(entry, 'project') ? { project: entry.project } : {}),
      ...(entry.local !== undefined && this.fileTrusted(entry, 'local') ? { local: entry.local } : {}),
    };
  }

  private fileTrusted(folder: { readonly path: string; readonly personalPath: string }, scope: FileScope): boolean {
    return settingsFileTrusted((candidate) => this.deps.trust.isTrusted(candidate), folder, scope);
  }

  private entry(target: { path: string; personalPath: string }): FolderEntry {
    const key = entryKey(target);
    const existing = this.folders.get(key);
    if (existing !== undefined) return existing;
    const entry: FolderEntry = { ...target, watchers: [] };
    this.readFolderLayers(entry, true);
    this.folders.set(key, entry);
    if (this.disposed) return entry;
    const reload = (): void => this.reloadEntry(entry, false);
    if (entry.personalPath === entry.path) entry.watchers.push(this.watchConfig(entry.path, PROJECT_GLOB, reload));
    else entry.watchers.push(this.watchConfig(entry.path, `.damocles/${PROJECT_FILE}`, reload), this.watchConfig(entry.personalPath, `.damocles/${LOCAL_FILE}`, reload));
    return entry;
  }

  // based at the file's scope root, so the watcher factory judges a link below it by the network rule (D10)
  private watchConfig(base: string, glob: string, reload: () => void): Disposable {
    const watcher = this.deps.fileWatchers.watch(base, glob);
    watcher.onDidCreate(reload);
    watcher.onDidChange(reload);
    watcher.onDidDelete(reload);
    return watcher;
  }

  private readFolderLayers(entry: FolderEntry, acceptEmpty: boolean): void {
    for (const scope of ['project', 'local'] as const) {
      if (this.fileTrusted(entry, scope)) entry[scope] = this.readProjectLayer(scope === 'project' ? entry.path : entry.personalPath, projectFile(entry, scope), acceptEmpty);
      else delete entry[scope];
    }
  }

  private snapshot(entry: FolderEntry | undefined): Layers {
    if (entry === undefined) return { user: this.user };
    return {
      user: this.user,
      ...(entry.project !== undefined ? { project: entry.project } : {}),
      ...(entry.local !== undefined ? { local: entry.local } : {}),
    };
  }

  private writableProjectFile(key: string, scope: FileScope, folder: SettingsFolder | undefined): string {
    if (this.isUserOnly(key)) {
      throw new Error(`${key} is read from user settings only, so it cannot be written to ${scope} settings`);
    }
    const target = this.targetFolder(folder);
    if (target === undefined) throw new Error(`No project is open, so ${key} cannot be written to ${scope} settings`);
    if (!this.fileTrusted(target, scope)) {
      const untrusted = this.deps.trust.isTrusted(target.path) ? target.personalPath : target.path;
      throw new Error(`${untrusted} is not trusted, so ${key} cannot be written to its ${scope} settings`);
    }
    return projectFile(target, scope);
  }

  // On a daemon's core user settings change only on the client, and a user-home setter writes this host's machine file
  // only from the host tab, for a key a host may hold.
  private checkMachineWrite(key: string): void {
    if (!this.deps.remote?.fromHostTab()) throw new LocalizedError(l('User settings change only in the User tab on this computer, so {0} was not changed on this host.', key));
    if (this.isClientOnly(key)) throw new LocalizedError(l('{0} applies only on this computer, so it cannot be set for this host.', key));
  }

  // On a daemon's core a machine scoped key never comes from a client's user layer: a host key is read from the host's
  // file and a client machine key from no layer.
  private readsFromClient(key: string): boolean {
    return !overlaps(key, this.deps.contributed.hostKeys) && !overlaps(key, this.deps.contributed.clientMachineKeys);
  }

  private isClientOnly(key: string): boolean {
    return overlaps(key, this.deps.contributed.clientOnlyKeys);
  }

  private isUserOnly(key: string): boolean {
    return overlaps(key, this.deps.contributed.userOnlyKeys);
  }

  // baseFolder: the file's scope root, the Damocles data folder for the user file and the project or personal folder otherwise
  private readLayer(baseFolder: string, filePath: string, acceptEmpty: boolean): SettingsObject {
    let text: string;
    try {
      // eslint-disable-next-line damocles/no-sync -- the store's layers are read synchronously already, right after this check
      if (checkConfigPathSync(baseFolder, filePath) !== 'ok') {
        this.deps.log(`[settings] ${filePath} links to a network share or WSL path; keeping what was last read from it`);
        noticeRefusedConfigRead(filePath, this.deps.notifications);
        return { ...this.lastParsed.get(filePath) };
      }
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.lastParsed.delete(filePath);
        this.reportedBroken.delete(filePath);
        this.reportedMistyped.delete(filePath);
        return {};
      }
      // A repository can make this path a directory, and a file can be unreadable; neither may stop a reload.
      this.deps.log(`[settings] cannot read ${filePath}; keeping what was last read from it: ${err instanceof Error ? err.message : String(err)}`);
      return { ...this.lastParsed.get(filePath) };
    }
    const previous = this.lastParsed.get(filePath);
    if (!acceptEmpty && isBlank(text) && previous !== undefined && Object.keys(previous).length > 0) {
      this.scheduleEmptyRetry();
      return { ...previous };
    }
    let settings: SettingsObject;
    try {
      settings = parseSettingsText(text, filePath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.log(`[settings] ${filePath} does not parse; keeping what was last read from it: ${reason}`);
      const notifications = this.deps.notifications;
      if (notifications !== undefined && !this.reportedBroken.has(filePath)) {
        this.reportedBroken.add(filePath);
        void notifications.warn(l('{0} is not valid JSON, so Damocles keeps using the settings it last read from it. Fix the file to apply it: {1}', filePath, reason));
      }
      return { ...previous };
    }
    const typed = this.withoutMistyped(settings, filePath);
    this.lastParsed.set(filePath, typed);
    this.reportedBroken.delete(filePath);
    return { ...typed };
  }

  // A value of a type its key does not declare is dropped, so every reader, the settings page included, gets the next
  // layer's value or the default; the file keeps it for the user to fix.
  private withoutMistyped(settings: SettingsObject, filePath: string): SettingsObject {
    const mistyped = Object.keys(settings).filter((key) => !this.typeFits(key, settings[key])).sort();
    const list = mistyped.join(', ');
    if (list === '') {
      this.reportedMistyped.delete(filePath);
      return settings;
    }
    if (this.reportedMistyped.get(filePath) !== list) {
      this.reportedMistyped.set(filePath, list);
      this.deps.log(`[settings] ${filePath}: ignoring ${list}; the value is not of the type the setting takes`);
      void this.deps.notifications?.warn(l('{0} gives {1} a value of the wrong type, so Damocles ignores it and uses the default or another settings file\'s value. Fix the value to apply it.', filePath, list));
    }
    return Object.fromEntries(Object.entries(settings).filter(([key]) => !mistyped.includes(key)));
  }

  private typeFits(key: string, value: unknown): boolean {
    const type = this.deps.contributed.types.get(key);
    return type === undefined || settingTypeFits(type, value);
  }

  private readProjectLayer(baseFolder: string, filePath: string, acceptEmpty: boolean): SettingsObject {
    const settings = this.readLayer(baseFolder, filePath, acceptEmpty);
    const ignored = Object.keys(settings).filter((key) => this.isUserOnly(key)).sort();
    for (const key of ignored) delete settings[key];
    const list = ignored.join(', ');
    if (list === '') {
      this.reportedIgnored.delete(filePath);
    } else if (this.reportedIgnored.get(filePath) !== list) {
      this.reportedIgnored.set(filePath, list);
      this.deps.log(`[settings] ${filePath}: ignoring ${list}; these apply from user settings only`);
    }
    return settings;
  }

  private scheduleEmptyRetry(): void {
    clearTimeout(this.emptyRetry);
    this.emptyRetry = setTimeout(() => {
      this.emptyRetry = undefined;
      this.reloadAll(true);
    }, EMPTY_SETTINGS_RETRY_MS);
  }

  private fire(keys: readonly string[], clientId?: string): void {
    if (keys.length > 0) this.listeners.fire(keys, clientId);
  }

  private reloadUser(acceptEmpty: boolean): void {
    const before = this.user;
    this.user = this.readLayer(path.dirname(this.deps.userFile), this.deps.userFile, acceptEmpty);
    this.fire(changedKeys({ user: before }, { user: this.user }));
  }

  private reloadEntry(entry: FolderEntry, acceptEmpty: boolean): void {
    if (this.folders.get(entryKey(entry)) !== entry) return;
    const before = this.snapshot(entry);
    this.readFolderLayers(entry, acceptEmpty);
    this.fire(changedKeys({ ...before, user: this.user }, this.snapshot(entry)));
  }

  /** Every loaded folder and the user file, one change event naming every key any of them changed. */
  private reloadAll(acceptEmpty: boolean): void {
    const keys = new Set<string>();
    const userBefore = this.user;
    this.user = this.readLayer(path.dirname(this.deps.userFile), this.deps.userFile, acceptEmpty);
    for (const key of changedKeys({ user: userBefore }, { user: this.user })) keys.add(key);
    for (const entry of this.folders.values()) {
      const before = this.snapshot(entry);
      this.readFolderLayers(entry, acceptEmpty);
      for (const key of changedKeys({ ...before, user: this.user }, this.snapshot(entry))) keys.add(key);
    }
    this.fire([...keys]);
  }

  /** The default project may have changed: window-level reads then come from another folder, whose differing keys change. */
  private windowFolderChanged(): void {
    const previous = this.windowKey === undefined ? undefined : this.folders.get(this.windowKey);
    const before = this.applying(previous);
    const current = this.windowEntry();
    this.windowKey = current === undefined ? undefined : entryKey(current);
    const after = this.applying(current);
    this.releaseUnused();
    this.fire(changedKeys(before, after));
  }

  private releaseUnused(): void {
    const used = new Set(this.deps.chatFolders.folders().map((folder) => entryKey(resolved(folder))));
    const fallback = this.targetFolder(undefined);
    if (fallback !== undefined) used.add(entryKey(fallback));
    for (const [key, entry] of this.folders) {
      if (used.has(key)) continue;
      for (const watcher of entry.watchers) watcher.dispose();
      this.folders.delete(key);
    }
  }
}

function projectFile(folder: { readonly path: string; readonly personalPath: string }, scope: FileScope): string {
  return scope === 'project'
    ? path.join(folder.path, '.damocles', PROJECT_FILE)
    : path.join(folder.personalPath, '.damocles', LOCAL_FILE);
}
