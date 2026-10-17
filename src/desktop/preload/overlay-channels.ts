// Shared by the overlay preload, main and (as types only) the shell and overlay apps. The overlay view and the desktop
// popup window's page both run the overlay preload; main listens on each one's own webContents.ipc, which only that page's
// messages reach, and answers the popup page only on getState and the toast channels.

import type { ChatsContinueWorktree, ChatsWorktreeOptions, DropZonesPointer, GridPane, GridSlot, NewChatWorktree, ShellGridLayout, ShellLocale, ShellPlatform } from './shell-channels';
import type { SettingsAccountId, SettingsSectionId, SettingsTarget } from '../../shared/settings-sections';
import type { DesktopLanguageSetting } from '../main/desktop-configuration';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../shared/types/messages';
import type { ChimeTone, NotificationBody, NotificationCenterState } from './notifications';
import type { ReleaseIndex, ReleaseNotes, UpdateSnapshot, VersionInfo } from './updates';
import type { ScmLetter } from './scm-channels';
import type { TerminalColor, TerminalGlyph, TerminalProfileOption, TerminalProfileReport, TerminalProjectOption } from './terminal-channels';
import { INPUT_VALIDATIONS, MAX_INPUT_VALUE_LENGTH, inputProblem, type InputPlatform, type InputValidation } from '../../shared/input-validation';
import { visibleText } from '../../shared/visible-text';

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
  // the notification center; each answers closed unless the center is open
  notificationsGet: 'damocles:overlay:notifications:get',
  notificationsClear: 'damocles:overlay:notifications:clear',
  // boolean: Do not disturb on or off
  notificationsDnd: 'damocles:overlay:notifications:dnd',
  // Settings › About; each answers closed unless the settings modal is open
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
  // QuickOpenQuery → QuickOpenResponse; answers closed unless a quickOpen request is open
  quickOpenQuery: 'damocles:overlay:quick-open:query',
  // {} → PaletteCommand[] for the focus context main captured when the quickOpen request opened; answers closed unless one is open
  commandsList: 'damocles:overlay:commands:list',
  // {} → TerminalProfileReport for Settings › Terminal; answers closed unless the settings modal is open
  terminalProfiles: 'damocles:overlay:terminal:profiles',
  // { value } → InputBrowseResult | null; answers closed unless an input request is open, null unless it has browse
  inputBrowse: 'damocles:overlay:input:browse',
  // {} → ChatsWorktreeOptions for the open newChatMenu request's project; answers closed unless one is open
  worktreeOptions: 'damocles:overlay:worktree-options',
  // {} → readonly ChatsContinueWorktree[], every live chat worktree of the open newChatMenu request's project that a new chat
  // can continue in, most recently used first; empty when untrusted; answers closed unless one is open
  continueWorktrees: 'damocles:overlay:continue-worktrees',
  // {} → { message } | null from the Background model (D24) for the open mergeMessage dialog's worktree; answers closed unless
  // one is open, and null when no message came (main told the user why)
  worktreeGenerateMessage: 'damocles:overlay:worktree:generate-message',
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
  'archive',
  'archive-restore',
  'arrow-down-to-line',
  'arrow-down-up',
  'arrow-right-to-line',
  'arrow-up-from-line',
  'arrow-up-right',
  'at-sign',
  'check',
  'check-check',
  'cherry',
  'chevrons-up-down',
  'circle-dot',
  'circle-x',
  'clipboard-paste',
  'cloud',
  'cloud-download',
  'cloud-upload',
  'code',
  'columns-2',
  'copy',
  'copy-plus',
  'copy-x',
  'eraser',
  'eye',
  'eye-off',
  'file',
  'file-clock',
  'file-plus',
  'file-symlink',
  'file-text',
  'files',
  'filter',
  'filter-x',
  'folder',
  'folder-git-2',
  'folder-input',
  'folder-minus',
  'folder-open',
  'folder-plus',
  'folder-search',
  'folder-tree',
  'git-branch',
  'git-branch-plus',
  'git-commit-horizontal',
  'git-compare',
  'git-fork',
  'git-merge',
  'git-pull-request-arrow',
  'hash',
  'history',
  'list',
  'list-filter',
  'list-tree',
  'maximize-2',
  'message-square',
  'message-square-plus',
  'minus',
  'palette',
  'panel-bottom',
  'panel-right',
  'pencil',
  'pencil-line',
  'plus',
  'refresh-cw',
  'replace',
  'replace-all',
  'rotate-cw',
  'scroll-text',
  'search',
  'shapes',
  'shield-check',
  'shield-off',
  'signature',
  'sparkles',
  'square',
  'square-code',
  'square-terminal',
  'tag',
  'tags',
  'text-select',
  'trash-2',
  'undo-2',
  'ungroup',
  'x',
] as const;
export type OverlayIcon = (typeof OVERLAY_ICONS)[number];

// Payload bounds; main rejects a request or answer outside them.
export const MAX_OVERLAY_ITEMS = 100;
// Items of a menu at both levels together (separators and submenu rows included); each level's list stays within
// MAX_OVERLAY_ITEMS.
export const MAX_MENU_ITEMS = 160;
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
// Refs the Graph's ref picker offers, every group together; past it the chosen refs and the first others, and a count of the rest.
export const MAX_REF_PICKER_REFS = 2000;

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
      // why the item is disabled, shown where the shortcut sits; only with disabled, within MAX_OVERLAY_LABEL_LENGTH
      readonly disabledReason?: string;
      readonly checked?: boolean;
      // with checked: one of mutually exclusive choices (menuitemradio) rather than a toggle
      readonly radio?: boolean;
    }
  | { readonly kind: 'separator' }
  // one level deep: its items are items and separators, never another submenu; its own id is never an answer
  | { readonly kind: 'submenu'; readonly id: string; readonly label: string; readonly icon?: OverlayIcon; readonly items: readonly OverlayMenuItem[] };

/**
 * Drops separators at either end and repeated ones, which conditional menu sections and dropped items leave behind, and a
 * submenu left empty.
 */
export function tidyMenu(items: readonly OverlayMenuItem[]): OverlayMenuItem[] {
  const out: OverlayMenuItem[] = [];
  for (const raw of items) {
    const item = raw.kind === 'submenu' ? { ...raw, items: tidyMenu(raw.items) } : raw;
    if (item.kind === 'submenu' && item.items.length === 0) continue;
    if (item.kind === 'separator' && (out.length === 0 || out[out.length - 1]?.kind === 'separator')) continue;
    out.push(item);
  }
  if (out[out.length - 1]?.kind === 'separator') out.pop();
  return out;
}

// A ref the Graph's ref picker offers: its full refname (refs/heads/, refs/remotes/ or refs/tags/) and its short name.
export interface OverlayRefPickerRef {
  readonly id: string;
  readonly name: string;
}

// What the Graph shows: Auto, All, or 1 to MAX_SCM_HISTORY_REFS full refnames.
export type OverlayRefChoice = 'auto' | 'all' | readonly string[];

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
  // The Graph's ref picker (A.4): Auto, All, then the repository's branches, remote branches and tags, any of which may be
  // picked together; selected names only refs it offers. failed: a group of refs could not be read; omitted: refs past
  // MAX_REF_PICKER_REFS left out of refs.
  | {
      readonly kind: 'refPicker';
      readonly anchor: OverlayRect;
      readonly refs: readonly OverlayRefPickerRef[];
      readonly selected: OverlayRefChoice;
      readonly failed: boolean;
      readonly omitted: number;
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
  // when projects has one entry, or none (the home folder). Shift+click or Shift+Enter on a profile answers with the current
  // project.
  | { readonly kind: 'newTerminal'; readonly profiles: readonly TerminalProfileOption[]; readonly projects: readonly TerminalProjectOption[] }
  // A list main offers (a terminal's icon, color or default profile, a ref, stash, tag, remote or worktree picker); only
  // main opens it. Ungrouped, the current item is focused first; filtering matches label and description.
  | { readonly kind: 'quickPick'; readonly placeholder: string; readonly items: readonly OverlayQuickPickItem[] }
  // A text box main asks through askInput; only main opens it.
  | ({ readonly kind: 'input' } & InputRequest)
  // a pane dragged past the shell's threshold; grid is the layout grid's rectangle, pointer where the drag is now
  | {
      readonly kind: 'dropZones';
      readonly pane: GridPane;
      readonly slots: ShellGridLayout['slots'];
      readonly grid: OverlayRect;
      readonly pointer: OverlayPoint;
    }
  // the Chats section's New split button menu (D30, D63); the overlay fetches the options through worktreeOptions
  | {
      readonly kind: 'newChatMenu';
      readonly anchor: OverlayRect;
      readonly projectKey: string;
      readonly projectName: string;
      // New chat's shortcut label, e.g. "Ctrl+N"
      readonly shortcut: string;
    }
  // Only main asks one (D41, slice 12a); it stacks above an open request as a message does.
  | WorktreeDialogRequest;

export type WorktreeDialogRequest = { readonly kind: 'worktreeDialog' } & WorktreeDialog;

// Texts that come from git or the disk (paths, branch names, subjects) reach the overlay as data and render as text only.
export type WorktreeDialog =
  // D32: the setup commands of .damocles/worktree.json, before they first run or after they changed
  | { readonly dialog: 'setupReview'; readonly projectName: string; readonly commands: readonly string[] }
  // D33: Delete worktree. deleteBranchDefault: no unmerged commit, so the branch goes too unless unticked; deleteBranchLocked:
  // the checkbox cannot change (the branch is checked out elsewhere)
  | {
      readonly dialog: 'delete';
      readonly path: string;
      readonly branch: string;
      readonly uncommitted: readonly WorktreeFile[];
      readonly submoduleChanges: readonly WorktreeFile[];
      readonly unmergedCommits: readonly WorktreeCommit[];
      readonly deleteBranchDefault: boolean;
      readonly deleteBranchLocked: boolean;
    }
  // D33: Merge into {target} with uncommitted worktree files, which are committed first with this message
  | { readonly dialog: 'mergeMessage'; readonly branch: string; readonly target: string; readonly files: readonly WorktreeFile[] }
  // D33: the target branch was rewritten after the worktree started
  | { readonly dialog: 'rewritten'; readonly branch: string }
  // Apply or hand-off refused: these files have local changes in the project folder
  | { readonly dialog: 'refusal'; readonly action: 'apply' | 'handOff'; readonly files: readonly WorktreeFile[] }
  // D61: the files that move, those also holding the user's edits marked
  | { readonly dialog: 'handOffConfirm'; readonly direction: 'toWorktree' | 'toProject'; readonly branch?: string; readonly files: readonly HandOffFile[] }
  // R15: the startup scan's findings; nothing is deleted, Prune runs git worktree prune on the item's repository
  | { readonly dialog: 'leftovers'; readonly items: readonly LeftoverItem[] };

export interface WorktreeCommit {
  readonly hash: string;
  readonly subject: string;
}

// A file of a worktree dialog's list, repository-relative, with the status letter source control shows for it.
export interface WorktreeFile {
  readonly path: string;
  readonly letter: ScmLetter;
}

export interface HandOffFile extends WorktreeFile {
  readonly alsoUserEdits: boolean;
}

// unregistered: a folder under ~/.damocles/worktrees no record owns (Reveal); missingFolder: a record whose folder is gone;
// noChat: a live chat worktree past its grace period no chat ever worked in (Delete, or Keep, which stops reporting it);
// gitRecordOnly: git lists a worktree whose folder is gone, which Prune drops
export interface LeftoverItem {
  readonly path: string;
  readonly reason: 'unregistered' | 'missingFolder' | 'gitRecordOnly' | 'noChat';
  // the repository Prune acts on, when one does
  readonly repository?: string;
}

// Bounds of a worktree dialog; main cuts its lists to them and refuses an answer outside them.
export const MAX_WORKTREE_DIALOG_ITEMS = 200;
export const MAX_WORKTREE_COMMIT_MESSAGE_CHARS: number = 64 * 1024;

export type MessageSeverity = 'info' | 'warning' | 'danger';

export type { InputValidation };

// VS Code's showInputBox options that Damocles uses. Labels are localized by main.
export interface InputRequest {
  // the box's heading, e.g. "Commit to a New Branch"
  readonly title?: string;
  // the line under the box, VS Code's prompt
  readonly prompt: string;
  readonly placeholder?: string;
  // the prefill
  readonly value?: string;
  // [start, end) UTF-16 offsets into value, VS Code's valueSelection; absent selects the whole value
  readonly valueSelection?: readonly [number, number];
  // checked as the user types; Enter is refused while it fails, and main checks the answer again
  readonly validation?: InputValidation;
  // a masked box with no autocomplete or spellcheck whose value is never logged; never together with validation or value
  readonly password?: boolean;
  // an inline folder button inside the box (VS Code's inline input button); its click asks main through inputBrowse, which
  // runs the handler main keeps for the request. Never together with password.
  readonly browse?: { readonly tooltip: string };
}

// The box's new value after its browse button, VS Code's value and valueSelection.
export interface InputBrowseResult {
  readonly value: string;
  readonly valueSelection?: readonly [number, number];
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const isOffset = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

/** A [start, end) selection within a value of `length`, or undefined when it is not one. */
export function parseValueSelection(raw: unknown, length: number): readonly [number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) return undefined;
  const [start, end] = raw as unknown[];
  return isOffset(start, length) && isOffset(end, length) && start <= end ? [start, end] : undefined;
}

/** A clean copy of an input request within the overlay's bounds, or undefined; main asks nothing it cannot show. */
export function parseInputRequest(raw: unknown): Extract<OverlayRequest, { kind: 'input' }> | undefined {
  if (!isRecordValue(raw) || own(raw, 'kind') !== 'input') return undefined;
  const title = own(raw, 'title');
  const prompt = own(raw, 'prompt');
  const placeholder = own(raw, 'placeholder');
  const value = own(raw, 'value');
  const valueSelection = own(raw, 'valueSelection');
  const validation = own(raw, 'validation');
  const password = own(raw, 'password');
  const browse = own(raw, 'browse');
  const label = (text: unknown, max: number): boolean => typeof text === 'string' && text.length > 0 && text.length <= max;
  if (!label(prompt, MAX_OVERLAY_TEXT_LENGTH)) return undefined;
  if (title !== undefined && !label(title, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  if (placeholder !== undefined && !label(placeholder, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  if (value !== undefined && !(typeof value === 'string' && value.length <= MAX_INPUT_VALUE_LENGTH)) return undefined;
  if (validation !== undefined && !(INPUT_VALIDATIONS as readonly unknown[]).includes(validation)) return undefined;
  if (password !== undefined && (typeof password !== 'boolean' || (password && (validation !== undefined || value !== undefined)))) return undefined;
  let tooltip: string | undefined;
  if (browse !== undefined) {
    if (!isRecordValue(browse) || Object.keys(browse).length !== 1 || password === true) return undefined;
    const text = own(browse, 'tooltip');
    if (!label(text, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
    tooltip = text as string;
  }
  let selection: readonly [number, number] | undefined;
  if (valueSelection !== undefined) {
    selection = parseValueSelection(valueSelection, typeof value === 'string' ? value.length : 0);
    if (!selection) return undefined;
  }
  return {
    kind: 'input',
    prompt: prompt as string,
    ...(title !== undefined ? { title: title as string } : {}),
    ...(placeholder !== undefined ? { placeholder: placeholder as string } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(selection ? { valueSelection: selection } : {}),
    ...(validation !== undefined ? { validation: validation as InputValidation } : {}),
    ...(password === true ? { password: true } : {}),
    ...(tooltip !== undefined ? { browse: { tooltip } } : {}),
  };
}

/** The typed value when it answers `request`: a bounded string its validation kind accepts on `platform`. */
export function parseInputAnswer(raw: Record<string, unknown>, request: Extract<OverlayRequest, { kind: 'input' }>, platform: InputPlatform): string | undefined {
  const value = own(raw, 'value');
  if (typeof value !== 'string' || value.length > MAX_INPUT_VALUE_LENGTH) return undefined;
  return request.validation === undefined || inputProblem(request.validation, value, platform) === undefined ? value : undefined;
}

// One quick pick request's items and their serialized size, sized for about 50,000 ref rows (docs/invariants.md, "Source
// control", ref pickers).
export const MAX_QUICK_PICK_ITEMS = 50_000;
export const MAX_QUICK_PICK_BYTES: number = 12 * 1024 * 1024;

const utf8 = new TextEncoder();

// The texts main shows escaped (parseQuickPickRequest), so an item is counted as the overlay receives it.
const SHOWN_TEXTS: ReadonlySet<string> = new Set(['label', 'description', 'hint', 'group']);

/** An item's share of MAX_QUICK_PICK_BYTES: its JSON in UTF-8, its shown texts escaped. */
export function quickPickItemBytes(item: unknown): number {
  return utf8.encode(JSON.stringify(item, (key, value: unknown) => (typeof value === 'string' && SHOWN_TEXTS.has(key) ? visibleText(value) : value))).byteLength;
}

/** Whether a quick pick of these items fits MAX_QUICK_PICK_ITEMS and MAX_QUICK_PICK_BYTES. */
export function fitsQuickPick(items: readonly unknown[]): boolean {
  if (items.length > MAX_QUICK_PICK_ITEMS) return false;
  let bytes = 0;
  for (const item of items) {
    bytes += quickPickItemBytes(item);
    if (bytes > MAX_QUICK_PICK_BYTES) return false;
  }
  return true;
}

// Lucide icons a quick pick item may lead with, by role; the overlay maps each to its glyph.
export const OVERLAY_QUICK_PICK_ICONS = ['add', 'branch', 'remoteBranch', 'tag', 'detached', 'stash', 'worktree', 'remote'] as const;
export type OverlayQuickPickIcon = (typeof OVERLAY_QUICK_PICK_ICONS)[number];

// Within fitsQuickPick, ids unique; id within MAX_OVERLAY_ID_LENGTH, the texts within
// MAX_OVERLAY_LABEL_LENGTH (main cuts a longer label to its tail); main checks them (parseQuickPickRequest in main/overlay.ts).
export interface OverlayQuickPickItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly glyph?: TerminalGlyph;
  // tints the glyph with --d-ansi-<index of the color in TERMINAL_COLORS>
  readonly color?: TerminalColor;
  // the current value, marked with a check
  readonly current?: boolean;
  readonly icon?: OverlayQuickPickIcon;
  // a short trailing hint main localizes: "local", "2↓ 1↑"
  readonly hint?: string;
  // a section label; items sharing it are contiguous and the picker heads each run with it, kept above its first visible item
  readonly group?: string;
  // shown whatever the filter, after the matching items (VS Code's QuickPickItem.alwaysShow); never on a grouped item
  readonly alwaysShow?: true;
  // while the filter holds text, the item's description is that text, trimmed and quoted (a create item that will use it);
  // only with alwaysShow
  readonly echoQuery?: true;
  // a row that only informs ("N more refs not shown"): shown dimmed, never accepted
  readonly info?: true;
}

export type OverlayAnswer =
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'menu'; readonly itemId: string }
  | { readonly kind: 'confirm'; readonly confirmed: boolean }
  // null removes the tag
  | { readonly kind: 'tagPicker'; readonly tag: string | null }
  // the Graph's ref choice; an empty selection is 'auto'
  | { readonly kind: 'refPicker'; readonly choice: OverlayRefChoice }
  // sent once the modal's exit animation ended
  | { readonly kind: 'settings'; readonly closed: true }
  // the index of the chosen action; null is Cancel
  | { readonly kind: 'message'; readonly action: number | null }
  | { readonly kind: 'notifications'; readonly action: 'open'; readonly entryId: string }
  // null: Escape; mention: the query had the @ prefix
  | { readonly kind: 'quickOpen'; readonly pick: QuickOpenPick | null }
  // a PaletteCommand id; main runs it only when it is listed and enabled for the captured focus context
  | { readonly kind: 'quickOpen'; readonly command: string }
  // Escape answers dismissed; main refuses a profile or project the request did not offer; null projectKey: the request
  // offered no project, so the terminal starts in the home folder
  | { readonly kind: 'newTerminal'; readonly profileId: string; readonly projectKey: string | null }
  // Escape answers dismissed; main refuses an id the request did not offer. query: the filter text as typed, within
  // MAX_INPUT_VALUE_LENGTH
  | { readonly kind: 'quickPick'; readonly itemId: string; readonly query: string }
  // Escape answers dismissed; main refuses a value its validation kind rejects
  | { readonly kind: 'input'; readonly value: string }
  // null: dropped outside every zone, or Escape
  | { readonly kind: 'dropZones'; readonly slot: GridSlot | null }
  // Escape answers dismissed; worktree only after the options came and were available, startRef one of their refs, and
  // bringChanges only with the current branch and uncommitted changes
  | { readonly kind: 'newChatMenu'; readonly choice: 'plain' }
  | ({ readonly kind: 'newChatMenu'; readonly choice: 'worktree' } & NewChatWorktree)
  // Continue in a worktree: one of the listed worktrees; the shell then calls newChatInWorktree
  | { readonly kind: 'newChatMenu'; readonly choice: 'continueInWorktree'; readonly worktreeId: string }
  // Escape answers dismissed, which main takes as Skip, Cancel or Close
  | ({ readonly kind: 'worktreeDialog' } & WorktreeDialogAnswer);

// Each answers only the dialog of the same name.
export type WorktreeDialogAnswer =
  | { readonly dialog: 'setupReview'; readonly choice: 'run' | 'skip' }
  | { readonly dialog: 'delete'; readonly choice: 'delete' | 'cancel'; readonly deleteBranch: boolean }
  // message: non-blank, within MAX_WORKTREE_COMMIT_MESSAGE_CHARS, when committing
  | { readonly dialog: 'mergeMessage'; readonly choice: 'commit' | 'cancel'; readonly message: string }
  | { readonly dialog: 'rewritten'; readonly choice: 'rebase' | 'apply' | 'cancel' }
  | { readonly dialog: 'refusal'; readonly choice: 'ok' }
  | { readonly dialog: 'handOffConfirm'; readonly choice: 'move' | 'cancel' }
  // reveal (unregistered), prune (gitRecordOnly), delete and keep (noChat) name one of the request's items by path
  | { readonly dialog: 'leftovers'; readonly choice: 'close' }
  | { readonly dialog: 'leftovers'; readonly choice: 'prune' | 'reveal' | 'delete' | 'keep'; readonly path: string };

/**
 * The answer of a channel scoped to one popup. A closed popup (or a disposed overlay) is an expected state its page can
 * still ask in, so main answers it as a value; malformed input and real failures still reject.
 */
export type PopupAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: 'closed' };

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
  // the index could not answer (its worker failed or went silent), so the empty results are no search result
  readonly failed?: true;
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
  // getNotifications, clearNotifications and setDoNotDisturb answer closed unless the center is open
  getNotifications(): Promise<PopupAnswer<NotificationCenterState>>;
  onNotifications(listener: (state: NotificationCenterState) => void): () => void;
  clearNotifications(): Promise<PopupAnswer<void>>;
  setDoNotDisturb(on: boolean): Promise<PopupAnswer<void>>;
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
  // setPref, relaunch and resetLayout answer closed unless the settings modal is open
  // writes a damocles.desktop.* setting to user settings
  setPref(key: string, value: unknown): Promise<PopupAnswer<OverlayPrefWrite>>;
  // restarts the app through its normal quit path
  relaunch(): Promise<PopupAnswer<void>>;
  // window-layout.json back to the default layout, applied now
  resetLayout(): Promise<PopupAnswer<void>>;
  // Settings › About, from here on; each answers closed unless the settings modal is open
  getUpdate(): Promise<PopupAnswer<UpdateSnapshot>>;
  // pushed only while the settings modal is open; returns the unsubscribe
  onUpdate(listener: (snapshot: UpdateSnapshot) => void): () => void;
  // a no-op unless the state is idle, upToDate or error
  checkForUpdates(): Promise<PopupAnswer<void>>;
  // rejects unless the state is ready
  restartToUpdate(): Promise<PopupAnswer<void>>;
  showUpdateLog(): Promise<PopupAnswer<void>>;
  // main composes the text and writes it through ClipboardService
  copyVersionInfo(): Promise<PopupAnswer<void>>;
  getVersionInfo(): Promise<PopupAnswer<VersionInfo>>;
  // macOS: rejects unless the state is available
  openReleasePage(): Promise<PopupAnswer<void>>;
  getReleaseIndex(): Promise<PopupAnswer<ReleaseIndex>>;
  // rejects a version not in the index
  getReleaseNotes(version: string): Promise<PopupAnswer<ReleaseNotes>>;
  // answers closed unless a quickOpen request is open
  queryQuickOpen(query: QuickOpenQuery): Promise<PopupAnswer<QuickOpenResponse>>;
  // answers closed unless a quickOpen request is open
  listCommands(): Promise<PopupAnswer<PaletteCommand[]>>;
  // answers closed unless the settings modal is open
  getTerminalProfiles(): Promise<PopupAnswer<TerminalProfileReport>>;
  // returns the unsubscribe
  onTerminalProfiles(listener: (report: TerminalProfileReport) => void): () => void;
  // the open input request's browse button; null leaves the box as it is; answers closed unless an input request is open
  browseInput(value: string): Promise<PopupAnswer<InputBrowseResult | null>>;
  // the shell's pane drag while a dropZones request is open; returns the unsubscribe
  onDropZonesPointer(listener: (pointer: DropZonesPointer) => void): () => void;
  // the open newChatMenu's worktree options; answers closed unless one is open
  worktreeOptions(): Promise<PopupAnswer<ChatsWorktreeOptions>>;
  continueWorktrees(): Promise<PopupAnswer<readonly ChatsContinueWorktree[]>>;
  // Generate in the open mergeMessage dialog; null: no message came, and main told the user why
  generateWorktreeMessage(): Promise<PopupAnswer<{ readonly message: string } | null>>;
}
