import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Disposable } from '../../platform/disposable';
import type { FileWatcher } from '../../platform/file-watcher';
import type { Platform } from '../../platform/platform';
import type { PanelHost } from '../../platform/window-service';
import type {
  ExtensionToWebviewMessage,
  SettingsFileAvailability,
  SettingsFileOnDisk,
  SettingsFileScope,
  SettingsFileUnavailableReason,
} from '../../shared/types/messages';
import { defaultProjectPath } from '../workspace-folders/folder-registry';
import { folderKey } from '../workspace-folders/folder-key';
import { writeJsonConfig } from '../config/json-config-write';
import { parseSettingsText, settingsFileVersion } from '../config/settings-file';
import { log } from '../logger';
import { t } from '../l10n';

interface LoadedFile {
  readonly path: string;
  // the version this panel last learned of, by load, save or change notification
  version: string;
  // the version a save in flight is writing; a watcher event for it is the panel's own save
  pendingVersion: string | undefined;
  readonly watcher: FileWatcher;
}

interface PanelFiles {
  readonly host: PanelHost;
  readonly files: Map<SettingsFileScope, LoadedFile>;
  // the panel asked for availability, so it hears each change to it
  availability: boolean;
}

class SaveRefused extends Error {
  readonly conflict: boolean;
  readonly onDisk: SettingsFileOnDisk | undefined;

  constructor(message: string, conflict: boolean, onDisk?: SettingsFileOnDisk) {
    super(message);
    this.name = 'SaveRefused';
    this.conflict = conflict;
    this.onDisk = onDisk;
  }
}

const SETTINGS_FILE_SCOPES: readonly SettingsFileScope[] = ['user', 'project', 'local'];
const KNOWN_SCOPES: ReadonlySet<string> = new Set(SETTINGS_FILE_SCOPES);

// Matches the project and local files the desktop settings store watches.
const PROJECT_FILES_GLOB = '.damocles/{settings.json,settings.local.json}';

async function readText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseError(text: string, filePath: string): string | undefined {
  try {
    parseSettingsText(text, filePath);
    return undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

/**
 * Loads and saves the raw text of the three `.damocles` settings files for the in-panel JSON editor, and tells each
 * panel when a file it loaded changes on disk. See docs/invariants.md "Settings file editor".
 */
export class SettingsFileEditor implements Disposable {
  private readonly platform: Platform;
  private readonly post: (host: PanelHost, message: ExtensionToWebviewMessage) => void;
  private readonly panels = new Map<string, PanelFiles>();
  private readonly subscriptions: Disposable[];

  constructor(platform: Platform, post: (host: PanelHost, message: ExtensionToWebviewMessage) => void) {
    this.platform = platform;
    this.post = post;
    const republish = (): void => this.republishAvailability();
    this.subscriptions = [platform.trust.onDidGrantTrust(republish), platform.workspaceFolders.onDidChange(republish)];
  }

  /** Returns true when this is the panel's first request, so the caller ties releasePanel to the panel's lifetime. */
  async load(panelId: string, host: PanelHost, scope: SettingsFileScope): Promise<boolean> {
    this.assertRequest(scope);
    const located = this.locate(scope);
    if (typeof located !== 'string') {
      this.forget(panelId, scope);
      this.post(host, { type: 'settingsFileContent', file: { scope, status: 'unavailable', reason: located.reason } });
      return false;
    }
    let text: string | undefined;
    try {
      text = await readText(located);
    } catch (err) {
      log('[SettingsFileEditor] reading %s failed: %O', located, err);
      this.forget(panelId, scope);
      this.post(host, { type: 'settingsFileContent', file: { scope, status: 'unavailable', reason: 'unreadable', path: located, error: errorMessage(err) } });
      return false;
    }
    const version = settingsFileVersion(text);
    const existing = this.panels.get(panelId)?.files.get(scope);
    let firstForPanel = false;
    if (existing?.path === located) {
      existing.version = version;
    } else {
      const watcher = this.watch(panelId, scope, located);
      existing?.watcher.dispose();
      const entry = this.enter(panelId, host);
      firstForPanel = entry.first;
      entry.panel.files.set(scope, { path: located, version, pendingVersion: undefined, watcher });
    }
    const error = text === undefined ? undefined : parseError(text, located);
    this.post(host, {
      type: 'settingsFileContent',
      file: {
        scope,
        status: 'ready',
        path: located,
        exists: text !== undefined,
        content: text ?? '',
        version,
        ...(error !== undefined ? { parseError: error } : {}),
      },
    });
    return firstForPanel;
  }

  async save(panelId: string, host: PanelHost, scope: SettingsFileScope, content: string, baseVersion: string): Promise<void> {
    this.assertRequest(scope);
    const refuse = (error: string, conflict = false, onDisk?: SettingsFileOnDisk): void => {
      this.post(host, { type: 'settingsFileSaveResult', scope, ok: false, error, ...(conflict ? { conflict } : {}), ...(onDisk ? { onDisk } : {}) });
    };
    const located = this.locate(scope);
    if (typeof located !== 'string') {
      refuse(located.reason === 'noProject'
        ? t('No project is open, so this settings file cannot be saved.')
        : t('The project is not trusted, so its settings files cannot be saved.'));
      return;
    }
    const loaded = this.panels.get(panelId)?.files.get(scope);
    if (!loaded) {
      refuse(t('{0} was not opened in this panel, so it was not saved. Open it again before saving.', located));
      return;
    }
    if (loaded.path !== located) {
      refuse(t('The default project changed since this file was opened. Reload it before saving.'), true);
      return;
    }
    loaded.pendingVersion = settingsFileVersion(content);
    try {
      await writeJsonConfig(located, (current) => {
        // A file that does not parse is the user's to fix; overwriting it would lose whatever it holds.
        const currentError = current === undefined ? undefined : parseError(current, located);
        if (currentError !== undefined) throw new SaveRefused(t('{0} does not parse, so it was not overwritten: {1}', located, currentError), false);
        const currentVersion = settingsFileVersion(current);
        if (currentVersion !== baseVersion) {
          const onDisk = { exists: current !== undefined, content: current ?? '', version: currentVersion };
          throw new SaveRefused(t('{0} changed on disk since it was loaded. Reload it before saving.', located), true, onDisk);
        }
        const contentError = parseError(content, located);
        if (contentError !== undefined) throw new SaveRefused(t('Not saved: the text is not valid JSON. {0}', contentError), false);
        return content;
      }, scope === 'user' ? {} : { confineTo: path.dirname(located) });
    } catch (err) {
      loaded.pendingVersion = undefined;
      if (err instanceof SaveRefused) {
        refuse(err.message, err.conflict, err.onDisk);
        return;
      }
      log('[SettingsFileEditor] saving %s failed: %O', located, err);
      refuse(t('Could not save {0}: {1}', located, errorMessage(err)));
      return;
    }
    loaded.pendingVersion = undefined;
    loaded.version = settingsFileVersion(content);
    this.post(host, { type: 'settingsFileSaveResult', scope, ok: true, version: loaded.version });
  }

  /** Posts which files apply now, and again on each trust grant or project change until the panel is released. */
  availability(panelId: string, host: PanelHost): boolean {
    if (!this.platform.capabilities.settingsSources) throw new Error('this host keeps no Damocles settings files to edit');
    const { panel, first } = this.enter(panelId, host);
    panel.availability = true;
    this.post(host, { type: 'settingsFileAvailability', files: this.currentAvailability() });
    return first;
  }

  async reveal(scope: SettingsFileScope): Promise<void> {
    this.assertRequest(scope);
    const located = this.locate(scope);
    if (typeof located === 'string') await this.platform.shell.revealPath(located);
  }

  releasePanel(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;
    for (const file of panel.files.values()) file.watcher.dispose();
    this.panels.delete(panelId);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const panelId of [...this.panels.keys()]) this.releasePanel(panelId);
  }

  // Only a host that keeps these files (settingsSources) offers the editor, so a request from any other is a bug.
  // The scope comes from the webview, so it is checked here rather than trusted to the store's path mapping.
  private assertRequest(scope: SettingsFileScope): void {
    if (!this.platform.capabilities.settingsSources) throw new Error('this host keeps no Damocles settings files to edit');
    if (!KNOWN_SCOPES.has(scope)) throw new Error(`unknown settings file scope ${JSON.stringify(scope)}`);
  }

  private locate(scope: SettingsFileScope): string | { reason: SettingsFileUnavailableReason } {
    if (scope !== 'user') {
      const folder = defaultProjectPath(this.platform.workspaceFolders, this.platform.state.workspace);
      if (folder === undefined) return { reason: 'noProject' };
      if (!this.platform.trust.isTrusted(folder)) return { reason: 'untrusted' };
    }
    const filePath = this.platform.settings.scopeFile(scope);
    if (filePath === undefined) throw new Error(`the settings store names no ${scope} settings file`);
    return filePath;
  }

  private currentAvailability(): Record<SettingsFileScope, SettingsFileAvailability> {
    const entries = SETTINGS_FILE_SCOPES.map((scope): [SettingsFileScope, SettingsFileAvailability] => {
      const located = this.locate(scope);
      return [scope, typeof located === 'string' ? { available: true } : { available: false, reason: located.reason }];
    });
    return Object.fromEntries(entries) as Record<SettingsFileScope, SettingsFileAvailability>;
  }

  private republishAvailability(): void {
    const listening = [...this.panels.values()].filter((panel) => panel.availability);
    if (listening.length === 0) return;
    const files = this.currentAvailability();
    for (const panel of listening) this.post(panel.host, { type: 'settingsFileAvailability', files });
  }

  private enter(panelId: string, host: PanelHost): { panel: PanelFiles; first: boolean } {
    const existing = this.panels.get(panelId);
    if (existing) return { panel: existing, first: false };
    const panel: PanelFiles = { host, files: new Map(), availability: false };
    this.panels.set(panelId, panel);
    return { panel, first: true };
  }

  private forget(panelId: string, scope: SettingsFileScope): void {
    const panel = this.panels.get(panelId);
    panel?.files.get(scope)?.watcher.dispose();
    panel?.files.delete(scope);
  }

  private watch(panelId: string, scope: SettingsFileScope, filePath: string): FileWatcher {
    const watcher = scope === 'user'
      ? this.platform.fileWatchers.watch(path.dirname(filePath), path.basename(filePath))
      : this.platform.fileWatchers.watchWorkspace(PROJECT_FILES_GLOB);
    const key = folderKey(filePath);
    const refresh = (changed: string): void => {
      if (folderKey(changed) !== key) return;
      this.refresh(panelId, scope, filePath).catch((err: unknown) => log('[SettingsFileEditor] re-reading %s failed: %O', filePath, err));
    };
    watcher.onDidCreate(refresh);
    watcher.onDidChange(refresh);
    watcher.onDidDelete(refresh);
    return watcher;
  }

  private async refresh(panelId: string, scope: SettingsFileScope, filePath: string): Promise<void> {
    const version = settingsFileVersion(await readText(filePath));
    const panel = this.panels.get(panelId);
    const loaded = panel?.files.get(scope);
    if (!panel || loaded?.path !== filePath || loaded.version === version || loaded.pendingVersion === version) return;
    loaded.version = version;
    this.post(panel.host, { type: 'settingsFileChanged', scope, version });
  }
}
