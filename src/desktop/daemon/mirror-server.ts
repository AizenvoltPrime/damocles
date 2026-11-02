// The daemon side of control.mirror.sync: the project's session, agent and team files under its pi
// session folder, newest first within the client's budget; and of mirror.syncSubcalls: the sub-call ledger. The daemon opens
// only files it listed itself; a name the client sends is only compared with that listing, never joined to a path.
import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { piSessionDir } from '../../core/pi-session/session-store/session-dir';
import type { FileWatcher, FileWatcherFactory } from '../../platform/file-watcher';
import type { MirrorChange, MirrorFile, MirrorHeld, MirrorLedgerChange } from './control-messages';

// the head hash covers the first 4 KiB, the tail hash the 4 KiB before the client's size
export const HASH_SPAN_BYTES = 4096;
// watches one connection holds, the ledger's included: a client names any project key, and a follow past it is refused
export const MAX_MIRROR_WATCHES = 256;
const READ_CHUNK_BYTES = 256 * 1024;

export interface ListedFile {
  // relative to the session folder, '/'-separated
  readonly file: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface MirrorStream {
  readonly id: number;
  // the connection is gone; closing fires onDrain
  readonly closed: boolean;
  write(bytes: Uint8Array): boolean;
  end(): void;
  onDrain(listener: () => void): void;
}

export interface MirrorStreamDeps {
  // a stream id for the answer, and the stream under it once its bytes go out
  readonly reserveStream: () => number;
  readonly openStream: (reserved: number) => MirrorStream;
  // settles once every frame queued before the call went out (Mux.drained)
  readonly drained: () => Promise<void>;
  readonly log: (line: string) => void;
}

export interface MirrorServerDeps extends MirrorStreamDeps {
  // the pi agent folder whose sessions/ holds every project's session folder
  readonly agentDir: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Every regular file under the folder, links never followed.
async function listFiles(root: string): Promise<ListedFile[]> {
  const out: ListedFile[] = [];
  const walk = async (folder: string, relative: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const file = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full, file);
      else if (entry.isFile()) {
        const stat = await fs.lstat(full);
        out.push({ file, path: full, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  await walk(root, '');
  return out;
}

async function readRange(filePath: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, 'r');
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

/** The project's session folder; on Windows a folder key is case-folded, so the folder whose name matches it ignoring case. */
export async function sessionFolder(agentDir: string, projectKey: string): Promise<string> {
  const exact = piSessionDir(projectKey, agentDir);
  if (process.platform !== 'win32') return exact;
  const parent = path.dirname(exact);
  const wanted = path.basename(exact).toLowerCase();
  let names: string[];
  try {
    names = await fs.readdir(parent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return exact;
    throw err;
  }
  const found = names.find((name) => name.toLowerCase() === wanted);
  return found === undefined ? exact : path.join(parent, found);
}

/**
 * The session folders and the sub-call ledger each connection mirrors, watched so it hears of every change it has not synced
 * (control mirror.changed and mirror.subcallsChanged).
 */
export interface MirrorWatches {
  // awaited before each mirror.sync of the project lists it, so no change after the listing goes unannounced; announces once
  // until the next follow
  follow(connectionId: string, projectKey: string, changed: () => void): Promise<void>;
  // the same for the sub-call ledger, before each mirror.syncSubcalls reads it
  followSubcalls(connectionId: string, changed: () => void): Promise<void>;
  release(connectionId: string): void;
}

interface Followed {
  // settles once the watch reports every later change
  readonly ready: Promise<void>;
  announced: boolean;
  dispose(): void;
}

export function createMirrorWatches(deps: { readonly agentDir: string; readonly ledgerPath: string; readonly watchers: FileWatcherFactory }): MirrorWatches {
  // per connection, keyed `project:<projectKey>` or `subcalls`, so no project key names the ledger's watch
  const byConnection = new Map<string, Map<string, Followed>>();
  const follow = (connectionId: string, key: string, place: () => Promise<{ readonly base: string; readonly glob: string }>, changed: () => void): Promise<void> => {
    let watched = byConnection.get(connectionId);
    if (!watched) {
      watched = new Map();
      byConnection.set(connectionId, watched);
    }
    const known = watched.get(key);
    if (known) {
      known.announced = false;
      return known.ready;
    }
    if (watched.size >= MAX_MIRROR_WATCHES) return Promise.reject(new Error(`${connectionId} already follows ${MAX_MIRROR_WATCHES} session folders`));
    const held = watched;
    let watcher: FileWatcher | undefined;
    let disposed = false;
    const followed: Followed = {
      announced: false,
      ready: (async () => {
        const { base, glob } = await place();
        if (disposed) return;
        watcher = deps.watchers.watch(base, glob);
        const announce = (): void => {
          if (followed.announced) return;
          followed.announced = true;
          changed();
        };
        watcher.onDidCreate(announce);
        watcher.onDidChange(announce);
        watcher.onDidDelete(announce);
        await watcher.ready;
      })().catch((err: unknown) => {
        followed.dispose();
        if (held.get(key) === followed) held.delete(key);
        throw err;
      }),
      dispose: () => {
        disposed = true;
        watcher?.dispose();
      },
    };
    held.set(key, followed);
    return followed.ready;
  };
  return {
    follow: (connectionId, projectKey, changed) => follow(connectionId, `project:${projectKey}`, async () => ({ base: await sessionFolder(deps.agentDir, projectKey), glob: '**' }), changed),
    // the ledger alone: the usage index beside it changes on every /stats of a remote chat
    followSubcalls: (connectionId, changed) => follow(connectionId, 'subcalls', () => Promise.resolve({ base: path.dirname(deps.ledgerPath), glob: path.basename(deps.ledgerPath) }), changed),
    release(connectionId) {
      const watched = byConnection.get(connectionId);
      byConnection.delete(connectionId);
      for (const followed of watched?.values() ?? []) followed.dispose();
    },
  };
}

// append when the client's head and tail still match the file, else the whole file
async function changeFor(listed: ListedFile, held: MirrorHeld | undefined): Promise<{ kind: 'append' | 'full'; offset: number } | undefined> {
  if (!held || held.size > listed.size) return { kind: 'full', offset: 0 };
  const head = await readRange(listed.path, 0, Math.min(HASH_SPAN_BYTES, held.size));
  const tailStart = Math.max(0, held.size - HASH_SPAN_BYTES);
  const tail = await readRange(listed.path, tailStart, held.size - tailStart);
  if (sha256(head) !== held.headHash || sha256(tail) !== held.tailHash) return { kind: 'full', offset: 0 };
  return held.size === listed.size ? undefined : { kind: 'append', offset: held.size };
}

// A file that shrank meanwhile ends its stream short of length; the client then holds an incomplete copy and resyncs it.
async function pump(stream: MirrorStream, filePath: string, offset: number, length: number): Promise<void> {
  try {
    for (let at = 0; at < length; at += READ_CHUNK_BYTES) {
      const bytes = await readRange(filePath, offset + at, Math.min(READ_CHUNK_BYTES, length - at));
      if (bytes.length === 0) break;
      if (stream.write(bytes)) continue;
      if (stream.closed) return;
      await new Promise<void>((resolve) => stream.onDrain(resolve));
    }
  } finally {
    stream.end();
  }
}

export async function syncMirror(deps: MirrorServerDeps, request: { readonly projectKey: string; readonly budgetBytes: number; readonly files: readonly MirrorFile[] }): Promise<{ changes: MirrorChange[] }> {
  const root = await sessionFolder(deps.agentDir, request.projectKey);
  const listed = (await listFiles(root)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const kept: ListedFile[] = [];
  let used = 0;
  for (const file of listed) {
    if (used + file.size > request.budgetBytes) continue;
    kept.push(file);
    used += file.size;
  }
  const held = new Map(request.files.map((file) => [file.file, file]));
  const keptNames = new Set(kept.map((file) => file.file));
  const changes: MirrorChange[] = [];
  const sends: Array<() => Promise<void>> = [];
  for (const file of kept) {
    const change = await changeFor(file, held.get(file.file));
    if (!change) continue;
    const length = file.size - change.offset;
    const id = deps.reserveStream();
    changes.push({ file: file.file, kind: change.kind, offset: change.offset, length, stream: id });
    // one stream open at a time, however many files change
    sends.push(async () => pump(deps.openStream(id), file.path, change.offset, length));
  }
  for (const file of request.files) if (!keptNames.has(file.file)) changes.push({ file: file.file, kind: 'deleted', offset: 0, length: 0, stream: 0 });
  sendAfterAnswer(deps, sends);
  return { changes };
}

// The endpoint queues the answer in the microtasks after its handler resolves, so the streams open once it went out.
function sendAfterAnswer(deps: MirrorStreamDeps, sends: ReadonlyArray<() => Promise<void>>): void {
  const failed = (err: unknown): void => deps.log(`[mirror] sending a file failed: ${err instanceof Error ? err.message : String(err)}`);
  const sendAll = (): Promise<void> => sends.reduce((chain, send) => chain.then(() => send().catch(failed)), Promise.resolve());
  setImmediate(() => void deps.drained().then(sendAll));
}

/** The sub-call ledger by mirror.sync's rules for one file; a link or anything but a regular file counts as no ledger. */
export async function syncSubcalls(deps: MirrorStreamDeps & { readonly ledgerPath: string }, request: { readonly budgetBytes: number; readonly held?: MirrorHeld }): Promise<{ change?: MirrorLedgerChange }> {
  let listed: ListedFile | undefined;
  try {
    const stat = await fs.lstat(deps.ledgerPath);
    if (stat.isFile()) listed = { file: path.basename(deps.ledgerPath), path: deps.ledgerPath, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!listed || listed.size > request.budgetBytes) return request.held ? { change: { kind: 'deleted', offset: 0, length: 0, stream: 0 } } : {};
  const change = await changeFor(listed, request.held);
  if (!change) return {};
  const length = listed.size - change.offset;
  const id = deps.reserveStream();
  const ledger = listed.path;
  sendAfterAnswer(deps, [async () => pump(deps.openStream(id), ledger, change.offset, length)]);
  return { change: { kind: change.kind, offset: change.offset, length, stream: id } };
}
