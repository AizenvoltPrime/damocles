// The daemon side of control.mirror.sync: the project's session, agent and team files under its pi
// session folder, newest first within the client's budget; of mirror.syncProject: those and its worktree chats' files; and of
// mirror.syncSubcalls: the sub-call ledger. The daemon opens only files it listed itself; a name the client sends is only
// compared with that listing, never joined to a path.
import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { piSessionDir } from '../../core/pi-session/session-store/session-dir';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { parseRegistry, recordsListedUnder, REGISTRY_FILE, type WorktreeRecord } from '../../core/worktrees/registry';
import type { Disposable } from '../../platform/disposable';
import type { FileWatcher, FileWatcherFactory } from '../../platform/file-watcher';
import { isMirrorWorktreeFolder, mirrorWorktreeFolder, type MirrorWorktreeKind } from '../../shared/remote-mirror';
import type { MirrorChange, MirrorFile, MirrorHeld, MirrorLedgerChange } from './control-messages';

// the head hash covers the first 4 KiB, the tail hash the 4 KiB before the client's size
export const HASH_SPAN_BYTES = 4096;
// watches one connection holds, the ledger's and the registry's included: a client names any project key, and a follow past it
// is refused
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

export interface ProjectMirrorDeps extends MirrorServerDeps {
  // the folder of core's worktree registry.json
  readonly worktreesRoot: string;
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

const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

// core's live list's rule (WorktreeRegistry.recordsOfProject, fs.existsSync): links followed, and any error is a folder gone
const exists = (folder: string): Promise<boolean> => fs.stat(folder).then(() => true, () => false);

export interface ProjectSessionFolders {
  readonly own: string;
  // no two the same folder, and none the project's own
  readonly worktrees: ReadonlyArray<{ readonly id: string; readonly kind: MirrorWorktreeKind; readonly folder: string }>;
  // registry.json does not parse, so which worktree folders the project lists is unknown and worktrees is empty
  readonly unreadable: boolean;
}

/**
 * The session folders a project's Chats list reads (AD12 Listing): its own and those of its registry records, read from
 * core's registry file, never from a path a client names, by the live list's rule (recordsListedUnder), a worktree open as a
 * project included, whose own sessions the offline list leaves out by their entries.
 */
export async function projectSessionFolders(agentDir: string, worktreesRoot: string, projectKey: string): Promise<ProjectSessionFolders> {
  const own = await sessionFolder(agentDir, projectKey);
  let text: string;
  try {
    text = await fs.readFile(path.join(worktreesRoot, REGISTRY_FILE), 'utf8');
  } catch (err) {
    if (missing(err)) return { own, worktrees: [], unreadable: false };
    throw err;
  }
  let records: WorktreeRecord[];
  try {
    // core's registry logs a record this version cannot read
    records = parseRegistry(text, worktreesRoot, () => undefined).records;
  } catch {
    return { own, worktrees: [], unreadable: true };
  }
  const key = folderKey(projectKey);
  const adopted = records.filter((record) => record.kind === 'adopted' && record.deletedAt === undefined && record.projectPath !== undefined && folderKey(record.projectPath) === key);
  const present = new Set<string>();
  await Promise.all(adopted.map(async (record) => {
    if (await exists(record.workingFolder)) present.add(record.workingFolder);
  }));
  const seen = new Set([folderKey(own)]);
  const worktrees: Array<{ readonly id: string; readonly kind: MirrorWorktreeKind; readonly folder: string }> = [];
  for (const record of recordsListedUnder(records, projectKey, (folder) => present.has(folder))) {
    const folder = await sessionFolder(agentDir, record.workingFolder);
    if (seen.has(folderKey(folder))) continue;
    seen.add(folderKey(folder));
    worktrees.push({ id: record.id, kind: record.kind, folder });
  }
  return { own, worktrees, unreadable: false };
}

/** What a connection's followProject read and followed for the mirror.syncProject that lists next. */
export interface FollowedProject {
  readonly folders: ProjectSessionFolders;
  // the first watch that failed, once the others are followed
  readonly failed?: unknown;
}

/**
 * One connection's watches of the session folders and the sub-call ledger it mirrors, so it hears of every change it has not
 * synced (control mirror.changed and mirror.subcallsChanged); disposed with the connection.
 */
export interface ConnectionMirrorWatches extends Disposable {
  // set by dispose
  readonly released: boolean;
  // awaited before each mirror.sync of the project lists it, so no change after the listing goes unannounced; announces once
  // until the next follow
  follow(projectKey: string, changed: () => void): Promise<void>;
  // the same before each mirror.syncProject: the worktree registry first, then the session folders it lists for the project,
  // letting go of a worktree folder no project of the connection lists any more; rejects only when the folders cannot be read
  followProject(projectKey: string, changed: () => void): Promise<FollowedProject>;
  // the same for the sub-call ledger, before each mirror.syncSubcalls reads it
  followSubcalls(changed: () => void): Promise<void>;
}

export interface MirrorWatches {
  forConnection(connectionId: string): ConnectionMirrorWatches;
}

interface Followed {
  // settles once the watch reports every later change
  readonly ready: Promise<void>;
  announced: boolean;
  dispose(): void;
}

export function createMirrorWatches(deps: { readonly agentDir: string; readonly ledgerPath: string; readonly worktreesRoot: string; readonly watchers: FileWatcherFactory }): MirrorWatches {
  const forConnection = (connectionId: string): ConnectionMirrorWatches => {
    // keyed `project:<projectKey>`, `folder:<session folder>`, `registry` or `subcalls`, so no project key names another watch
    const watched = new Map<string, Followed>();
    // the `folder:` keys each project's latest readable followProject listed
    const listedBy = new Map<string, ReadonlySet<string>>();
    let released = false;
    const follow = (key: string, place: () => Promise<{ readonly base: string; readonly glob: string }>, changed: () => void): Promise<void> => {
      if (released) return Promise.reject(new Error(`${connectionId} is closed`));
      const known = watched.get(key);
      if (known) {
        known.announced = false;
        return known.ready;
      }
      if (watched.size >= MAX_MIRROR_WATCHES) return Promise.reject(new Error(`${connectionId} already follows ${MAX_MIRROR_WATCHES} session folders`));
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
          if (watched.get(key) === followed) watched.delete(key);
          throw err;
        }),
        dispose: () => {
          disposed = true;
          watcher?.dispose();
        },
      };
      watched.set(key, followed);
      return followed.ready;
    };
    return {
      get released() {
        return released;
      },
      follow: (projectKey, changed) => follow(`project:${projectKey}`, async () => ({ base: await sessionFolder(deps.agentDir, projectKey), glob: '**' }), changed),
      followProject: async (projectKey, changed) => {
        const failures: unknown[] = [];
        const attempt = (following: Promise<void>): Promise<void> => following.catch((err: unknown) => { failures.push(err); });
        const at = (base: string) => () => Promise.resolve({ base, glob: '**' });
        // followed before it is read, so a record added after the read is announced
        await attempt(follow('registry', () => Promise.resolve({ base: deps.worktreesRoot, glob: REGISTRY_FILE }), changed));
        const folders = await projectSessionFolders(deps.agentDir, deps.worktreesRoot, projectKey);
        // an unreadable registry keeps what the project listed before, as core keeps its last records
        if (!folders.unreadable) {
          const listed = new Set(folders.worktrees.map(({ folder }) => `folder:${folder}`));
          const before = listedBy.get(projectKey);
          listedBy.set(projectKey, listed);
          for (const key of before ?? []) {
            if ([...listedBy.values()].some((keys) => keys.has(key))) continue;
            watched.get(key)?.dispose();
            watched.delete(key);
          }
        }
        await Promise.all([attempt(follow(`project:${projectKey}`, at(folders.own), changed)), ...folders.worktrees.map(({ folder }) => attempt(follow(`folder:${folder}`, at(folder), changed)))]);
        return failures.length > 0 ? { folders, failed: failures[0] } : { folders };
      },
      // the ledger alone: the usage index beside it changes on every /stats of a remote chat
      followSubcalls: (changed) => follow('subcalls', () => Promise.resolve({ base: path.dirname(deps.ledgerPath), glob: path.basename(deps.ledgerPath) }), changed),
      dispose: () => {
        released = true;
        for (const followed of watched.values()) followed.dispose();
        watched.clear();
        listedBy.clear();
      },
    };
  };
  return { forConnection };
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

type SyncRequest = { readonly projectKey: string; readonly budgetBytes: number; readonly files: readonly MirrorFile[] };

export async function syncMirror(deps: MirrorServerDeps, request: SyncRequest): Promise<{ changes: MirrorChange[] }> {
  return answerListing(deps, await listFiles(await sessionFolder(deps.agentDir, request.projectKey)), request);
}

/**
 * mirror.sync's answer over the project's own files and, each under its worktree.<id>/ or adopted.<id>/ name, its worktree
 * chats' files; folders: what the connection's followProject read for this sync, else read here.
 */
export async function syncProject(deps: ProjectMirrorDeps, request: SyncRequest, folders?: ProjectSessionFolders): Promise<{ changes: MirrorChange[] }> {
  const { own, worktrees, unreadable } = folders ?? (await projectSessionFolders(deps.agentDir, deps.worktreesRoot, request.projectKey));
  const inWorktree = (name: string): boolean => isMirrorWorktreeFolder(name.split('/', 1)[0]!);
  const listed = (await listFiles(own)).filter((file) => !inWorktree(file.file));
  for (const worktree of worktrees) {
    const prefix = mirrorWorktreeFolder(worktree.id, worktree.kind);
    for (const file of await listFiles(worktree.folder)) listed.push({ ...file, file: `${prefix}/${file.file}` });
  }
  if (!unreadable) return answerListing(deps, listed, request);
  deps.log(`[mirror] ${request.projectKey}: registry.json does not parse, so its worktree chats' copies stay as the client holds them`);
  return answerListing(deps, listed, request, inWorktree);
}

// keepHeld: a held name it does not list that is answered no change rather than deleted
async function answerListing(deps: MirrorStreamDeps, files: ListedFile[], request: SyncRequest, keepHeld: (name: string) => boolean = () => false): Promise<{ changes: MirrorChange[] }> {
  const listed = files.sort((a, b) => b.mtimeMs - a.mtimeMs);
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
  for (const file of request.files) if (!keptNames.has(file.file) && !keepHeld(file.file)) changes.push({ file: file.file, kind: 'deleted', offset: 0, length: 0, stream: 0 });
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
