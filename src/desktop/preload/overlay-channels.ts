// Shared by the overlay preload, main and (as types only) the shell and overlay apps. The overlay view and the desktop
// popup window's page both run the overlay preload; main listens on each one's own webContents.ipc, which only that page's
// messages reach, and answers the popup page only on getState and the toast channels.

import type { DropZonesPointer, GridPane, GridSlot, ShellGridLayout, ShellLocale, ShellPlatform } from './shell-channels';
import type { SettingsAccountId, SettingsSectionId, SettingsTarget } from '../../shared/settings-sections';
import type { DesktopLanguageSetting } from '../main/desktop-configuration';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../shared/types/messages';
import type { ChimeTone, NotificationBody, NotificationCenterState } from './notifications';
import type { ReleaseIndex, ReleaseNotes, UpdateSnapshot, VersionInfo } from './updates';
import type { TerminalColor, TerminalGlyph, TerminalProfileOption, TerminalProfileReport, TerminalProjectOption } from './terminal-channels';

export const OVERLAY_CHANNELS = {
  // renderer → main, invoke
  getState: 'damocles:overlay:get-state',
  // renderer → main, send
  ack: 'damocles:overlay:ack',
  shown: 'damocles:overlay:shown',
  answer: 'damocles:overlay:answer',
  resolveToast: 'damocles:overlay:resolve-toast',
  toastArea: 'damocles:overlay:toast-area',
  // Escape in the toast stack: keyboard focus goes back to the part F6 took it from
  toastsLeave: 'damocles:overlay:toasts:leave',
  // (id, held): the pointer or keyboard focus is on a toast, whose life main pauses until released
  toastHold: 'damocles:overlay:toast-hold',
  // boolean: the pointer is over a toast or the "N more" pill, so the popup window takes it
  toastsPointer: 'damocles:overlay:toasts:pointer',
  // { generation, message }: a settings view request for the chat the modal is attached to
  settingsSend: 'damocles:overlay:settings:send',
  // (id, png: Uint8Array | null): the answer to a rasterize request; main validates the PNG before using it
  rasterized: 'damocles:overlay:rasterized',
  // renderer → main, invoke
  prefsGet: 'damocles:overlay:prefs:get',
  prefsSet: 'damocles:overlay:prefs:set',
  relaunch: 'damocles:overlay:app:relaunch',
  layoutReset: 'damocles:overlay:layout:reset',
  // the notification center; refused unless the center is open
  notificationsGet: 'damocles:overlay:notifications:get',
  notificationsClear: 'damocles:overlay:notifications:clear',
  // boolean: Do not disturb on or off
  notificationsDnd: 'damocles:overlay:notifications:dnd',
  // Settings › About; each is refused unless the settings modal is open
  updateGet: 'damocles:overlay:update:get',
  // a check from About, which posts no notice: the version card shows its result
  updateCheck: 'damocles:overlay:update:check',
  updateRestart: 'damocles:overlay:update:restart',
  updateShowLog: 'damocles:overlay:update:show-log',
  updateCopyInfo: 'damocles:overlay:update:copy-info',
  updateVersionInfo: 'damocles:overlay:update:version-info',
  // macOS, while an update is available
  updateOpenReleasePage: 'damocles:overlay:update:open-release-page',
  releaseNotesIndex: 'damocles:overlay:release-notes:index',
  // { version }: a version of the index
  releaseNotesGet: 'damocles:overlay:release-notes:get',
  // QuickOpenQuery → QuickOpenResponse; refused unless a quickOpen request is open
  quickOpenQuery: 'damocles:overlay:quick-open:query',
  // {} → PaletteCommand[] for the focus context main captured when the quickOpen request opened; refused unless one is open
  commandsList: 'damocles:overlay:commands:list',
  // {} → TerminalProfileReport for Settings › Terminal; refused unless the settings modal is open
  terminalProfiles: 'damocles:overlay:terminal:profiles',
  // main → renderer
  // OverlayState after the UI language changed
  state: 'damocles:overlay:state',
  request: 'damocles:overlay:request',
  cancel: 'damocles:overlay:cancel',
  toast: 'damocles:overlay:toast',
  toastDismiss: 'damocles:overlay:toast-dismiss',
  // main → renderer: F6 moved keyboard focus to the popup window, whose page focuses the newest toast
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
  // main → renderer, TerminalProfileReport after the profiles were validated again while the modal shows
  terminalProfilesChanged: 'damocles:overlay:terminal:profiles-changed',
  // main → renderer, NotificationCenterState after a change while the center is open
  notificationsState: 'damocles:overlay:notifications:state',
  // main → renderer, OverlayRasterRequest: draw main's art on a canvas and answer with its PNG
  rasterize: 'damocles:overlay:rasterize',
  // main → renderer, ChimeTone: the popup page plays the sound of a popup that just arrived
  chime: 'damocles:overlay:chime',
  // main → renderer, UpdateSnapshot after each update state change while the settings modal is open
  updateState: 'damocles:overlay:update:state',
  // main → renderer, DropZonesPointer from the shell's pane drag while a dropZones request is open
  dropZonesPointer: 'damocles:overlay:drop-zones:pointer',
} as const;

// Lucide names a request may carry; main rejects a request naming any other icon.
export const OVERLAY_ICONS = [
  'arrow-right-to-line',
  'at-sign',
  'check',
  'chevrons-up-down',
  'circle-x',
  'clipboard-paste',
  'code',
  'columns-2',
  'copy',
  'copy-x',
  'eraser',
  'eye',
  'file',
  'file-plus',
  'file-text',
  'filter',
  'filter-x',
  'folder-minus',
  'folder-open',
  'folder-plus',
  'folder-search',
  'git-compare',
  'list-tree',
  'maximize-2',
  'message-square',
  'palette',
  'panel-bottom',
  'panel-right',
  'pencil',
  'pencil-line',
  'plus',
  'replace',
  'replace-all',
  'rotate-cw',
  'scroll-text',
  'search',
  'shapes',
  'shield-check',
  'square',
  'square-code',
  'tag',
  'tags',
  'text-select',
  'trash-2',
  'ungroup',
  'x',
] as const;
export type OverlayIcon = (typeof OVERLAY_ICONS)[number];

// Payload bounds; main rejects a request or answer outside them.
export const MAX_OVERLAY_ITEMS = 100;
export const MAX_OVERLAY_LABEL_LENGTH = 200;
export const MAX_OVERLAY_ID_LENGTH = 200;
// A palette command id; an Open Chat in Project id carries the project's absolute path.
export const MAX_COMMAND_ID_LENGTH = 5000;
export const MAX_OVERLAY_TAGS = 500;
export const MAX_OVERLAY_TEXT_LENGTH = 2000;
// Buttons of a message dialog besides Cancel.
export const MAX_MESSAGE_ACTIONS = 4;
// Lines of a message dialog's preview, each at most MAX_OVERLAY_LABEL_LENGTH characters.
export const MAX_MESSAGE_PREVIEW_LINES = 8;
// CSS px; a coordinate or size outside [0, MAX_OVERLAY_COORDINATE] is malformed.
export const MAX_OVERLAY_COORDINATE = 100_000;
// Boxes in one toast area report: three toasts, the pill and toasts still leaving.
export const MAX_TOAST_PARTS = 32;
// JSON characters of one settings view request; a pasted API key is far smaller.
export const MAX_SETTINGS_MESSAGE_CHARS: number = 64 * 1024;
// The overlay must ack receipt of a request within this many ms or main hides it and rejects the request.
export const OVERLAY_ACK_TIMEOUT_MS = 2000;
// Bytes of one rasterized PNG; main refuses a larger answer.
export const MAX_RASTER_PNG_BYTES: number = 64 * 1024;

// Main's art for the taskbar badge (D52): drawn in order on a width×height canvas. Coordinates and sizes are design units,
// multiplied by scale; an SVG layer covers the whole canvas.
export type RasterOp =
  | { readonly kind: 'svg'; readonly svg: string }
  // centred on (x, y) by its ink box, in the renderer's --d-font
  | { readonly kind: 'text'; readonly text: string; readonly x: number; readonly y: number; readonly size: number; readonly weight: number; readonly color: string };

export interface RasterArt {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly ops: readonly RasterOp[];
}

export interface OverlayRasterRequest {
  // issued by main
  readonly id: string;
  readonly art: RasterArt;
}

// CSS px in window content coordinates (the shell page's coordinates).
export interface OverlayPoint {
  readonly x: number;
  readonly y: number;
}

export interface OverlayRect extends OverlayPoint {
  readonly width: number;
  readonly height: number;
}

// What main does itself when the user picks an item: cut, copy or paste on the page that asked, or allow one paste into its
// active terminal. Main sets such an item's label and icon, and keeps it only in a menu a context-menu click or key opened.
export const OVERLAY_CLIPBOARD_ACTIONS = ['cut', 'copy', 'paste', 'terminalPaste'] as const;
export type OverlayClipboardAction = (typeof OVERLAY_CLIPBOARD_ACTIONS)[number];

export type OverlayMenuItem =
  | {
      readonly kind: 'item';
      readonly id: string;
      readonly label: string;
      readonly clipboard?: OverlayClipboardAction;
      readonly icon?: OverlayIcon;
      // a shell's or custom terminal icon, drawn instead of icon (the New Terminal dropdown's profiles)
      readonly glyph?: TerminalGlyph;
      // tints the glyph with --d-ansi-<index of the color in TERMINAL_COLORS>
      readonly color?: TerminalColor;
      readonly shortcut?: string;
      readonly danger?: boolean;
      readonly disabled?: boolean;
      readonly checked?: boolean;
    }
  | { readonly kind: 'separator' };

/** Drops separators at either end and repeated ones, which conditional menu sections and dropped items leave behind. */
export function tidyMenu(items: readonly OverlayMenuItem[]): OverlayMenuItem[] {
  const out: OverlayMenuItem[] = [];
  for (const item of items) {
    if (item.kind === 'separator' && (out.length === 0 || out[out.length - 1]?.kind === 'separator')) continue;
    out.push(item);
  }
  if (out[out.length - 1]?.kind === 'separator') out.pop();
  return out;
}

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
      // a line above the items, e.g. a file's relative path, in mono
      readonly caption?: string;
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
  | {
      readonly kind: 'settings';
      readonly section?: SettingsSectionId;
      readonly account?: SettingsAccountId;
      // a release index version, which About's What's new expands and scrolls to
      readonly release?: string;
      readonly generation: number;
    }
  // Only main asks one (D41); it stacks above an open request instead of dismissing it.
  | {
      readonly kind: 'message';
      readonly severity: MessageSeverity;
      readonly message: string;
      readonly detail?: string;
      readonly actions: readonly string[];
      // absent: no Cancel button (a save prompt offers Save and Don't Save only); Escape and the scrim still answer null
      readonly cancelLabel?: string;
      // index of the action focused first; absent, Cancel is, so Enter alone never takes a risky action
      readonly defaultAction?: number;
      // lines shown verbatim in the mono font under the detail, e.g. the start of a paste with its control characters as symbols
      readonly preview?: readonly string[];
    }
  // the title bar bell's menu, under the bell
  | { readonly kind: 'notifications'; readonly anchor: OverlayRect }
  // Ctrl+P or the title-bar search box (files), or Ctrl+Shift+P (commands); only main opens it. Files mode answers through
  // quickOpenQuery, commands mode through commandsList; a leading '>' switches files to commands, as VS Code does. A scope
  // limits the files to one folder of one project.
  | { readonly kind: 'quickOpen'; readonly mode: QuickOpenMode; readonly scope?: QuickOpenScope }
  // New Terminal (Ctrl+Shift+` or the terminal pane's +); only main opens it. Step 1 picks a profile; step 2 a project, skipped
  // when projects has one entry. Shift+click or Shift+Enter on a profile answers with the current project.
  | { readonly kind: 'newTerminal'; readonly profiles: readonly TerminalProfileOption[]; readonly projects: readonly TerminalProjectOption[] }
  // A list main offers (Change Icon..., Change Color..., Select Default Profile); only main opens it. The current item is
  // focused first; filtering matches label and description.
  | { readonly kind: 'quickPick'; readonly placeholder: string; readonly items: readonly OverlayQuickPickItem[] }
  // a pane dragged past the shell's threshold; grid is the layout grid's rectangle, pointer where the drag is now
  | {
      readonly kind: 'dropZones';
      readonly pane: GridPane;
      readonly slots: ShellGridLayout['slots'];
      readonly grid: OverlayRect;
      readonly pointer: OverlayPoint;
    };

export type MessageSeverity = 'info' | 'warning' | 'danger';

// At most MAX_OVERLAY_ITEMS per request; id and label within MAX_OVERLAY_ID_LENGTH and MAX_OVERLAY_LABEL_LENGTH.
export interface OverlayQuickPickItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly glyph?: TerminalGlyph;
  // tints the glyph with --d-ansi-<index of the color in TERMINAL_COLORS>
  readonly color?: TerminalColor;
  // the current value, marked with a check
  readonly current?: boolean;
}

export type OverlayAnswer =
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'menu'; readonly itemId: string }
  | { readonly kind: 'confirm'; readonly confirmed: boolean }
  // null removes the tag
  | { readonly kind: 'tagPicker'; readonly tag: string | null }
  // sent once the modal's exit animation ended
  | { readonly kind: 'settings'; readonly closed: true }
  // the index of the chosen action; null is Cancel
  | { readonly kind: 'message'; readonly action: number | null }
  | { readonly kind: 'notifications'; readonly action: 'open'; readonly entryId: string }
  // null: Escape; mention: the query had the @ prefix
  | { readonly kind: 'quickOpen'; readonly pick: QuickOpenPick | null }
  // a PaletteCommand id; main runs it only when it is listed and enabled for the captured focus context
  | { readonly kind: 'quickOpen'; readonly command: string }
  // Escape answers dismissed; main refuses a profile or project the request did not offer
  | { readonly kind: 'newTerminal'; readonly profileId: string; readonly projectKey: string }
  // Escape answers dismissed; main refuses an id the request did not offer
  | { readonly kind: 'quickPick'; readonly itemId: string }
  // null: dropped outside every zone, or Escape
  | { readonly kind: 'dropZones'; readonly slot: GridSlot | null };

export type QuickOpenMode = 'files' | 'commands';

export interface QuickOpenScope {
  readonly projectKey: string;
  readonly projectName: string;
  // '/' separated, relative to the project, ending in '/'; '' is the project's root
  readonly folder: string;
}

// A command of the desktop registry as the palette shows it, for the focus context main captured.
export interface PaletteCommand {
  readonly id: string;
  // "Category: Title", localized
  readonly label: string;
  // the same in English, which the palette also matches when the UI language is not English
  readonly englishLabel: string;
  readonly category: string;
  // the platform's display form, e.g. 'Ctrl+Shift+F' or '⇧⌘F'
  readonly accelerator: string | null;
  readonly enabled: boolean;
  readonly checked?: boolean;
  // run during this session; recent ones come first, most recent on top
  readonly recent: boolean;
}

export interface QuickOpenPick {
  readonly projectKey: string;
  readonly relativePath: string;
  // 1-based, from the query's :line suffix
  readonly line?: number;
  readonly mention: boolean;
}

// Characters of a Quick Open query; main refuses a longer one.
export const MAX_QUICK_OPEN_QUERY_LENGTH = 512;
// Results of a non-empty query.
export const MAX_QUICK_OPEN_RESULTS = 30;

// generation: the overlay's counter; a response carries the query's, so a late answer to an older query is ignored
export interface QuickOpenQuery {
  readonly query: string;
  readonly generation: number;
}

// [start, end) UTF-16 offsets into label or description
export type QuickOpenMatch = readonly [number, number];

export interface QuickOpenResult {
  readonly projectKey: string;
  readonly projectName: string;
  readonly relativePath: string;
  // the file name
  readonly label: string;
  // the folder path relative to the project, '' at its root
  readonly description: string;
  readonly labelMatches: readonly QuickOpenMatch[];
  readonly descriptionMatches: readonly QuickOpenMatch[];
  readonly recent: boolean;
}

export interface QuickOpenResponse {
  readonly generation: number;
  // the selected project, for the current-project label
  readonly currentProjectKey?: string;
  // the query's :line suffix and @ prefix as main parsed them, so the overlay need not parse
  readonly line?: number;
  readonly mention: boolean;
  // recent files first, then per-project groups (empty query) or best score first
  readonly results: readonly QuickOpenResult[];
}

// A notification-center entry on screen; its id is the entry's.
export interface OverlayToast {
  readonly id: string;
  // epoch ms
  readonly at: number;
  readonly lifeMs: number;
  // life left when main sent it; main pauses it while the toast is held
  readonly remainingMs: number;
  readonly body: NotificationBody;
}

export interface OverlayState {
  readonly locale: ShellLocale;
  readonly platform: ShellPlatform;
}

// CSS px of the measured toast stack with its margin, 0×0 when no toast shows; the area's bottom-right corner is the popup
// window's.
export interface OverlayToastArea {
  readonly width: number;
  readonly height: number;
  // the layout boxes of the toasts and the "N more" pill, leaving ones included, from the area's top-left corner
  readonly parts: readonly OverlayRect[];
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
  // the page received the request; send as it arrives, before rendering it, within OVERLAY_ACK_TIMEOUT_MS
  ack(requestId: string): void;
  // the request is on screen, however long its render took
  shown(requestId: string): void;
  answer(requestId: string, answer: OverlayAnswer): void;
  // the popup page's toast stack (D52), from here to holdToast
  onToast(listener: (toast: OverlayToast) => void): () => void;
  // main timed the toast out, or it was answered or withdrawn in main
  onToastDismiss(listener: (id: string) => void): () => void;
  // undefined action = dismissed
  resolveToast(id: string, action?: string): void;
  reportToastArea(area: OverlayToastArea): void;
  // the pointer moved onto a toast or the "N more" pill (true) or off them (false)
  reportToastPointer(over: boolean): void;
  // F6 moved keyboard focus into the toast stack; returns the unsubscribe
  onToastsFocus(listener: () => void): () => void;
  // Escape in the toast stack; main moves keyboard focus back to the part F6 took it from
  leaveToasts(): void;
  // the pointer or focus is on the toast (true) or left it (false)
  holdToast(id: string, held: boolean): void;
  // refused unless the center is open
  getNotifications(): Promise<NotificationCenterState>;
  onNotifications(listener: (state: NotificationCenterState) => void): () => void;
  clearNotifications(): Promise<void>;
  setDoNotDisturb(on: boolean): Promise<void>;
  // main's art to draw; answer each request once through rasterized
  onRasterize(listener: (request: OverlayRasterRequest) => void): () => void;
  // the PNG of a rasterize request, or null when it could not be drawn
  rasterized(id: string, png: Uint8Array | null): void;
  // the popup page: a popup arrived and its sound is on
  onChime(listener: (tone: ChimeTone) => void): () => void;
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
  // Settings › About, from here on; each is refused unless the settings modal is open
  getUpdate(): Promise<UpdateSnapshot>;
  // pushed only while the settings modal is open; returns the unsubscribe
  onUpdate(listener: (snapshot: UpdateSnapshot) => void): () => void;
  // a no-op unless the state is idle, upToDate or error
  checkForUpdates(): Promise<void>;
  // refused unless the state is ready
  restartToUpdate(): Promise<void>;
  showUpdateLog(): Promise<void>;
  // main composes the text and writes it through ClipboardService
  copyVersionInfo(): Promise<void>;
  getVersionInfo(): Promise<VersionInfo>;
  // macOS: refused unless the state is available
  openReleasePage(): Promise<void>;
  getReleaseIndex(): Promise<ReleaseIndex>;
  // refused for a version not in the index
  getReleaseNotes(version: string): Promise<ReleaseNotes>;
  // refused unless a quickOpen request is open
  queryQuickOpen(query: QuickOpenQuery): Promise<QuickOpenResponse>;
  // refused unless a quickOpen request is open
  listCommands(): Promise<PaletteCommand[]>;
  // refused unless the settings modal is open
  getTerminalProfiles(): Promise<TerminalProfileReport>;
  // returns the unsubscribe
  onTerminalProfiles(listener: (report: TerminalProfileReport) => void): () => void;
  // the shell's pane drag while a dropZones request is open; returns the unsubscribe
  onDropZonesPointer(listener: (pointer: DropZonesPointer) => void): () => void;
}
