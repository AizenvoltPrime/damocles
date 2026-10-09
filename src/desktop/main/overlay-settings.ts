import type { WebContents } from 'electron';
import type { Disposable } from '../../platform/disposable';
import type { SettingsStore } from '../../platform/settings-store';
import type { PanelManager } from '../../core/chat-panel/panel-manager';
import type { WebviewToExtensionMessage } from '../../shared/types/messages';
import { isSettingsAccountId, isSettingsSectionId, type SettingsTarget } from '../../shared/settings-sections';
import { SETTINGS_VIEW_REQUEST_TYPES } from '../../shared/settings-view-messages';
import { MAX_SETTINGS_MESSAGE_CHARS, OVERLAY_CHANNELS, type OverlayPrefs, type OverlayPrefWrite } from '../preload/overlay-channels';
import type { TerminalProfileReport } from '../preload/terminal-channels';
import { DESKTOP_CONFIGURATION, isDesktopSettingValue, TERMINAL_PROFILES_SETTING, type DesktopLanguageSetting } from './desktop-configuration';
import type { OverlayHost } from './overlay';
import { isVersion } from './release-notes';
import { asJsonValue, isWebviewMessage } from './views';

export interface OverlaySettingsDeps {
  readonly overlay: OverlayHost;
  readonly settings: SettingsStore;
  readonly panelManager: () => PanelManager | undefined;
  // the core panel id of the selected chat, opening an empty chat on the default project when none is loaded (the
  // promptTarget rule); undefined when no chat could be had
  readonly targetPanel: () => Promise<string | undefined>;
  // the webContents keyboard focus returns to when the modal closes
  readonly focused: () => WebContents | undefined;
  readonly relaunch: () => void;
  readonly resetLayout: () => void;
  // Settings › Terminal's profiles: the listed ones (its default profile), the hidden detected ones and the refused entries
  readonly terminalProfiles: () => TerminalProfileReport;
  readonly log: (line: string) => void;
  readonly languageAtLaunch: DesktopLanguageSetting;
}

/** The one write path for a damocles.desktop.* value: checked against its declaration, written to user settings (D37). */
export async function writeDesktopSetting(settings: SettingsStore, key: string, value: unknown): Promise<void> {
  if (!isDesktopSettingValue(key, value)) throw new Error('Not a desktop setting value');
  await settings.update(key, value, 'user');
}

interface Attachment {
  readonly panelId: string;
  readonly generation: number;
  readonly handle: Disposable;
}

/**
 * The settings modal in the overlay (plan AD2): attaches it to the selected chat with PanelManager.attachView, re-attaches
 * it when the selection changes, and carries its messages both ways. Each attachment has a generation, and a message the
 * renderer sent for an earlier one is dropped, so a write meant for one chat never lands on another.
 */
export class OverlaySettings {
  private readonly deps: OverlaySettingsDeps;
  private open = false;
  private generation = 0;
  private attachment: Attachment | undefined;
  // attach work runs one at a time, so a selection change during an attach never leaves two views
  private attaching: Promise<void> = Promise.resolve();
  private readonly prefsWatch: Disposable;

  constructor(deps: OverlaySettingsDeps) {
    this.deps = deps;
    const { overlay } = deps;
    this.prefsWatch = deps.settings.onDidChange('damocles.desktop', () => {
      if (this.open) overlay.send(OVERLAY_CHANNELS.prefsChanged, this.prefs());
    });
    overlay.on(OVERLAY_CHANNELS.settingsSend, (raw) => this.receive(raw));
    overlay.handle(OVERLAY_CHANNELS.prefsGet, () => this.prefs());
    overlay.handle(OVERLAY_CHANNELS.prefsSet, (raw) => {
      if (!this.open) throw new Error('Desktop settings are written only by the open settings');
      return this.setPref(raw);
    });
    overlay.handle(OVERLAY_CHANNELS.relaunch, () => {
      if (!this.open) throw new Error('Restart is offered only by the open settings');
      deps.relaunch();
    });
    overlay.handle(OVERLAY_CHANNELS.layoutReset, () => {
      if (!this.open) throw new Error('Restore default layout is offered only by the open settings');
      deps.resetLayout();
    });
    overlay.handle(OVERLAY_CHANNELS.terminalProfiles, (raw) => {
      if (!this.open) throw new Error('Terminal profiles are listed only for the open settings');
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length > 0) throw new Error('Malformed terminal profiles request');
      return deps.terminalProfiles();
    });
  }

  /**
   * Opens the modal on the target's section, with its account or release expanded there, attached to the selected chat;
   * resolves once it has closed. While it shows, the modal goes to the target instead.
   */
  async show(request: SettingsTarget): Promise<void> {
    const { section, account, release } = request;
    if (section !== undefined && !isSettingsSectionId(section)) throw new Error('Unknown settings section');
    if (account !== undefined && !isSettingsAccountId(account)) throw new Error('Unknown settings account');
    if (release !== undefined && !isVersion(release)) throw new Error('Unknown release');
    const target: SettingsTarget = {
      ...(section !== undefined ? { section } : {}),
      ...(account !== undefined ? { account } : {}),
      ...(release !== undefined ? { release } : {}),
    };
    if (this.open) {
      this.deps.overlay.send(OVERLAY_CHANNELS.settingsTarget, target);
      return;
    }
    this.open = true;
    const returnFocus = this.deps.focused();
    try {
      await this.reattach();
      // The window closed while the modal was opening.
      if (!this.open) return;
      const attachment = this.attachment;
      if (attachment === undefined) throw new Error('No chat could be opened for the settings');
      await this.deps.overlay.request({ kind: 'settings', ...target, generation: attachment.generation }, returnFocus);
    } finally {
      this.open = false;
      this.generation++;
      const attachment = this.attachment;
      this.attachment = undefined;
      attachment?.handle.dispose();
    }
  }

  dispose(): void {
    this.prefsWatch.dispose();
  }

  /** The window is closing: the modal goes with it and follows none of the chats the close unloads. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.deps.overlay.dismiss('settings');
  }

  /** The selected chat may have changed; an open modal follows it. */
  selectionChanged(): void {
    if (!this.open) return;
    this.reattach().catch((err: unknown) => this.deps.log(`[settings] re-attaching to the selected chat failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private reattach(): Promise<void> {
    const run = this.attaching.then(() => this.attachToTarget());
    this.attaching = run.catch(() => undefined);
    return run;
  }

  private async attachToTarget(): Promise<void> {
    if (!this.open) return;
    const panelId = await this.deps.targetPanel();
    const panelManager = this.deps.panelManager();
    if (!this.open || panelId === undefined || panelManager === undefined) return;
    const current = this.attachment;
    if (current !== undefined && current.panelId === panelId && panelManager.attachedView(panelId) !== undefined) return;
    const generation = ++this.generation;
    // Sent before the attach, which posts the chat's host prompts to the view; the renderer resets its stores on this.
    // The first attachment's generation travels in the request itself.
    if (current !== undefined) this.deps.overlay.send(OVERLAY_CHANNELS.settingsAttached, { generation });
    // Both callbacks compare this.generation, not this.attachment: attachView calls post before it returns the handle.
    const handle = panelManager.attachView(panelId, {
      post: (message) => {
        if (this.generation === generation) this.deps.overlay.send(OVERLAY_CHANNELS.settingsMessage, message);
      },
      // The chat closed under the open modal: it follows the selection to another chat.
      detached: () => {
        if (this.open && this.generation === generation) this.selectionChanged();
      },
    });
    this.attachment = { panelId, generation, handle };
    current?.handle.dispose();
  }

  private receive(raw: unknown): void {
    const envelope = asJsonValue(raw, MAX_SETTINGS_MESSAGE_CHARS);
    const value = envelope?.value as { generation?: unknown; message?: unknown } | undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.deps.log('[settings] dropped a malformed or oversized settings message');
      return;
    }
    const attachment = this.attachment;
    if (!this.open || attachment === undefined || value.generation !== attachment.generation) {
      this.deps.log('[settings] dropped a settings message sent for an earlier attachment');
      return;
    }
    const message = value.message;
    // Only the type is ever logged: these messages carry API keys and prompt answers.
    if (!isWebviewMessage(message) || !SETTINGS_VIEW_REQUEST_TYPES.has(message.type)) {
      this.deps.log(`[settings] refused a settings message of type ${isWebviewMessage(message) ? JSON.stringify(message.type.slice(0, 64)) : 'none'}`);
      return;
    }
    const panelManager = this.deps.panelManager();
    if (panelManager === undefined) return;
    panelManager.dispatchFromView(attachment.panelId, message as WebviewToExtensionMessage)
      .catch((err: unknown) => this.deps.log(`[settings] ${message.type} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** The profiles were validated again: the open modal gets the new report. */
  terminalProfilesChanged(): void {
    if (this.open) this.deps.overlay.send(OVERLAY_CHANNELS.terminalProfilesChanged, this.deps.terminalProfiles());
  }

  private prefs(): OverlayPrefs {
    return {
      // Settings › Terminal reads the validated profile report, never the raw profile entries
      values: Object.fromEntries(Object.keys(DESKTOP_CONFIGURATION).filter((key) => key !== TERMINAL_PROFILES_SETTING).map((key) => [key, this.deps.settings.get(key)])),
      languageAtLaunch: this.deps.languageAtLaunch,
    };
  }

  private async setPref(raw: unknown): Promise<OverlayPrefWrite> {
    const request = raw as { key?: unknown; value?: unknown } | null;
    if (typeof request !== 'object' || request === null || typeof request.key !== 'string') return { ok: false, error: 'Not a desktop setting value' };
    try {
      await writeDesktopSetting(this.deps.settings, request.key, request.value);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const file = this.deps.settings.scopeFile('user');
    if (file === undefined) throw new Error('The desktop settings store has no user file');
    return { ok: true, file };
  }
}
