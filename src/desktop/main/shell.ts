import { randomBytes } from 'node:crypto';
import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle, type WebContents } from 'electron';
import { HOST_THEME_STYLE_ID } from '../../shared/host-theme';
import { isSettingsSectionId, type SettingsSectionId } from '../../shared/settings-sections';
import { MAX_BROWSER_URL_LENGTH } from '../../shared/typed-address';
import type { OverlayAnswer, OverlayRequest } from '../preload/overlay-channels';
import type { PanelTheme } from '../preload/panel-channels';
import {
  BROWSER_ACTIONS,
  EDITOR_TAB_ACTIONS,
  MAX_FORMAT_ERROR_CHARS,
  MAX_FORMAT_TAB_SIZE,
  GRID_PANES,
  GRID_SLOTS,
  MAX_CHAT_NAME_LENGTH,
  MAX_EDITOR_LINE,
  MAX_EDITOR_TEXT_CHARS,
  MAX_FILE_NAME_LENGTH,
  MAX_ID_LENGTH,
  MAX_REPLACE_FILES,
  MAX_REPLACE_OCCURRENCES,
  MAX_SEARCH_LENGTH,
  MAX_SEARCH_PAYLOAD_MATCHES,
  MAX_SHELL_COORDINATE,
  MAX_TAG_LENGTH,
  SHELL_CHANNELS,
  SHELL_FOCUS_PARTS,
  WINDOW_CONTROLS,
  type BrowserActionRequest,
  type BrowserNavigateRequest,
  type ChatMutationResult,
  type DropZonesPointer,
  type EditorConflictRequest,
  type EditorConflictResult,
  type EditorBuiltinFormatFailure,
  type EditorFormatReply,
  type EditorFormatRequest,
  type EditorOpenRequest,
  type EditorOpenResult,
  type EditorSaveResult,
  type EditorSelectionRange,
  type EditorTabRequest,
  type EditorEditReport,
  type EditorTextRequest,
  type FileRef,
  type FilesCreateRequest,
  type FilesDeleteResult,
  type FilesListResult,
  type FilesMutationResult,
  type GridPane,
  type GridSlot,
  type EditorCommand,
  type FilesChanged,
  type ShellDocumentContent,
  type ShellEditorState,
  type RemoveProjectResult,
  type SelectChatResult,
  type ShellChatList,
  type ShellFocusPart,
  type SearchCommandMessage,
  type SearchConfirmReplaceRequest,
  type SearchCopyRequest,
  type SearchCopyTarget,
  type SearchDismissRequest,
  type SearchDone,
  type SearchEditorConfig,
  type SearchEditorHighlights,
  type SearchEditorOpenRequest,
  type SearchEditorOpenResult,
  type SearchEditorOpenResultRequest,
  type SearchFileKey,
  type SearchFileUpdate,
  type SearchFocus,
  type SearchPreviewRequest,
  type SearchPreviewResult,
  type SearchReplaceRequest,
  type SearchReplaceResult,
  type SearchResultsBatch,
  type SearchStartRequest,
  type SearchStartResult,
  type ShellGridSizes,
  type ShellSidebarLayout,
  type ShellState,
  type WindowControl,
} from '../preload/shell-channels';
import { isUpdateAction, type UpdateAction, type UpdateSnapshot } from '../preload/updates';
import {
  MAX_TERMINAL_ACK_CHARS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_GROUP_PANES,
  MAX_TERMINAL_INPUT_CHARS,
  MAX_TERMINAL_LINK_PATH_LENGTH,
  MAX_TERMINAL_LINK_PATHS,
  MAX_TERMINAL_LINK_POSITION,
  MAX_TERMINAL_ROWS,
  TERMINAL_CHANNELS,
  isTerminalPasteChord,
  type TerminalAction,
  type TerminalAddToChat,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  type TerminalData,
  type TerminalLinkKind,
  type TerminalOpenLink,
  type TerminalPaste,
  type TerminalResolveLinks,
  type TerminalState,
} from '../preload/terminal-channels';
import { MAX_TERMINAL_ATTACHMENT_CHARS, MAX_TERMINAL_ATTACHMENT_OMITTED_LINES } from '../preload/terminal-attachment-cap';
import { parseTerminalName } from './terminal/terminal-service';
import { isTerminalId } from '../pty-host/protocol';
import { isRelativeFilePath } from '../../shared/relative-path';
import { MAX_CONTEXT_LINES, MAX_REPLACEMENT_LENGTH, MAX_SEARCH_GLOBS_LENGTH, MAX_SEARCH_PATTERN_LENGTH, type SearchQuery, type SearchRange } from '../../shared/text-search';
import { GestureGrant, isActivationKey, isContextMenuKey, isContextMenuMouse, isPrimaryClick } from './clipboard-gestures';
import { isRelativeOrRoot } from './documents/confine';
import { parseOverlayRequest } from './overlay';
import { APP_ORIGIN, SHELL_PAGE_URL } from './protocol';
import { loadAppPage, loggableUrl } from './security';
import { isPanelSender } from './views';
import { parseGridSizes, parseSearchEditorConfig, parseSidebarLayout } from './window-layout-store';

// What the shell may ask for; every key and chat id is resolved against main's own lists by the implementation.
export interface ShellActions {
  // ShellHost numbers each state it gives the page
  state(): Omit<ShellState, 'revision'>;
  addProject(): Promise<void>;
  removeProject(key: string): Promise<RemoveProjectResult>;
  selectProject(key: string): Promise<void>;
  grantTrust(key: string): Promise<void>;
  // undefined: projectKey is not a project of main's list
  listChats(projectKey: string): Promise<ShellChatList | undefined>;
  searchChats(projectKey: string, query: string): Promise<ShellChatList | undefined>;
  selectChat(chatId: string): Promise<SelectChatResult>;
  newChat(projectKey: string | undefined): Promise<void>;
  // name is trimmed and within bounds
  renameChat(chatId: string, name: string): Promise<ChatMutationResult>;
  // tag is trimmed and within bounds; null removes it
  tagChat(chatId: string, tag: string | null): Promise<ChatMutationResult>;
  deleteChat(chatId: string): Promise<ChatMutationResult>;
  // request is a validated copy; focus returns to the shell page when the popup closes
  requestOverlay(request: OverlayRequest, returnFocus: WebContents): Promise<OverlayAnswer>;
  // window DIP
  openAppMenu(anchor: { readonly x: number; readonly y: number }): void;
  toggleTheme(): void;
  toggleSidebar(): void;
  showSidebar(): void;
  windowControl(control: WindowControl): void;
  openSettings(section: SettingsSectionId | undefined): void;
  setContentBounds(bounds: Rectangle): void;
  setSidebarLayout(layout: ShellSidebarLayout): void;
  setGridSizes(sizes: ShellGridSizes): void;
  setFocusedPart(part: ShellFocusPart | null): void;
  update(): UpdateSnapshot;
  runUpdateAction(action: UpdateAction): Promise<void>;
  // the layout grid; main applies the shared rules (moveGridPane) and publishes the layout in ShellState
  layoutMove(pane: GridPane, slot: GridSlot): void;
  toggleEditor(): void;
  toggleTerminal(): void;
  toggleMaximize(pane: GridPane): void;
  // the shell's pane drag; forwarded to the overlay while its dropZones request is open
  dropZonesPointer(pointer: DropZonesPointer): void;
  readonly editor: ShellEditorActions;
  readonly files: ShellFilesActions;
  readonly search: ShellSearchActions;
  readonly searchEditor: ShellSearchEditorActions;
  readonly browser: ShellBrowserActions;
  readonly terminal: ShellTerminalActions;
  readonly gestures: ShellGestureActions;
  openQuickOpen(): Promise<void>;
  showCommands(): Promise<void>;
}

// User input main observed in the shell page (before-input-event, before-mouse-event), never a renderer's report.
export interface ShellGestureActions {
  // a terminal paste key of this platform (isTerminalPasteChord)
  pasteKey(): void;
  // Linux's middle button, which pastes the primary selection
  middleClick(): void;
  // a right click, a macOS Control+click, the context menu key or Shift+F10
  contextMenu(): void;
  // the page lost keyboard focus
  blurred(): void;
}

// Terminal ids are issued by main and resolved against its own list; an unknown one is dropped there.
export interface ShellTerminalActions {
  state(): TerminalState;
  has(id: string): boolean;
  // profile ids and project keys are resolved against main's detected profiles and open projects
  create(request: TerminalCreateRequest): TerminalCreateResult;
  // the new-terminal quick pick
  openNew(): void;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  ack(id: string, chars: number): void;
  kill(id: string): void;
  restart(id: string): void;
  select(id: string): void;
  split(id: string): void;
  unsplit(id: string): void;
  // finite numbers, one per pane at most; the terminal service checks them against the group
  resizePanes(groupId: string, sizes: readonly number[]): void;
  // a finite number; main clamps it
  setListWidth(rem: number): void;
  // the shell page loaded and holds no terminal output
  shellLoaded(): void;
  // main reads the clipboard and writes it to the pty, only with a grant a user's paste gesture issued for that terminal
  paste(request: TerminalPaste): void;
  // whether focus in the terminal pane is an xterm's own input
  setInputFocused(focused: boolean): void;
  // each path resolved against the terminal's project, index-aligned
  resolveLinks(request: TerminalResolveLinks): Promise<Array<TerminalLinkKind | null>>;
  openLink(request: TerminalOpenLink): void;
  // null restores the automatic title
  rename(id: string, name: string | null): void;
  pickIcon(id: string): void;
  pickColor(id: string): void;
  selectDefaultProfile(): void;
  // the selection or a command's output for the current chat; main labels it from its own facts
  addToChat(request: TerminalAddToChat): void;
}

// Browser tabs (D14): every tab id is resolved among the selected chat's pages; an unknown one is refused there.
export interface ShellBrowserActions {
  action(request: BrowserActionRequest): Promise<void>;
  // url is the bounded text as typed; false when main refused it
  navigate(request: BrowserNavigateRequest): boolean;
  // window DIP; undefined while no browser tab shows its page area; radius rounds the page view's corners
  setBounds(bounds: Rectangle | undefined, radius: number): void;
}

// Search: searchIds come from the shell, match ids from main, and both are checked against main's running search.
export interface ShellSearchActions {
  start(request: SearchStartRequest): SearchStartResult;
  cancel(): void;
  clear(): void;
  dismiss(request: SearchDismissRequest): void;
  copy(request: SearchCopyRequest): Promise<void>;
  confirmReplace(request: SearchConfirmReplaceRequest): Promise<boolean>;
  replace(request: SearchReplaceRequest): Promise<SearchReplaceResult>;
  preview(request: SearchPreviewRequest): Promise<SearchPreviewResult>;
  // the folder is confined like a Files reveal; it reaches Search only as a files-to-include entry
  findInFolder(folder: FileRef): Promise<void>;
}

// Search Editor: every documentId is resolved against main's Search Editor tabs; a path never comes from the shell.
export interface ShellSearchEditorActions {
  openNew(request: SearchEditorOpenRequest): Promise<{ readonly tabId: string }>;
  setConfig(documentId: string, config: SearchEditorConfig): void;
  run(documentId: string): void;
  openResult(request: SearchEditorOpenResultRequest): Promise<SearchEditorOpenResult>;
}

// Every id is resolved against main's own tabs and documents; an unknown one is refused there.
export interface ShellEditorActions {
  state(): ShellEditorState;
  content(documentId: string): ShellDocumentContent;
  open(request: EditorOpenRequest): Promise<EditorOpenResult>;
  tab(request: EditorTabRequest): Promise<void>;
  edit(request: EditorEditReport): void;
  save(request: EditorTextRequest, as: boolean): Promise<EditorSaveResult>;
  conflict(request: EditorConflictRequest): Promise<EditorConflictResult>;
  // the documentId is resolved against main's open documents; main confines the file and checks the project's trust
  format(request: EditorFormatRequest): Promise<EditorFormatReply>;
  formatFailed(failure: EditorBuiltinFormatFailure): void;
  selection(documentId: string, range: EditorSelectionRange | null): void;
  mention(tabId: string): Promise<void>;
  setFocusOverlay(open: boolean): void;
  flushed(requestId: string): void;
}

// Every path is confined to its project in main (documents/confine.ts).
export interface ShellFilesActions {
  // report: a failure is reported to the user, for a listing a user action waits on
  list(projectKey: string, relativeDir: string, report: boolean): Promise<FilesListResult>;
  create(request: FilesCreateRequest): Promise<FilesMutationResult>;
  rename(file: FileRef, newName: string): Promise<FilesMutationResult>;
  delete(file: FileRef): Promise<FilesDeleteResult>;
  copyPath(file: FileRef, relative: boolean): Promise<void>;
  reveal(file: FileRef): Promise<void>;
  mention(file: FileRef): Promise<void>;
}

const MAX_BOUND = MAX_SHELL_COORDINATE;

// A terminal payload carries exactly these fields; anything else, a path above all, is refused.
function exactFields(raw: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  const value = record(raw);
  return value && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) ? value : undefined;
}

const isKeyOrNull = (value: unknown): value is string | null => value === null || isShellId(value);

/** terminal:create from the shell: a profile id and a project key, each null for the default, and nothing else. */
export function parseTerminalCreate(raw: unknown): TerminalCreateRequest | undefined {
  const value = exactFields(raw, ['profileId', 'projectKey']);
  const profileId = value?.['profileId'];
  const projectKey = value?.['projectKey'];
  return isKeyOrNull(profileId) && isKeyOrNull(projectKey) ? { profileId, projectKey } : undefined;
}

export function parseTerminalInputFocus(raw: unknown): boolean | undefined {
  const focused = exactFields(raw, ['focused'])?.['focused'];
  return typeof focused === 'boolean' ? focused : undefined;
}

export function parseTerminalRef(raw: unknown): string | undefined {
  const id = exactFields(raw, ['id'])?.['id'];
  return isTerminalId(id) ? id : undefined;
}

export function parseTerminalInput(raw: unknown): { id: string; data: string } | undefined {
  const value = exactFields(raw, ['id', 'data']);
  const id = value?.['id'];
  const data = value?.['data'];
  return isTerminalId(id) && isText(data, MAX_TERMINAL_INPUT_CHARS) ? { id, data } : undefined;
}

export function parseTerminalResize(raw: unknown): { id: string; cols: number; rows: number } | undefined {
  const value = exactFields(raw, ['id', 'cols', 'rows']);
  const id = value?.['id'];
  const cols = value?.['cols'];
  const rows = value?.['rows'];
  return isTerminalId(id) && boundedInteger(cols, 1, MAX_TERMINAL_COLS) && boundedInteger(rows, 1, MAX_TERMINAL_ROWS) ? { id, cols, rows } : undefined;
}

export function parseTerminalAck(raw: unknown): { id: string; chars: number } | undefined {
  const value = exactFields(raw, ['id', 'chars']);
  const id = value?.['id'];
  const chars = value?.['chars'];
  return isTerminalId(id) && boundedInteger(chars, 1, MAX_TERMINAL_ACK_CHARS) ? { id, chars } : undefined;
}

export function parseTerminalPaste(raw: unknown): TerminalPaste | undefined {
  const value = exactFields(raw, ['id', 'bracketedPasteMode', 'source']);
  const id = value?.['id'];
  const bracketedPasteMode = value?.['bracketedPasteMode'];
  const source = value?.['source'];
  if (!isTerminalId(id) || typeof bracketedPasteMode !== 'boolean' || (source !== 'clipboard' && source !== 'selection')) return undefined;
  return { id, bracketedPasteMode, source };
}

const isLinkPath = (value: unknown): value is string => isText(value, MAX_TERMINAL_LINK_PATH_LENGTH) && value.length > 0 && !value.includes('\0');

export function parseTerminalResolveLinks(raw: unknown): TerminalResolveLinks | undefined {
  const value = exactFields(raw, ['id', 'paths']);
  const id = value?.['id'];
  const paths = value?.['paths'];
  if (!isTerminalId(id) || !Array.isArray(paths) || paths.length === 0 || paths.length > MAX_TERMINAL_LINK_PATHS) return undefined;
  return (paths as unknown[]).every(isLinkPath) ? { id, paths: [...(paths as string[])] } : undefined;
}

const isLinkPosition = (value: unknown): value is number | null => value === null || boundedInteger(value, 1, MAX_TERMINAL_LINK_POSITION);

export function parseTerminalOpenLink(raw: unknown): TerminalOpenLink | undefined {
  const value = exactFields(raw, ['id', 'path', 'line', 'column']);
  const id = value?.['id'];
  const linkPath = value?.['path'];
  const line = value?.['line'];
  const column = value?.['column'];
  return isTerminalId(id) && isLinkPath(linkPath) && isLinkPosition(line) && isLinkPosition(column) ? { id, path: linkPath, line, column } : undefined;
}

/** terminal:rename: a known shape, and a name parseTerminalName accepts; null restores the automatic title. */
export function parseTerminalRename(raw: unknown): { id: string; name: string | null } | undefined {
  const value = exactFields(raw, ['id', 'name']);
  const id = value?.['id'];
  const name = parseTerminalName(value?.['name']);
  return isTerminalId(id) && name !== undefined ? { id, name } : undefined;
}

// A command id as main issues them: 1 and up.
const isCommandId = (value: unknown): value is number => boundedInteger(value, 1, Number.MAX_SAFE_INTEGER);

/** terminal:add-to-chat: a selection (no command id) or a command's output, text within the cap's character bound. */
export function parseTerminalAddToChat(raw: unknown): TerminalAddToChat | undefined {
  const value = exactFields(raw, ['id', 'source', 'commandId', 'text', 'omittedLines']);
  const id = value?.['id'];
  const source = value?.['source'];
  const commandId = value?.['commandId'];
  const text = value?.['text'];
  const omittedLines = value?.['omittedLines'];
  if (!isTerminalId(id) || !isText(text, MAX_TERMINAL_ATTACHMENT_CHARS) || !boundedInteger(omittedLines, 0, MAX_TERMINAL_ATTACHMENT_OMITTED_LINES)) return undefined;
  if (source === 'selection' && commandId === null) return { id, source, commandId, text, omittedLines };
  return source === 'command' && isCommandId(commandId) ? { id, source, commandId, text, omittedLines } : undefined;
}

// A group id as main issues them: group-<n>, n from 1.
const TERMINAL_GROUP_ID = /^group-[1-9]\d{0,9}$/;

/** terminal:resize-panes: a group id and 1..MAX_TERMINAL_GROUP_PANES finite numbers, and nothing else. */
export function parseTerminalResizePanes(raw: unknown): { groupId: string; sizes: number[] } | undefined {
  const value = exactFields(raw, ['groupId', 'sizes']);
  const groupId = value?.['groupId'];
  const sizes = value?.['sizes'];
  if (typeof groupId !== 'string' || !TERMINAL_GROUP_ID.test(groupId) || !Array.isArray(sizes) || sizes.length === 0 || sizes.length > MAX_TERMINAL_GROUP_PANES) return undefined;
  return (sizes as unknown[]).every((size) => typeof size === 'number' && Number.isFinite(size)) ? { groupId, sizes: [...(sizes as number[])] } : undefined;
}

export function parseTerminalListWidth(raw: unknown): number | undefined {
  const rem = exactFields(raw, ['rem'])?.['rem'];
  return typeof rem === 'number' && Number.isFinite(rem) ? rem : undefined;
}

// A shell page that kills its renderer on every load is left dead rather than reloaded in a loop.
const MAX_CRASHES_IN_WINDOW = 3;
const CRASH_WINDOW_MS = 60_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isShellId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** A chat name from the shell, trimmed, or undefined when it is not a string of 1..MAX_CHAT_NAME_LENGTH characters after trimming. */
export function chatName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_CHAT_NAME_LENGTH ? name : undefined;
}

/** A tag from the shell, trimmed, null to remove; undefined when malformed. */
export function chatTag(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const tag = value.trim();
  return tag.length > 0 && tag.length <= MAX_TAG_LENGTH ? tag : undefined;
}

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function own(raw: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function boundedArray(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && value.length <= max;
}

function parseSearchQuery(raw: unknown): SearchQuery | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const pattern = own(value, 'pattern');
  const include = own(value, 'include');
  const exclude = own(value, 'exclude');
  const isRegex = own(value, 'isRegex');
  const matchCase = own(value, 'matchCase');
  const wholeWord = own(value, 'wholeWord');
  const useExcludeSettingsAndIgnoreFiles = own(value, 'useExcludeSettingsAndIgnoreFiles');
  const onlyOpenEditors = own(value, 'onlyOpenEditors');
  if (!isText(pattern, MAX_SEARCH_PATTERN_LENGTH) || pattern.length === 0) return undefined;
  if (!isText(include, MAX_SEARCH_GLOBS_LENGTH) || !isText(exclude, MAX_SEARCH_GLOBS_LENGTH)) return undefined;
  if (typeof isRegex !== 'boolean' || typeof matchCase !== 'boolean' || typeof wholeWord !== 'boolean' || typeof useExcludeSettingsAndIgnoreFiles !== 'boolean') return undefined;
  if (typeof onlyOpenEditors !== 'boolean') return undefined;
  return { pattern, isRegex, matchCase, wholeWord, include, exclude, useExcludeSettingsAndIgnoreFiles, onlyOpenEditors };
}

const isSearchId = (value: unknown): value is number => boundedInteger(value, 0, Number.MAX_SAFE_INTEGER);

// Distinct ids: a repeated empty match would be replaced once per repetition.
function parseMatchIds(value: unknown): number[] | undefined {
  if (!boundedArray(value, MAX_SEARCH_PAYLOAD_MATCHES) || value.length === 0) return undefined;
  return value.every(isSearchId) && new Set(value).size === value.length ? [...value] : undefined;
}

function parseFileKey(raw: unknown): SearchFileKey | undefined {
  const value = record(raw);
  const kind = value ? own(value, 'kind') : undefined;
  if (kind === 'file') {
    const relativePath = own(value!, 'relativePath');
    return isRelativeFilePath(relativePath) ? { kind, relativePath } : undefined;
  }
  const documentId = value ? own(value, 'documentId') : undefined;
  return kind === 'untitled' && isShellId(documentId) ? { kind, documentId } : undefined;
}

function parseFileKeys(raw: unknown): SearchFileKey[] | undefined {
  if (!boundedArray(raw, MAX_SEARCH_PAYLOAD_MATCHES)) return undefined;
  const keys = raw.map(parseFileKey);
  return keys.every((key): key is SearchFileKey => key !== undefined) ? keys : undefined;
}

// Distinct ids; none at all is allowed where files carry the request (a dismissal of whole files).
function parseOptionalMatchIds(value: unknown): number[] | undefined {
  if (!boundedArray(value, MAX_SEARCH_PAYLOAD_MATCHES)) return undefined;
  return value.every(isSearchId) && new Set(value).size === value.length ? [...value] : undefined;
}

/** search:start from the shell, within the contract's bounds, or undefined. */
export function parseSearchStart(raw: unknown): SearchStartRequest | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const searchId = own(value, 'searchId');
  const query = parseSearchQuery(own(value, 'query'));
  const immediate = own(value, 'immediate');
  if (!isSearchId(searchId) || !query || typeof immediate !== 'boolean') return undefined;
  return { searchId, query, immediate };
}

/** search:dismiss: match ids and file keys of one search, at least one of either. */
export function parseSearchDismiss(raw: unknown): SearchDismissRequest | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const searchId = own(value, 'searchId');
  const matchIds = parseOptionalMatchIds(own(value, 'matchIds'));
  const files = parseFileKeys(own(value, 'files'));
  if (!isSearchId(searchId) || !matchIds || !files || matchIds.length + files.length === 0) return undefined;
  return { searchId, matchIds, files };
}

/** search:copy: matches by id, files by key, or all. */
export function parseSearchCopy(raw: unknown): SearchCopyRequest | undefined {
  const value = record(raw);
  const target = value ? record(own(value, 'target')) : undefined;
  const searchId = value ? own(value, 'searchId') : undefined;
  if (!target || !isSearchId(searchId)) return undefined;
  const kind = own(target, 'kind');
  let parsed: SearchCopyTarget | undefined;
  if (kind === 'all') parsed = { kind };
  else if (kind === 'matches') {
    const matchIds = parseMatchIds(own(target, 'matchIds'));
    parsed = matchIds ? { kind, matchIds } : undefined;
  } else if (kind === 'files') {
    const files = parseFileKeys(own(target, 'files'));
    parsed = files && files.length > 0 ? { kind, files } : undefined;
  }
  return parsed ? { searchId, target: parsed } : undefined;
}

export function parseConfirmReplace(raw: unknown): SearchConfirmReplaceRequest | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const occurrences = own(value, 'occurrences');
  const files = own(value, 'files');
  const replacement = own(value, 'replacement');
  if (!boundedInteger(occurrences, 1, MAX_REPLACE_OCCURRENCES) || !boundedInteger(files, 1, MAX_REPLACE_FILES)) return undefined;
  return isText(replacement, MAX_REPLACEMENT_LENGTH) ? { occurrences, files, replacement } : undefined;
}

export function parseSearchReplace(raw: unknown): SearchReplaceRequest | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const searchId = own(value, 'searchId');
  const replacement = own(value, 'replacement');
  const preserveCase = own(value, 'preserveCase');
  const matchIds = parseMatchIds(own(value, 'matchIds'));
  return isSearchId(searchId) && isText(replacement, MAX_REPLACEMENT_LENGTH) && typeof preserveCase === 'boolean' && matchIds ? { searchId, replacement, preserveCase, matchIds } : undefined;
}

/** search:preview: the match ids of one file of the search; main checks that they share it. */
export function parseSearchPreview(raw: unknown): SearchPreviewRequest | undefined {
  return parseSearchReplace(raw);
}

const SEARCH_EDITOR_CONFIG_FLAGS = ['isRegex', 'matchCase', 'wholeWord', 'useExcludeSettingsAndIgnoreFiles', 'onlyOpenEditors', 'showIncludesExcludes'] as const;

// A partial Search Editor config: each field it carries in range, nothing else.
function parsePartialSearchEditorConfig(raw: unknown): Partial<SearchEditorConfig> | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const config: { -readonly [K in keyof SearchEditorConfig]?: SearchEditorConfig[K] } = {};
  for (const key of Object.keys(value)) {
    const field = value[key];
    if (field === undefined) continue;
    if (key === 'query') {
      if (!isText(field, MAX_SEARCH_PATTERN_LENGTH)) return undefined;
      config.query = field;
    } else if (key === 'include' || key === 'exclude') {
      if (!isText(field, MAX_SEARCH_GLOBS_LENGTH)) return undefined;
      config[key] = field;
    } else if (key === 'contextLines') {
      if (!boundedInteger(field, 0, MAX_CONTEXT_LINES)) return undefined;
      config.contextLines = field;
    } else if (oneOf(SEARCH_EDITOR_CONFIG_FLAGS, key)) {
      if (typeof field !== 'boolean') return undefined;
      config[key] = field;
    } else {
      return undefined;
    }
  }
  return config;
}

/** searchEditor:open-new: a blank editor (optionally seeded) or the view's results by searchId. */
export function parseSearchEditorOpen(raw: unknown): SearchEditorOpenRequest | undefined {
  const value = record(raw);
  const from = value ? own(value, 'from') : undefined;
  if (from === 'viewResults') {
    const searchId = own(value!, 'searchId');
    return isSearchId(searchId) ? { from, searchId } : undefined;
  }
  if (from !== 'blank') return undefined;
  const rawConfig = own(value!, 'config');
  if (rawConfig === undefined) return { from };
  const config = parsePartialSearchEditorConfig(rawConfig);
  return config ? { from, config } : undefined;
}

export function parseSearchEditorConfigRequest(raw: unknown): { documentId: string; config: SearchEditorConfig } | undefined {
  const value = record(raw);
  const documentId = value ? own(value, 'documentId') : undefined;
  const config = value ? parseSearchEditorConfig(own(value, 'config')) : undefined;
  return isShellId(documentId) && config ? { documentId, config } : undefined;
}

export function parseSearchEditorOpenResult(raw: unknown): SearchEditorOpenResultRequest | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const documentId = own(value, 'documentId');
  const line = own(value, 'line');
  const column = own(value, 'column');
  const toSide = own(value, 'toSide');
  if (!isShellId(documentId) || !boundedInteger(line, 1, MAX_EDITOR_LINE) || !boundedInteger(column, 1, MAX_EDITOR_TEXT_CHARS) || typeof toSide !== 'boolean') return undefined;
  return { documentId, line, column, toSide };
}

/** editor:open from the shell, or undefined unless it names a project by key and a relative path a renderer may name. */
export function parseEditorOpen(raw: unknown): EditorOpenRequest | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const projectKey = own(value, 'projectKey');
  const relativePath = own(value, 'relativePath');
  const line = own(value, 'line');
  const as = own(value, 'as');
  const preserveFocus = own(value, 'preserveFocus');
  const toSide = own(value, 'toSide');
  if (!isShellId(projectKey) || !isRelativeFilePath(relativePath)) return undefined;
  if (line !== undefined && !boundedInteger(line, 1, MAX_EDITOR_LINE)) return undefined;
  if (as !== undefined && as !== 'preview' && as !== 'source') return undefined;
  if ((preserveFocus !== undefined && typeof preserveFocus !== 'boolean') || (toSide !== undefined && typeof toSide !== 'boolean')) return undefined;
  return {
    projectKey,
    relativePath,
    ...(line !== undefined ? { line } : {}),
    ...(as !== undefined ? { as } : {}),
    ...(preserveFocus !== undefined ? { preserveFocus } : {}),
    ...(toSide !== undefined ? { toSide } : {}),
  };
}

export function parseEditorTab(raw: unknown): EditorTabRequest | undefined {
  const value = record(raw);
  const action = value ? own(value, 'action') : undefined;
  const tabId = value ? own(value, 'tabId') : undefined;
  return oneOf(EDITOR_TAB_ACTIONS, action) && isShellId(tabId) ? { action, tabId } : undefined;
}

export function parseBrowserAction(raw: unknown): BrowserActionRequest | undefined {
  const value = record(raw);
  const tabId = value ? own(value, 'tabId') : undefined;
  const action = value ? own(value, 'action') : undefined;
  return isShellId(tabId) && oneOf(BROWSER_ACTIONS, action) ? { tabId, action } : undefined;
}

export function parseBrowserNavigate(raw: unknown): BrowserNavigateRequest | undefined {
  const value = record(raw);
  const tabId = value ? own(value, 'tabId') : undefined;
  const url = value ? own(value, 'url') : undefined;
  return isShellId(tabId) && isText(url, MAX_BROWSER_URL_LENGTH) ? { tabId, url } : undefined;
}

export function parseEditorText(raw: unknown): EditorTextRequest | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const documentId = own(value, 'documentId');
  const version = own(value, 'version');
  const text = own(value, 'text');
  if (!isShellId(documentId) || !boundedInteger(version, 0, Number.MAX_SAFE_INTEGER)) return undefined;
  return typeof text === 'string' && text.length <= MAX_EDITOR_TEXT_CHARS ? { documentId, version, text } : undefined;
}

export function parseEditorEdit(raw: unknown): EditorEditReport | undefined {
  const request = parseEditorText(raw);
  const value = record(raw);
  const seq = value ? own(value, 'seq') : undefined;
  const overReload = value ? own(value, 'overReload') : undefined;
  if (!request || !boundedInteger(seq, 0, Number.MAX_SAFE_INTEGER) || typeof overReload !== 'boolean') return undefined;
  return { ...request, seq, overReload };
}

const FORMAT_REASONS = ['save', 'command'] as const;

/** editor:format from the shell: a document id, its whole text, Monaco's indentation and the reason, or undefined. */
export function parseEditorFormat(raw: unknown): EditorFormatRequest | undefined {
  const value = record(raw);
  const options = value ? record(own(value, 'options')) : undefined;
  if (!value || !options) return undefined;
  const documentId = own(value, 'documentId');
  const text = own(value, 'text');
  const reason = own(value, 'reason');
  const tabSize = own(options, 'tabSize');
  const insertSpaces = own(options, 'insertSpaces');
  if (!isShellId(documentId) || !isText(text, MAX_EDITOR_TEXT_CHARS) || !oneOf(FORMAT_REASONS, reason)) return undefined;
  if (!boundedInteger(tabSize, 1, MAX_FORMAT_TAB_SIZE) || typeof insertSpaces !== 'boolean') return undefined;
  return { documentId, text, options: { tabSize, insertSpaces }, reason };
}

export function parseFormatFailure(raw: unknown): EditorBuiltinFormatFailure | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const documentId = own(value, 'documentId');
  const reason = own(value, 'reason');
  const timedOut = own(value, 'timedOut');
  const message = own(value, 'message');
  if (!isShellId(documentId) || !oneOf(FORMAT_REASONS, reason) || typeof timedOut !== 'boolean' || !isText(message, MAX_FORMAT_ERROR_CHARS)) return undefined;
  return { documentId, reason, timedOut, message };
}

export function parseEditorConflict(raw: unknown): EditorConflictRequest | undefined {
  const value = record(raw);
  const documentId = value ? own(value, 'documentId') : undefined;
  const action = value ? own(value, 'action') : undefined;
  return isShellId(documentId) && oneOf(['compare', 'overwrite', 'revert'] as const, action) ? { documentId, action } : undefined;
}

export function parseEditorSelection(raw: unknown): { documentId: string; range: EditorSelectionRange | null } | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const documentId = own(value, 'documentId');
  const selection = own(value, 'selection');
  if (!isShellId(documentId)) return undefined;
  if (selection === null) return { documentId, range: null };
  const range = record(selection);
  if (!range) return undefined;
  const [startLine, startColumn, endLine, endColumn] = ['startLine', 'startColumn', 'endLine', 'endColumn'].map((key) => own(range, key));
  if (!boundedInteger(startLine, 1, MAX_EDITOR_LINE) || !boundedInteger(endLine, 1, MAX_EDITOR_LINE)) return undefined;
  if (!boundedInteger(startColumn, 1, MAX_EDITOR_TEXT_CHARS) || !boundedInteger(endColumn, 1, MAX_EDITOR_TEXT_CHARS)) return undefined;
  return { documentId, range: { startLine, startColumn, endLine, endColumn } };
}

/** A file the shell names: a project by key and a relative path; '' (the project itself) only where allowRoot is set. */
export function parseFileRef(raw: unknown, allowRoot: boolean): FileRef | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const projectKey = own(value, 'projectKey');
  const relativePath = own(value, 'relativePath');
  if (!isShellId(projectKey)) return undefined;
  const valid = allowRoot ? isRelativeOrRoot(relativePath) : isRelativeFilePath(relativePath);
  return valid ? { projectKey, relativePath: relativePath as string } : undefined;
}

export function parseFilesCreate(raw: unknown): FilesCreateRequest | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const projectKey = own(value, 'projectKey');
  const relativeDir = own(value, 'relativeDir');
  const name = own(value, 'name');
  const kind = own(value, 'kind');
  if (!isShellId(projectKey) || !isRelativeOrRoot(relativeDir)) return undefined;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_FILE_NAME_LENGTH || (kind !== 'file' && kind !== 'dir')) return undefined;
  return { projectKey, relativeDir, name, kind };
}

export function parseDropZonesPointer(raw: unknown): DropZonesPointer | undefined {
  const point = shellPoint(raw);
  const value = record(raw);
  const released = value ? own(value, 'released') : undefined;
  return point && typeof released === 'boolean' ? { x: point.x, y: point.y, released } : undefined;
}

/** A point in CSS px from the shell, or undefined when malformed. */
export function shellPoint(raw: unknown): { readonly x: number; readonly y: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const x = Object.hasOwn(raw, 'x') ? (raw as Record<string, unknown>)['x'] : undefined;
  const y = Object.hasOwn(raw, 'y') ? (raw as Record<string, unknown>)['y'] : undefined;
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_BOUND;
  return valid(x) && valid(y) ? { x, y } : undefined;
}

/** The shell's CSS-pixel content rectangle as window DIPs, or undefined for a malformed report. */
export function contentBoundsToDip(raw: unknown, zoomFactor: number): Rectangle | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { x, y, width, height } = raw as Record<string, unknown>;
  const values = [x, y, width, height];
  if (!values.every((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_BOUND)) return undefined;
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return undefined;
  const [dx, dy, dw, dh] = values.map((value) => value * zoomFactor) as [number, number, number, number];
  // Rounded outward on the far edge, so a fractional layout leaves no one-pixel gap under the view.
  const left = Math.round(dx);
  const top = Math.round(dy);
  return { x: left, y: top, width: Math.max(0, Math.ceil(dx + dw) - left), height: Math.max(0, Math.ceil(dy + dh) - top) };
}

// The largest corner radius, in CSS px, main takes from the shell for a page area.
const MAX_PAGE_RADIUS = 64;

/** A browser page area in window DIP with its corner radius, as the shell reports it in CSS px; undefined when malformed. */
export function browserPageAreaToDip(raw: unknown, zoomFactor: number): { readonly bounds: Rectangle; readonly radius: number } | undefined {
  const bounds = contentBoundsToDip(raw, zoomFactor);
  const radius = bounds ? (raw as Record<string, unknown>)['radius'] : undefined;
  if (!bounds || typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0 || radius > MAX_PAGE_RADIUS) return undefined;
  return { bounds, radius: Math.round(radius * zoomFactor) };
}

/** A shell action whose failure the page cannot show: report logs it and tells the user, and the call resolves (with `fallback`). */
export function reportFailure<A extends unknown[]>(action: (...args: A) => Promise<void>, report: (err: unknown) => void): (...args: A) => Promise<void>;
export function reportFailure<A extends unknown[], R>(action: (...args: A) => Promise<R>, report: (err: unknown) => void, fallback: R): (...args: A) => Promise<R>;
export function reportFailure<A extends unknown[], R>(action: (...args: A) => Promise<R>, report: (err: unknown) => void, fallback?: R): (...args: A) => Promise<R | undefined> {
  return async (...args) => {
    try {
      return await action(...args);
    } catch (err) {
      report(err);
      return fallback;
    }
  };
}

// Monaco's editor, JSON and TypeScript module workers; a worker carries no nonce, and its script response has its own CSP.
export const SHELL_WORKER_SRC: string = `${APP_ORIGIN}/desktop-shell/assets/`;

/** The shell page main serves at SHELL_PAGE_URL: the built shell app under a fresh script nonce and the current theme. */
export function shellHtml(theme: PanelTheme): string {
  const nonce = randomBytes(16).toString('base64');
  const assets = `${APP_ORIGIN}/desktop-shell/assets`;
  return `<!DOCTYPE html>
<html lang="en"${theme.reducedMotion ? ' data-reduced-motion' : ''}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${APP_ORIGIN} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src ${SHELL_WORKER_SRC}; font-src ${APP_ORIGIN}; img-src ${APP_ORIGIN} data:; base-uri 'none'; form-action 'none';">
  <link href="${assets}/index.css" rel="stylesheet">
  <style id="${HOST_THEME_STYLE_ID}">${theme.css}</style>
  <title>Damocles</title>
</head>
<body class="vscode-${theme.kind}" data-vscode-theme-kind="vscode-${theme.kind}">
  <div id="app"></div>
  <script nonce="${nonce}" type="module" src="${assets}/index.js"></script>
</body>
</html>`;
}

// The project keys a state lets the page ask about: each listed project, and the selected one, the home folder while none is.
function projectKeysOf(state: Pick<ShellState, 'projects' | 'selected'>): ReadonlySet<string> {
  const keys = new Set(state.projects.map((project) => project.key));
  if (state.selected.projectKey !== undefined) keys.add(state.selected.projectKey);
  return keys;
}

/** The window's own page: the title bar and sidebar, talking to main only through the damocles:shell: channels. */
export class ShellHost {
  private readonly window: BrowserWindow;
  private readonly actions: ShellActions;
  private readonly log: (line: string) => void;
  // The page crashed more than MAX_CRASHES_IN_WINDOW times within CRASH_WINDOW_MS and is left dead.
  private readonly onRendererGaveUp: () => void;
  private readonly invokeChannels: string[] = [];
  private readonly sendHandlers: Array<[string, (event: IpcMainEvent, ...args: unknown[]) => void]> = [];
  // the page's requests main is still answering
  private readonly answering = new Set<Promise<unknown>>();
  private stateScheduled = false;
  // ShellState.revision of the last state given to the page
  private revision = 0;
  // The project keys the states given to the page named, from the revision each set took effect, oldest first; only states
  // given since the page last started loading, the ones a request of its can name.
  private projectKeysFrom: Array<{ readonly revision: number; readonly keys: ReadonlySet<string> }> = [];
  private loaded = false;
  private reportedBadBounds = false;
  private crashes: number[] = [];
  private disposed = false;
  // A click or activation key in the page, which the application menu takes, so page script alone cannot open it.
  private readonly appMenuGrant = new GestureGrant<true>();

  constructor(window: BrowserWindow, actions: ShellActions, log: (line: string) => void, onRendererGaveUp: () => void) {
    this.window = window;
    this.actions = actions;
    this.log = log;
    this.onRendererGaveUp = onRendererGaveUp;

    this.handle(SHELL_CHANNELS.getState, () => this.given(this.actions.state()));
    this.handle(SHELL_CHANNELS.addProject, () => this.actions.addProject());
    this.handle(SHELL_CHANNELS.removeProject, (key) => this.actions.removeProject(this.id(key)));
    this.handle(SHELL_CHANNELS.selectProject, (key) => this.actions.selectProject(this.id(key)));
    this.handle(SHELL_CHANNELS.grantTrust, (key) => this.actions.grantTrust(this.id(key)));
    this.handle(SHELL_CHANNELS.chatsList, (key, revision) => this.chatList(this.id(key), revision, (projectKey) => this.actions.listChats(projectKey)));
    this.handle(SHELL_CHANNELS.chatsSearch, (key, query, revision) => {
      if (typeof query !== 'string' || query.length > MAX_SEARCH_LENGTH) throw new Error('Malformed search from the shell');
      return this.chatList(this.id(key), revision, (projectKey) => this.actions.searchChats(projectKey, query));
    });
    this.handle(SHELL_CHANNELS.chatsSelect, (id) => this.actions.selectChat(this.id(id)));
    this.handle(SHELL_CHANNELS.chatsNew, (key) => this.actions.newChat(key === undefined ? undefined : this.id(key)));
    this.handle(SHELL_CHANNELS.chatsRename, (id, raw) => {
      const name = chatName(raw);
      if (name === undefined) throw new Error('Malformed chat name from the shell');
      return this.actions.renameChat(this.id(id), name);
    });
    this.handle(SHELL_CHANNELS.chatsTag, (id, raw) => {
      const tag = chatTag(raw);
      if (tag === undefined) throw new Error('Malformed tag from the shell');
      return this.actions.tagChat(this.id(id), tag);
    });
    this.handle(SHELL_CHANNELS.chatsDelete, (id) => this.actions.deleteChat(this.id(id)));
    this.handle(SHELL_CHANNELS.overlayRequest, (raw) => {
      const request = parseOverlayRequest(raw);
      if (!request) throw new Error('Malformed overlay request from the shell');
      return this.actions.requestOverlay(request, this.window.webContents);
    });
    this.handle(SHELL_CHANNELS.appMenu, (raw) => {
      const anchor = shellPoint(raw);
      if (!anchor) throw new Error('Malformed menu anchor from the shell');
      if (this.appMenuGrant.take() !== true) {
        this.log('[shell] not opening the application menu: no click or key of the user asked for it');
        return;
      }
      const zoom = this.window.webContents.getZoomFactor();
      this.actions.openAppMenu({ x: Math.round(anchor.x * zoom), y: Math.round(anchor.y * zoom) });
    });
    this.handle(SHELL_CHANNELS.toggleTheme, () => this.actions.toggleTheme());
    this.handle(SHELL_CHANNELS.toggleSidebar, () => this.actions.toggleSidebar());
    this.handle(SHELL_CHANNELS.showSidebar, () => this.actions.showSidebar());
    this.handle(SHELL_CHANNELS.windowControl, (control) => {
      if (!WINDOW_CONTROLS.includes(control as WindowControl)) throw new Error('Unknown window control from the shell');
      this.actions.windowControl(control as WindowControl);
    });
    this.handle(SHELL_CHANNELS.openSettings, (section) => {
      if (section !== undefined && !isSettingsSectionId(section)) throw new Error('Unknown settings section from the shell');
      this.actions.openSettings(section);
    });
    this.handle(SHELL_CHANNELS.updateGet, () => this.actions.update());
    this.handle(SHELL_CHANNELS.updateRun, (action) => {
      if (!isUpdateAction(action)) throw new Error('Unknown update action from the shell');
      return this.actions.runUpdateAction(action);
    });
    this.on(SHELL_CHANNELS.contentBounds, (raw) => {
      const bounds = contentBoundsToDip(raw, this.window.webContents.getZoomFactor());
      if (!bounds) {
        if (!this.reportedBadBounds) this.log('[shell] ignoring malformed content bounds');
        this.reportedBadBounds = true;
        return;
      }
      this.actions.setContentBounds(bounds);
    });
    this.on(SHELL_CHANNELS.sidebarLayout, (raw) => {
      const layout = parseSidebarLayout(raw);
      if (!layout) {
        this.log('[shell] ignoring a malformed sidebar layout');
        return;
      }
      this.actions.setSidebarLayout(layout);
    });
    this.on(SHELL_CHANNELS.gridSizes, (raw) => {
      const sizes = parseGridSizes(raw);
      if (!sizes) {
        this.log('[shell] ignoring malformed grid sizes');
        return;
      }
      this.actions.setGridSizes(sizes);
    });
    this.on(SHELL_CHANNELS.focusedPart, (part) => {
      if (part !== null && !SHELL_FOCUS_PARTS.includes(part as ShellFocusPart)) {
        this.log('[shell] ignoring a malformed focused part');
        return;
      }
      this.actions.setFocusedPart(part as ShellFocusPart | null);
    });
    this.handleLayoutGrid();
    this.handleEditor();
    this.handleBrowser();
    this.handleFiles();
    this.handleSearch();
    this.handleSearchEditor();
    this.handleTerminal();

    const contents = window.webContents;
    // Only input the browser process routes reaches these: page script's synthetic events never do.
    contents.on('before-input-event', (_event, input) => {
      if (isActivationKey(input)) this.appMenuGrant.grant(true);
      if (isContextMenuKey(input)) this.actions.gestures.contextMenu();
      else if (input.type === 'keyDown' && !input.isComposing && isTerminalPasteChord({ code: input.code, ctrl: input.control, shift: input.shift, alt: input.alt, meta: input.meta }, process.platform)) {
        this.actions.gestures.pasteKey();
      }
    });
    contents.on('before-mouse-event', (_event, mouse) => {
      if (isPrimaryClick(mouse, process.platform)) this.appMenuGrant.grant(true);
      else if (isContextMenuMouse(mouse, process.platform)) this.actions.gestures.contextMenu();
      else if (process.platform === 'linux' && mouse.type === 'mouseDown' && mouse.button === 'middle') this.actions.gestures.middleClick();
    });
    contents.on('blur', () => {
      this.appMenuGrant.clear();
      this.actions.gestures.blurred();
    });
    // A reload by any route commits a new document, which refetches what it shows once it has loaded.
    contents.on('did-navigate', () => {
      this.loaded = false;
      this.projectKeysFrom = [];
    });
    contents.on('did-finish-load', () => {
      this.loaded = true;
      this.actions.terminal.setInputFocused(false);
      this.actions.editor.setFocusOverlay(false);
      this.sendState();
      this.actions.terminal.shellLoaded();
    });
    contents.on('render-process-gone', (_event, details) => {
      this.loaded = false;
      this.log(`[shell] renderer gone (${details.reason})`);
      this.actions.setFocusedPart(null);
      this.actions.terminal.setInputFocused(false);
      this.actions.editor.setFocusOverlay(false);
      if (this.disposed || details.reason === 'clean-exit') return;
      const now = Date.now();
      this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
      if (this.crashes.length > MAX_CRASHES_IN_WINDOW) {
        this.log(`[shell] crashed ${this.crashes.length} times within ${CRASH_WINDOW_MS / 1000} s; not reloading it`);
        this.onRendererGaveUp();
        return;
      }
      this.load();
    });
  }

  private handleLayoutGrid(): void {
    this.handle(SHELL_CHANNELS.layoutMove, (raw) => {
      const value = record(raw);
      const pane = value ? own(value, 'pane') : undefined;
      const slot = value ? own(value, 'slot') : undefined;
      if (!oneOf(GRID_PANES, pane) || !oneOf(GRID_SLOTS, slot)) throw new Error('Malformed layout move from the shell');
      this.actions.layoutMove(pane, slot);
    });
    this.handle(SHELL_CHANNELS.toggleEditor, () => this.actions.toggleEditor());
    this.handle(SHELL_CHANNELS.toggleTerminal, () => this.actions.toggleTerminal());
    this.handle(SHELL_CHANNELS.toggleMaximize, (raw) => {
      const value = record(raw);
      const pane = value ? own(value, 'pane') : undefined;
      if (!oneOf(GRID_PANES, pane)) throw new Error('Malformed pane from the shell');
      this.actions.toggleMaximize(pane);
    });
    this.on(SHELL_CHANNELS.dropZonesPointer, (raw) => {
      const pointer = parseDropZonesPointer(raw);
      if (pointer) this.actions.dropZonesPointer(pointer);
      else this.log('[shell] ignoring a malformed drop zones pointer');
    });
    this.handle(SHELL_CHANNELS.quickOpen, () => this.actions.openQuickOpen());
    this.handle(SHELL_CHANNELS.showCommands, () => this.actions.showCommands());
  }

  private handleEditor(): void {
    const editor = this.actions.editor;
    this.handle(SHELL_CHANNELS.editorGetState, () => editor.state());
    this.handle(SHELL_CHANNELS.editorGetDocument, (raw) => {
      const value = record(raw);
      const documentId = value ? own(value, 'documentId') : undefined;
      if (!isShellId(documentId)) throw new Error('Malformed document id from the shell');
      return editor.content(documentId);
    });
    // A well-formed request naming a path a renderer may not name answers 'outside', as an unconfined one does in main.
    this.handle(SHELL_CHANNELS.editorOpen, (raw): Promise<EditorOpenResult> | EditorOpenResult => {
      const request = parseEditorOpen(raw);
      if (request) return editor.open(request);
      const value = record(raw);
      const pathOnly = value && parseEditorOpen({ ...value, relativePath: 'x' });
      if (!pathOnly || typeof own(value, 'relativePath') !== 'string') throw new Error('Malformed open from the shell');
      this.log('[shell] refused an open of a path outside its project');
      return { ok: false, reason: 'outside' };
    });
    this.handle(SHELL_CHANNELS.editorTab, (raw) => {
      const request = parseEditorTab(raw);
      if (!request) throw new Error('Malformed tab action from the shell');
      return editor.tab(request);
    });
    for (const [channel, as] of [[SHELL_CHANNELS.editorSave, false], [SHELL_CHANNELS.editorSaveAs, true]] as const) {
      this.handle(channel, (raw) => {
        const request = parseEditorText(raw);
        if (!request) throw new Error('Malformed save from the shell');
        return editor.save(request, as);
      });
    }
    this.handle(SHELL_CHANNELS.editorConflict, (raw) => {
      const request = parseEditorConflict(raw);
      if (!request) throw new Error('Malformed conflict action from the shell');
      return editor.conflict(request);
    });
    this.handle(SHELL_CHANNELS.editorFormat, (raw) => {
      const request = parseEditorFormat(raw);
      if (!request) throw new Error('Malformed format request from the shell');
      return editor.format(request);
    });
    this.on(SHELL_CHANNELS.editorFormatFailed, (raw) => {
      const failure = parseFormatFailure(raw);
      if (failure) editor.formatFailed(failure);
      else this.log('[shell] ignoring a malformed format failure');
    });
    this.handle(SHELL_CHANNELS.editorMention, (raw) => {
      const value = record(raw);
      const tabId = value ? own(value, 'tabId') : undefined;
      if (!isShellId(tabId)) throw new Error('Malformed tab id from the shell');
      return editor.mention(tabId);
    });
    this.handle(SHELL_CHANNELS.editorFocusOverlay, (raw) => {
      const value = record(raw);
      const open = value ? own(value, 'open') : undefined;
      if (typeof open !== 'boolean') throw new Error('Malformed focus overlay flag from the shell');
      editor.setFocusOverlay(open);
    });
    this.on(SHELL_CHANNELS.editorEdit, (raw) => {
      const request = parseEditorEdit(raw);
      if (request) editor.edit(request);
      else this.log('[shell] ignoring a malformed edit');
    });
    this.on(SHELL_CHANNELS.editorSelection, (raw) => {
      const report = parseEditorSelection(raw);
      if (report) editor.selection(report.documentId, report.range);
      else this.log('[shell] ignoring a malformed selection');
    });
    this.on(SHELL_CHANNELS.editorFlushed, (raw) => {
      const value = record(raw);
      const requestId = value ? own(value, 'requestId') : undefined;
      if (isShellId(requestId)) editor.flushed(requestId);
      else this.log('[shell] ignoring a malformed flush answer');
    });
  }

  private handleBrowser(): void {
    const browser = this.actions.browser;
    this.handle(SHELL_CHANNELS.browserAction, (raw) => {
      const request = parseBrowserAction(raw);
      if (!request) throw new Error('Malformed browser action from the shell');
      return browser.action(request);
    });
    this.handle(SHELL_CHANNELS.browserNavigate, (raw) => {
      const request = parseBrowserNavigate(raw);
      if (!request) throw new Error('Malformed address from the shell');
      return browser.navigate(request);
    });
    this.on(SHELL_CHANNELS.browserBounds, (raw) => {
      const area = raw === null ? undefined : browserPageAreaToDip(raw, this.window.webContents.getZoomFactor());
      if (raw !== null && !area) {
        this.log('[shell] ignoring malformed browser bounds');
        return;
      }
      browser.setBounds(area?.bounds, area?.radius ?? 0);
    });
  }

  private handleFiles(): void {
    const files = this.actions.files;
    this.handle(SHELL_CHANNELS.filesList, (raw) => {
      const value = record(raw);
      const ref = value ? parseFileRef({ projectKey: own(value, 'projectKey'), relativePath: own(value, 'relativeDir') }, true) : undefined;
      const report = value ? own(value, 'report') : undefined;
      if (!ref || typeof report !== 'boolean') throw new Error('Malformed or unconfined listing from the shell');
      return files.list(ref.projectKey, ref.relativePath, report);
    });
    this.handle(SHELL_CHANNELS.filesCreate, (raw) => {
      const request = parseFilesCreate(raw);
      if (!request) throw new Error('Malformed create from the shell');
      return files.create(request);
    });
    this.handle(SHELL_CHANNELS.filesRename, (raw) => {
      const ref = parseFileRef(raw, false);
      const newName = record(raw) ? own(record(raw)!, 'newName') : undefined;
      if (!ref || typeof newName !== 'string' || newName.length === 0 || newName.length > MAX_FILE_NAME_LENGTH) throw new Error('Malformed rename from the shell');
      return files.rename(ref, newName);
    });
    this.handle(SHELL_CHANNELS.filesDelete, (raw) => {
      const ref = parseFileRef(raw, false);
      if (!ref) throw new Error('Malformed delete from the shell');
      return files.delete(ref);
    });
    this.handle(SHELL_CHANNELS.filesCopyPath, (raw) => {
      const ref = parseFileRef(raw, true);
      const relative = record(raw) ? own(record(raw)!, 'relative') : undefined;
      if (!ref || typeof relative !== 'boolean') throw new Error('Malformed copy path from the shell');
      return files.copyPath(ref, relative);
    });
    this.handle(SHELL_CHANNELS.filesReveal, (raw) => {
      const ref = parseFileRef(raw, true);
      if (!ref) throw new Error('Malformed reveal from the shell');
      return files.reveal(ref);
    });
    this.handle(SHELL_CHANNELS.filesMention, (raw) => {
      const ref = parseFileRef(raw, false);
      if (!ref) throw new Error('Malformed mention from the shell');
      return files.mention(ref);
    });
  }

  private handleSearch(): void {
    const search = this.actions.search;
    this.handle(SHELL_CHANNELS.searchStart, (raw) => {
      const request = parseSearchStart(raw);
      if (!request) throw new Error('Malformed search from the shell');
      return search.start(request);
    });
    this.handle(SHELL_CHANNELS.searchCancel, (raw) => {
      const value = record(raw);
      if (!value || Object.keys(value).length > 0) throw new Error('Malformed search cancel from the shell');
      search.cancel();
    });
    this.handle(SHELL_CHANNELS.searchClear, (raw) => {
      const value = record(raw);
      if (!value || Object.keys(value).length > 0) throw new Error('Malformed search clear from the shell');
      search.clear();
    });
    this.handle(SHELL_CHANNELS.searchDismiss, (raw) => {
      const request = parseSearchDismiss(raw);
      if (!request) throw new Error('Malformed dismiss from the shell');
      search.dismiss(request);
    });
    this.handle(SHELL_CHANNELS.searchCopy, (raw) => {
      const request = parseSearchCopy(raw);
      if (!request) throw new Error('Malformed copy from the shell');
      return search.copy(request);
    });
    this.handle(SHELL_CHANNELS.searchFindInFolder, (raw) => {
      const folder = parseFileRef(raw, true);
      if (!folder) throw new Error('Malformed or unconfined folder from the shell');
      return search.findInFolder(folder);
    });
    this.handle(SHELL_CHANNELS.searchConfirmReplace, (raw) => {
      const request = parseConfirmReplace(raw);
      if (!request) throw new Error('Malformed replace confirmation from the shell');
      return search.confirmReplace(request);
    });
    this.handle(SHELL_CHANNELS.searchReplace, (raw) => {
      const request = parseSearchReplace(raw);
      if (!request) throw new Error('Malformed replace from the shell');
      return search.replace(request);
    });
    this.handle(SHELL_CHANNELS.searchPreview, (raw) => {
      const request = parseSearchPreview(raw);
      if (!request) throw new Error('Malformed replace preview from the shell');
      return search.preview(request);
    });
  }

  private handleSearchEditor(): void {
    const searchEditor = this.actions.searchEditor;
    this.handle(SHELL_CHANNELS.searchEditorOpenNew, (raw) => {
      const request = parseSearchEditorOpen(raw);
      if (!request) throw new Error('Malformed Search Editor open from the shell');
      return searchEditor.openNew(request);
    });
    this.handle(SHELL_CHANNELS.searchEditorConfig, (raw) => {
      const request = parseSearchEditorConfigRequest(raw);
      if (!request) throw new Error('Malformed Search Editor config from the shell');
      searchEditor.setConfig(request.documentId, request.config);
    });
    this.handle(SHELL_CHANNELS.searchEditorRun, (raw) => {
      const documentId = record(raw) ? own(record(raw)!, 'documentId') : undefined;
      if (!isShellId(documentId)) throw new Error('Malformed Search Editor run from the shell');
      searchEditor.run(documentId);
    });
    this.handle(SHELL_CHANNELS.searchEditorOpenResult, (raw) => {
      const request = parseSearchEditorOpenResult(raw);
      if (!request) throw new Error('Malformed Search Editor result open from the shell');
      return searchEditor.openResult(request);
    });
  }

  private handleTerminal(): void {
    const terminal = this.actions.terminal;
    this.handle(TERMINAL_CHANNELS.getState, () => terminal.state());
    this.handle(TERMINAL_CHANNELS.create, (raw) => {
      const request = parseTerminalCreate(raw);
      if (!request) throw new Error('Malformed terminal create from the shell');
      return terminal.create(request);
    });
    this.on(TERMINAL_CHANNELS.new, () => terminal.openNew());
    this.onTerminal(TERMINAL_CHANNELS.input, parseTerminalInput, ({ id, data }) => terminal.input(id, data));
    this.onTerminal(TERMINAL_CHANNELS.resize, parseTerminalResize, ({ id, cols, rows }) => terminal.resize(id, cols, rows));
    this.onTerminal(TERMINAL_CHANNELS.ack, parseTerminalAck, ({ id, chars }) => terminal.ack(id, chars));
    this.onTerminal(TERMINAL_CHANNELS.kill, parseTerminalRef, (id) => terminal.kill(id));
    this.onTerminal(TERMINAL_CHANNELS.restart, parseTerminalRef, (id) => terminal.restart(id));
    this.onTerminal(TERMINAL_CHANNELS.select, parseTerminalRef, (id) => terminal.select(id));
    this.onTerminal(TERMINAL_CHANNELS.split, parseTerminalRef, (id) => terminal.split(id));
    this.onTerminal(TERMINAL_CHANNELS.unsplit, parseTerminalRef, (id) => terminal.unsplit(id));
    this.onTerminal(TERMINAL_CHANNELS.resizePanes, parseTerminalResizePanes, ({ groupId, sizes }) => terminal.resizePanes(groupId, sizes));
    this.onTerminal(TERMINAL_CHANNELS.listWidth, parseTerminalListWidth, (rem) => terminal.setListWidth(rem));
    this.onTerminal(TERMINAL_CHANNELS.paste, parseTerminalPaste, (request) => terminal.paste(request));
    this.onTerminal(TERMINAL_CHANNELS.inputFocus, parseTerminalInputFocus, (focused) => terminal.setInputFocused(focused));
    this.onTerminal(TERMINAL_CHANNELS.openLink, parseTerminalOpenLink, (request) => terminal.openLink(request));
    this.onTerminal(TERMINAL_CHANNELS.rename, parseTerminalRename, ({ id, name }) => terminal.rename(id, name));
    this.onTerminal(TERMINAL_CHANNELS.pickIcon, parseTerminalRef, (id) => terminal.pickIcon(id));
    this.onTerminal(TERMINAL_CHANNELS.pickColor, parseTerminalRef, (id) => terminal.pickColor(id));
    this.on(TERMINAL_CHANNELS.selectDefaultProfile, () => terminal.selectDefaultProfile());
    this.onTerminal(TERMINAL_CHANNELS.addToChat, parseTerminalAddToChat, (request) => terminal.addToChat(request));
    this.handle(TERMINAL_CHANNELS.resolveLinks, (raw) => {
      const request = parseTerminalResolveLinks(raw);
      if (!request) throw new Error('Malformed terminal link resolution from the shell');
      return terminal.resolveLinks(request);
    });
  }

  // A malformed payload is dropped and logged, once per channel, since input and acks stream.
  private onTerminal<T>(channel: string, parse: (raw: unknown) => T | undefined, handler: (value: T) => void): void {
    let reported = false;
    this.on(channel, (raw) => {
      const value = parse(raw);
      if (value !== undefined) {
        handler(value);
        return;
      }
      if (!reported) this.log(`[shell] ignoring a malformed ${channel}`);
      reported = true;
    });
  }

  terminalState(state: TerminalState): void {
    this.send(TERMINAL_CHANNELS.state, state);
  }

  terminalData(data: TerminalData): void {
    this.send(TERMINAL_CHANNELS.data, data);
  }

  // A user's action in main: keyboard focus moves to the window's own page, which focuses the terminal. The state goes first,
  // so the shell already shows the pane main just opened.
  focusTerminal(id: string): void {
    if (this.disposed || this.window.isDestroyed()) return;
    this.window.webContents.focus();
    this.sendState();
    this.send(TERMINAL_CHANNELS.focus, { id });
  }

  // The palette's Rename..., a user's action: keyboard focus moves to the window's own page, which starts the inline rename.
  startTerminalRename(id: string): void {
    if (this.disposed || this.window.isDestroyed()) return;
    this.window.webContents.focus();
    this.sendState();
    this.send(TERMINAL_CHANNELS.startRename, { id });
  }

  // The Edit menu's Paste while the terminal's xterm has keyboard focus: the shell answers with its bracketed paste mode.
  requestTerminalPaste(id: string): void {
    this.send(TERMINAL_CHANNELS.requestPaste, { id });
  }

  // A palette command on that terminal's buffer, a user's action: keyboard focus moves to the window's own page.
  runTerminalAction(id: string, action: TerminalAction): void {
    if (this.disposed || this.window.isDestroyed()) return;
    this.window.webContents.focus();
    this.sendState();
    this.send(TERMINAL_CHANNELS.runAction, { id, action });
  }

  // A terminal link to a folder, a user's action: keyboard focus moves to the window's own page, whose Files section reveals it.
  // The sidebar shows first and the state goes before the reveal, so the shell's Files tree is no longer inert.
  revealInFiles(file: FileRef): void {
    if (this.disposed || this.window.isDestroyed()) return;
    this.actions.showSidebar();
    this.window.webContents.focus();
    this.sendState();
    this.send(TERMINAL_CHANNELS.revealInFiles, { projectKey: file.projectKey, relativePath: file.relativePath });
  }

  searchResults(batch: SearchResultsBatch): void {
    this.send(SHELL_CHANNELS.searchResults, batch);
  }

  searchDone(done: SearchDone): void {
    this.send(SHELL_CHANNELS.searchDone, done);
  }

  searchFileUpdate(update: SearchFileUpdate): void {
    this.send(SHELL_CHANNELS.searchFileUpdate, update);
  }

  searchEditorHighlights(highlights: SearchEditorHighlights): void {
    this.send(SHELL_CHANNELS.searchEditorHighlights, highlights);
  }

  // A registry command for the Search view or a Search Editor, a user's action: keyboard focus moves to the window's own page.
  searchCommand(message: SearchCommandMessage): void {
    if (this.disposed || this.window.isDestroyed()) return;
    this.window.webContents.focus();
    this.sendState();
    this.send(SHELL_CHANNELS.searchCommand, message);
  }

  // Find in Files and Replace in Files, a user's action: keyboard focus moves to the window's own page, which focuses the query.
  // The state goes first, so the shell already shows the sidebar main just opened.
  focusSearch(focus: SearchFocus): void {
    if (this.disposed || this.window.isDestroyed()) return;
    this.window.webContents.focus();
    this.sendState();
    this.send(SHELL_CHANNELS.searchFocus, focus);
  }

  load(): void {
    this.loaded = false;
    this.projectKeysFrom = [];
    loadAppPage(this.window.webContents, SHELL_PAGE_URL).catch((err: unknown) => {
      this.log(`[shell] failed to load: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // After the page gave up crashing, at the user's request: a fresh crash budget and a new load.
  restart(): void {
    if (this.disposed) return;
    this.crashes = [];
    this.load();
  }

  // Coalesces bursts (an activity event per chat) into one snapshot per turn of the event loop.
  stateChanged(): void {
    if (this.stateScheduled || this.disposed) return;
    this.stateScheduled = true;
    setImmediate(() => {
      this.stateScheduled = false;
      this.sendState();
    });
  }

  sendTheme(theme: PanelTheme): void {
    this.send(SHELL_CHANNELS.theme, theme);
  }

  updateChanged(snapshot: UpdateSnapshot): void {
    this.send(SHELL_CHANNELS.updateState, snapshot);
  }

  chatsChanged(projectKey: string): void {
    this.send(SHELL_CHANNELS.chatsChanged, projectKey);
  }

  // main → shell editor and Files pushes; each is dropped while the page is not loaded, which refetches on load
  editorState(state: ShellEditorState): void {
    this.send(SHELL_CHANNELS.editorState, state);
  }

  documentChanged(documentId: string, content: ShellDocumentContent): void {
    this.send(SHELL_CHANNELS.editorDocumentChanged, { documentId, content });
  }

  editorCommand(command: EditorCommand): void {
    this.send(SHELL_CHANNELS.editorCommand, command);
  }

  // false: no loaded page to answer; format names the documents the shell formats first
  editorFlush(requestId: string, format: readonly string[]): boolean {
    if (!this.loaded || this.disposed) return false;
    this.send(SHELL_CHANNELS.editorFlush, { requestId, format: [...format] });
    return true;
  }

  // A user's open: keyboard focus moves to the window's own page, which focuses the tab's editor.
  focusEditorTab(tabId: string): void {
    if (this.disposed || this.window.isDestroyed()) return;
    this.window.webContents.focus();
    this.send(SHELL_CHANNELS.editorFocus, { tabId });
  }

  revealEditorLine(tabId: string, line: number, range?: SearchRange): void {
    this.send(SHELL_CHANNELS.editorReveal, { tabId, line, ...(range ? { range } : {}) });
  }

  filesChanged(change: FilesChanged): void {
    this.send(SHELL_CHANNELS.filesChanged, change);
  }

  // Keyboard focus moves to the window's own page; the shell then focuses the part (the sidebar's current row, the active editor).
  focusPart(part: ShellFocusPart): void {
    if (this.disposed || this.window.isDestroyed()) return;
    this.window.webContents.focus();
    this.send(SHELL_CHANNELS.focusPart, part);
  }

  // A closing window destroys its page before the window, and reading a destroyed page's focus throws.
  get focused(): boolean {
    return !this.disposed && !this.window.isDestroyed() && !this.window.webContents.isDestroyed() && this.window.webContents.isFocused();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.appMenuGrant.clear();
    for (const channel of this.invokeChannels) ipcMain.removeHandler(channel);
    for (const [channel, handler] of this.sendHandlers) ipcMain.removeListener(channel, handler);
  }

  // After dispose no request is accepted, so this settles once the last one main was still answering has.
  async settled(): Promise<void> {
    await Promise.allSettled([...this.answering]);
  }

  private sendState(state: Omit<ShellState, 'revision'> = this.actions.state()): void {
    this.target()?.send(SHELL_CHANNELS.state, this.given(state));
  }

  private send(channel: string, payload: unknown): void {
    this.target()?.send(channel, payload);
  }

  // undefined while there is no loaded page
  private target(): WebContents | undefined {
    if (this.disposed || !this.loaded || this.window.isDestroyed()) return undefined;
    const contents = this.window.webContents;
    return contents.isDestroyed() || contents.isCrashed() ? undefined : contents;
  }

  private given(body: Omit<ShellState, 'revision'>): ShellState {
    const state: ShellState = { ...body, revision: ++this.revision };
    const keys = projectKeysOf(state);
    const last = this.projectKeysFrom.at(-1);
    if (!last || last.keys.size !== keys.size || [...keys].some((key) => !last.keys.has(key))) this.projectKeysFrom.push({ revision: state.revision, keys });
    return state;
  }

  // The project keys of the state with this revision the page was given; a revision it was never given is refused.
  private projectKeysAt(revision: unknown): ReadonlySet<string> {
    const at = typeof revision === 'number' && Number.isSafeInteger(revision) && revision <= this.revision
      ? this.projectKeysFrom.filter((entry) => entry.revision <= revision).at(-1)
      : undefined;
    if (!at) throw new Error('Malformed state revision from the shell');
    return at.keys;
  }

  // A key the page's state named that main's list no longer holds crossed the change: once the state without it is sent the
  // answer is null, which the page drops. A key the state never named, or one main still publishes and refuses, is refused.
  private async chatList(key: string, revision: unknown, list: (projectKey: string) => Promise<ShellChatList | undefined>): Promise<ShellChatList | null> {
    if (!this.projectKeysAt(revision).has(key)) throw new Error('Unknown project');
    const answer = await list(key);
    if (answer) return answer;
    const current = this.actions.state();
    if (projectKeysOf(current).has(key)) throw new Error('A published project is not in the project list');
    this.sendState(current);
    return null;
  }

  private id(value: unknown): string {
    if (!isShellId(value)) throw new Error('Malformed id from the shell');
    return value;
  }

  // Read at call time: the window's webContents is the only accepted sender, on the exact shell page, main frame.
  private accepts(event: IpcMainEvent | IpcMainInvokeEvent, channel: string): boolean {
    const accepted = !this.disposed && !this.window.isDestroyed() && isPanelSender(event, this.window.webContents, SHELL_PAGE_URL);
    if (!accepted) this.log(`[shell] rejected ${channel} from ${event.senderFrame ? loggableUrl(event.senderFrame.url) : 'a destroyed frame'} (webContents ${event.sender.id})`);
    return accepted;
  }

  private handle(channel: string, handler: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!this.accepts(event, channel)) throw new Error('Rejected');
      const answer = (async () => handler(...args))();
      this.answering.add(answer);
      try {
        return await answer;
      } catch (err) {
        this.log(`[shell] ${channel} failed: ${errorText(err)}`);
        throw err;
      } finally {
        this.answering.delete(answer);
      }
    });
    this.invokeChannels.push(channel);
  }

  private on(channel: string, handler: (...args: unknown[]) => void): void {
    const guarded = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (this.accepts(event, channel)) handler(...args);
    };
    ipcMain.on(channel, guarded);
    this.sendHandlers.push([channel, guarded]);
  }
}
