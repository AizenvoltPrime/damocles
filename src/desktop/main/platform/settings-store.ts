import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import type { LocalizationService } from '../../../platform/localization-service';
import type { NotificationService } from '../../../platform/notification-service';
import type { SettingInspection, SettingsChange, SettingsScope, SettingsStore } from '../../../platform/settings-store';
import type { TrustService } from '../../../platform/trust-service';
import type { WorkspaceFolders } from '../../../platform/workspace-folders';
import type { ContributedConfiguration } from '../../../core/config/contributed-configuration';
import { writeJsonConfig } from '../../../core/config/json-config-write';
import { mergeSettingValues, parseSettingsText, type SettingsObject } from '../../../core/config/settings-file';
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

export interface DesktopSettingsStoreDeps {
  readonly userFile: string;
  readonly contributed: ContributedConfiguration;
  readonly fileWatchers: FileWatcherFactory;
  readonly projects: WorkspaceFolders;
  readonly trust: TrustService;
  readonly defaultProject: DefaultProject;
  readonly notifications: NotificationService;
  readonly localization: LocalizationService;
  readonly log: (line: string) => void;
}

interface Layers {
  readonly user: SettingsObject;
  // present only for a trusted default project
  readonly project?: SettingsObject;
  readonly local?: SettingsObject;
}

function affects(changedKeys: readonly string[], key: string): boolean {
  return changedKeys.some((changed) => changed === key || changed.startsWith(`${key}.`) || key.startsWith(`${changed}.`));
}

function layerValue(layer: SettingsObject | undefined, key: string): string | undefined {
  return layer !== undefined && Object.hasOwn(layer, key) ? JSON.stringify(layer[key]) : undefined;
}

function isBlank(text: string): boolean {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim() === '';
}

/**
 * `damocles.*` keys, flat beside the `permissions` object, in three files: user `~/.damocles/settings.json` always,
 * project `<folder>/.damocles/settings.json` and local `<folder>/.damocles/settings.local.json` of the default project
 * only while it is trusted. Precedence local > project > user > package.json default, with object values merged
 * across layers; user-only keys never come from a project or local file. A file that stops parsing keeps the layer
 * it last parsed. See docs/invariants.md "Desktop host".
 */
export class DesktopSettingsStore implements SettingsStore, Disposable {
  private readonly deps: DesktopSettingsStoreDeps;
  private readonly listeners: Emitter<[readonly string[]]>;
  private readonly subscriptions: Disposable[] = [];
  // the last text that parsed, per file, which a file that no longer parses keeps serving
  private readonly lastParsed = new Map<string, SettingsObject>();
  // files the user has been told do not parse, until they parse again
  private readonly reportedBroken = new Set<string>();
  private emptyRetry: NodeJS.Timeout | undefined;
  private layers: Layers;

  constructor(deps: DesktopSettingsStoreDeps) {
    this.deps = deps;
    this.listeners = new Emitter('settings', deps.log);
    this.layers = this.readLayers(true);
    const reload = (): void => this.reload();
    const userWatcher = deps.fileWatchers.watch(path.dirname(deps.userFile), path.basename(deps.userFile));
    const projectWatcher = deps.fileWatchers.watchWorkspace(PROJECT_GLOB);
    for (const watcher of [userWatcher, projectWatcher]) {
      watcher.onDidCreate(reload);
      watcher.onDidChange(reload);
      watcher.onDidDelete(reload);
      this.subscriptions.push(watcher);
    }
    this.subscriptions.push(
      deps.projects.onDidChange(reload),
      deps.trust.onDidGrantTrust(reload),
      deps.defaultProject.onDidChange(reload),
    );
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    const inspection = this.inspect<T>(key);
    const values = (['defaultValue', 'userValue', 'projectValue', 'localValue'] as const)
      .filter((layer) => layer in inspection)
      .map((layer) => inspection[layer]);
    return values.length === 0 ? defaultValue : (mergeSettingValues(values) as T);
  }

  inspect<T>(key: string): SettingInspection<T> {
    const { user, project, local } = this.layers;
    const contributed = this.deps.contributed.defaults.get(key);
    const defaultValue = contributed !== undefined ? contributed : HOST_DEFAULTS[key];
    return {
      ...(defaultValue !== undefined ? { defaultValue: defaultValue as T } : {}),
      ...(Object.hasOwn(user, key) ? { userValue: user[key] as T } : {}),
      ...(project !== undefined && Object.hasOwn(project, key) ? { projectValue: project[key] as T } : {}),
      ...(local !== undefined && Object.hasOwn(local, key) ? { localValue: local[key] as T } : {}),
    };
  }

  scopeFile(scope: SettingsScope): string | undefined {
    if (scope === 'user') return this.deps.userFile;
    const folder = this.deps.defaultProject.folder();
    return folder === undefined ? undefined : projectFile(folder, scope);
  }

  async update(key: string, value: unknown, scope: SettingsScope): Promise<void> {
    const filePath = scope === 'user' ? this.deps.userFile : this.writableProjectFile(key, scope);
    await writeJsonConfig(filePath, (current) => {
      // A file that does not parse is the user's to fix; overwriting it would lose every other setting in it.
      const settings = current === undefined ? {} : parseSettingsText(current, filePath);
      if (value === undefined) delete settings[key];
      else settings[key] = value;
      return `${JSON.stringify(settings, null, 2)}\n`;
    }, scope === 'user' ? {} : { confineTo: path.dirname(filePath) });
    this.reload();
  }

  onDidChange(section: string, cb: (change: SettingsChange) => void): Disposable {
    return this.listeners.add((changedKeys) => {
      if (affects(changedKeys, section)) cb({ affects: (key) => affects(changedKeys, key) });
    });
  }

  dispose(): void {
    clearTimeout(this.emptyRetry);
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.listeners.clear();
  }

  private writableProjectFile(key: string, scope: FileScope): string {
    if (this.isUserOnly(key)) {
      throw new Error(`${key} is read from user settings only, so it cannot be written to ${scope} settings`);
    }
    const folder = this.deps.defaultProject.folder();
    if (folder === undefined) throw new Error(`No project is open, so ${key} cannot be written to ${scope} settings`);
    if (!this.deps.trust.isTrusted(folder)) {
      throw new Error(`${folder} is not trusted, so ${key} cannot be written to its ${scope} settings`);
    }
    return projectFile(folder, scope);
  }

  // A key that is, contains or sits under a user-only key, so an object value cannot smuggle one in.
  private isUserOnly(key: string): boolean {
    for (const userOnly of this.deps.contributed.userOnlyKeys) {
      if (key === userOnly || userOnly.startsWith(`${key}.`) || key.startsWith(`${userOnly}.`)) return true;
    }
    return false;
  }

  private readLayers(acceptEmpty: boolean): Layers {
    const user = this.readLayer(this.deps.userFile, acceptEmpty);
    const folder = this.deps.defaultProject.folder();
    if (folder === undefined || !this.deps.trust.isTrusted(folder)) return { user };
    return {
      user,
      project: this.readProjectLayer(projectFile(folder, 'project'), acceptEmpty),
      local: this.readProjectLayer(projectFile(folder, 'local'), acceptEmpty),
    };
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
      this.reload(true);
    }, EMPTY_SETTINGS_RETRY_MS);
  }

  private reload(acceptEmpty = false): void {
    const previous = this.layers;
    this.layers = this.readLayers(acceptEmpty);
    const keys = new Set<string>();
    for (const layers of [previous, this.layers]) {
      for (const layer of [layers.user, layers.project, layers.local]) {
        if (layer !== undefined) for (const key of Object.keys(layer)) keys.add(key);
      }
    }
    const changed = [...keys].filter((key) =>
      layerValue(previous.user, key) !== layerValue(this.layers.user, key)
      || layerValue(previous.project, key) !== layerValue(this.layers.project, key)
      || layerValue(previous.local, key) !== layerValue(this.layers.local, key));
    if (changed.length === 0) return;
    this.listeners.fire(changed);
  }
}

function projectFile(folder: string, scope: FileScope): string {
  return path.join(folder, '.damocles', scope === 'project' ? PROJECT_FILE : LOCAL_FILE);
}
