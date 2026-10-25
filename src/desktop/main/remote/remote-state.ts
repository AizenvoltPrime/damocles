import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { jsonConfigWritesSettled, writeJsonConfig } from '../../../core/config/json-config-write';
import { TERMINAL_ICONS, type TerminalColor, type TerminalCustomIcon, type TerminalIcon } from '../../preload/terminal-channels';
import { isTerminalId } from '../../pty-host/protocol';
import { isTerminalColor, isTerminalCustomIcon, parseTerminalName } from '../terminal/terminal-service';

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

// A chat open on an authority's core: its conversation and the page's panel token, which a rejoin names its view by.
export interface RemoteChatRecord {
  readonly authority: string;
  readonly sessionId: string;
  readonly panelToken: string;
}

interface AuthorityState {
  readonly terminals: readonly RemoteTerminalRecord[];
  readonly chats: readonly RemoteChatRecord[];
  // the core epoch the chats were open under; the same epoch at the next attach rejoins them, another restores them
  readonly coreEpoch: string | null;
}

type StateFile = ReadonlyMap<string, AuthorityState>;

const EMPTY_AUTHORITY: AuthorityState = { terminals: [], chats: [], coreEpoch: null };
const PANEL_TOKEN = /^[0-9a-f-]{1,64}$/i;
const CORE_EPOCH = /^[0-9a-f]{32}$/;

function parseChat(value: unknown, authority: string): RemoteChatRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const sessionId = own(record, 'sessionId');
  const panelToken = own(record, 'panelToken');
  if (own(record, 'authority') !== authority || !isText(sessionId) || sessionId.length > 256 || typeof panelToken !== 'string' || !PANEL_TOKEN.test(panelToken)) return undefined;
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

function parseStateFile(text: string): StateFile {
  const parsed = JSON.parse(text) as { version?: unknown; authorities?: unknown } | null;
  if (parsed?.version !== SCHEMA_VERSION || typeof parsed.authorities !== 'object' || parsed.authorities === null || Array.isArray(parsed.authorities)) {
    throw new Error('unknown schema');
  }
  const file = new Map<string, AuthorityState>();
  for (const [key, value] of Object.entries(parsed.authorities)) {
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
    const terminals = record ? own(record, 'terminals') : undefined;
    const chats = record ? own(record, 'chats') : undefined;
    const coreEpoch = record ? own(record, 'coreEpoch') : undefined;
    if (!isText(key) || record === undefined) continue;
    file.set(key, {
      terminals: Array.isArray(terminals) ? terminals.flatMap((entry) => parseTerminal(entry) ?? []) : [],
      chats: Array.isArray(chats) ? chats.flatMap((entry) => parseChat(entry, key) ?? []) : [],
      coreEpoch: typeof coreEpoch === 'string' && CORE_EPOCH.test(coreEpoch) ? coreEpoch : null,
    });
  }
  return file;
}

/**
 * What main keeps of remote work by authority, in remote-state.json, never in panels.json or window-layout.json, which an
 * older app version reads after a downgrade and would drop or misread it.
 */
export class RemoteState {
  private readonly filePath: string;
  private file: StateFile;

  private constructor(filePath: string, file: StateFile) {
    this.filePath = filePath;
    this.file = file;
  }

  /** Reads the file; a missing one is empty, an unreadable one is logged and replaced at the next change. */
  static async open(userDataDir: string, log: (line: string) => void): Promise<RemoteState> {
    const filePath = path.join(userDataDir, REMOTE_STATE_FILE);
    let text: string | undefined;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text === undefined) return new RemoteState(filePath, new Map());
    try {
      return new RemoteState(filePath, parseStateFile(text));
    } catch (err) {
      log(`[remote-state] ignoring ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return new RemoteState(filePath, new Map());
    }
  }

  terminals(authorityKey: string): readonly RemoteTerminalRecord[] {
    return this.file.get(authorityKey)?.terminals ?? [];
  }

  chats(authorityKey: string): readonly RemoteChatRecord[] {
    return this.file.get(authorityKey)?.chats ?? [];
  }

  coreEpoch(authorityKey: string): string | null {
    return this.file.get(authorityKey)?.coreEpoch ?? null;
  }

  /** Replaces the authority's terminals; memory follows only once the file says so. */
  setTerminals(authorityKey: string, terminals: readonly RemoteTerminalRecord[]): Promise<void> {
    return this.change(authorityKey, { terminals: [...terminals] });
  }

  /** Replaces the authority's open chats and the core epoch they are open under. */
  setChats(authorityKey: string, chats: readonly RemoteChatRecord[], coreEpoch: string | null): Promise<void> {
    return this.change(authorityKey, { chats: [...chats], coreEpoch });
  }

  private async change(authorityKey: string, patch: Partial<AuthorityState>): Promise<void> {
    let next = this.file;
    await writeJsonConfig(this.filePath, () => {
      next = new Map(this.file).set(authorityKey, { ...(this.file.get(authorityKey) ?? EMPTY_AUTHORITY), ...patch });
      return `${JSON.stringify({ version: SCHEMA_VERSION, authorities: Object.fromEntries(next) }, null, 2)}\n`;
    });
    this.file = next;
  }

  /** Settles once every write to the file, one queued meanwhile included, has landed or failed; a quit awaits it. */
  flush(): Promise<void> {
    return jsonConfigWritesSettled(this.filePath);
  }
}
