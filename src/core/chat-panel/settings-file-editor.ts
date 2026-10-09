import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { Platform } from '../../platform/platform';
import type { PanelHost } from '../../platform/window-service';
import type { ExtensionToWebviewMessage, SettingsFileAvailability, SettingsFileScope, SettingsFileUnavailableReason } from '../../shared/types/messages';
import { defaultProjectPath } from '../workspace-folders/folder-registry';
import { folderKey } from '../workspace-folders/folder-key';
import { writeJsonConfig } from '../config/json-config-write';
import { parseSettingsText, settingsFileVersion } from '../config/settings-file';
import { log } from '../logger';
import { t } from '../l10n';

class SaveRefused extends Error {
  readonly conflict: boolean;

  constructor(message: string, conflict: boolean) {
    super(message);
    this.name = 'SaveRefused';
    this.conflict = conflict;
  }
}

export const SETTINGS_FILE_SCOPES: readonly SettingsFileScope[] = ['user', 'project', 'local'];
const KNOWN_SCOPES: ReadonlySet<string> = new Set(SETTINGS_FILE_SCOPES);

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

/** The file a scope names, or why it does not apply: project and local files only for a trusted default project. */
export function locateSettingsFile(platform: Platform, scope: SettingsFileScope): string | { reason: SettingsFileUnavailableReason } {
  if (!KNOWN_SCOPES.has(scope)) throw new Error(`unknown settings file scope ${JSON.stringify(scope)}`);
  if (scope !== 'user') {
    const folder = defaultProjectPath(platform.workspaceFolders, platform.state.workspace);
    if (folder === undefined) return { reason: 'noProject' };
    if (!platform.trust.isTrusted(folder)) return { reason: 'untrusted' };
  }
  const filePath = platform.settings.scopeFile(scope);
  if (filePath === undefined) throw new Error(`the settings store names no ${scope} settings file`);
  return filePath;
}

function unavailableReason(reason: SettingsFileUnavailableReason): string {
  return reason === 'noProject'
    ? t('No project is open, so this settings file cannot be saved.')
    : t('The project is not trusted, so its settings files cannot be saved.');
}

export type SettingsFileSaveOutcome =
  | { readonly ok: true; readonly path: string; readonly version: string }
  // conflict: the file's version is no longer baseVersion; cause: the error of a write that failed, which a host may word itself
  | { readonly ok: false; readonly error: string; readonly conflict: boolean; readonly cause?: unknown };

/**
 * The one save rule for a settings file's raw text (`version` is the sha256 of the file read as UTF-8, '' for no file):
 * refused when the scope no longer names filePath (the default project moved since it was opened), and inside the file's
 * lock when the file on disk does not parse, when its version is not baseVersion (a conflict), or when content does not
 * parse; otherwise content is written verbatim.
 */
export async function saveSettingsFileText(platform: Platform, scope: SettingsFileScope, filePath: string, content: string, baseVersion: string): Promise<SettingsFileSaveOutcome> {
  if (!platform.capabilities.settingsSources) throw new Error('this host keeps no Damocles settings files to edit');
  const located = locateSettingsFile(platform, scope);
  if (typeof located !== 'string') return { ok: false, error: unavailableReason(located.reason), conflict: false };
  if (folderKey(located) !== folderKey(filePath)) {
    return { ok: false, error: t('The default project changed since this file was opened. Reload it before saving.'), conflict: false };
  }
  try {
    await writeJsonConfig(located, (current) => {
      // A file that does not parse is the user's to fix; overwriting it would lose whatever it holds.
      const currentError = current === undefined ? undefined : parseError(current, located);
      if (currentError !== undefined) throw new SaveRefused(t('{0} does not parse, so it was not overwritten: {1}', located, currentError), false);
      if (settingsFileVersion(current) !== baseVersion) throw new SaveRefused(t('{0} changed on disk since it was loaded. Reload it before saving.', located), true);
      const contentError = parseError(content, located);
      if (contentError !== undefined) throw new SaveRefused(t('Not saved: the text is not valid JSON. {0}', contentError), false);
      return content;
    }, scope === 'user' ? {} : { confineTo: path.dirname(located) });
  } catch (err) {
    if (err instanceof SaveRefused) return { ok: false, error: err.message, conflict: err.conflict };
    log('[SettingsFileEditor] saving %s failed: %O', located, err);
    return { ok: false, error: t('Could not save {0}: {1}', located, errorMessage(err)), conflict: false, cause: err };
  }
  return { ok: true, path: located, version: settingsFileVersion(content) };
}

/**
 * Tells each panel that asked which of the three `.damocles` settings files apply (the settings modal's Edit settings.json
 * menu), again on every trust grant or project change until the panel is released.
 */
export class SettingsFileAvailabilityFeed implements Disposable {
  private readonly platform: Platform;
  private readonly post: (host: PanelHost, message: ExtensionToWebviewMessage) => void;
  private readonly panels = new Map<string, PanelHost>();
  private readonly subscriptions: Disposable[];

  constructor(platform: Platform, post: (host: PanelHost, message: ExtensionToWebviewMessage) => void) {
    this.platform = platform;
    this.post = post;
    const republish = (): void => this.republish();
    this.subscriptions = [platform.trust.onDidGrantTrust(republish), platform.workspaceFolders.onDidChange(republish)];
  }

  /** Posts which files apply now; true on the panel's first request, so the caller ties release to the panel's lifetime. */
  availability(panelId: string, host: PanelHost): boolean {
    if (!this.platform.capabilities.settingsSources) throw new Error('this host keeps no Damocles settings files to edit');
    const first = !this.panels.has(panelId);
    this.panels.set(panelId, host);
    this.post(host, { type: 'settingsFileAvailability', files: this.current() });
    return first;
  }

  releasePanel(panelId: string): void {
    this.panels.delete(panelId);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.panels.clear();
  }

  private current(): Record<SettingsFileScope, SettingsFileAvailability> {
    const entries = SETTINGS_FILE_SCOPES.map((scope): [SettingsFileScope, SettingsFileAvailability] => {
      const located = locateSettingsFile(this.platform, scope);
      return [scope, typeof located === 'string' ? { available: true } : { available: false, reason: located.reason }];
    });
    return Object.fromEntries(entries) as Record<SettingsFileScope, SettingsFileAvailability>;
  }

  private republish(): void {
    if (this.panels.size === 0) return;
    const files = this.current();
    for (const host of this.panels.values()) this.post(host, { type: 'settingsFileAvailability', files });
  }
}
