// The integrated terminal's channels (AD6), shared by the shell preload, main and (as types only) the shell and overlay apps.
// Main issues every terminal id and resolves every cwd from a project key; the renderer never sends a path.

import type { TERMINAL_COLORS, TERMINAL_CUSTOM_ICONS, TerminalCursorStyle } from '../main/desktop-configuration';
import type { FileRef } from './shell-channels';

export const TERMINAL_CHANNELS = {
  // renderer → main, invoke
  // → TerminalState
  getState: 'damocles:terminal:get-state',
  // TerminalCreateRequest → TerminalCreateResult; the empty state's button, a user action the shell follows with its own focus
  create: 'damocles:terminal:create',
  // renderer → main, send
  // no payload: the new-terminal quick pick in the overlay
  new: 'damocles:terminal:new',
  // TerminalInput
  input: 'damocles:terminal:input',
  // TerminalResize
  resize: 'damocles:terminal:resize',
  // TerminalAck: characters xterm parsed, sent each time TERMINAL_ACK_CHARS more are parsed
  ack: 'damocles:terminal:ack',
  // TerminalRef: kills the process and removes the row
  kill: 'damocles:terminal:kill',
  // TerminalRef: an exited terminal only; a new process with the same id, profile and project
  restart: 'damocles:terminal:restart',
  // TerminalRef: the active terminal, persisted; its group becomes the active group
  select: 'damocles:terminal:select',
  // TerminalRef: a new pane right of that one, with its profile and working directory, which takes keyboard focus
  split: 'damocles:terminal:split',
  // TerminalRef: a pane of a multi-pane group becomes its own group at the end of the list
  unsplit: 'damocles:terminal:unsplit',
  // TerminalResizePanes: a sash drag's end or a keyboard step; main refuses sizes outside the bounds below
  resizePanes: 'damocles:terminal:resize-panes',
  // { rem }: the vertical list's width, clamped by main to TERMINAL_LIST_MIN_REM..TERMINAL_LIST_MAX_REM and persisted
  listWidth: 'damocles:terminal:list-width',
  // TerminalPaste: only with a grant main issued for the user's paste key, middle click, menu pick or Edit › Paste; main reads
  // the clipboard, asks per damocles.desktop.terminal.multiLinePasteWarning and writes the text to the pty itself
  paste: 'damocles:terminal:paste',
  // TerminalInputFocus: whether focus in the terminal pane is an xterm's own input, which Edit › Paste pastes into the pty
  inputFocus: 'damocles:terminal:input-focus',
  // TerminalOpenLink: main resolves the path again; a file opens in the editor at line and column, a folder is revealed in Files
  openLink: 'damocles:terminal:open-link',
  // TerminalRename
  rename: 'damocles:terminal:rename',
  // TerminalRef: Change Icon... and Change Color..., main's quick pick in the overlay
  pickIcon: 'damocles:terminal:pick-icon',
  pickColor: 'damocles:terminal:pick-color',
  // no payload: Select Default Profile..., main's quick pick in the overlay
  selectDefaultProfile: 'damocles:terminal:select-default-profile',
  // renderer → main, invoke
  // TerminalResolveLinks → (TerminalLinkKind | null)[], index-aligned with paths; null: not a file or folder inside the project
  resolveLinks: 'damocles:terminal:resolve-links',
  // renderer → main, send
  // TerminalAddToChat: the selection or a command's output; main labels it from its own facts and adds it to the current chat
  addToChat: 'damocles:terminal:add-to-chat',
  // main → renderer
  // TerminalState on every change and on shell load
  state: 'damocles:terminal:state',
  // TerminalData, the pty host's 5 ms / 64 KB batches
  data: 'damocles:terminal:data',
  // TerminalRef after a user action in main (Ctrl+`, New Terminal, the quick pick's accept); restored terminals never get it
  focus: 'damocles:terminal:focus',
  // TerminalRef: the palette's Rename...; the shell starts the inline rename of that terminal
  startRename: 'damocles:terminal:start-rename',
  // TerminalRef: the Edit menu's Paste while that terminal's xterm has keyboard focus; the shell answers through paste
  requestPaste: 'damocles:terminal:request-paste',
  // FileRef: a terminal link to a folder; the Files section expands to it and focuses its row
  revealInFiles: 'damocles:terminal:reveal-in-files',
  // TerminalRunAction: a palette command the shell carries out on that terminal's buffer
  runAction: 'damocles:terminal:run-action',
} as const;

// Characters of one input message; a larger write is split.
export const MAX_TERMINAL_INPUT_CHARS: number = 64 * 1024;
export const MAX_TERMINAL_COLS = 2000;
export const MAX_TERMINAL_ROWS = 1000;
export const MAX_TERMINAL_ACK_CHARS = 1_000_000;
export const MAX_TERMINAL_ID_LENGTH = 50;
// Paths of one resolveLinks request and characters of one path (VS Code's MaxResolvedLinkLength); main refuses more.
export const MAX_TERMINAL_LINK_PATHS = 50;
export const MAX_TERMINAL_LINK_PATH_LENGTH = 1024;
// A link's line and column are 1..MAX_TERMINAL_LINK_POSITION; must equal MAX_EDITOR_LINE.
export const MAX_TERMINAL_LINK_POSITION = 10_000_000;
// Characters of a terminal's name after trimming; control and bidi characters are refused.
export const MAX_TERMINAL_NAME_LENGTH = 64;
// Characters of an automatic title or description; a longer one is cut and ends in '…'.
export const MAX_TERMINAL_TITLE_CHARS = 100;
// Characters of one OSC 633 sequence after `633;`; a longer one is dropped whole.
export const MAX_SHELL_SEQUENCE_CHARS: number = 16 * 1024;
// Characters of a reported working directory after unescaping.
export const MAX_TERMINAL_CWD_CHARS = 4096;

// Flow control (VS Code's FlowControlConstants): the host pauses a pty once more than TERMINAL_HIGH_WATERMARK_CHARS of its
// output are unacknowledged and resumes it below TERMINAL_LOW_WATERMARK_CHARS; the shell acks every TERMINAL_ACK_CHARS.
export const TERMINAL_HIGH_WATERMARK_CHARS = 100_000;
export const TERMINAL_LOW_WATERMARK_CHARS = 5_000;
export const TERMINAL_ACK_CHARS = 5_000;

// The vertical terminal list's width in rem: 110px to 420px at the default font, double-click resets to 190px.
export const TERMINAL_LIST_MIN_REM: number = 110 / 16;
export const TERMINAL_LIST_MAX_REM: number = 420 / 16;
export const TERMINAL_LIST_DEFAULT_REM: number = 190 / 16;

// Panes of one group; a split beyond it is refused. MAX_TERMINAL_GROUP_PANES * MIN_TERMINAL_PANE_FRACTION must stay below 1.
export const MAX_TERMINAL_GROUP_PANES = 8;
// A pane's smallest share of its group's width.
export const MIN_TERMINAL_PANE_FRACTION = 0.05;
// How far a resizePanes sum may stray from 1; main rescales a sum within it and refuses any other.
export const TERMINAL_PANE_SIZES_EPSILON = 0.001;

export const TERMINAL_ICONS = ['powershell', 'cmd', 'git-bash', 'wsl', 'bash', 'zsh', 'fish', 'shell'] as const;
export type TerminalIcon = (typeof TERMINAL_ICONS)[number];

export { TERMINAL_COLORS, TERMINAL_CURSOR_STYLES, TERMINAL_CUSTOM_ICONS, type TerminalCursorStyle } from '../main/desktop-configuration';

export type TerminalCustomIcon = (typeof TERMINAL_CUSTOM_ICONS)[number];
// What a terminal row or quick pick item draws: a profile's icon or a custom one.
export type TerminalGlyph = TerminalIcon | TerminalCustomIcon;

export type TerminalColor = (typeof TERMINAL_COLORS)[number];

// starting: spawned, no pid yet; exited with exitCode null: the pty host stopped
export type TerminalStatus = 'starting' | 'running' | 'exited';

export interface TerminalInfo {
  // `term-<n>`, issued by main; kept across a restart
  readonly id: string;
  // name when set, else the running command's first line, else (macOS and Linux without integration) the foreground process
  // name, else the profile's name; control, bidi and format characters removed, at most MAX_TERMINAL_TITLE_CHARS
  readonly title: string;
  // the user's name from Rename; null: the automatic title
  readonly name: string | null;
  readonly profileId: string;
  readonly icon: TerminalIcon;
  readonly customIcon: TerminalCustomIcon | null;
  readonly color: TerminalColor | null;
  readonly projectKey: string;
  readonly projectName: string;
  readonly status: TerminalStatus;
  readonly exitCode: number | null;
  // the folder name of the reported working directory when it is not the project folder, sanitized like title
  readonly description: string | null;
  // what runs, sanitized: the command line, or the foreground process (macOS and Linux without integration); '' a command
  // whose line was not reported; null nothing
  readonly running: string | null;
  // a trusted shell-integration sequence arrived since the process started
  readonly integrated: boolean;
}

export interface TerminalSettings {
  // CSS px at the default font; the shell scales it with remPx
  readonly fontSize: number;
  readonly scrollback: number;
  readonly cursorStyle: TerminalCursorStyle;
  // '' uses the app's mono font (--d-mono)
  readonly fontFamily: string;
  // 1..2, multiplied by the font size
  readonly lineHeight: number;
  readonly cursorBlinking: boolean;
  // macOS only
  readonly macOptionIsMeta: boolean;
  // command marks in the gutter
  readonly decorationsEnabled: boolean;
}

// One tab of side-by-side panes (VS Code's terminal group).
export interface TerminalGroupInfo {
  // `group-<n>`, issued by main
  readonly id: string;
  // left to right, 1..MAX_TERMINAL_GROUP_PANES
  readonly paneIds: readonly string[];
  // one of paneIds
  readonly activePaneId: string;
  // index-aligned with paneIds, each at least MIN_TERMINAL_PANE_FRACTION, summing to 1
  readonly sizes: readonly number[];
}

export interface TerminalState {
  // in list order: group by group, pane by pane
  readonly terminals: readonly TerminalInfo[];
  // in list order; every terminal is in exactly one
  readonly groups: readonly TerminalGroupInfo[];
  // the active group's active pane
  readonly activeId: string | null;
  readonly listWidthRem: number;
  readonly settings: TerminalSettings;
  // a project is open and a profile was detected
  readonly canCreate: boolean;
  // Electron accelerators of the commands that fire while a terminal has focus (the skip list, from the command registry);
  // xterm leaves exactly these keys unhandled so they reach the application menu. Focus Previous and Next Pane are in it
  // only while the active group has more than one pane.
  readonly passKeys: readonly string[];
  // the visible detected shells and the valid user profiles, the default marked, for the New Terminal dropdown
  readonly profiles: readonly TerminalProfileOption[];
  // Chromium's accessibility support is on (a screen reader is running), which xterm's screenReaderMode follows
  readonly screenReader: boolean;
  // the Windows build from os.release(), which xterm reads for conpty's reflow and wrapped lines; 0 outside Windows
  readonly windowsBuild: number;
}

export interface TerminalResizePanes {
  readonly groupId: string;
  // index-aligned with the group's paneIds
  readonly sizes: readonly number[];
}

// null profileId: the default profile setting, else the first detected; null projectKey: the selected project
export interface TerminalCreateRequest {
  readonly profileId: string | null;
  readonly projectKey: string | null;
}

export type TerminalCreateResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: 'noProject' | 'unknownProject' | 'unknownProfile' | 'noProfile' };

export interface TerminalRef {
  readonly id: string;
}

export interface TerminalInputFocus {
  readonly focused: boolean;
}

/**
 * VS Code's terminal paste keys, which main (before-input-event) and the shell's key handler both read: Ctrl+V and
 * Ctrl+Shift+V on Windows, Ctrl+Shift+V on Linux; macOS pastes with Cmd+V, the Edit menu's accelerator. AltGr arrives as
 * Ctrl+Alt on Windows, so Alt excludes it.
 */
export function isTerminalPasteChord(chord: { readonly code: string; readonly ctrl: boolean; readonly shift: boolean; readonly alt: boolean; readonly meta: boolean }, platform: string): boolean {
  if (chord.code !== 'KeyV' || !chord.ctrl || chord.alt || chord.meta) return false;
  return platform === 'win32' || (platform === 'linux' && chord.shift);
}

// bracketedPasteMode: the terminal's shell turned it on (xterm's modes.bracketedPasteMode); source 'selection' is Linux's
// middle-click primary selection, which main honours only for a Linux middle press it saw
export interface TerminalPaste {
  readonly id: string;
  readonly bracketedPasteMode: boolean;
  readonly source: 'clipboard' | 'selection';
}

// paths: the parser's candidates as printed, without their line and column suffix; at most MAX_TERMINAL_LINK_PATHS, each
// 1..MAX_TERMINAL_LINK_PATH_LENGTH characters
export interface TerminalResolveLinks {
  readonly id: string;
  readonly paths: readonly string[];
}

export type TerminalLinkKind = 'file' | 'folder';

// line and column: 1..MAX_TERMINAL_LINK_POSITION, or null when the link names none
export interface TerminalOpenLink {
  readonly id: string;
  readonly path: string;
  readonly line: number | null;
  readonly column: number | null;
}

// name: at most MAX_TERMINAL_NAME_LENGTH characters once trimmed; '' restores the automatic title
export interface TerminalRename {
  readonly id: string;
  readonly name: string;
}

export interface TerminalInput {
  readonly id: string;
  // at most MAX_TERMINAL_INPUT_CHARS
  readonly data: string;
}

export interface TerminalResize {
  readonly id: string;
  // 1..MAX_TERMINAL_COLS and 1..MAX_TERMINAL_ROWS
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalAck {
  readonly id: string;
  // 1..MAX_TERMINAL_ACK_CHARS
  readonly chars: number;
}

export interface TerminalData {
  readonly id: string;
  // the pty's output without its OSC 633 sequences; '' when a batch held only sequences
  readonly data: string;
  // the trusted sequences, in stream order; offset: where in data each stood (0..data.length, non-decreasing)
  readonly events?: readonly TerminalShellEventAt[];
}

export interface TerminalShellEventAt {
  readonly offset: number;
  readonly event: TerminalShellEvent;
}

// OSC 633 A, B, C (with the last E's command line, '' without one) and D. commandId: issued by main per terminal from 1, never
// reused; null on a D without a C. time: main's clock when the sequence arrived. commandLine may hold \n and \t.
export type TerminalShellEvent =
  | { readonly kind: 'promptStart' }
  | { readonly kind: 'commandStart' }
  | { readonly kind: 'commandExecuted'; readonly commandId: number; readonly commandLine: string; readonly time: number }
  | { readonly kind: 'commandFinished'; readonly commandId: number | null; readonly exitCode: number | null; readonly time: number };

// commandId: the command whose output text holds (source 'command'), null for a selection; text: already passed through
// capTerminalText, at most MAX_TERMINAL_ATTACHMENT_CHARS; omittedLines: the lines that cut dropped
export interface TerminalAddToChat {
  readonly id: string;
  readonly source: 'selection' | 'command';
  readonly commandId: number | null;
  readonly text: string;
  readonly omittedLines: number;
}

// The palette's buffer commands; addToChat sends the selection, else the last command's output. resizePaneLeft and
// resizePaneRight move the terminal's pane edge by VS Code's step and answer with resizePanes; they move no focus.
export const TERMINAL_ACTIONS = ['copyLastCommand', 'copyLastCommandOutput', 'addToChat', 'scrollToPreviousCommand', 'scrollToNextCommand', 'resizePaneLeft', 'resizePaneRight'] as const;
export type TerminalAction = (typeof TERMINAL_ACTIONS)[number];

export interface TerminalRunAction {
  readonly id: string;
  readonly action: TerminalAction;
}

// A profile for the new-terminal quick pick and Settings › Terminal; path is the executable, shown as a description.
export interface TerminalProfileOption {
  // a detected shell's id, which a user profile of the same name keeps, or `user:<name>`
  readonly id: string;
  readonly name: string;
  readonly path: string;
  // for display: each argument cleaned and cut like a title
  readonly args: readonly string[];
  // user: damocles.desktop.terminal.profiles defines it, a detected shell's name included
  readonly source: 'detected' | 'user';
  readonly icon: TerminalIcon;
  // a user profile's lucide icon, drawn instead of icon, and its tint
  readonly customIcon: TerminalCustomIcon | null;
  readonly color: TerminalColor | null;
  // the profile a null profileId starts
  readonly isDefault: boolean;
}

// User profiles in damocles.desktop.terminal.profiles; entries past it are refused as tooManyProfiles.
export const MAX_USER_TERMINAL_PROFILES = 32;

// Why a damocles.desktop.terminal.profiles entry never launches (Settings › Terminal localizes each).
export const TERMINAL_PROFILE_PROBLEMS = [
  // the setting is not an object of entries; name is null
  'settingNotAnObject',
  'tooManyProfiles',
  // the key is empty, longer than MAX_TERMINAL_NAME_LENGTH, padded, or holds control or bidi characters
  'invalidName',
  'notAnObject',
  // detail: the field
  'unknownField',
  'missingPath',
  // path is not a string or a non-empty array of strings within MAX_HOST_PATH_CHARS
  'invalidPath',
  // detail: the path; UNC, device, drive-relative, root-relative, `~`, or relative with a folder
  'pathNotAllowed',
  // detail: the first path; no path names an existing file, none on PATH
  'pathNotFound',
  // detail: the first path that exists but is no regular file
  'pathNotAFile',
  // detail: the first path whose file could not be read (access denied, a link loop)
  'pathUnreadable',
  // args is not an array of strings without NUL
  'invalidArgs',
  'tooManyArgs',
  // an arg longer than MAX_HOST_PATH_CHARS, or a command line past the host's limit
  'argsTooLong',
  // detail: the value
  'invalidIcon',
  'invalidColor',
] as const;
export type TerminalProfileProblemReason = (typeof TERMINAL_PROFILE_PROBLEMS)[number];

export interface TerminalProfileProblem {
  // the entry's key, cut and cleaned like a title; null for the setting as a whole
  readonly name: string | null;
  readonly reason: TerminalProfileProblemReason;
  // the offending field, path or value, cut and cleaned like a title; text only
  readonly detail: string | null;
}

// Settings › Terminal: the profiles the dropdown lists, the detected names a null entry hides, and the refused entries.
export interface TerminalProfileReport {
  readonly profiles: readonly TerminalProfileOption[];
  readonly hidden: readonly string[];
  readonly problems: readonly TerminalProfileProblem[];
}

export interface TerminalProjectOption {
  readonly key: string;
  readonly name: string;
  readonly path: string;
  // the selected project, listed first
  readonly current: boolean;
}

export interface DamoclesTerminalApi {
  getState(): Promise<TerminalState>;
  // returns the unsubscribe
  onState(listener: (state: TerminalState) => void): () => void;
  onData(listener: (data: TerminalData) => void): () => void;
  onFocus(listener: (id: string) => void): () => void;
  onStartRename(listener: (id: string) => void): () => void;
  onRequestPaste(listener: (id: string) => void): () => void;
  onRevealInFiles(listener: (file: FileRef) => void): () => void;
  onRunAction(listener: (request: TerminalRunAction) => void): () => void;
  create(request: TerminalCreateRequest): Promise<TerminalCreateResult>;
  openNew(): void;
  input(input: TerminalInput): void;
  resize(resize: TerminalResize): void;
  ack(ack: TerminalAck): void;
  kill(id: string): void;
  restart(id: string): void;
  select(id: string): void;
  split(id: string): void;
  unsplit(id: string): void;
  resizePanes(request: TerminalResizePanes): void;
  setListWidth(rem: number): void;
  paste(request: TerminalPaste): void;
  reportInputFocus(focused: boolean): void;
  resolveLinks(request: TerminalResolveLinks): Promise<Array<TerminalLinkKind | null>>;
  openLink(request: TerminalOpenLink): void;
  rename(request: TerminalRename): void;
  pickIcon(id: string): void;
  pickColor(id: string): void;
  selectDefaultProfile(): void;
  addToChat(request: TerminalAddToChat): void;
}
