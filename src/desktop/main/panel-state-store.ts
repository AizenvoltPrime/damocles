import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonConfig } from '../../core/config/json-config-write';
import { MAX_PANE_URL_LENGTH, MAX_PANE_WIDTH } from '../preload/pane-channels';
import { MAX_ID_LENGTH } from '../preload/shell-channels';

const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
export const PANEL_STATE_FILE = 'panels.json';

// A chat's browser pane: whether it is open or maximized, its pages' addresses in pane order and the active one.
export interface PersistedPane {
  readonly open: boolean;
  readonly maximized: boolean;
  readonly pages: readonly string[];
  // index into pages
  readonly activePage?: number;
}

export const EMPTY_PANE: PersistedPane = { open: false, maximized: false, pages: [] };

// A loaded chat; its browser pages live in its pane.
export interface PersistedChat {
  readonly panelId: string;
  readonly state: unknown;
  readonly pane: PersistedPane;
}

// The selected project and, within it, the selected chat: its loaded panel and the session file it is bound to.
export interface PersistedSelection {
  readonly projectKey: string;
  readonly sessionId?: string;
  readonly panelId?: string;
}

const PANEL_ID = /^[A-Za-z0-9-]+$/;

interface ParsedPanels {
  readonly chats: PersistedChat[];
  readonly selected: PersistedSelection | undefined;
  readonly paneWidth: number | undefined;
}

const EMPTY: ParsedPanels = { chats: [], selected: undefined, paneWidth: undefined };

type Log = (line: string) => void;

export function isPaneWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PANE_WIDTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function parsePages(rawPages: unknown, rawActive: unknown, panelId: string, log: Log): { pages: string[]; activePage?: number } {
  if (rawPages === undefined) return { pages: [] };
  if (!Array.isArray(rawPages)) {
    log(`[panels] chat ${panelId}: dropping malformed browser pages`);
    return { pages: [] };
  }
  const pages: string[] = [];
  let activePage: number | undefined;
  for (const [index, url] of (rawPages as unknown[]).entries()) {
    if (typeof url !== 'string' || url.length === 0 || url.length > MAX_PANE_URL_LENGTH) {
      log(`[panels] chat ${panelId}: dropping a browser page with a malformed address`);
      continue;
    }
    if (index === rawActive) activePage = pages.length;
    pages.push(url);
  }
  return { pages, ...(activePage !== undefined ? { activePage } : {}) };
}

function chatEntry(panelId: string, state: unknown, open: unknown, maximized: unknown, pages: { pages: string[]; activePage?: number }): PersistedChat {
  return { panelId, state: state ?? null, pane: { open: open === true, maximized: maximized === true, ...pages } };
}

function parsePanelId(entry: Record<string, unknown>, log: Log): string | undefined {
  const panelId = field(entry, 'panelId');
  if (typeof panelId === 'string' && PANEL_ID.test(panelId) && panelId.length <= MAX_ID_LENGTH) return panelId;
  log('[panels] dropping a chat with a malformed panel id');
  return undefined;
}

// The webview state is a plain object (session id, folder key) or null.
function parseState(raw: unknown, panelId: string, log: Log): unknown {
  if (raw === undefined || raw === null || isRecord(raw)) return raw ?? null;
  log(`[panels] chat ${panelId}: dropping a malformed webview state`);
  return null;
}

function stateString(state: unknown, key: string): string | undefined {
  if (!isRecord(state)) return undefined;
  const value = field(state, key);
  return isKey(value) ? value : undefined;
}

function parseSelection(raw: unknown, chats: readonly PersistedChat[], log: Log): PersistedSelection | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !isKey(field(raw, 'projectKey'))) {
    log('[panels] ignoring a malformed selection');
    return undefined;
  }
  const sessionId = field(raw, 'sessionId');
  const panelId = field(raw, 'panelId');
  if (sessionId !== undefined && !isKey(sessionId)) log('[panels] ignoring a malformed selected session id');
  if (panelId !== undefined && !(isKey(panelId) && chats.some((chat) => chat.panelId === panelId))) log('[panels] ignoring a selected chat that is not saved');
  return {
    projectKey: field(raw, 'projectKey') as string,
    ...(isKey(sessionId) ? { sessionId } : {}),
    ...(isKey(panelId) && chats.some((chat) => chat.panelId === panelId) ? { panelId } : {}),
  };
}

function parseV2(file: Record<string, unknown>, log: Log): ParsedPanels {
  const rawChats = field(file, 'chats');
  if (!Array.isArray(rawChats)) {
    log(`[panels] ignoring ${PANEL_STATE_FILE}: no chat list`);
    return EMPTY;
  }
  const chats: PersistedChat[] = [];
  for (const entry of rawChats as unknown[]) {
    if (!isRecord(entry)) {
      log('[panels] dropping a malformed chat');
      continue;
    }
    const panelId = parsePanelId(entry, log);
    if (panelId === undefined || chats.some((chat) => chat.panelId === panelId)) continue;
    const pages = parsePages(field(entry, 'pages'), field(entry, 'activePage'), panelId, log);
    chats.push(chatEntry(panelId, parseState(field(entry, 'state'), panelId, log), field(entry, 'paneOpen'), field(entry, 'paneMaximized'), pages));
  }
  return { chats, selected: parseSelection(field(file, 'selected'), chats, log), paneWidth: parsePaneWidth(file, log) };
}

// v1 held chat tabs in strip order and the selected tab; tabs become chats and the selected tab the selected chat.
function parseV1(file: Record<string, unknown>, log: Log): ParsedPanels {
  const rawPanels = field(file, 'panels');
  if (!Array.isArray(rawPanels)) {
    log(`[panels] ignoring ${PANEL_STATE_FILE}: no tab list`);
    return EMPTY;
  }
  const chats: PersistedChat[] = [];
  for (const entry of rawPanels as unknown[]) {
    if (!isRecord(entry)) {
      log('[panels] dropping a malformed tab');
      continue;
    }
    const panelId = parsePanelId(entry, log);
    if (panelId === undefined || chats.some((chat) => chat.panelId === panelId)) continue;
    if (field(entry, 'kind') !== 'chat') {
      log(`[panels] dropping tab ${panelId}: not a chat tab`);
      continue;
    }
    const pane = field(entry, 'pane');
    const paneRecord = isRecord(pane) ? pane : {};
    if (pane !== undefined && !isRecord(pane)) log(`[panels] chat ${panelId}: dropping a malformed browser pane`);
    const pages = parsePages(field(paneRecord, 'pages'), field(paneRecord, 'activePage'), panelId, log);
    chats.push(chatEntry(panelId, parseState(field(entry, 'state'), panelId, log), field(paneRecord, 'open'), field(paneRecord, 'maximized'), pages));
  }
  const selectedId = field(file, 'selectedPanelId');
  const selectedChat = chats.find((chat) => chat.panelId === selectedId);
  const projectKey = stateString(selectedChat?.state, 'workspaceFolderKey');
  const sessionId = stateString(selectedChat?.state, 'sessionId');
  const selected: PersistedSelection | undefined = selectedChat && projectKey !== undefined
    ? { projectKey, panelId: selectedChat.panelId, ...(sessionId !== undefined ? { sessionId } : {}) }
    : undefined;
  log(`[panels] migrated ${PANEL_STATE_FILE} from version ${LEGACY_SCHEMA_VERSION} (${chats.length} chats)`);
  return { chats, selected, paneWidth: parsePaneWidth(file, log) };
}

function parsePaneWidth(file: Record<string, unknown>, log: Log): number | undefined {
  const width = field(file, 'paneWidth');
  if (width === undefined) return undefined;
  if (isPaneWidth(width)) return width;
  log('[panels] ignoring a malformed browser pane width');
  return undefined;
}

export function parsePanels(text: string, log: Log): ParsedPanels {
  const parsed: unknown = JSON.parse(text);
  const version = isRecord(parsed) ? field(parsed, 'version') : undefined;
  if (isRecord(parsed) && version === SCHEMA_VERSION) return parseV2(parsed, log);
  if (isRecord(parsed) && version === LEGACY_SCHEMA_VERSION) return parseV1(parsed, log);
  log(`[panels] ignoring ${PANEL_STATE_FILE}: unknown schema`);
  return EMPTY;
}

// Loaded chats with each one's webview state and browser pane, the selection and the pane width shared by every chat,
// under userData; a relaunch restores them.
export class PanelStateStore {
  private readonly filePath: string;
  private readonly chats = new Map<string, PersistedChat>();
  private selection: PersistedSelection | undefined;
  private width: number | undefined;
  private readonly log: Log;

  constructor(userDataDir: string, log: Log) {
    this.filePath = path.join(userDataDir, PANEL_STATE_FILE);
    this.log = log;
    let text: string | undefined;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text === undefined) return;
    try {
      const parsed = parsePanels(text, log);
      for (const chat of parsed.chats) this.chats.set(chat.panelId, chat);
      this.selection = parsed.selected;
      this.width = parsed.paneWidth;
    } catch (err) {
      log(`[panels] ignoring unreadable ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  list(): readonly PersistedChat[] {
    return [...this.chats.values()];
  }

  get(panelId: string): PersistedChat | undefined {
    return this.chats.get(panelId);
  }

  selected(): PersistedSelection | undefined {
    return this.selection;
  }

  paneWidth(): number | undefined {
    return this.width;
  }

  // A new chat starts with an empty pane; an existing one keeps its pane.
  set(chat: { readonly panelId: string; readonly state: unknown }): void {
    this.chats.set(chat.panelId, { panelId: chat.panelId, state: chat.state, pane: this.chats.get(chat.panelId)?.pane ?? EMPTY_PANE });
    this.persist();
  }

  // Ignored for a chat the store does not hold.
  setPane(panelId: string, pane: PersistedPane): void {
    const chat = this.chats.get(panelId);
    if (!chat) return;
    this.chats.set(panelId, { ...chat, pane });
    this.persist();
  }

  setPaneWidth(width: number): void {
    if (!isPaneWidth(width) || width === this.width) return;
    this.width = width;
    this.persist();
  }

  delete(panelId: string): void {
    if (!this.chats.delete(panelId)) return;
    if (this.selection?.panelId === panelId) {
      const { projectKey, sessionId } = this.selection;
      this.selection = { projectKey, ...(sessionId !== undefined ? { sessionId } : {}) };
    }
    this.persist();
  }

  select(selection: PersistedSelection): void {
    const current = this.selection;
    if (current?.projectKey === selection.projectKey && current.sessionId === selection.sessionId && current.panelId === selection.panelId) return;
    this.selection = {
      projectKey: selection.projectKey,
      ...(selection.sessionId !== undefined ? { sessionId: selection.sessionId } : {}),
      ...(selection.panelId !== undefined ? { panelId: selection.panelId } : {}),
    };
    this.persist();
  }

  private persist(): void {
    const snapshot = {
      version: SCHEMA_VERSION,
      ...(this.selection !== undefined ? { selected: this.selection } : {}),
      chats: this.list().map((chat) => ({
        panelId: chat.panelId,
        state: chat.state,
        pages: chat.pane.pages,
        ...(chat.pane.activePage !== undefined ? { activePage: chat.pane.activePage } : {}),
        paneOpen: chat.pane.open,
        paneMaximized: chat.pane.maximized,
      })),
      ...(this.width !== undefined ? { paneWidth: this.width } : {}),
    };
    writeJsonConfig(this.filePath, () => `${JSON.stringify(snapshot, null, 2)}\n`).catch((err: unknown) => {
      this.log(`[panels] failed to write ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
