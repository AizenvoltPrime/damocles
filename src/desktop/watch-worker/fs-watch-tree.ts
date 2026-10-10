// The Windows recursive watch, shared by main's watcher factory and the watch worker thread; no electron import.
import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import type { Disposable } from '../../platform/disposable';
import { settlePending } from '../../shared/settle-pending';

export type RawEventType = 'create' | 'change' | 'delete';
export type RawListener = (type: RawEventType, fsPath: string) => void;
export type Log = (line: string) => void;
// Records watcher work still running (a @parcel/watcher subscribe or unsubscribe, a Windows tree scan) and hands the same promise back.
export type TrackWork = <T>(work: Promise<T>) => Promise<T>;

// VS Code's files.watcherExclude defaults: churn no Damocles watcher cares about.
export const RECURSIVE_IGNORE: string[] = ['**/node_modules/**', '**/.git/objects/**', '**/.git/subtree-cache/**', '**/.hg/store/**'];
// A burst of raw fs.watch events on one directory (a checkout, an atomic rewrite) is reported once per file; VS Code's non-recursive watcher waits 75 ms too.
export const SHALLOW_COALESCE_MS = 75;
// A Windows recursive watch whose handle died is opened again after this delay, doubled per failure since its last event.
export const REOPEN_FIRST_MS = 1000;
const REOPEN_MAX_MS = 60_000;
// A Windows tree notes its rescans in the log at most once per this interval.
const RESCAN_NOTE_MS = 60_000;

export const isRecursiveIgnored: (relative: string) => boolean = picomatch(RECURSIVE_IGNORE, { dot: true });

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toGlobPath(relative: string): string {
  return relative.split(path.sep).join('/');
}

export function isGoneError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function lstatNow(fsPath: string, log: Log): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(fsPath, { bigint: true, throwIfNoEntry: false });
  } catch (err) {
    log(`[watcher] could not stat ${fsPath}: ${errorText(err)}`);
    return undefined;
  }
}

export async function lstatLater(fsPath: string, log: Log): Promise<fs.BigIntStats | undefined> {
  try {
    return await fs.promises.lstat(fsPath, { bigint: true });
  } catch (err) {
    if (!isGoneError(err)) log(`[watcher] could not stat ${fsPath}: ${errorText(err)}`);
    return undefined;
  }
}

// A Windows tree's record of one entry, keyed in its parent by the name Windows reports, which is the name's case on disk.
interface FsEntry {
  readonly ino: bigint;
  readonly size: bigint;
  readonly ctimeNs: bigint;
  // A directory's entries; undefined for anything else, a link included.
  readonly children: Map<string, FsEntry> | undefined;
}

interface FsScan {
  readonly rel: string;
  readonly children: Map<string, FsEntry>;
  readonly report: boolean;
}

function fsEntry(stat: fs.BigIntStats): FsEntry {
  return { ino: stat.ino, size: stat.size, ctimeNs: stat.ctimeNs, children: stat.isDirectory() ? new Map() : undefined };
}

// Windows reports a last-access update as a change, and it moves none of these; a write moves ctime, a replacement the file id.
function sameFile(entry: FsEntry, stat: fs.BigIntStats): boolean {
  return entry.ino === stat.ino && entry.size === stat.size && entry.ctimeNs === stat.ctimeNs;
}

// One fs.watch(real, { recursive: true }) per root; docs/invariants.md "The Windows tree settles every event against a snapshot".
function startFsWatchTree(dir: string, report: boolean, emit: RawListener, lost: () => void, log: Log, track: TrackWork): Disposable {
  // Events are relative to the real path (long names, links resolved) and reported under dir, the caller's form.
  const real = fs.realpathSync.native(dir);
  const root = new Map<string, FsEntry>();
  const pending = new Set<string>();
  const scans: FsScan[] = [];
  let scanning = false;
  let watcher: fs.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let reopenTimer: NodeJS.Timeout | undefined;
  let failures = 0;
  let overflows = 0;
  let notedAt = -Infinity;
  let stopped = false;

  const callerPath = (rel: string): string => path.join(dir, rel);

  // undefined while the snapshot has no such directory; the listing queued for an ancestor reports what it holds.
  const childrenOf = (rel: string): Map<string, FsEntry> | undefined => {
    let children: Map<string, FsEntry> | undefined = root;
    if (rel !== '') for (const part of rel.split(path.sep)) children = children?.get(part)?.children;
    return children;
  };

  const reportDeleted = (entry: FsEntry, rel: string): void => {
    for (const [name, child] of entry.children ?? []) reportDeleted(child, path.join(rel, name));
    emit('delete', callerPath(rel));
  };

  // Brings the entry for name in line with stat (undefined: nothing there) and reports the difference; returns the entry it added.
  const settle = (children: Map<string, FsEntry>, parentRel: string, name: string, stat: fs.BigIntStats | undefined, reportIt: boolean): FsEntry | undefined => {
    const known = children.get(name);
    const rel = path.join(parentRel, name);
    if (known && stat && (known.children !== undefined) === stat.isDirectory()) {
      // A file replaced under its name (an atomic write) is a change; a directory replaced is a delete and a create.
      if (!known.children) {
        if (!sameFile(known, stat)) {
          children.set(name, fsEntry(stat));
          if (reportIt) emit('change', callerPath(rel));
        }
        return undefined;
      }
      if (known.ino === stat.ino) return undefined;
    }
    if (known) {
      children.delete(name);
      if (reportIt) reportDeleted(known, rel);
    }
    if (!stat) return undefined;
    const added = fsEntry(stat);
    children.set(name, added);
    if (reportIt) emit('create', callerPath(rel));
    return added;
  };

  // Diffs one directory against its entries, then each directory under it.
  const scanDir = async (rel: string, children: Map<string, FsEntry>, reportIt: boolean): Promise<void> => {
    let names: string[];
    try {
      names = await fs.promises.readdir(path.join(real, rel));
    } catch (err) {
      // A directory gone since it was queued is removed by its own events, or by the next full scan.
      if (!isGoneError(err)) log(`[watcher] could not list ${callerPath(rel)}: ${errorText(err)}`);
      return;
    }
    if (stopped) return;
    const listed = names.filter((name) => !isRecursiveIgnored(toGlobPath(path.join(rel, name))));
    const stats = await Promise.all(listed.map((name) => lstatLater(path.join(real, rel, name), log)));
    if (stopped) return;
    const present = new Set<string>();
    listed.forEach((name, index) => {
      const stat = stats[index];
      if (!stat) return;
      present.add(name);
      settle(children, rel, name, stat, reportIt);
    });
    for (const name of [...children.keys()]) if (!present.has(name)) settle(children, rel, name, undefined, reportIt);
    for (const [name, entry] of [...children]) {
      if (stopped) return;
      if (entry.children) await scanDir(path.join(rel, name), entry.children, reportIt);
    }
  };

  const runScans = async (): Promise<void> => {
    try {
      for (let scan = scans.shift(); scan && !stopped; scan = scans.shift()) {
        // A directory removed since it was queued is no longer the snapshot's.
        if (childrenOf(scan.rel) === scan.children) await scanDir(scan.rel, scan.children, scan.report);
      }
    } finally {
      scanning = false;
    }
    flush();
  };

  // Scans run one at a time and never while a flush settles events, so each diffs a snapshot nothing else is changing.
  const startScans = (): void => {
    if (scanning || stopped || scans.length === 0) return;
    scanning = true;
    track(runScans()).catch((err: unknown) => log(`[watcher] scanning ${dir} failed: ${errorText(err)}`));
  };

  // A full scan already running gets one successor, since it may have listed a directory before the changes it missed.
  const rescan = (): void => {
    if (!scans.some((scan) => scan.children === root)) scans.push({ rel: '', children: root, report: true });
    startScans();
  };

  const overflowed = (): void => {
    overflows++;
    const now = Date.now();
    if (now - notedAt >= RESCAN_NOTE_MS) {
      log(`[watcher] ${dir}: more changes than one Windows change notification holds (${overflows} since the last note); rescanning`);
      notedAt = now;
      overflows = 0;
    }
    rescan();
  };

  const namesOnDisk = (rel: string): ReadonlySet<string> | undefined => {
    try {
      return new Set(fs.readdirSync(path.join(real, path.dirname(rel))));
    } catch {
      return undefined;
    }
  };

  // onDisk: the names the parent lists, when the batch names one entry in two cases; lstat would find it under either.
  const reconcile = (rel: string, onDisk: ReadonlySet<string> | undefined): void => {
    const cut = rel.lastIndexOf(path.sep);
    const parentRel = cut < 0 ? '' : rel.slice(0, cut);
    const name = rel.slice(cut + 1);
    const children = childrenOf(parentRel);
    if (!children) return;
    const stat = onDisk && !onDisk.has(name) ? undefined : lstatNow(path.join(real, rel), log);
    const added = settle(children, parentRel, name, stat, true);
    // A directory created in place reports its contents through events, one moved in only through this listing.
    if (added?.children) scans.push({ rel, children: added.children, report: true });
  };

  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (scanning || stopped) return;
    // A case-only rename reports both names, which fold to one.
    const byFold = new Map<string, string[]>();
    for (const rel of pending) {
      const fold = rel.toLowerCase();
      const same = byFold.get(fold);
      if (same) same.push(rel);
      else byFold.set(fold, [rel]);
    }
    pending.clear();
    for (const rels of byFold.values()) {
      const onDisk = rels.length > 1 ? namesOnDisk(rels[0]!) : undefined;
      for (const rel of rels) reconcile(rel, onDisk);
      if (stopped) return;
    }
    // A root renamed away keeps its handle, which goes on reporting from the new place.
    if (!fs.existsSync(dir)) {
      gone();
      return;
    }
    startScans();
  };

  const stop = (): void => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(reopenTimer);
    timer = undefined;
    reopenTimer = undefined;
    pending.clear();
    scans.length = 0;
    watcher?.close();
    watcher = undefined;
  };

  const gone = (): void => {
    if (stopped) return;
    stop();
    for (const [name, entry] of root) reportDeleted(entry, name);
    root.clear();
    lost();
  };

  // The handle is dead or must close; a root still there is watched again after a delay that grows while that keeps failing.
  const reopenLater = (): void => {
    watcher?.close();
    watcher = undefined;
    if (!fs.existsSync(dir)) {
      gone();
      return;
    }
    const delay = Math.min(REOPEN_MAX_MS, REOPEN_FIRST_MS * 2 ** failures++);
    log(`[watcher] watching ${dir} again in ${delay} ms`);
    clearTimeout(reopenTimer);
    reopenTimer = setTimeout(() => {
      reopenTimer = undefined;
      if (stopped) return;
      try {
        open();
      } catch (err) {
        log(`[watcher] could not watch ${dir} again: ${errorText(err)}`);
        reopenLater();
        return;
      }
      // What changed while no handle was open is found by the diff.
      scans.push({ rel: '', children: root, report: true });
      startScans();
    }, delay);
  };

  const onEvent = (_eventType: string, filename: string | null): void => {
    if (stopped) return;
    if (filename === null) {
      overflowed();
      return;
    }
    // libuv names the watched directory itself, by absolute path, once it is deleted, and again on every read until the handle closes.
    if (path.isAbsolute(filename)) {
      reopenLater();
      return;
    }
    failures = 0;
    // Before any syscall, so a busy node_modules costs nothing beyond the event.
    if (isRecursiveIgnored(toGlobPath(filename))) return;
    pending.add(filename);
    timer ??= setTimeout(flush, SHALLOW_COALESCE_MS);
  };

  const open = (): void => {
    const handle = fs.watch(real, { recursive: true }, onEvent);
    // Node has closed the handle by the time it reports the error.
    handle.on('error', (err) => {
      if (handle !== watcher) return;
      log(`[watcher] ${dir}: ${err.message}`);
      reopenLater();
    });
    watcher = handle;
  };

  open();
  scans.push({ rel: '', children: root, report });
  startScans();
  return { dispose: stop };
}

/** Where the Windows recursive watches run: this thread's event loop; main uses the watch worker's (watch-worker-host.ts). */
export interface FsWatchTreeHost {
  // report: the first scan reports what the root holds as created. lost: the root is gone, and its files were reported deleted.
  start(dir: string, report: boolean, emit: RawListener, lost: () => void): Disposable;
  // Settles once no scan of a watch it started is running; the caller has disposed every watch first.
  close(): Promise<void>;
}

/** Runs each watch on this thread's event loop. */
export function createInProcessTreeHost(log: Log): FsWatchTreeHost {
  const work = new Set<Promise<unknown>>();
  const track: TrackWork = (promise) => {
    work.add(promise);
    const settled = (): void => {
      work.delete(promise);
    };
    promise.then(settled, settled);
    return promise;
  };
  return {
    start: (dir, report, emit, lost) => startFsWatchTree(dir, report, emit, lost, log, track),
    close: () => settlePending(() => work),
  };
}
