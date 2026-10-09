import * as fs from 'node:fs';
import * as path from 'node:path';
import { jsonConfigWritesSettled, writeJsonConfig } from '../../core/config/json-config-write';
import { MAX_BROWSER_URL_LENGTH } from '../../shared/typed-address';
import { MAX_ID_LENGTH } from '../preload/shell-channels';

const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
export const PANEL_STATE_FILE = 'panels.json';

// A chat's browser pages: their addresses in tab order and the one its tabs show first.
export interface PersistedPages {
  readonly pages: readonly string[];
  // index into pages
  readonly activePage?: number;
}

export const NO_PAGES: PersistedPages = { pages: [] };

// A loaded chat and its browser pages.
export interface PersistedChat {
  readonly panelId: string;
  readonly state: unknown;
  readonly browser: PersistedPages;
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
}

const EMPTY: ParsedPanels = { chats: [], selected: undefined };

type Log = (line: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function parsePages(rawPages: unknown, rawActive: unknown, panelId: string, log: Log): PersistedPages {
  if (rawPages === undefined) return { pages: [] };
  if (!Array.isArray(rawPages)) {
    log(`[panels] chat ${panelId}: dropping malformed browser pages`);
    return { pages: [] };
  }
  const pages: string[] = [];
  let activePage: number | undefined;
  for (const [index, url] of (rawPages as unknown[]).entries()) {
    if (typeof url !== 'string' || url.length === 0 || url.length > MAX_BROWSER_URL_LENGTH) {
      log(`[panels] chat ${panelId}: dropping a browser page with a malformed address`);
      continue;
    }
    if (index === rawActive) activePage = pages.length;
    pages.push(url);
  }
  return { pages, ...(activePage !== undefined ? { activePage } : {}) };
}

function chatEntry(panelId: string, state: unknown, browser: PersistedPages): PersistedChat {
  return { panelId, state: state ?? null, browser };
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
    chats.push(chatEntry(panelId, parseState(field(entry, 'state'), panelId, log), pages));
  }
  return { chats, selected: parseSelection(field(file, 'selected'), chats, log) };
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
    chats.push(chatEntry(panelId, parseState(field(entry, 'state'), panelId, log), pages));
  }
  const selectedId = field(file, 'selectedPanelId');
  const selectedChat = chats.find((chat) => chat.panelId === selectedId);
  const projectKey = stateString(selectedChat?.state, 'workspaceFolderKey');
  const sessionId = stateString(selectedChat?.state, 'sessionId');
  const selected: PersistedSelection | undefined = selectedChat && projectKey !== undefined
    ? { projectKey, panelId: selectedChat.panelId, ...(sessionId !== undefined ? { sessionId } : {}) }
    : undefined;
  log(`[panels] migrated ${PANEL_STATE_FILE} from version ${LEGACY_SCHEMA_VERSION} (${chats.length} chats)`);
  return { chats, selected };
}

export function parsePanels(text: string, log: Log): ParsedPanels {
  const parsed: unknown = JSON.parse(text);
  const version = isRecord(parsed) ? field(parsed, 'version') : undefined;
  if (isRecord(parsed) && version === SCHEMA_VERSION) return parseV2(parsed, log);
  if (isRecord(parsed) && version === LEGACY_SCHEMA_VERSION) return parseV1(parsed, log);
  log(`[panels] ignoring ${PANEL_STATE_FILE}: unknown schema`);
  return EMPTY;
}

// Loaded chats with each one's webview state and browser pages, and the selection, under userData; a relaunch restores them.
export class PanelStateStore {
  private readonly filePath: string;
  private readonly chats = new Map<string, PersistedChat>();
  private selection: PersistedSelection | undefined;
  private sealed = false;
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

  // A new chat starts with no pages; an existing one keeps its pages.
  set(chat: { readonly panelId: string; readonly state: unknown }): void {
    if (this.sealed) return;
    this.chats.set(chat.panelId, { panelId: chat.panelId, state: chat.state, browser: this.chats.get(chat.panelId)?.browser ?? NO_PAGES });
    this.persist();
  }

  // Ignored for a chat the store does not hold.
  setPages(panelId: string, browser: PersistedPages): void {
    if (this.sealed) return;
    const chat = this.chats.get(panelId);
    if (!chat) return;
    this.chats.set(panelId, { ...chat, browser });
    this.persist();
  }

  delete(panelId: string): void {
    if (this.sealed || !this.chats.delete(panelId)) return;
    if (this.selection?.panelId === panelId) {
      const { projectKey, sessionId } = this.selection;
      this.selection = { projectKey, ...(sessionId !== undefined ? { sessionId } : {}) };
    }
    this.persist();
  }

  select(selection: PersistedSelection): void {
    if (this.sealed) return;
    const current = this.selection;
    if (current?.projectKey === selection.projectKey && current.sessionId === selection.sessionId && current.panelId === selection.panelId) return;
    this.selection = {
      projectKey: selection.projectKey,
      ...(selection.sessionId !== undefined ? { sessionId: selection.sessionId } : {}),
      ...(selection.panelId !== undefined ? { panelId: selection.panelId } : {}),
    };
    this.persist();
  }

  /** Settles once every write to the file, one queued meanwhile included, has landed or failed; a quit awaits it. */
  flush(): Promise<void> {
    return jsonConfigWritesSettled(this.filePath);
  }

  private persist(): void {
    const snapshot = {
      version: SCHEMA_VERSION,
      ...(this.selection !== undefined ? { selected: this.selection } : {}),
      chats: this.list().map((chat) => ({
        panelId: chat.panelId,
        state: chat.state,
        pages: chat.browser.pages,
        ...(chat.browser.activePage !== undefined ? { activePage: chat.browser.activePage } : {}),
      })),
    };
    void writeJsonConfig(this.filePath, () => `${JSON.stringify(snapshot, null, 2)}\n`).catch((err: unknown) => {
      this.log(`[panels] failed to write ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
