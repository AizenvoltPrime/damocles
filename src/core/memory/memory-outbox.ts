import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { isSafeAgentPathId } from '../../shared/agent-path-id';
import { globalMemoryWriteFits, type GlobalMemoryWrite } from '../../shared/remote-user';
import { renameWithRetry } from '../config/json-config-write';
import { DAMOCLES_HOME_DIR } from '../paths';
import { log } from '../logger';

/** Where a daemon's core keeps the global memory writes each client's turns made while that client was away. */
export const MEMORY_OUTBOX_DIR: string = path.join(DAMOCLES_HOME_DIR, 'outbox');

// A holder that stops refreshing its lock for this long is gone; appends and acknowledgements take milliseconds.
const LOCK_STALE_MS = 20_000;
const LOCK_UPDATE_MS = 2_000;
// The wait for another holder of the lock: at most 150 retries of at most 250 ms, about 35 s, past LOCK_STALE_MS.
const LOCK_WAIT = { retries: 150, factor: 1.3, minTimeout: 5, maxTimeout: 250, randomize: true };
const OUTBOX_SUFFIX = '.jsonl';
// When each client was last attached (epoch ms by client id); not an outbox, as its suffix is not OUTBOX_SUFFIX.
const LAST_SEEN_FILE = 'last-seen.json';

/** One entry of an outbox and the byte offset just past its line, which an acknowledgement names. */
export interface OutboxEntry {
  readonly end: number;
  readonly write: GlobalMemoryWrite;
}

/** The complete entries an outbox holds, in order, and the offset just past its last complete line. */
export interface OutboxContents {
  readonly entries: readonly OutboxEntry[];
  readonly end: number;
}

// A line past user.memory.apply's bounds would fail every drain that sends it, so it is no write.
function isWrite(value: unknown): value is GlobalMemoryWrite {
  if (typeof value !== 'object' || value === null) return false;
  const write = value as Record<string, unknown>;
  return typeof write['uuid'] === 'string'
    && (write['kind'] === 'fact' || write['kind'] === 'preference' || write['kind'] === 'episode' || write['kind'] === 'note')
    && typeof write['content'] === 'string'
    && (write['title'] === undefined || typeof write['title'] === 'string')
    && (write['tags'] === undefined || (Array.isArray(write['tags']) && write['tags'].every((tag) => typeof tag === 'string')))
    && globalMemoryWriteFits(write as unknown as GlobalMemoryWrite);
}

/** The write a line holds, or undefined for a line that is not one. */
function writeOf(line: string): GlobalMemoryWrite | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  return isWrite(parsed) ? parsed : undefined;
}

const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * One file per client, `<dir>/<clientId>.jsonl` (mode 0600), every change under its lock: an append adds one line, and an
 * acknowledgement removes only the prefix its client applied, so a line appended during a drain stays for the next one.
 */
export class MemoryOutbox {
  private readonly dir: string;

  constructor(dir: string = MEMORY_OUTBOX_DIR) {
    this.dir = dir;
  }

  /** The outbox file of a client; a client id that is not one safe path segment has none. */
  file(clientId: string): string {
    if (!isSafeAgentPathId(clientId)) throw new Error(`${JSON.stringify(clientId.slice(0, 64))} cannot name an outbox`);
    return path.join(this.dir, `${clientId}${OUTBOX_SUFFIX}`);
  }

  async append(clientId: string, write: GlobalMemoryWrite): Promise<void> {
    const file = this.file(clientId);
    await this.locked(file, () => appendLines(file, `${JSON.stringify(write)}\n`));
  }

  /** Whether the client's outbox holds no byte; a file of skipped lines alone is not empty. */
  async isEmpty(clientId: string): Promise<boolean> {
    try {
      return (await fs.stat(this.file(clientId))).size === 0;
    } catch (err) {
      if (missing(err)) return true;
      throw err;
    }
  }

  /** What the client's outbox holds; a line that does not parse as a write is skipped, and the end covers it. */
  async read(clientId: string): Promise<OutboxContents> {
    const file = this.file(clientId);
    return this.locked(file, async () => {
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(file);
      } catch (err) {
        if (missing(err)) return { entries: [], end: 0 };
        throw err;
      }
      const entries: OutboxEntry[] = [];
      let start = 0;
      for (let newline = bytes.indexOf(0x0a, start); newline !== -1; newline = bytes.indexOf(0x0a, start)) {
        const write = writeOf(bytes.toString('utf8', start, newline));
        start = newline + 1;
        if (write) entries.push({ end: start, write });
        else log(`[MemoryOutbox] skipped a line of ${file} that is not a global memory write`);
      }
      return { entries, end: start };
    });
  }

  /**
   * Removes the first `through` bytes the client acknowledged, and the file once nothing follows them. `last` is the uuid of
   * the write whose line ends at `through`, or null for a skipped line; an outbox whose line there is another one (another
   * drain cut it meanwhile) is left as it is and the acknowledgement throws.
   */
  async acknowledge(clientId: string, through: number, last: string | null): Promise<void> {
    const file = this.file(clientId);
    await this.locked(file, async () => {
      const bytes = await fs.readFile(file);
      if (through > bytes.length) throw new Error(`An acknowledgement through byte ${through} is past the end of ${file} (${bytes.length} bytes)`);
      const lineStart = through < 2 ? 0 : bytes.lastIndexOf(0x0a, through - 2) + 1;
      const ended = through > 0 && bytes[through - 1] === 0x0a ? writeOf(bytes.toString('utf8', lineStart, through - 1)) : undefined;
      const fits = through > 0 && bytes[through - 1] === 0x0a && (last === null ? ended === undefined : ended?.uuid === last);
      if (!fits) throw new Error(`The line of ${file} that ends at byte ${through} is not the one its client acknowledged`);
      if (through === bytes.length) {
        await fs.rm(file, { force: true });
        return;
      }
      // synced before the rename, or a power loss can leave the renamed outbox empty
      const rest = `${file}.rest`;
      const handle = await fs.open(rest, 'w', 0o600);
      try {
        await handle.writeFile(bytes.subarray(through));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(rest, file);
    });
  }

  /** The clients that have an outbox file. */
  async clients(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if (missing(err)) return [];
      throw err;
    }
    return names.filter((name) => name.endsWith(OUTBOX_SUFFIX)).map((name) => name.slice(0, -OUTBOX_SUFFIX.length)).filter(isSafeAgentPathId);
  }

  /**
   * Moves every line of `from`'s outbox to the end of `to`'s, in order, and deletes `from`'s; false when `from` has none or
   * `may` answers false under the locks, where a drain of `from` cannot read it meanwhile.
   */
  async transfer(from: string, to: string, may: () => boolean = () => true): Promise<boolean> {
    const source = this.file(from);
    const target = this.file(to);
    if (source === target) throw new Error(`An outbox cannot move onto itself (${from})`);
    // two transfers lock in one order, so neither waits on the other
    const [first, second] = [source, target].sort();
    return this.locked(first!, () => this.locked(second!, async () => {
      if (!may()) return false;
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(source);
      } catch (err) {
        if (missing(err)) return false;
        throw err;
      }
      if (bytes.length > 0) await appendLines(target, bytes[bytes.length - 1] === 0x0a ? bytes : Buffer.concat([bytes, Buffer.from('\n')]));
      await fs.rm(source, { force: true });
      return true;
    }));
  }

  /** Deletes the client's outbox; false when it has none or `may` answers false under its lock. */
  async discard(clientId: string, may: () => boolean = () => true): Promise<boolean> {
    const file = this.file(clientId);
    return this.locked(file, async () => {
      if (!may()) return false;
      try {
        await fs.rm(file);
        return true;
      } catch (err) {
        if (missing(err)) return false;
        throw err;
      }
    });
  }

  /** Records each client as attached at `at`, keeping a later time already recorded. */
  async recordSeen(clientIds: readonly string[], at: number): Promise<void> {
    if (clientIds.length === 0) return;
    await this.updateSeen((seen) => {
      for (const clientId of clientIds) seen[clientId] = Math.max(seen[clientId] ?? 0, at);
    });
  }

  /** When each client was last attached; a client with no record yet is recorded as seen at `now`. */
  async lastSeen(clientIds: readonly string[], now: number): Promise<Record<string, number>> {
    return this.updateSeen((seen) => {
      for (const clientId of clientIds) seen[clientId] ??= now;
      return Object.fromEntries(clientIds.map((clientId) => [clientId, seen[clientId]!]));
    });
  }

  private async updateSeen<T>(change: (seen: Record<string, number>) => T): Promise<T> {
    const file = path.join(this.dir, LAST_SEEN_FILE);
    return this.locked(file, async () => {
      let seen: Record<string, number> = {};
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          seen = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1])));
        } else {
          log(`[MemoryOutbox] ${file} holds no record of attaches; starting it again`);
        }
      } catch (err) {
        if (err instanceof SyntaxError) log(`[MemoryOutbox] ${file} is not JSON; starting it again`);
        else if (!missing(err)) throw err;
      }
      const before = JSON.stringify(seen);
      const result = change(seen);
      const after = JSON.stringify(seen);
      if (after !== before) {
        const next = `${file}.next`;
        const handle = await fs.open(next, 'w', 0o600);
        try {
          await handle.writeFile(after);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await renameWithRetry(next, file);
      }
      return result;
    });
  }

  private async locked<T>(file: string, body: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    let compromised: Error | undefined;
    const release = await lockfile.lock(file, {
      realpath: false,
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      retries: LOCK_WAIT,
      onCompromised: (err) => {
        compromised = err;
      },
    });
    try {
      const result = await body();
      if (compromised) throw new Error(`The lock on ${file} was lost while it was held: ${compromised.message}`);
      return result;
    } finally {
      if (!compromised) await release();
    }
  }
}

/** Appends whole lines to an outbox file (mode 0600); a line a crash cut short before them stays a line of its own, which the drain skips. */
async function appendLines(file: string, lines: string | Buffer): Promise<void> {
  const handle = await fs.open(file, 'a+', 0o600);
  try {
    const { size } = await handle.stat();
    let separator = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) separator = '\n';
    }
    await handle.appendFile(typeof lines === 'string' ? `${separator}${lines}` : Buffer.concat([Buffer.from(separator), lines]));
    await handle.sync();
  } finally {
    await handle.close();
  }
}
