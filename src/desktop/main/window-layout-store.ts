import * as fs from 'node:fs';
import * as path from 'node:path';
import { jsonConfigWritesSettled, writeJsonConfig } from '../../core/config/json-config-write';
import {
  DEFAULT_GRID_LAYOUT,
  GRID_PANES,
  GRID_SLOTS,
  MAX_SHELL_COORDINATE,
  MIN_SECTION_SIZE,
  MIN_SIDEBAR_WIDTH,
  type GridPane,
  type ShellGridLayout,
  type ShellGridSizes,
  type ShellLayout,
  type ShellSectionLayout,
  type ShellSidebarLayout,
  MAX_ID_LENGTH,
  MAX_RELATIVE_PATH_LENGTH,
  type FileRef,
  MAX_SEARCH_VIEW_STATES,
  EMPTY_SEARCH_HISTORY,
  type SearchEditorConfig,
  type SearchHistory,
  type SearchViewState,
} from '../preload/shell-channels';
import { MAX_CONTEXT_LINES, MAX_REPLACEMENT_LENGTH, MAX_SEARCH_GLOBS_LENGTH, MAX_SEARCH_HISTORY, MAX_SEARCH_PATTERN_LENGTH } from '../../shared/text-search';
import { SEARCH_DEFAULT_VIEW_MODES } from './desktop-configuration';
import { isRelativeFilePath } from '../../shared/relative-path';
import { MAX_RECENT_FILES, type PersistedEditor, type PersistedTab } from './editor-pane';
import {
  clampListWidth,
  DEFAULT_PERSISTED_TERMINALS,
  isTerminalColor,
  isTerminalCustomIcon,
  parsePaneSizes,
  parseTerminalName,
  type PersistedTerminal,
  type PersistedTerminalGroup,
  type PersistedTerminals,
} from './terminal/terminal-service';
import { MAX_TERMINAL_GROUP_PANES } from '../preload/terminal-channels';

// An absolute path saved for a tab outside every project.
const MAX_PATH_LENGTH = MAX_RELATIVE_PATH_LENGTH;

const SCHEMA_VERSION = 2;
export const WINDOW_LAYOUT_FILE = 'window-layout.json';

// AD7: the window fits the sidebar and every slot at their minimum sizes.
export const MIN_WINDOW_WIDTH = 900;
export const MIN_WINDOW_HEIGHT = 600;
export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 820;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// DIP, the window's normal (not maximized) bounds.
export interface WindowPlacement {
  readonly bounds: Rect;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

export interface WindowLayout {
  readonly window?: WindowPlacement;
  readonly sidebar: ShellLayout;
  readonly editor: PersistedEditor;
  readonly terminals: PersistedTerminals;
}

export const EMPTY_EDITOR: PersistedEditor = { tabs: [], active: null, recent: [] };
// A saved editor holds at most this many tabs; the rest are dropped on read.
const MAX_PERSISTED_TABS = 200;
// A saved terminal list holds at most this many terminals; the rest are dropped on read.
const MAX_PERSISTED_TERMINALS = 50;
// A profile id: pwsh, git-bash, wsl:<distro name>, a shell's file name.
const MAX_PROFILE_ID_LENGTH = 200;
const LOG_FILE_NAME = /^[A-Za-z0-9._-]{1,200}\.log$/;
const BACKUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const DEFAULT_SHELL_LAYOUT: ShellLayout = {
  sidebarVisible: true,
  sidebarWidth: 264,
  sections: { projects: { collapsed: false, size: 180 }, files: { collapsed: false, size: 230 }, search: { collapsed: true, size: 260 }, chats: { collapsed: false } },
  grid: DEFAULT_GRID_LAYOUT,
  search: {},
};

type Log = (line: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function parseSection(raw: unknown): ShellSectionLayout | undefined {
  if (!isRecord(raw)) return undefined;
  const collapsed = field(raw, 'collapsed');
  const size = field(raw, 'size');
  if (typeof collapsed !== 'boolean' || !inRange(size, MIN_SECTION_SIZE, MAX_SHELL_COORDINATE)) return undefined;
  return { collapsed, size };
}

function isGridPane(value: unknown): value is GridPane {
  return (GRID_PANES as readonly unknown[]).includes(value);
}

/** The grid's sash sizes from the shell or the file, or undefined unless both are in range. */
export function parseGridSizes(raw: unknown): ShellGridSizes | undefined {
  if (!isRecord(raw)) return undefined;
  const sideWidth = field(raw, 'sideWidth');
  const bottomHeight = field(raw, 'bottomHeight');
  if (!inRange(sideWidth, 0, MAX_SHELL_COORDINATE) || !inRange(bottomHeight, 0, MAX_SHELL_COORDINATE)) return undefined;
  return { sideWidth, bottomHeight };
}

/** A grid layout from the shell or the file, or undefined unless its slots are a permutation of the panes and every field is in range. */
export function parseGridLayout(raw: unknown): ShellGridLayout | undefined {
  if (!isRecord(raw)) return undefined;
  const slots = field(raw, 'slots');
  const visible = field(raw, 'visible');
  const maximized = field(raw, 'maximized');
  if (!isRecord(slots) || !isRecord(visible)) return undefined;
  const [main, side, bottom] = GRID_SLOTS.map((slot) => field(slots, slot));
  if (!isGridPane(main) || !isGridPane(side) || !isGridPane(bottom) || new Set([main, side, bottom]).size !== GRID_PANES.length) return undefined;
  const editor = field(visible, 'editor');
  const terminal = field(visible, 'terminal');
  if (typeof editor !== 'boolean' || typeof terminal !== 'boolean') return undefined;
  const sizes = parseGridSizes(raw);
  if (!sizes) return undefined;
  if (maximized !== null && !isGridPane(maximized)) return undefined;
  return { slots: { main, side, bottom }, visible: { editor, terminal }, ...sizes, maximized };
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

// One input's history: at most MAX_SEARCH_HISTORY strings of at most max characters each.
function parseHistoryList(raw: unknown, max: number): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_SEARCH_HISTORY) return undefined;
  return raw.every((entry) => boundedString(entry, max)) ? [...(raw as string[])] : undefined;
}

/** The inputs' history, or undefined when a list is not an array of bounded strings or holds more than MAX_SEARCH_HISTORY. */
export function parseSearchHistory(raw: unknown): SearchHistory | undefined {
  if (!isRecord(raw)) return undefined;
  const query = parseHistoryList(field(raw, 'query'), MAX_SEARCH_PATTERN_LENGTH);
  const replace = parseHistoryList(field(raw, 'replace'), MAX_REPLACEMENT_LENGTH);
  const include = parseHistoryList(field(raw, 'include'), MAX_SEARCH_GLOBS_LENGTH);
  const exclude = parseHistoryList(field(raw, 'exclude'), MAX_SEARCH_GLOBS_LENGTH);
  return query && replace && include && exclude ? { query, replace, include, exclude } : undefined;
}

// A boolean field a layout written before it existed lacks: its default then.
function optionalBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean | undefined {
  const value = field(raw, key);
  if (value === undefined) return fallback;
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * One project's Search view state, or undefined when any field is missing, of the wrong type or too long. A state written
 * before the open-editors toggle, Preserve Case, the details toggle, the view mode, the history and the replace text gets their defaults.
 */
export function parseSearchViewState(raw: unknown): SearchViewState | undefined {
  if (!isRecord(raw)) return undefined;
  const pattern = field(raw, 'pattern');
  const include = field(raw, 'include');
  const exclude = field(raw, 'exclude');
  const flags = (['isRegex', 'matchCase', 'wholeWord', 'useExcludeSettingsAndIgnoreFiles', 'replaceOpen'] as const).map((key) => field(raw, key));
  if (!boundedString(pattern, MAX_SEARCH_PATTERN_LENGTH) || !boundedString(include, MAX_SEARCH_GLOBS_LENGTH) || !boundedString(exclude, MAX_SEARCH_GLOBS_LENGTH)) return undefined;
  const [isRegex, matchCase, wholeWord, useExcludeSettingsAndIgnoreFiles, replaceOpen] = flags;
  if (typeof isRegex !== 'boolean' || typeof matchCase !== 'boolean' || typeof wholeWord !== 'boolean') return undefined;
  if (typeof useExcludeSettingsAndIgnoreFiles !== 'boolean' || typeof replaceOpen !== 'boolean') return undefined;
  const onlyOpenEditors = optionalBoolean(raw, 'onlyOpenEditors', false);
  const preserveCase = optionalBoolean(raw, 'preserveCase', false);
  const detailsOpen = optionalBoolean(raw, 'detailsOpen', false);
  const rawViewMode = field(raw, 'viewMode');
  const viewMode = rawViewMode === undefined ? 'list' : (SEARCH_DEFAULT_VIEW_MODES as readonly unknown[]).includes(rawViewMode) ? (rawViewMode as SearchViewState['viewMode']) : undefined;
  const rawHistory = field(raw, 'history');
  const history = rawHistory === undefined ? EMPTY_SEARCH_HISTORY : parseSearchHistory(rawHistory);
  const rawReplaceText = field(raw, 'replaceText');
  const replaceText = rawReplaceText === undefined ? '' : rawReplaceText;
  if (onlyOpenEditors === undefined || preserveCase === undefined || detailsOpen === undefined || viewMode === undefined || !history) return undefined;
  if (!boundedString(replaceText, MAX_REPLACEMENT_LENGTH)) return undefined;
  return { pattern, isRegex, matchCase, wholeWord, useExcludeSettingsAndIgnoreFiles, replaceOpen, include, exclude, onlyOpenEditors, preserveCase, detailsOpen, viewMode, history, replaceText };
}

/** A Search Editor's config from a renderer or a saved tab, or undefined unless every field is present, typed and in range. */
export function parseSearchEditorConfig(raw: unknown): SearchEditorConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const query = field(raw, 'query');
  const include = field(raw, 'include');
  const exclude = field(raw, 'exclude');
  const contextLines = field(raw, 'contextLines');
  const flags = (['isRegex', 'matchCase', 'wholeWord', 'useExcludeSettingsAndIgnoreFiles', 'onlyOpenEditors', 'showIncludesExcludes'] as const).map((key) => field(raw, key));
  if (!boundedString(query, MAX_SEARCH_PATTERN_LENGTH) || !boundedString(include, MAX_SEARCH_GLOBS_LENGTH) || !boundedString(exclude, MAX_SEARCH_GLOBS_LENGTH)) return undefined;
  if (typeof contextLines !== 'number' || !Number.isInteger(contextLines) || contextLines < 0 || contextLines > MAX_CONTEXT_LINES) return undefined;
  if (!flags.every((flag) => typeof flag === 'boolean')) return undefined;
  const [isRegex, matchCase, wholeWord, useExcludeSettingsAndIgnoreFiles, onlyOpenEditors, showIncludesExcludes] = flags as boolean[];
  return { query, isRegex: isRegex!, matchCase: matchCase!, wholeWord: wholeWord!, include, exclude, useExcludeSettingsAndIgnoreFiles: useExcludeSettingsAndIgnoreFiles!, onlyOpenEditors: onlyOpenEditors!, contextLines, showIncludesExcludes: showIncludesExcludes! };
}

// The Search states by project key: a malformed entry, or one past MAX_SEARCH_VIEW_STATES, is dropped.
function parseSearchViewStates(raw: unknown): Record<string, SearchViewState> | undefined {
  if (!isRecord(raw)) return undefined;
  const states: Record<string, SearchViewState> = {};
  for (const [key, value] of Object.entries(raw).slice(0, MAX_SEARCH_VIEW_STATES)) {
    const state = parseSearchViewState(value);
    if (key.length > 0 && key.length <= MAX_ID_LENGTH && state) states[key] = state;
  }
  return states;
}

/**
 * The sidebar's part of a layout from the shell or the file, or undefined when any field is missing, of the wrong type or
 * out of range. A layout written before the Search section gets its defaults.
 */
export function parseSidebarLayout(raw: unknown): ShellSidebarLayout | undefined {
  if (!isRecord(raw)) return undefined;
  const sidebarWidth = field(raw, 'sidebarWidth');
  const sections = field(raw, 'sections');
  if (!inRange(sidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SHELL_COORDINATE) || !isRecord(sections)) return undefined;
  const projects = parseSection(field(sections, 'projects'));
  const files = parseSection(field(sections, 'files'));
  const rawSearchSection = field(sections, 'search');
  const searchSection = rawSearchSection === undefined ? DEFAULT_SHELL_LAYOUT.sections.search : parseSection(rawSearchSection);
  const chats = field(sections, 'chats');
  const chatsCollapsed = isRecord(chats) ? field(chats, 'collapsed') : undefined;
  const rawSearch = field(raw, 'search');
  const search = rawSearch === undefined ? {} : parseSearchViewStates(rawSearch);
  if (!projects || !files || !searchSection || typeof chatsCollapsed !== 'boolean' || !search) return undefined;
  return { sidebarWidth, sections: { projects, files, search: searchSection, chats: { collapsed: chatsCollapsed } }, search };
}

/** A shell layout from the file, or undefined when any field is missing, of the wrong type or out of range. */
export function parseShellLayout(raw: unknown): ShellLayout | undefined {
  if (!isRecord(raw)) return undefined;
  const sidebarVisible = field(raw, 'sidebarVisible');
  const sidebar = parseSidebarLayout(raw);
  const grid = parseGridLayout(field(raw, 'grid'));
  if (typeof sidebarVisible !== 'boolean' || !sidebar || !grid) return undefined;
  return { sidebarVisible, ...sidebar, grid };
}

// A version 1 file holds the sidebar without Files and the grid, which start at their defaults.
function parseVersion1Sidebar(raw: unknown): ShellLayout | undefined {
  if (!isRecord(raw)) return undefined;
  const sections = field(raw, 'sections');
  if (!isRecord(sections)) return undefined;
  const defaults = DEFAULT_SHELL_LAYOUT;
  return parseShellLayout({ ...raw, sections: { ...sections, files: defaults.sections.files }, grid: defaults.grid });
}

function parsePlacement(raw: unknown): WindowPlacement | undefined {
  if (!isRecord(raw)) return undefined;
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key) => field(raw, key));
  const maximized = field(raw, 'maximized');
  const fullScreen = field(raw, 'fullScreen');
  if (!inRange(x, -MAX_SHELL_COORDINATE, MAX_SHELL_COORDINATE) || !inRange(y, -MAX_SHELL_COORDINATE, MAX_SHELL_COORDINATE)) return undefined;
  if (!inRange(width, MIN_WINDOW_WIDTH, MAX_SHELL_COORDINATE) || !inRange(height, MIN_WINDOW_HEIGHT, MAX_SHELL_COORDINATE)) return undefined;
  if (typeof maximized !== 'boolean' || typeof fullScreen !== 'boolean') return undefined;
  return { bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }, maximized, fullScreen };
}

function parseFileRef(raw: unknown): FileRef | undefined {
  if (!isRecord(raw)) return undefined;
  const projectKey = field(raw, 'projectKey');
  const relativePath = field(raw, 'relativePath');
  return typeof projectKey === 'string' && projectKey.length > 0 && projectKey.length <= MAX_ID_LENGTH && isRelativeFilePath(relativePath)
    ? { projectKey, relativePath }
    : undefined;
}

function parseBackupId(raw: unknown): { ok: boolean; backupId?: string } {
  if (raw === undefined) return { ok: true };
  return typeof raw === 'string' && BACKUP_ID.test(raw) ? { ok: true, backupId: raw } : { ok: false };
}

/** One saved tab, or undefined when any field is missing or malformed; an absolute path is only ever reopened read-only. */
export function parsePersistedTab(raw: unknown): PersistedTab | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = field(raw, 'kind');
  const backup = parseBackupId(field(raw, 'backupId'));
  if (!backup.ok) return undefined;
  const withBackup = backup.backupId !== undefined ? { backupId: backup.backupId } : {};
  if (kind === 'log') {
    const name = field(raw, 'name');
    return typeof name === 'string' && LOG_FILE_NAME.test(name) ? { kind, name } : undefined;
  }
  if (kind === 'untitled') return backup.backupId !== undefined ? { kind, backupId: backup.backupId } : undefined;
  if (kind === 'searchEditor') {
    const file = field(raw, 'file');
    if (file !== undefined) {
      const ref = parseFileRef(file);
      return ref ? { kind, file: ref, ...withBackup } : undefined;
    }
    const projectKey = field(raw, 'projectKey');
    const config = parseSearchEditorConfig(field(raw, 'config'));
    if (!config || (projectKey !== undefined && (typeof projectKey !== 'string' || projectKey.length === 0 || projectKey.length > MAX_ID_LENGTH))) return undefined;
    return { kind, ...(projectKey !== undefined ? { projectKey: projectKey as string } : {}), config, ...withBackup };
  }
  if (kind === 'settings') {
    const scope = field(raw, 'scope');
    return scope === 'user' || scope === 'project' || scope === 'local' ? { kind, scope, ...withBackup } : undefined;
  }
  if (kind !== 'code' && kind !== 'markdownPreview' && kind !== 'image' && kind !== 'notDisplayed') return undefined;
  const file = field(raw, 'file');
  if (file !== undefined) {
    const ref = parseFileRef(file);
    return ref ? { kind, file: ref, ...withBackup } : undefined;
  }
  const filePath = field(raw, 'path');
  return typeof filePath === 'string' && filePath.length <= MAX_PATH_LENGTH && path.isAbsolute(filePath) && !filePath.includes('\0') && backup.backupId === undefined
    ? { kind, path: filePath }
    : undefined;
}

/** The saved editor: each malformed tab or recent file is dropped and logged, the rest kept. */
export function parsePersistedEditor(raw: unknown, log: Log): PersistedEditor {
  if (!isRecord(raw)) {
    log('[layout] dropping a malformed editor');
    return EMPTY_EDITOR;
  }
  const rawTabs = field(raw, 'tabs');
  const rawRecent = field(raw, 'recent');
  const rawActive = field(raw, 'active');
  const tabs: PersistedTab[] = [];
  let active: number | null = null;
  (Array.isArray(rawTabs) ? (rawTabs as unknown[]) : []).slice(0, MAX_PERSISTED_TABS).forEach((rawTab, index) => {
    const tab = parsePersistedTab(rawTab);
    if (!tab) {
      log('[layout] dropping a malformed editor tab');
      return;
    }
    if (index === rawActive) active = tabs.length;
    tabs.push(tab);
  });
  const recent: FileRef[] = [];
  for (const entry of (Array.isArray(rawRecent) ? (rawRecent as unknown[]) : []).slice(0, MAX_RECENT_FILES)) {
    const ref = parseFileRef(entry);
    if (ref) recent.push(ref);
    else log('[layout] dropping a malformed recent file');
  }
  return { tabs, active, recent };
}

// A name, icon or color that main would not accept now is dropped and logged; the terminal itself is kept.
function parsePersistedTerminal(raw: unknown, log: Log): PersistedTerminal | undefined {
  if (!isRecord(raw)) return undefined;
  const profileId = field(raw, 'profileId');
  const projectKey = field(raw, 'projectKey');
  if (typeof profileId !== 'string' || profileId.length === 0 || profileId.length > MAX_PROFILE_ID_LENGTH) return undefined;
  if (typeof projectKey !== 'string' || projectKey.length === 0 || projectKey.length > MAX_ID_LENGTH) return undefined;
  const rawName = field(raw, 'name') ?? null;
  const rawIcon = field(raw, 'customIcon') ?? null;
  const rawColor = field(raw, 'color') ?? null;
  const name = rawName === null ? null : parseTerminalName(rawName);
  const customIcon = rawIcon === null || isTerminalCustomIcon(rawIcon) ? rawIcon : undefined;
  const color = rawColor === null || isTerminalColor(rawColor) ? rawColor : undefined;
  if (name === undefined) log('[layout] dropping the malformed name of a terminal');
  if (customIcon === undefined) log('[layout] dropping the unknown icon of a terminal');
  if (color === undefined) log('[layout] dropping the unknown color of a terminal');
  return { profileId, projectKey, name: name ?? null, customIcon: customIcon ?? null, color: color ?? null };
}

function parsePersistedGroup(raw: unknown): PersistedTerminalGroup | undefined {
  if (!isRecord(raw)) return undefined;
  const panes = field(raw, 'panes');
  const activePane = field(raw, 'activePane');
  const rawSizes = field(raw, 'sizes');
  if (typeof panes !== 'number' || !Number.isInteger(panes) || panes < 1 || panes > MAX_TERMINAL_GROUP_PANES) return undefined;
  if (typeof activePane !== 'number' || !Number.isInteger(activePane) || activePane < 0 || activePane >= panes) return undefined;
  const sizes = Array.isArray(rawSizes) ? parsePaneSizes(rawSizes as unknown[], panes) : undefined;
  return sizes && { panes, activePane, sizes };
}

const singleGroups = (count: number): PersistedTerminalGroup[] => Array.from({ length: count }, () => ({ panes: 1, activePane: 0, sizes: [1] }));

// The groups only as saved alongside exactly these terminals; anything else gives each terminal its own group. A list saved
// before split groups existed has none and needs no log line.
function parsePersistedGroups(raw: unknown, terminals: number, droppedTerminal: boolean, log: Log): PersistedTerminalGroup[] {
  if (raw === undefined) return singleGroups(terminals);
  const groups = Array.isArray(raw) ? (raw as unknown[]).map(parsePersistedGroup) : [];
  const valid = groups.every((group): group is PersistedTerminalGroup => group !== undefined);
  if (!droppedTerminal && Array.isArray(raw) && valid && groups.reduce((sum, group) => sum + group.panes, 0) === terminals) return groups;
  log('[layout] the saved terminal groups do not fit the terminal list; giving each terminal its own group');
  return singleGroups(terminals);
}

/**
 * The saved terminal list: each malformed terminal is dropped and logged, an out-of-range list width clamped, and groups that
 * do not fit the list replaced by one group per terminal.
 */
export function parsePersistedTerminals(raw: unknown, log: Log): PersistedTerminals {
  if (!isRecord(raw)) {
    log('[layout] dropping a malformed terminal list');
    return DEFAULT_PERSISTED_TERMINALS;
  }
  const rawTerminals = field(raw, 'terminals');
  const rawActive = field(raw, 'active');
  const rawWidth = field(raw, 'listWidthRem');
  const terminals: PersistedTerminal[] = [];
  let active: number | null = null;
  (Array.isArray(rawTerminals) ? (rawTerminals as unknown[]) : []).slice(0, MAX_PERSISTED_TERMINALS).forEach((rawTerminal, index) => {
    const terminal = parsePersistedTerminal(rawTerminal, log);
    if (!terminal) {
      log('[layout] dropping a malformed terminal');
      return;
    }
    if (index === rawActive) active = terminals.length;
    terminals.push(terminal);
  });
  const listWidthRem = typeof rawWidth === 'number' && Number.isFinite(rawWidth) ? clampListWidth(rawWidth) : DEFAULT_PERSISTED_TERMINALS.listWidthRem;
  const kept = Array.isArray(rawTerminals) ? Math.min(rawTerminals.length, MAX_PERSISTED_TERMINALS) : 0;
  const groups = parsePersistedGroups(field(raw, 'groups'), terminals.length, terminals.length !== kept, log);
  return { terminals, active, listWidthRem, groups };
}

export function parseWindowLayout(text: string, log: Log): WindowLayout {
  const parsed: unknown = JSON.parse(text);
  const version = isRecord(parsed) ? field(parsed, 'version') : undefined;
  if (!isRecord(parsed) || (version !== SCHEMA_VERSION && version !== 1)) {
    log(`[layout] ignoring ${WINDOW_LAYOUT_FILE}: unknown schema`);
    return { sidebar: DEFAULT_SHELL_LAYOUT, editor: EMPTY_EDITOR, terminals: DEFAULT_PERSISTED_TERMINALS };
  }
  const rawWindow = field(parsed, 'window');
  const placement = rawWindow === undefined ? undefined : parsePlacement(rawWindow);
  if (rawWindow !== undefined && !placement) log('[layout] dropping malformed window bounds');
  const rawSidebar = field(parsed, 'sidebar');
  const sidebar = rawSidebar === undefined ? undefined : version === 1 ? parseVersion1Sidebar(rawSidebar) : parseShellLayout(rawSidebar);
  if (rawSidebar !== undefined && !sidebar) log('[layout] dropping a malformed sidebar layout');
  const rawEditor = field(parsed, 'editor');
  const editor = rawEditor === undefined ? EMPTY_EDITOR : parsePersistedEditor(rawEditor, log);
  const rawTerminals = field(parsed, 'terminals');
  const terminals = rawTerminals === undefined ? DEFAULT_PERSISTED_TERMINALS : parsePersistedTerminals(rawTerminals, log);
  return { ...(placement ? { window: placement } : {}), sidebar: sidebar ?? DEFAULT_SHELL_LAYOUT, editor, terminals };
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function centerDistance(a: Rect, b: Rect): number {
  return Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
}

/**
 * Bounds that lie on a display: kept on the work area they overlap most, else moved onto the nearest one. The window
 * shrinks to fit that work area, but never below the window minimum.
 */
export function clampToWorkAreas(bounds: Rect, workAreas: readonly Rect[]): Rect {
  if (workAreas.length === 0) return bounds;
  const target = workAreas.reduce((best, area) => {
    const overlap = overlapArea(bounds, area) - overlapArea(bounds, best);
    if (overlap !== 0) return overlap > 0 ? area : best;
    return centerDistance(bounds, area) < centerDistance(bounds, best) ? area : best;
  });
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(bounds.width, target.width));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(bounds.height, target.height));
  const x = Math.max(target.x, Math.min(bounds.x, target.x + target.width - width));
  const y = Math.max(target.y, Math.min(bounds.y, target.y + target.height - height));
  return { x, y, width, height };
}

// The window's placement, the sidebar layout, the grid, the open editors, the terminal list and the Search states under
// userData; a relaunch restores them.
export class WindowLayoutStore {
  private readonly filePath: string;
  private placement: WindowPlacement | undefined;
  private sidebarLayout: ShellLayout = DEFAULT_SHELL_LAYOUT;
  private editorLayout: PersistedEditor = EMPTY_EDITOR;
  private terminalLayout: PersistedTerminals = DEFAULT_PERSISTED_TERMINALS;
  private sealed = false;
  private readonly log: Log;

  constructor(userDataDir: string, log: Log) {
    this.filePath = path.join(userDataDir, WINDOW_LAYOUT_FILE);
    this.log = log;
    let text: string | undefined;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text === undefined) return;
    try {
      const parsed = parseWindowLayout(text, log);
      this.placement = parsed.window;
      this.sidebarLayout = parsed.sidebar;
      this.editorLayout = parsed.editor;
      this.terminalLayout = parsed.terminals;
    } catch (err) {
      log(`[layout] ignoring unreadable ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  window(): WindowPlacement | undefined {
    return this.placement;
  }

  /**
   * A closing window, a quit's included, seals the store, as VS Code saves its window state on onBeforeShutdown and a
   * closing window does not rewrite it: until unseal, nothing changes in memory or on disk.
   */
  seal(): void {
    this.sealed = true;
  }

  // A window opened again after a close.
  unseal(): void {
    this.sealed = false;
  }

  sidebar(): ShellLayout {
    return this.sidebarLayout;
  }

  setWindow(placement: WindowPlacement): void {
    if (this.sealed) return;
    const current = this.placement;
    if (current && JSON.stringify(current) === JSON.stringify(placement)) return;
    this.placement = placement;
    this.persist();
  }

  editor(): PersistedEditor {
    return this.editorLayout;
  }

  setEditor(editor: PersistedEditor): void {
    if (this.sealed || JSON.stringify(this.editorLayout) === JSON.stringify(editor)) return;
    this.editorLayout = editor;
    this.persist();
  }

  terminals(): PersistedTerminals {
    return this.terminalLayout;
  }

  setTerminals(terminals: PersistedTerminals): void {
    if (this.sealed || JSON.stringify(this.terminalLayout) === JSON.stringify(terminals)) return;
    this.terminalLayout = terminals;
    this.persist();
  }

  setSidebar(layout: ShellLayout): void {
    if (this.sealed || JSON.stringify(this.sidebarLayout) === JSON.stringify(layout)) return;
    this.sidebarLayout = layout;
    this.persist();
  }

  // Clear Search History: every project's inputs forget what they held, as VS Code's clears the workspace's.
  clearSearchHistory(): void {
    const search = Object.fromEntries(Object.entries(this.sidebarLayout.search).map(([key, state]) => [key, { ...state, history: EMPTY_SEARCH_HISTORY }]));
    this.setSidebar({ ...this.sidebarLayout, search });
  }

  // Restore default layout: the window placement, sidebar and grid back to their defaults; the open editors, the terminals
  // and each project's Search query stay.
  reset(): void {
    if (this.sealed) return;
    this.placement = undefined;
    this.sidebarLayout = { ...DEFAULT_SHELL_LAYOUT, search: this.sidebarLayout.search };
    this.persist();
  }

  // A launch with damocles.desktop.restoreLayout off: the default layout, no saved editors, terminals or Search queries.
  clear(): void {
    if (this.sealed) return;
    this.editorLayout = EMPTY_EDITOR;
    this.terminalLayout = DEFAULT_PERSISTED_TERMINALS;
    this.placement = undefined;
    this.sidebarLayout = DEFAULT_SHELL_LAYOUT;
    this.persist();
  }

  /** Settles once every write to the file, one queued meanwhile included, has landed or failed; a quit awaits it. */
  flush(): Promise<void> {
    return jsonConfigWritesSettled(this.filePath);
  }

  private persist(): void {
    const placement = this.placement;
    const snapshot = {
      version: SCHEMA_VERSION,
      ...(placement ? { window: { ...placement.bounds, maximized: placement.maximized, fullScreen: placement.fullScreen } } : {}),
      sidebar: this.sidebarLayout,
      editor: this.editorLayout,
      terminals: this.terminalLayout,
    };
    void writeJsonConfig(this.filePath, () => `${JSON.stringify(snapshot, null, 2)}\n`).catch((err: unknown) => {
      this.log(`[layout] failed to write ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
