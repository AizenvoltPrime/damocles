import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { renameWithRetry } from '../../../core/config/json-config-write';
import { isSafeAgentPathId } from '../../../shared/agent-path-id';
import { MIRROR_CLOCK_FILE, MIRROR_SUBCALLS_FILE, type MirrorClock } from '../../../shared/remote-mirror';
import type { MirrorChange, MirrorFile, MirrorHeld, MirrorLedgerChange } from '../../daemon/control-messages';
import type { Disposable } from '../../../platform/disposable';
import type { OtherProtocolDaemon, RemoteConnection } from './connection';

// The session mirror of one host may hold this many bytes across all its projects.
export const MIRROR_QUOTA_BYTES: number = 1024 * 1024 * 1024;
// The head hash covers the first 4 KiB of a file, the tail hash the 4 KiB before its size (the daemon's HASH_SPAN_BYTES).
const HASH_SPAN_BYTES = 4096;
// Segments of a mirrored name: a session file, or an agent or team file under its session's agent folder.
const MAX_NAME_SEGMENTS = 6;
const TEMP_SUFFIX = '.mirror-partial';
const SESSION_SUFFIX = '.jsonl';

/** One connection's mirror.sync and the streams its answer names; stream ids are per connection. */
export interface MirrorChannel {
  readonly sync: (request: { readonly projectKey: string; readonly budgetBytes: number; readonly files: readonly MirrorFile[] }) => Promise<{ readonly changes: readonly MirrorChange[] }>;
  // the change's bytes from the stream it names, in order
  readonly receive: (stream: number, maxBytes: number, onChunk: (bytes: Uint8Array) => Promise<void>) => Promise<number>;
  // the target's sub-call ledger; absent on a daemon that does not list mirror.subcalls
  readonly syncSubcalls?: (request: { readonly budgetBytes: number; readonly held?: MirrorHeld }) => Promise<{ readonly change?: MirrorLedgerChange }>;
  // the host's clock minus this computer's, as the connection's handshake measured it; absent on a daemon of another protocol,
  // whose refusal carries no time
  readonly skewMs?: number;
}

// The daemon serves control mirror.syncSubcalls and sends mirror.subcallsChanged.
export const MIRROR_SUBCALLS_FEATURE = 'mirror.subcalls';

/** A connection of this protocol as a mirror channel: the sub-call ledger only when its daemon lists it. */
export function connectionMirrorChannel(connection: Pick<RemoteConnection, 'control' | 'receiveStream' | 'features' | 'skewMs'>): MirrorChannel {
  return {
    sync: (request) => connection.control.request('mirror.sync', request),
    receive: (stream, maxBytes, onChunk) => connection.receiveStream(stream, maxBytes, onChunk),
    ...(connection.features.includes(MIRROR_SUBCALLS_FEATURE) ? { syncSubcalls: (request) => connection.control.request('mirror.syncSubcalls', request) } : {}),
    skewMs: connection.skewMs,
  };
}

/** A daemon of another protocol as a mirror channel: its frozen mirror.sync alone. */
export function frozenMirrorChannel(daemon: Pick<OtherProtocolDaemon, 'control' | 'receiveStream'>): MirrorChannel {
  return { sync: (request) => daemon.control.request('mirror.sync', request), receive: (stream, maxBytes, onChunk) => daemon.receiveStream(stream, maxBytes, onChunk) };
}

export interface SessionMirrorDeps {
  // <userData>/remote/<hostId>/mirror
  readonly root: string;
  // the host's channel now; throws while it has none
  readonly channel: () => MirrorChannel;
  readonly log: (line: string) => void;
}

type Receive = (onChunk: (bytes: Uint8Array) => Promise<void>) => Promise<number>;

// A Windows device name, refused on every client so a mirror never depends on how a platform opens one.
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/** A name the daemon sent as a relative '/'-separated path: every segment one safe path segment (isSafeAgentPathId). */
export function isMirrorName(name: string): boolean {
  const segments = name.split('/');
  return segments.length <= MAX_NAME_SEGMENTS && segments.every((segment) => isSafeAgentPathId(segment) && !segment.endsWith(TEMP_SUFFIX) && !DEVICE_NAME.test(segment));
}

/** The session id a session file names: pi writes `<timestamp>_<session id>.jsonl` (piSessionIdFromFile's rule). */
export function sessionIdOfFile(name: string): string | undefined {
  if (!name.endsWith(SESSION_SUFFIX) || !isMirrorName(name)) return undefined;
  const base = name.slice(0, -SESSION_SUFFIX.length);
  const id = base.slice(base.indexOf('_') + 1);
  return isSafeAgentPathId(id) ? id : undefined;
}

/** The folder of one project's mirror: its target folder key hashed into a single segment. */
export function projectMirrorFolder(root: string, folderKey: string): string {
  return path.join(root, createHash('sha256').update(folderKey).digest('hex').slice(0, 32));
}

/** The local path of a mirrored name under folder, or undefined when the name is unsafe or would leave the folder. */
export function mirrorPath(folder: string, name: string): string | undefined {
  if (!isMirrorName(name)) return undefined;
  const resolved = path.resolve(folder, ...name.split('/'));
  return resolved.startsWith(`${path.resolve(folder)}${path.sep}`) ? resolved : undefined;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function readRange(file: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(bytes, filled, length - filled, offset + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return bytes.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

async function heldOf(full: string, size: number): Promise<MirrorHeld> {
  const head = await readRange(full, 0, Math.min(HASH_SPAN_BYTES, size));
  const tailStart = Math.max(0, size - HASH_SPAN_BYTES);
  const tail = await readRange(full, tailStart, size - tailStart);
  return { size, headHash: sha256(head), tailHash: sha256(tail) };
}

// What the mirror holds for a project, links never followed; a file whose name fails isMirrorName is never reported, and a
// partial file a crash left is removed.
async function heldFiles(folder: string): Promise<Array<MirrorFile & { readonly path: string }>> {
  const out: Array<MirrorFile & { readonly path: string }> = [];
  const walk = async (dir: string, relative: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, name);
      else if (entry.isFile() && entry.name.endsWith(TEMP_SUFFIX)) await fs.rm(full, { force: true });
      else if (entry.isFile() && isMirrorName(name)) {
        const { size } = await fs.lstat(full);
        out.push({ file: name, ...(await heldOf(full, size)), path: full });
      }
    }
  };
  await walk(folder, '');
  return out;
}

// The daemon sends control mirror.changed for each project a mirror.sync of this connection named.
export const MIRROR_CHANGED_FEATURE = 'mirror.changed';

/** Runs sync on each mirror.changed and mirror.subcallsChanged the connection's daemon sends, of those it lists. */
export function followMirrorChanges(connection: Pick<RemoteConnection, 'features' | 'control'>, sync: () => void): Disposable {
  const followed: Disposable[] = [];
  if (connection.features.includes(MIRROR_CHANGED_FEATURE)) followed.push(connection.control.onEvent('mirror.changed', () => sync()));
  if (connection.features.includes(MIRROR_SUBCALLS_FEATURE)) followed.push(connection.control.onEvent('mirror.subcallsChanged', () => sync()));
  return { dispose: () => { for (const each of followed) each.dispose(); } };
}

/** The client side of control mirror.sync for one host: docs/invariants.md "Remote daemon and wire", the session mirror. */
export class SessionMirror {
  private readonly deps: SessionMirrorDeps;
  // the sync running, and the projects of the one asked for meanwhile
  private running: Promise<void> | undefined;
  private again: (() => readonly string[]) | undefined;
  // the skew this instance last wrote to the clock file
  private recordedSkewMs: number | undefined;

  constructor(deps: SessionMirrorDeps) {
    this.deps = deps;
  }

  /**
   * Syncs the projects folderKeys names (read when the sync starts) now, or once more after the sync running, so requests
   * that arrive together coalesce into one sync after it, of the latest request's projects; resolves once no sync runs or
   * waits.
   */
  schedule(folderKeys: () => readonly string[]): Promise<void> {
    if (this.running) {
      this.again = folderKeys;
      return this.running;
    }
    const run = async (): Promise<void> => {
      let next: (() => readonly string[]) | undefined = folderKeys;
      while (next) {
        this.again = undefined;
        await this.syncAll(next());
        next = this.again;
      }
      // in the turn that read no request: one made from here on starts a sync of its own
      this.running = undefined;
    };
    const running = run().finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }

  /** Settles once no sync runs; a quit waits for it before it closes the connection. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /**
   * Syncs the target's sub-call ledger with the whole quota, then the projects in order of last use, each given the quota the
   * ones before it left as budgetBytes, so the daemon keeps the newest sessions that fit and answers deleted for the rest; a
   * file dropped that way is not sent again while the budget stays. A part that fails is logged and the next one still syncs
   * within what is left.
   */
  async syncAll(folderKeys: readonly string[]): Promise<void> {
    let left = MIRROR_QUOTA_BYTES;
    try {
      left -= await this.syncSubcalls(left);
    } catch (err) {
      this.deps.log(`[mirror] syncing the sub-call ledger failed: ${err instanceof Error ? err.message : String(err)}`);
      left -= await this.subcallsBytes().catch((readErr: unknown) => {
        this.deps.log(`[mirror] reading what the sub-call ledger's mirror holds failed: ${readErr instanceof Error ? readErr.message : String(readErr)}`);
        return 0;
      });
    }
    left = Math.max(0, left);
    for (const folderKey of folderKeys) {
      try {
        left -= await this.syncProject(folderKey, left);
      } catch (err) {
        this.deps.log(`[mirror] syncing a project failed: ${err instanceof Error ? err.message : String(err)}`);
        // a mirror folder that cannot be read counts nothing, so the later projects still sync
        left -= await this.heldBytes(folderKey).catch((readErr: unknown) => {
          this.deps.log(`[mirror] reading what a project's mirror holds failed: ${readErr instanceof Error ? readErr.message : String(readErr)}`);
          return 0;
        });
      }
      left = Math.max(0, left);
    }
  }

  /**
   * One project's sync within budgetBytes over one channel, the only one that carries its answer's streams; resolves the bytes
   * its mirror holds afterwards. A change that fails is logged and its stream drained, so no stream stays unclaimed.
   */
  async syncProject(folderKey: string, budgetBytes: number): Promise<number> {
    const folder = projectMirrorFolder(this.deps.root, folderKey);
    const held = await heldFiles(folder);
    const byName = new Map(held.map((file) => [file.file, file]));
    const channel = this.deps.channel();
    const { changes } = await channel.sync({ projectKey: folderKey, budgetBytes, files: held.map(({ file, size, headHash, tailHash }) => ({ file, size, headHash, tailHash })) });
    const named = new Set<string>();
    for (const change of changes) await this.land(channel, change, JSON.stringify(change.file).slice(0, 200), (receive) => this.apply(folder, byName, named, change, receive));
    return this.heldBytes(folderKey);
  }

  /**
   * The target's sub-call ledger within budgetBytes; resolves the bytes its mirror holds afterwards. It first records the
   * channel's clock skew, so the usage index places what this sync brings on this computer's clock. The daemon names no path:
   * the copy's place is fixed under the root, and a change must follow what is held and fit the budget, else its stream is
   * drained and nothing is written.
   */
  async syncSubcalls(budgetBytes: number): Promise<number> {
    const channel = this.deps.channel();
    if (channel.skewMs !== undefined) await this.recordSkew(Math.round(channel.skewMs));
    if (!channel.syncSubcalls) return this.subcallsBytes();
    const target = path.join(this.deps.root, MIRROR_SUBCALLS_FILE);
    const held = await this.subcallsHeld(target);
    const { change } = await channel.syncSubcalls({ budgetBytes, ...(held ? { held } : {}) });
    if (change) await this.land(channel, change, MIRROR_SUBCALLS_FILE, (receive) => this.applySubcalls(target, held, budgetBytes, change, receive));
    return this.subcallsBytes();
  }

  // A change that fails is logged and its stream drained if nothing claimed it, so no stream stays unclaimed.
  private async land(channel: MirrorChannel, change: MirrorLedgerChange, label: string, apply: (receive: Receive) => Promise<void>): Promise<void> {
    let claimed = change.kind === 'deleted';
    const receive: Receive = (onChunk) => {
      claimed = true;
      return channel.receive(change.stream, change.length, onChunk);
    };
    try {
      await apply(receive);
    } catch (err) {
      this.deps.log(`[mirror] the change to ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (claimed) return;
      await receive(async () => undefined).catch((drainErr: unknown) => {
        this.deps.log(`[mirror] draining stream ${change.stream} failed: ${drainErr instanceof Error ? drainErr.message : String(drainErr)}`);
      });
    }
  }

  private async applySubcalls(target: string, held: MirrorHeld | undefined, budgetBytes: number, change: MirrorLedgerChange, receive: Receive): Promise<void> {
    if (change.kind === 'deleted') {
      await fs.rm(target, { force: true });
      return;
    }
    if (change.kind === 'append' && held?.size !== change.offset) {
      this.deps.log(`[mirror] an append to ${MIRROR_SUBCALLS_FILE} at ${change.offset} does not follow the ${held?.size ?? 0} bytes held; dropping it`);
      await receive(async () => undefined);
      await fs.rm(target, { force: true });
      return;
    }
    if ((change.kind === 'full' && change.offset !== 0) || change.offset + change.length > budgetBytes) {
      this.deps.log(`[mirror] refused a ${change.kind} of ${change.length} bytes at ${change.offset} to ${MIRROR_SUBCALLS_FILE} within a budget of ${budgetBytes}`);
      await receive(async () => undefined);
      return;
    }
    await this.write(target, change, receive);
  }

  // anything but a regular file in the ledger's place is not held
  private async subcallsHeld(target: string): Promise<MirrorHeld | undefined> {
    try {
      const stat = await fs.lstat(target);
      return stat.isFile() ? await heldOf(target, stat.size) : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  private async subcallsBytes(): Promise<number> {
    return (await this.subcallsHeld(path.join(this.deps.root, MIRROR_SUBCALLS_FILE)))?.size ?? 0;
  }

  // a partial file renamed into place, so the usage index never reads half of it
  private async recordSkew(skewMs: number): Promise<void> {
    if (this.recordedSkewMs === skewMs) return;
    const file = path.join(this.deps.root, MIRROR_CLOCK_FILE);
    const partial = `${file}${TEMP_SUFFIX}`;
    const clock: MirrorClock = { skewMs };
    await fs.mkdir(this.deps.root, { recursive: true });
    await fs.writeFile(partial, JSON.stringify(clock));
    await renameWithRetry(partial, file).catch(async (err: unknown) => {
      await fs.rm(partial, { force: true });
      throw err;
    });
    this.recordedSkewMs = skewMs;
  }

  /** The folder one project's mirror lives in, which may not exist yet. */
  projectFolder(folderKey: string): string {
    return projectMirrorFolder(this.deps.root, folderKey);
  }

  /** The mirrored session file of a session, when the mirror holds it. */
  async sessionFile(folderKey: string, sessionId: string): Promise<string | undefined> {
    if (!isSafeAgentPathId(sessionId)) return undefined;
    const folder = projectMirrorFolder(this.deps.root, folderKey);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const entry = entries.find((candidate) => candidate.isFile() && sessionIdOfFile(candidate.name) === sessionId);
    return entry ? mirrorPath(folder, entry.name) : undefined;
  }

  private async apply(folder: string, byName: ReadonlyMap<string, MirrorFile>, named: Set<string>, change: MirrorChange, receive: Receive): Promise<void> {
    const target = mirrorPath(folder, change.file);
    if (!target || named.has(change.file)) {
      this.deps.log(`[mirror] refused a change for the unsafe or repeated name ${JSON.stringify(change.file).slice(0, 200)}`);
      if (change.kind !== 'deleted') await receive(async () => undefined);
      return;
    }
    named.add(change.file);
    if (change.kind === 'deleted') {
      await fs.rm(target, { force: true });
      return;
    }
    const current = byName.get(change.file);
    if (change.kind === 'append' && current?.size !== change.offset) {
      // an append past what is held cannot be placed; the file goes, and the next sync sends it whole
      this.deps.log(`[mirror] an append to ${change.file} at ${change.offset} does not follow the ${current?.size ?? 0} bytes held; dropping it`);
      await receive(async () => undefined);
      await fs.rm(target, { force: true });
      return;
    }
    await this.write(target, change, receive);
  }

  private async heldBytes(folderKey: string): Promise<number> {
    return (await heldFiles(projectMirrorFolder(this.deps.root, folderKey))).reduce((sum, file) => sum + file.size, 0);
  }

  // A full copy goes to a partial file renamed into place once whole; an append writes after the bytes held. A stream the
  // daemon ends short (the file shrank meanwhile) leaves a copy whose tail hash fails, so the next sync sends it whole.
  private async write(target: string, change: Pick<MirrorChange, 'kind' | 'offset'>, receive: Receive): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const destination = change.kind === 'full' ? `${target}${TEMP_SUFFIX}` : target;
    const handle = await fs.open(destination, change.kind === 'full' ? 'w' : 'r+');
    let position = change.kind === 'full' ? 0 : change.offset;
    try {
      await receive(async (bytes) => {
        let written = 0;
        while (written < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, position);
          written += bytesWritten;
          position += bytesWritten;
        }
      });
      await handle.truncate(position);
    } catch (err) {
      await handle.close();
      if (change.kind === 'full') await fs.rm(destination, { force: true });
      throw err;
    }
    await handle.close();
    if (change.kind === 'full') {
      await renameWithRetry(destination, target).catch(async (err: unknown) => {
        await fs.rm(destination, { force: true });
        throw err;
      });
    }
  }
}
