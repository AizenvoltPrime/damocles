// Shared by the overlay preload, main and (as types only) the shell and overlay apps. Main listens on the overlay view's own
// webContents.ipc, which only the overlay page's messages reach.

import type { ShellLocale, ShellPlatform } from './shell-channels';
import type { SettingsAccountId, SettingsSectionId, SettingsTarget } from '../../shared/settings-sections';
import type { DesktopLanguageSetting } from '../main/desktop-configuration';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../shared/types/messages';

export const OVERLAY_CHANNELS = {
  // renderer → main, invoke
  getState: 'damocles:overlay:get-state',
  // renderer → main, send
  ack: 'damocles:overlay:ack',
  answer: 'damocles:overlay:answer',
  resolveToast: 'damocles:overlay:resolve-toast',
  toastArea: 'damocles:overlay:toast-area',
  // Escape in the toast stack: keyboard focus goes back out of the overlay
  toastsLeave: 'damocles:overlay:toasts:leave',
  // { generation, message }: a settings view request for the chat the modal is attached to
  settingsSend: 'damocles:overlay:settings:send',
  // renderer → main, invoke
  prefsGet: 'damocles:overlay:prefs:get',
  prefsSet: 'damocles:overlay:prefs:set',
  relaunch: 'damocles:overlay:app:relaunch',
  layoutReset: 'damocles:overlay:layout:reset',
  // main → renderer
  // OverlayState after the UI language changed
  state: 'damocles:overlay:state',
  request: 'damocles:overlay:request',
  cancel: 'damocles:overlay:cancel',
  toast: 'damocles:overlay:toast',
  toastDismiss: 'damocles:overlay:toast-dismiss',
  // main → renderer: F6 moved keyboard focus to the overlay, which focuses the newest toast
  toastsFocus: 'damocles:overlay:toasts:focus',
  // main → renderer, PanelTheme; the preload applies it to the page itself
  theme: 'damocles:overlay:theme',
  // main → renderer, ExtensionToWebviewMessage for the settings modal
  settingsMessage: 'damocles:overlay:settings:message',
  // main → renderer, { generation }: the modal is attached to another chat now, and drops that chat's state
  settingsAttached: 'damocles:overlay:settings:attached',
  // main → renderer, SettingsTarget: settings were asked for again while the modal shows
  settingsTarget: 'damocles:overlay:settings:target',
  // main → renderer, OverlayPrefs after a damocles.desktop.* setting changed while the modal shows
  prefsChanged: 'damocles:overlay:prefs:changed',
} as const;

// Lucide names a request may carry; main rejects a request naming any other icon.
export const OVERLAY_ICONS = [
  'check',
  'copy',
  'folder-minus',
  'folder-open',
  'message-square',
  'pencil',
  'pencil-line',
  'plus',
  'shield-check',
  'tag',
  'tags',
  'trash-2',
  'x',
] as const;
export type OverlayIcon = (typeof OVERLAY_ICONS)[number];

// Payload bounds; main rejects a request or answer outside them.
export const MAX_OVERLAY_ITEMS = 100;
export const MAX_OVERLAY_LABEL_LENGTH = 200;
export const MAX_OVERLAY_ID_LENGTH = 200;
export const MAX_OVERLAY_TAGS = 500;
export const MAX_OVERLAY_TEXT_LENGTH = 2000;
// CSS px; a coordinate or size outside [0, MAX_OVERLAY_COORDINATE] is malformed.
export const MAX_OVERLAY_COORDINATE = 100_000;
// JSON characters of one settings view request; a pasted API key is far smaller.
export const MAX_SETTINGS_MESSAGE_CHARS: number = 64 * 1024;
// The overlay must ack a request within this many ms or main hides it and rejects the request.
export const OVERLAY_ACK_TIMEOUT_MS = 2000;

// CSS px in window content coordinates (the shell page's coordinates).
export interface OverlayPoint {
  readonly x: number;
  readonly y: number;
}

export interface OverlayRect extends OverlayPoint {
  readonly width: number;
  readonly height: number;
}

export type OverlayMenuItem =
  | {
      readonly kind: 'item';
      readonly id: string;
      readonly label: string;
      readonly icon?: OverlayIcon;
      readonly shortcut?: string;
      readonly danger?: boolean;
      readonly disabled?: boolean;
      readonly checked?: boolean;
    }
  | { readonly kind: 'separator' };

// Labels are localized by the sender.
export type OverlayRequest =
  | {
      readonly kind: 'menu';
      // the menu's accessible name
      readonly label: string;
      readonly anchor: OverlayRect;
      readonly items: readonly OverlayMenuItem[];
      // present = the menu shows a filter box (the all-tags menu)
      readonly filterPlaceholder?: string;
    }
  | {
      readonly kind: 'confirm';
      readonly title: string;
      readonly message: string;
      // running: the warning is about work in progress, marked with a spinner
      readonly warning?: { readonly text: string; readonly running: boolean };
      // a labelled box under the message, e.g. "Session:" and the chat title
      readonly detail?: { readonly label: string; readonly text: string };
      readonly confirmLabel: string;
      readonly cancelLabel: string;
      readonly danger: boolean;
    }
  | {
      readonly kind: 'tagPicker';
      readonly anchor: OverlayRect;
      readonly current?: string;
      readonly tags: readonly string[];
      readonly placeholder: string;
    }
  // Only main opens it; `generation` is the attachment the modal's first settingsSend calls must carry.
  | { readonly kind: 'settings'; readonly section?: SettingsSectionId; readonly account?: SettingsAccountId; readonly generation: number };

export type OverlayAnswer =
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'menu'; readonly itemId: string }
  | { readonly kind: 'confirm'; readonly confirmed: boolean }
  // null removes the tag
  | { readonly kind: 'tagPicker'; readonly tag: string | null }
  // sent once the modal's exit animation ended
  | { readonly kind: 'settings'; readonly closed: true };

export interface OverlayToast {
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly actions: readonly string[];
}

export interface OverlayState {
  readonly locale: ShellLocale;
  readonly platform: ShellPlatform;
}

export interface OverlayToastArea {
  readonly width: number;
  readonly height: number;
}

export interface OverlaySettingsAttached {
  readonly generation: number;
}

export interface OverlayPrefs {
  // every damocles.desktop.* setting, from user settings
  readonly values: Readonly<Record<string, unknown>>;
  // damocles.desktop.language as this run read it at launch; another value takes a restart
  readonly languageAtLaunch: DesktopLanguageSetting;
}

export type OverlayPrefWrite = { readonly ok: true; readonly file: string } | { readonly ok: false; readonly error: string };

export interface DamoclesOverlayApi {
  getState(): Promise<OverlayState>;
  // the new state after the UI language changed; returns the unsubscribe
  onState(listener: (state: OverlayState) => void): () => void;
  // returns the unsubscribe
  onRequest(listener: (requestId: string, request: OverlayRequest) => void): () => void;
  // main withdrew the request (timeout, crash, window closing); the overlay closes it without answering
  onCancel(listener: (requestId: string) => void): () => void;
  // the request is on screen; send within OVERLAY_ACK_TIMEOUT_MS
  ack(requestId: string): void;
  answer(requestId: string, answer: OverlayAnswer): void;
  onToast(listener: (toast: OverlayToast) => void): () => void;
  // main timed the toast out or it was answered elsewhere
  onToastDismiss(listener: (id: string) => void): () => void;
  // undefined action = dismissed
  resolveToast(id: string, action?: string): void;
  // CSS px of the measured toast stack, 0×0 when no toast shows
  reportToastArea(size: OverlayToastArea): void;
  // F6 moved keyboard focus into the toast stack; returns the unsubscribe
  onToastsFocus(listener: () => void): () => void;
  // Escape in the toast stack; main moves keyboard focus back out of the overlay
  leaveToasts(): void;
  // a settings view request; main drops it unless generation is the current attachment's
  settingsSend(generation: number, message: WebviewToExtensionMessage): void;
  onSettingsMessage(listener: (message: ExtensionToWebviewMessage) => void): () => void;
  onSettingsAttached(listener: (attached: OverlaySettingsAttached) => void): () => void;
  onSettingsTarget(listener: (target: SettingsTarget) => void): () => void;
  getPrefs(): Promise<OverlayPrefs>;
  onPrefsChanged(listener: (prefs: OverlayPrefs) => void): () => void;
  // writes a damocles.desktop.* setting to user settings
  setPref(key: string, value: unknown): Promise<OverlayPrefWrite>;
  // restarts the app through its normal quit path
  relaunch(): Promise<void>;
  // window-layout.json back to the default layout, applied now
  resetLayout(): Promise<void>;
}
