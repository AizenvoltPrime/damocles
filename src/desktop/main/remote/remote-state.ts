import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { jsonConfigWritesSettled, writeJsonConfig } from '../../../core/config/json-config-write';
import { TERMINAL_ICONS, type TerminalColor, type TerminalCustomIcon, type TerminalIcon } from '../../preload/terminal-channels';
import { isTerminalId } from '../../pty-host/protocol';
import { isTerminalColor, isTerminalCustomIcon, parseTerminalName } from '../terminal/terminal-service';
import { isImageBlock, type UserContentBlock } from '../../../shared/types/content';
import { authorityKeyOfProject } from '../../../shared/project-location';

const SCHEMA_VERSION = 1;
export const REMOTE_STATE_FILE = 'remote-state.json';

// A terminal running on an authority's daemon, as main reattaches it after a relaunch: the daemon keeps the pty, main its tab.
export interface RemoteTerminalRecord {
  readonly id: string;
  readonly projectKey: string;
  readonly profile: { readonly id: string; readonly name: string; readonly file: string; readonly args: readonly string[]; readonly icon: TerminalIcon };
  readonly startCwd: string;
  // the shell-integration nonce in the terminal's environment, without which its OSC 633 sequences are not trusted
  readonly nonce: string;
  readonly name: string | null;
  readonly customIcon: TerminalCustomIcon | null;
  readonly color: TerminalColor | null;
}

// A chat open on an authority's core: its conversation and the page's panel token, which a rejoin names its view by. A new chat
// with no conversation yet is kept only while it holds messages, and reopens new with them.
export interface RemoteChatRecord {
  readonly authority: string;
  readonly sessionId?: string;
  readonly panelToken: string;
}

// A chat whose turn was running when this app detached from its host, which the next attach tells about once it finished.
export interface AwayChat {
  // the core panel id the host's run registry names it by
  readonly panelId: string;
  readonly sessionId: string;
  readonly title: string;
}

interface AuthorityState {
  readonly terminals: readonly RemoteTerminalRecord[];
  readonly chats: readonly RemoteChatRecord[];
  readonly away: readonly AwayChat[];
  // the core epoch the away chats ran under: another one at the next attach means their core ended, which stopped them
  readonly awayEpoch: string | null;
  // the core epoch the chats were open under; the same epoch at the next attach rejoins them, another restores them
  readonly coreEpoch: string | null;
  // the stored chat last viewed in each of the authority's projects, one entry per project; no session once it is gone (LastChats)
  readonly lastChats: readonly RemoteSelection[];
}

// The selected project and chat when they are remote, which panels.json (read by older versions) never names; cleared when a
// local chat is selected.
export interface RemoteSelection {
  readonly projectKey: string;
  readonly sessionId?: string;
}

// A message a remote chat's page sent while its host was away: its text and images, and the conversation the page showed then.
// notSent: core refused it after the reconnect because the chat had moved to another conversation; it is never sent again.
export interface OfflineEntry {
  readonly id: string;
  readonly conversationId: string | null;
  readonly content: string | readonly UserContentBlock[];
  readonly status: 'queued' | 'notSent';
}

// One chat page's held messages, in the order it sent them, under the authority whose core they go to.
export interface QueuedPanel {
  readonly authority: string;
  readonly entries: readonly OfflineEntry[];
}

interface StateFile {
  readonly authorities: ReadonlyMap<string, AuthorityState>;
  readonly selected: RemoteSelection | undefined;
  // by panel token, which names the page across a fresh attach and a relaunch
  readonly offlineQueue: ReadonlyMap<string, QueuedPanel>;
}

const EMPTY_AUTHORITY: AuthorityState = { terminals: [], chats: [], away: [], awayEpoch: null, coreEpoch: null, lastChats: [] };
const isEmptyAuthority = (state: AuthorityState): boolean =>
  state.terminals.length === 0 && state.chats.length === 0 && state.away.length === 0 && state.awayEpoch === null && state.coreEpoch === null && state.lastChats.length === 0;
// a chat title as the run registry clamps it (MAX_RUN_TITLE_CHARS)
const MAX_AWAY_TITLE = 1024;

function parseAway(value: unknown): AwayChat | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const panelId = own(record, 'panelId');
  const sessionId = own(record, 'sessionId');
  const title = own(record, 'title');
  if (!isText(panelId) || panelId.length > 128 || !isText(sessionId) || sessionId.length > 256 || typeof title !== 'string' || title.length > MAX_AWAY_TITLE) return undefined;
  return { panelId, sessionId, title };
}
const PANEL_TOKEN = /^[0-9a-f-]{1,64}$/i;
/** A page's panel token as remote-state.json keeps it; a page supplies its own, so it is checked before anything is held. */
export const isPanelToken = (value: string): boolean => PANEL_TOKEN.test(value);
const CORE_EPOCH = /^[0-9a-f]{32}$/;

function parseChat(value: unknown, authority: string): RemoteChatRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const sessionId = own(record, 'sessionId');
  const panelToken = own(record, 'panelToken');
  if (own(record, 'authority') !== authority || typeof panelToken !== 'string' || !PANEL_TOKEN.test(panelToken)) return undefined;
  if (sessionId === undefined) return { authority, panelToken };
  if (!isText(sessionId) || sessionId.length > 256) return undefined;
  return { authority, sessionId, panelToken };
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);

function parseTerminal(value: unknown): RemoteTerminalRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const profile = own(record, 'profile');
  if (typeof profile !== 'object' || profile === null) return undefined;
  const p = profile as Record<string, unknown>;
  const args = own(p, 'args');
  const icon = own(p, 'icon');
  const name = own(record, 'name') === null ? null : parseTerminalName(own(record, 'name'));
  const customIcon = own(record, 'customIcon');
  const color = own(record, 'color');
  const fields = [own(record, 'id'), own(record, 'projectKey'), own(p, 'id'), own(p, 'name'), own(p, 'file'), own(record, 'startCwd'), own(record, 'nonce')];
  if (!isTerminalId(fields[0]) || !fields.every(isText) || !Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return undefined;
  if (!(TERMINAL_ICONS as readonly unknown[]).includes(icon) || name === undefined) return undefined;
  if (!(customIcon === null || isTerminalCustomIcon(customIcon)) || !(color === null || isTerminalColor(color))) return undefined;
  const [id, projectKey, profileId, profileName, file, startCwd, nonce] = fields as string[];
  return {
    id: id!, projectKey: projectKey!, startCwd: startCwd!, nonce: nonce!, name, customIcon, color,
    profile: { id: profileId!, name: profileName!, file: file!, args: args as string[], icon: icon as TerminalIcon },
  };
}

function parseSelection(value: unknown): RemoteSelection | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const projectKey = own(record, 'projectKey');
  const sessionId = own(record, 'sessionId');
  if (!isText(projectKey) || projectKey.length > 4096 || (sessionId !== undefined && !(isText(sessionId) && sessionId.length <= 256))) return undefined;
  return { projectKey, ...(sessionId !== undefined ? { sessionId: sessionId as string } : {}) };
}

function parseLastChats(value: unknown, authority: string): RemoteSelection[] {
  if (!Array.isArray(value)) return [];
  const entries: RemoteSelection[] = [];
  for (const entry of value) {
    const parsed = parseSelection(entry);
    if (parsed === undefined || authorityKeyOfProject(parsed.projectKey) !== authority || entries.some((kept) => kept.projectKey === parsed.projectKey)) continue;
    entries.push(parsed);
  }
  return entries;
}

const ENTRY_ID = /^[0-9a-f-]{36}$/i;

/** A message's content as a page or the file gives it: text, or text and image blocks with no other field; undefined otherwise. */
export function parseContent(value: unknown): string | UserContentBlock[] | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const blocks = value.flatMap((block: unknown): UserContentBlock[] => {
    if (isImageBlock(block)) return [{ type: 'image', source: { type: 'base64', media_type: block.source.media_type, data: block.source.data } }];
    const text = typeof block === 'object' && block !== null ? (block as { type?: unknown; text?: unknown }) : undefined;
    return text?.type === 'text' && typeof text.text === 'string' ? [{ type: 'text', text: text.text }] : [];
  });
  return blocks.length === value.length ? blocks : undefined;
}

function parseEntry(value: unknown): OfflineEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = own(record, 'id');
  const conversationId = own(record, 'conversationId');
  const status = own(record, 'status');
  const content = parseContent(own(record, 'content'));
  if (typeof id !== 'string' || !ENTRY_ID.test(id) || content === undefined || (status !== 'queued' && status !== 'notSent')) return undefined;
  if (conversationId !== null && !(isText(conversationId) && conversationId.length <= 256)) return undefined;
  return { id, conversationId, content, status };
}

function parseQueue(value: unknown): Map<string, QueuedPanel> {
  const queue = new Map<string, QueuedPanel>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return queue;
  for (const [panelToken, panel] of Object.entries(value)) {
    const record = typeof panel === 'object' && panel !== null ? panel as Record<string, unknown> : undefined;
    const authority = record ? own(record, 'authority') : undefined;
    const entries = record ? own(record, 'entries') : undefined;
    if (!PANEL_TOKEN.test(panelToken) || !isText(authority) || !Array.isArray(entries)) continue;
    const parsed = entries.flatMap((entry) => parseEntry(entry) ?? []);
    if (parsed.length > 0) queue.set(panelToken, { authority, entries: parsed });
  }
  return queue;
}

function parseStateFile(text: string): StateFile {
  const parsed = JSON.parse(text) as { version?: unknown; authorities?: unknown; selected?: unknown; offlineQueue?: unknown } | null;
  if (parsed?.version !== SCHEMA_VERSION || typeof parsed.authorities !== 'object' || parsed.authorities === null || Array.isArray(parsed.authorities)) {
    throw new Error('unknown schema');
  }
  const authorities = new Map<string, AuthorityState>();
  for (const [key, value] of Object.entries(parsed.authorities)) {
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
    const terminals = record ? own(record, 'terminals') : undefined;
    const chats = record ? own(record, 'chats') : undefined;
    const away = record ? own(record, 'away') : undefined;
    const coreEpoch = record ? own(record, 'coreEpoch') : undefined;
    const awayEpoch = record ? own(record, 'awayEpoch') : undefined;
    if (!isText(key) || record === undefined) continue;
    authorities.set(key, {
      terminals: Array.isArray(terminals) ? terminals.flatMap((entry) => parseTerminal(entry) ?? []) : [],
      chats: Array.isArray(chats) ? chats.flatMap((entry) => parseChat(entry, key) ?? []) : [],
      away: Array.isArray(away) ? away.flatMap((entry) => parseAway(entry) ?? []) : [],
      awayEpoch: typeof awayEpoch === 'string' && CORE_EPOCH.test(awayEpoch) ? awayEpoch : null,
      coreEpoch: typeof coreEpoch === 'string' && CORE_EPOCH.test(coreEpoch) ? coreEpoch : null,
      lastChats: parseLastChats(own(record, 'lastChats'), key),
    });
  }
  return { authorities, selected: parseSelection(parsed.selected), offlineQueue: parseQueue(parsed.offlineQueue) };
}

const EMPTY_FILE: StateFile = { authorities: new Map(), selected: undefined, offlineQueue: new Map() };

/**
 * What main keeps of remote work by authority, in remote-state.json, never in panels.json or window-layout.json, which an
 * older app version reads after a downgrade and would drop or misread it.
 */
export class RemoteState {
  readonly filePath: string;
  private file: StateFile;
  // a closing window seals the selection and the last chats, as panels.json's, so the chats closing under a quit never replace them
  private selectionSealed = false;
  // why the file did not parse at launch (a hand edit, a newer version's schema); while set, every write is refused
  private readonly readError: string | undefined;
  // the batch under way: the writes made inside it, which land as one write at its end
  private batching: { readonly applies: Array<(file: StateFile) => StateFile>; readonly written: Promise<void> } | undefined;

  private constructor(filePath: string, file: StateFile, readError?: string) {
    this.filePath = filePath;
    this.file = file;
    this.readError = readError;
  }

  /**
   * Reads the file; a missing one is empty. One that does not parse or names another schema holds nothing for the run and
   * refuses every write, so neither a typo nor a downgrade replaces the held messages and away chats it keeps.
   */
  static async open(userDataDir: string, log: (line: string) => void): Promise<RemoteState> {
    const filePath = path.join(userDataDir, REMOTE_STATE_FILE);
    let text: string | undefined;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text === undefined) return new RemoteState(filePath, EMPTY_FILE);
    try {
      return new RemoteState(filePath, parseStateFile(text));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`[remote-state] ${filePath} does not parse (${reason}); holding nothing from it and refusing every write`);
      return new RemoteState(filePath, EMPTY_FILE, reason);
    }
  }

  /** Why remote-state.json did not parse; undefined while it is read and written normally. */
  unreadable(): string | undefined {
    return this.readError;
  }

  terminals(authorityKey: string): readonly RemoteTerminalRecord[] {
    return this.file.authorities.get(authorityKey)?.terminals ?? [];
  }

  chats(authorityKey: string): readonly RemoteChatRecord[] {
    return this.file.authorities.get(authorityKey)?.chats ?? [];
  }

  coreEpoch(authorityKey: string): string | null {
    return this.file.authorities.get(authorityKey)?.coreEpoch ?? null;
  }

  /** The chats that were running when this app last detached from the authority. */
  away(authorityKey: string): readonly AwayChat[] {
    return this.file.authorities.get(authorityKey)?.away ?? [];
  }

  /** The core epoch the away chats ran under; null when unknown. */
  awayEpoch(authorityKey: string): string | null {
    return this.file.authorities.get(authorityKey)?.awayEpoch ?? null;
  }

  /** Replaces them: on a detach, the chats running then under coreEpoch; on the next attach's notice, none. */
  setAway(authorityKey: string, away: readonly AwayChat[], coreEpoch: string | null): Promise<void> {
    return this.change(authorityKey, { away: [...away], awayEpoch: away.length > 0 ? coreEpoch : null });
  }

  /** Every chat page's held messages, by panel token. */
  offlineQueue(): ReadonlyMap<string, QueuedPanel> {
    return this.file.offlineQueue;
  }

  /** Replaces one page's held messages; undefined or no entries removes them. */
  async setOfflineQueue(panelToken: string, panel: QueuedPanel | undefined): Promise<void> {
    if (!isPanelToken(panelToken)) throw new Error('A held message names its page by a panel token');
    return this.write((file) => {
      const offlineQueue = new Map(file.offlineQueue);
      if (panel && panel.entries.length > 0) offlineQueue.set(panelToken, panel);
      else offlineQueue.delete(panelToken);
      return { ...file, offlineQueue };
    });
  }

  /** The last selected project and chat when they were remote. */
  selected(): RemoteSelection | undefined {
    return this.file.selected;
  }

  /** Records the selection when it is remote, undefined when a local chat took it; nothing while sealed. */
  async select(selection: RemoteSelection | undefined): Promise<void> {
    const current = this.file.selected;
    if (this.selectionSealed || (current?.projectKey === selection?.projectKey && current?.sessionId === selection?.sessionId)) return;
    await this.write((file) => ({ ...file, selected: selection }));
  }

  /** The stored chat last viewed in each of the authority's projects. */
  lastChats(authorityKey: string): readonly RemoteSelection[] {
    return this.file.authorities.get(authorityKey)?.lastChats ?? [];
  }

  /** Replaces the authority's last chats; nothing while sealed. */
  async setLastChats(authorityKey: string, lastChats: readonly RemoteSelection[]): Promise<void> {
    if (this.selectionSealed) return;
    await this.change(authorityKey, { lastChats: lastChats.map(({ projectKey, sessionId }) => ({ projectKey, ...(sessionId !== undefined ? { sessionId } : {}) })) });
  }

  seal(): void {
    this.selectionSealed = true;
  }

  unseal(): void {
    this.selectionSealed = false;
  }

  /** Replaces the authority's terminals; memory follows only once the file says so. */
  setTerminals(authorityKey: string, terminals: readonly RemoteTerminalRecord[]): Promise<void> {
    return this.change(authorityKey, { terminals: [...terminals] });
  }

  /** Replaces the authority's open chats and the core epoch they are open under. */
  setChats(authorityKey: string, chats: readonly RemoteChatRecord[], coreEpoch: string | null): Promise<void> {
    return this.change(authorityKey, { chats: [...chats], coreEpoch });
  }

  /** Forget host: the authority's terminals, chats, away list and last chats, its pages' held messages, and a selection on it. */
  forgetAuthority(authorityKey: string): Promise<void> {
    return this.write((file) => {
      const authorities = new Map(file.authorities);
      authorities.delete(authorityKey);
      const offlineQueue = new Map([...file.offlineQueue].filter(([, panel]) => panel.authority !== authorityKey));
      const selected = file.selected !== undefined && authorityKeyOfProject(file.selected.projectKey) === authorityKey ? undefined : file.selected;
      return { authorities, offlineQueue, selected };
    });
  }

  // An authority holding nothing has no entry, so a write after Forget host leaves none behind.
  private change(authorityKey: string, patch: Partial<AuthorityState>): Promise<void> {
    return this.write((file) => {
      const authorities = new Map(file.authorities);
      const next = { ...(file.authorities.get(authorityKey) ?? EMPTY_AUTHORITY), ...patch };
      if (isEmptyAuthority(next)) authorities.delete(authorityKey);
      else authorities.set(authorityKey, next);
      return { ...file, authorities };
    });
  }

  /** Runs change, landing every write it makes as one write of the file; each of those writes settles with that one. */
  batch(change: () => void): void {
    if (this.batching) return change();
    let land: (written: Promise<void>) => void = () => undefined;
    const written = new Promise<void>((resolve) => {
      land = resolve;
    });
    const applies: Array<(file: StateFile) => StateFile> = [];
    this.batching = { applies, written };
    try {
      change();
    } finally {
      this.batching = undefined;
      land(applies.length > 0 ? this.write((file) => applies.reduce((next, apply) => apply(next), file)) : Promise.resolve());
    }
  }

  private async write(apply: (file: StateFile) => StateFile): Promise<void> {
    if (this.batching) {
      this.batching.applies.push(apply);
      return this.batching.written;
    }
    if (this.readError !== undefined) throw new Error(`${this.filePath} could not be read, so it is not changed: ${this.readError}`);
    let next = this.file;
    await writeJsonConfig(this.filePath, () => {
      next = apply(this.file);
      const offlineQueue = next.offlineQueue.size > 0 ? { offlineQueue: Object.fromEntries(next.offlineQueue) } : {};
      return `${JSON.stringify({ version: SCHEMA_VERSION, authorities: Object.fromEntries(next.authorities), ...(next.selected ? { selected: next.selected } : {}), ...offlineQueue }, null, 2)}\n`;
    });
    this.file = next;
  }

  /** Settles once every write to the file, one queued meanwhile included, has landed or failed; a quit awaits it. */
  flush(): Promise<void> {
    return jsonConfigWritesSettled(this.filePath);
  }
}
