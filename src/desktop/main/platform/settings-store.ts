import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import type { LocalizationService } from '../../../platform/localization-service';
import type { NotificationService } from '../../../platform/notification-service';
import type { SettingInspection, SettingsChange, SettingsFolder, SettingsScope, SettingsStore } from '../../../platform/settings-store';
import type { TrustService } from '../../../platform/trust-service';
import type { WorkspaceFolders } from '../../../platform/workspace-folders';
import type { ContributedConfiguration } from '../../../core/config/contributed-configuration';
import { jsonConfigWritesSettled, writeJsonConfig } from '../../../core/config/json-config-write';
import { mergeSettingValues, parseSettingsText, type SettingsObject } from '../../../core/config/settings-file';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { DESKTOP_CONFIGURATION } from '../desktop-configuration';
import { Emitter } from './emitter';

// VS Code's own search settings, which ripgrep enumeration reads; desktop answers VS Code's defaults so .gitignore stays respected.
const HOST_DEFAULTS: Readonly<Record<string, unknown>> = {
  'search.useIgnoreFiles': true,
  'search.useGlobalIgnoreFiles': true,
  'search.useParentIgnoreFiles': true,
};

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

export interface DesktopSettingsStoreDeps {
  readonly userFile: string;
  readonly contributed: ContributedConfiguration;
  readonly fileWatchers: FileWatcherFactory;
  readonly projects: WorkspaceFolders;
  readonly trust: TrustService;
  readonly defaultProject: DefaultProject;
  readonly chatFolders: ChatFolders;
  readonly notifications: NotificationService;
  readonly localization: LocalizationService;
  readonly log: (line: string) => void;
}

interface Layers {
  readonly user: SettingsObject;
  // present only while the folder's personal path is trusted
  readonly project?: SettingsObject;
  readonly local?: SettingsObject;
}

/** One folder's project and local layers, read only while its personal path was trusted. */
interface FolderEntry {
  // the working folder, whose .damocles/settings.json is the project layer
  readonly path: string;
  // the folder whose .damocles/settings.local.json is the local layer and whose trust gates both (D34)
  readonly personalPath: string;
  project?: SettingsObject;
  local?: SettingsObject;
  readonly watchers: Disposable[];
}

function affects(changedKeys: readonly string[], key: string): boolean {
  return changedKeys.some((changed) => changed === key || changed.startsWith(`${key}.`) || key.startsWith(`${changed}.`));
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
  };
}

function isBlank(text: string): boolean {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim() === '';
}

function entryKey(folder: { readonly path: string; readonly personalPath: string }): string {
  return `${folderKey(folder.path)}\n${folderKey(folder.personalPath)}`;
}

function resolved(folder: SettingsFolder): { path: string; personalPath: string } {
  return { path: folder.path, personalPath: folder.personalPath ?? folder.path };
}

/**
 * `damocles.*` keys, flat beside the `permissions` object, in three files: user `~/.damocles/settings.json` always, and
 * for a folder its project `<path>/.damocles/settings.json` and local `<personalPath>/.damocles/settings.local.json`
 * only while `personalPath` is trusted. A read with no folder uses the default project's. Precedence local > project >
 * user > package.json default, with object values merged across layers; user-only keys never come from a project or
 * local file. A file that stops parsing keeps the layer it last parsed. Each folder's layers are cached and watched
 * while the default project or a loaded chat uses it. See docs/invariants.md "Desktop host".
 */
export class DesktopSettingsStore implements SettingsStore, Disposable {
  private readonly deps: DesktopSettingsStoreDeps;
  private readonly listeners: Emitter<[readonly string[]]>;
  private readonly subscriptions: Disposable[] = [];
  // the last text that parsed, per file, which a file that no longer parses keeps serving
  private readonly lastParsed = new Map<string, SettingsObject>();
  // files the user has been told do not parse, until they parse again
  private readonly reportedBroken = new Set<string>();
  private readonly folders = new Map<string, FolderEntry>();
  // every file update wrote, kept after its folder's entry is released so a quit still waits for it
  private readonly written = new Set<string>();
  private emptyRetry: NodeJS.Timeout | undefined;
  private user: SettingsObject;
  private disposed = false;
  // the entry window-level reads used at the last default-project change
  private windowKey: string | undefined;

  constructor(deps: DesktopSettingsStoreDeps) {
    this.deps = { ...deps, contributed: withDesktopConfiguration(deps.contributed) };
    this.listeners = new Emitter('settings', deps.log);
    this.user = this.readLayer(deps.userFile, true);
    const userWatcher = deps.fileWatchers.watch(path.dirname(deps.userFile), path.basename(deps.userFile));
    const reloadUser = (): void => this.reloadUser(false);
    userWatcher.onDidCreate(reloadUser);
    userWatcher.onDidChange(reloadUser);
    userWatcher.onDidDelete(reloadUser);
    const windowChange = (): void => this.windowFolderChanged();
    this.subscriptions.push(
      userWatcher,
      deps.projects.onDidChange(windowChange),
      deps.defaultProject.onDidChange(windowChange),
      deps.chatFolders.onDidChange(() => this.releaseUnused()),
      deps.trust.onDidGrantTrust(() => this.reloadAll(false)),
    );
    const windowEntry = this.windowEntry();
    this.windowKey = windowEntry === undefined ? undefined : entryKey(windowEntry);
  }

  get<T>(key: string, defaultValue?: undefined, folder?: SettingsFolder): T | undefined;
  get<T>(key: string, defaultValue: T, folder?: SettingsFolder): T;
  get<T>(key: string, defaultValue?: T, folder?: SettingsFolder): T | undefined {
    const inspection = this.inspect<T>(key, folder);
    const values = (['defaultValue', 'userValue', 'projectValue', 'localValue'] as const)
      .filter((layer) => layer in inspection)
      .map((layer) => inspection[layer]);
    return values.length === 0 ? defaultValue : (mergeSettingValues(values) as T);
  }

  inspect<T>(key: string, folder?: SettingsFolder): SettingInspection<T> {
    const { user, project, local } = this.layersFor(folder);
    const contributed = this.deps.contributed.defaults.get(key);
    const defaultValue = contributed !== undefined ? contributed : HOST_DEFAULTS[key];
    return {
      ...(defaultValue !== undefined ? { defaultValue: defaultValue as T } : {}),
      ...(Object.hasOwn(user, key) ? { userValue: user[key] as T } : {}),
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
    const filePath = scope === 'user' ? this.deps.userFile : this.writableProjectFile(key, scope, folder);
    this.written.add(filePath);
    await writeJsonConfig(filePath, (current) => {
      // A file that does not parse is the user's to fix; overwriting it would lose every other setting in it.
      const settings = current === undefined ? {} : parseSettingsText(current, filePath);
      if (value === undefined) delete settings[key];
      else settings[key] = value;
      return `${JSON.stringify(settings, null, 2)}\n`;
    }, scope === 'user' ? {} : { confineTo: path.dirname(filePath) });
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
    return this.listeners.add((keys) => {
      if (affects(keys, section)) cb({ affects: (key) => affects(keys, key) });
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
    const fallback = this.deps.defaultProject.folder();
    return fallback === undefined ? undefined : { path: fallback, personalPath: fallback };
  }

  private windowEntry(): FolderEntry | undefined {
    const target = this.targetFolder(undefined);
    return target === undefined ? undefined : this.entry(target);
  }

  private layersFor(folder: SettingsFolder | undefined): Layers {
    const target = this.targetFolder(folder);
    if (target === undefined) return { user: this.user };
    const entry = this.entry(target);
    // Checked on every read as well as at load: a layer read while trusted applies only while the folder still is.
    if (!this.deps.trust.isTrusted(entry.personalPath)) return { user: this.user };
    return {
      user: this.user,
      ...(entry.project !== undefined ? { project: entry.project } : {}),
      ...(entry.local !== undefined ? { local: entry.local } : {}),
    };
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
    const watched = entry.personalPath === entry.path
      ? [this.deps.fileWatchers.watch(entry.path, PROJECT_GLOB)]
      : [this.deps.fileWatchers.watch(entry.path, `.damocles/${PROJECT_FILE}`), this.deps.fileWatchers.watch(entry.personalPath, `.damocles/${LOCAL_FILE}`)];
    for (const watcher of watched) {
      watcher.onDidCreate(reload);
      watcher.onDidChange(reload);
      watcher.onDidDelete(reload);
      entry.watchers.push(watcher);
    }
    return entry;
  }

  private readFolderLayers(entry: FolderEntry, acceptEmpty: boolean): void {
    if (!this.deps.trust.isTrusted(entry.personalPath)) {
      delete entry.project;
      delete entry.local;
      return;
    }
    entry.project = this.readProjectLayer(projectFile(entry, 'project'), acceptEmpty);
    entry.local = this.readProjectLayer(projectFile(entry, 'local'), acceptEmpty);
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
    if (!this.deps.trust.isTrusted(target.personalPath)) {
      throw new Error(`${target.personalPath} is not trusted, so ${key} cannot be written to its ${scope} settings`);
    }
    return projectFile(target, scope);
  }

  // A key that is, contains or sits under a user-only key, so an object value cannot smuggle one in.
  private isUserOnly(key: string): boolean {
    for (const userOnly of this.deps.contributed.userOnlyKeys) {
      if (key === userOnly || userOnly.startsWith(`${key}.`) || key.startsWith(`${userOnly}.`)) return true;
    }
    return false;
  }

  private readLayer(filePath: string, acceptEmpty: boolean): SettingsObject {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.lastParsed.delete(filePath);
        this.reportedBroken.delete(filePath);
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
      if (!this.reportedBroken.has(filePath)) {
        this.reportedBroken.add(filePath);
        void this.deps.notifications.warn(this.deps.localization.t('{0} is not valid JSON, so Damocles keeps using the settings it last read from it. Fix the file to apply it: {1}', filePath, reason));
      }
      return { ...previous };
    }
    this.lastParsed.set(filePath, settings);
    this.reportedBroken.delete(filePath);
    return { ...settings };
  }

  private readProjectLayer(filePath: string, acceptEmpty: boolean): SettingsObject {
    const settings = this.readLayer(filePath, acceptEmpty);
    const ignored = Object.keys(settings).filter((key) => this.isUserOnly(key));
    for (const key of ignored) delete settings[key];
    if (ignored.length > 0) this.deps.log(`[settings] ${filePath}: ignoring ${ignored.join(', ')}; these apply from user settings only`);
    return settings;
  }

  private scheduleEmptyRetry(): void {
    clearTimeout(this.emptyRetry);
    this.emptyRetry = setTimeout(() => {
      this.emptyRetry = undefined;
      this.reloadAll(true);
    }, EMPTY_SETTINGS_RETRY_MS);
  }

  private fire(keys: readonly string[]): void {
    if (keys.length > 0) this.listeners.fire(keys);
  }

  private reloadUser(acceptEmpty: boolean): void {
    const before = this.user;
    this.user = this.readLayer(this.deps.userFile, acceptEmpty);
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
    this.user = this.readLayer(this.deps.userFile, acceptEmpty);
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
    const before = this.snapshot(previous !== undefined && this.deps.trust.isTrusted(previous.personalPath) ? previous : undefined);
    const current = this.windowEntry();
    this.windowKey = current === undefined ? undefined : entryKey(current);
    const after = this.snapshot(current !== undefined && this.deps.trust.isTrusted(current.personalPath) ? current : undefined);
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
