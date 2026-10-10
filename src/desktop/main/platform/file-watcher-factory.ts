import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackendType, Options, SubscribeCallback } from '@parcel/watcher';
import picomatch from 'picomatch';
import type { Disposable } from '../../../platform/disposable';
import type { FileRename, FileWatcher, FileWatcherFactory } from '../../../platform/file-watcher';
import type { WorkspaceFolders } from '../../../platform/workspace-folders';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { settlePending } from '../../../shared/settle-pending';
import {
  errorText,
  isRecursiveIgnored,
  lstatLater,
  lstatNow,
  RECURSIVE_IGNORE,
  SHALLOW_COALESCE_MS,
  toGlobPath,
  type FsWatchTreeHost,
  type Log,
  type RawEventType,
  type RawListener,
  type TrackWork,
} from '../../watch-worker/fs-watch-tree';
import { Emitter } from './emitter';

// Bound on the synthetic create events replayed for a directory that appears after its watch started.
const REPLAY_LIMIT = 10_000;

// A glob with no separator and no globstar matches direct children only, so a non-recursive watch covers it; this keeps a
// watch like (home, '.claude.json') from subscribing to the whole home tree.
export function isShallowGlob(glob: string): boolean {
  return !glob.includes('/') && !glob.includes('**');
}

/** The directory to subscribe to for (base, glob): the glob's static prefix under base, recursive only when the rest needs it. */
export function watchRoot(base: string, glob: string): { readonly root: string; readonly recursive: boolean } {
  const scan = picomatch.scan(glob);
  const prefix = scan.isGlob ? scan.base : path.posix.dirname(glob);
  const rest = scan.isGlob ? scan.glob : path.posix.basename(glob);
  return { root: path.resolve(base, prefix), recursive: !isShallowGlob(rest) };
}

// Linux watches recursively with startInotifyTree; @parcel/watcher's inotify backend never lists a directory created or moved in
// after the watch started, so it misses what is inside and never watches its subdirectories (parcel-bundler/watcher#97).
const USE_INOTIFY_TREE = process.platform === 'linux';
// Windows watches recursively on the FsWatchTreeHost and never loads @parcel/watcher: its Windows backend frees a subscription
// while its ReadDirectoryChangesW read is still pending (parcel-bundler/watcher#262), which crashed the process on quit and unwatch.
const USE_FS_WATCH_TREE = process.platform === 'win32';

// @parcel/watcher runs on macOS only, and otherwise probes for a watchman binary on every subscribe.
const PARCEL_BACKEND: BackendType = 'fs-events';

function ignoredUnder(root: string, fsPath: string): boolean {
  return isRecursiveIgnored(toGlobPath(path.relative(root, fsPath)));
}

function isStrictlyInside(relative: string): boolean {
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function nearestExistingAncestor(dir: string): string | undefined {
  let current = path.dirname(dir);
  while (!fs.existsSync(current)) {
    const up = path.dirname(current);
    if (up === current) return undefined;
    current = up;
  }
  return current;
}

// start(appeared, lost) runs while dir exists; lost() hands the directory back to waiting, so a deleted root resumes once recreated.
// Until then a non-recursive watch on its nearest existing ancestor waits for it.
function watchWhileExists(
  dir: string,
  start: (appeared: boolean, lost: () => void) => Disposable,
  log: Log,
): Disposable {
  let disposed = false;
  let started: Disposable | undefined;
  let waiting: { ancestor: string; watcher: fs.FSWatcher } | undefined;
  const stopWaiting = (): void => {
    waiting?.watcher.close();
    waiting = undefined;
  };
  const lost = (): void => {
    if (disposed || !started) return;
    started.dispose();
    started = undefined;
    log(`[watcher] ${dir} is gone; watching for it to come back`);
    check(true);
  };
  const check = (appeared: boolean): void => {
    if (disposed || started) return;
    try {
      if (fs.existsSync(dir)) {
        stopWaiting();
        try {
          started = start(appeared, lost);
          return;
        } catch (err) {
          log(`[watcher] could not watch ${dir}: ${errorText(err)}`);
          // Only a directory that vanished while the watch started is waited for again; any other failure stays logged.
          if (fs.existsSync(dir)) return;
        }
      }
      const ancestor = nearestExistingAncestor(dir);
      if (ancestor === undefined || ancestor === waiting?.ancestor) return;
      stopWaiting();
      const watcher = fs.watch(ancestor, () => check(true));
      watcher.on('error', (err) => {
        log(`[watcher] waiting on ${ancestor} for ${dir} failed: ${err.message}`);
        if (waiting?.watcher !== watcher) return;
        stopWaiting();
        check(true);
      });
      waiting = { ancestor, watcher };
      // The directory may have appeared between the existence check and the watch.
      if (fs.existsSync(dir)) check(true);
    } catch (err) {
      log(`[watcher] could not watch ${dir}: ${errorText(err)}`);
    }
  };
  check(false);
  return {
    dispose: () => {
      disposed = true;
      stopWaiting();
      started?.dispose();
      started = undefined;
    },
  };
}

function replayExisting(dir: string, recursive: boolean, emit: RawListener, log: Log, isIgnored: (fsPath: string) => boolean = () => false): void {
  let budget = REPLAY_LIMIT;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      log(`[watcher] could not list ${current}: ${errorText(err)}`);
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const full = path.join(current, entry.name);
      if (isIgnored(full)) continue;
      emit('create', full);
      if (recursive && entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
}

function startShallow(dir: string, emit: RawListener, lost: () => void, log: Log): Disposable {
  const present = new Set(fs.readdirSync(dir));
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    timer = undefined;
    for (const name of pending) {
      const full = path.join(dir, name);
      if (!fs.existsSync(full)) {
        if (present.delete(name)) emit('delete', full);
      } else if (!present.has(name)) {
        present.add(name);
        emit('create', full);
      } else {
        // A rename onto an existing name (an atomic write) replaces the file; to a watcher of its path that is a change.
        emit('change', full);
      }
    }
    pending.clear();
  };
  const gone = (): void => {
    clearTimeout(timer);
    timer = undefined;
    pending.clear();
    for (const name of present) emit('delete', path.join(dir, name));
    present.clear();
    lost();
  };
  // Windows reports a deleted watched directory as an endless run of rename events naming the directory itself.
  const watcher = fs.watch(dir, (_eventType, filename) => {
    if (!fs.existsSync(dir)) {
      gone();
      return;
    }
    if (filename === null) return;
    pending.add(filename.toString());
    timer ??= setTimeout(flush, SHALLOW_COALESCE_MS);
  });
  watcher.on('error', (err) => {
    log(`[watcher] ${dir}: ${err.message}`);
    if (!fs.existsSync(dir)) gone();
  });
  return {
    dispose: () => {
      clearTimeout(timer);
      watcher.close();
    },
  };
}

// The OS watch covers the whole tree, but a directory moved in arrives as one create with nothing for what it holds, so it is listed.
// Every subscribe and unsubscribe goes through track, so the factory's close() can wait for it.
function startParcel(dir: string, emit: RawListener, lost: () => void, log: Log, track: TrackWork): Disposable {
  // FSEvents reports real paths, so a root under a symlink (/var is /private/var on macOS) is watched at its real path and events map back to dir.
  const real = fs.realpathSync.native(dir);
  const toCaller = (eventPath: string): string => (real === dir ? eventPath : path.join(dir, path.relative(real, eventPath)));
  let disposed = false;
  const checkRoot = (): void => {
    if (!disposed && !fs.existsSync(dir)) lost();
  };
  const onEvents: SubscribeCallback = (err, events) => {
    if (disposed) return;
    if (err) log(`[watcher] ${dir}: ${err.message}`);
    const reported = new Set(events.map((event) => event.path));
    for (const event of events) emit(event.type === 'update' ? 'change' : event.type, toCaller(event.path));
    for (const event of events) {
      if (event.type !== 'create' || !lstatNow(event.path, log)?.isDirectory()) continue;
      replayExisting(event.path, true, (type, fsPath) => {
        if (reported.has(fsPath)) return;
        reported.add(fsPath);
        emit(type, toCaller(fsPath));
      }, log, (fsPath) => ignoredUnder(real, fsPath));
    }
    checkRoot();
  };
  const options: Options = { ignore: RECURSIVE_IGNORE, backend: PARCEL_BACKEND };
  // undefined when the subscribe failed, or was never made because the watch was disposed while the module loaded
  const subscribed = track(import('@parcel/watcher').then((parcel) => (disposed ? undefined : parcel.subscribe(real, onEvents, options)))).catch((err: unknown) => {
    log(`[watcher] could not watch ${dir}: ${errorText(err)}`);
    checkRoot();
    return undefined;
  });
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // A subscribe still running is unsubscribed once it lands.
      track(subscribed.then((subscription) => subscription?.unsubscribe())).catch((err: unknown) => log(`[watcher] could not stop watching ${dir}: ${errorText(err)}`));
    },
  };
}

interface TreeEntry {
  readonly isDir: boolean;
  // Identity when last reported; absent for a file the startup scan found, so any later event on it is reported as a change.
  readonly ino?: bigint;
  readonly ctimeNs?: bigint;
}

interface TreeDir {
  readonly watcher: fs.FSWatcher;
  readonly entries: Map<string, TreeEntry>;
}

function treeEntry(stat: fs.BigIntStats): TreeEntry {
  return { isDir: stat.isDirectory(), ino: stat.ino, ctimeNs: stat.ctimeNs };
}

// One non-recursive inotify watch per directory. A directory is watched before it is listed, as inotify(7) prescribes for a subtree,
// so nothing created in between is missed. Events are diffed against the entries already reported, so each one names a real change.
function startInotifyTree(root: string, emit: RawListener, lost: () => void, log: Log): Disposable {
  const dirs = new Map<string, TreeDir>();
  // Per directory: the names with raw events since the last flush, and whether any of them was a content change.
  const pending = new Map<string, Map<string, boolean>>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const remove = (node: TreeDir, dir: string, name: string): void => {
    const entry = node.entries.get(name);
    if (!entry) return;
    node.entries.delete(name);
    const full = path.join(dir, name);
    if (entry.isDir) unwatch(full);
    emit('delete', full);
  };

  const unwatch = (dir: string): void => {
    const node = dirs.get(dir);
    if (!node) return;
    dirs.delete(dir);
    pending.delete(dir);
    node.watcher.close();
    for (const name of [...node.entries.keys()]) remove(node, dir, name);
  };

  // report: the entry is new since the watch started, so it and everything under it are reported as created.
  const add = (node: TreeDir, dir: string, name: string, entry: TreeEntry, report: boolean): void => {
    node.entries.set(name, entry);
    const full = path.join(dir, name);
    if (report) emit('create', full);
    if (entry.isDir) watchDir(full, report);
  };

  const list = async (node: TreeDir, dir: string, report: boolean): Promise<void> => {
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      log(`[watcher] could not list ${dir}: ${errorText(err)}`);
      return;
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (ignoredUnder(root, full)) continue;
      // The startup scan stats directories only, whose inode tells a replacement apart; a reported entry keeps its identity too.
      let entry: TreeEntry = { isDir: false };
      if (report || dirent.isDirectory()) {
        const stat = await lstatLater(full, log);
        if (!stat) continue;
        entry = treeEntry(stat);
      }
      // An event flushed while the listing awaited may have added the entry already, or removed this directory.
      if (stopped || dirs.get(dir) !== node || node.entries.has(dirent.name)) continue;
      add(node, dir, dirent.name, entry, report);
    }
  };

  const watchDir = (dir: string, report: boolean): void => {
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, (eventType, filename) => queue(dir, eventType, filename));
    } catch (err) {
      if (dir === root) throw err;
      const limit = (err as NodeJS.ErrnoException).code === 'ENOSPC' ? '; the inotify watch limit (fs.inotify.max_user_watches) is reached' : '';
      log(`[watcher] could not watch ${dir}: ${errorText(err)}${limit}`);
      return;
    }
    watcher.on('error', (err) => {
      log(`[watcher] ${dir}: ${err.message}`);
      if (dir === root && !fs.existsSync(root)) gone();
    });
    const node: TreeDir = { watcher, entries: new Map() };
    dirs.set(dir, node);
    void list(node, dir, report);
  };

  const reconcile = (node: TreeDir, dir: string, name: string, sawChange: boolean): void => {
    const full = path.join(dir, name);
    if (ignoredUnder(root, full)) return;
    const known = node.entries.get(name);
    const stat = lstatNow(full, log);
    if (!known) {
      if (stat) add(node, dir, name, treeEntry(stat), true);
      return;
    }
    if (!stat || stat.isDirectory() !== known.isDir || (known.isDir && stat.ino !== known.ino)) {
      remove(node, dir, name);
      if (stat) add(node, dir, name, treeEntry(stat), true);
      return;
    }
    if (known.isDir) {
      if (sawChange) emit('change', full);
      return;
    }
    // A rename onto the name (an atomic write) brings a new inode; an event for the file a listing already reported changes nothing.
    const unchanged = stat.ino === known.ino && stat.ctimeNs === known.ctimeNs;
    node.entries.set(name, treeEntry(stat));
    if (sawChange || !unchanged) emit('change', full);
  };

  const flush = (): void => {
    timer = undefined;
    const batch = [...pending];
    pending.clear();
    for (const [dir, names] of batch) {
      for (const [name, sawChange] of names) {
        const node = dirs.get(dir);
        if (node) reconcile(node, dir, name, sawChange);
      }
    }
  };

  const queue = (dir: string, eventType: string, filename: string | Buffer | null): void => {
    if (stopped) return;
    if (dir === root && !fs.existsSync(root)) {
      gone();
      return;
    }
    if (filename === null || !dirs.has(dir)) return;
    let names = pending.get(dir);
    if (!names) pending.set(dir, (names = new Map()));
    const name = filename.toString();
    names.set(name, names.get(name) === true || eventType === 'change');
    timer ??= setTimeout(flush, SHALLOW_COALESCE_MS);
  };

  const gone = (): void => {
    if (stopped) return;
    clearTimeout(timer);
    timer = undefined;
    pending.clear();
    unwatch(root);
    stopped = true;
    lost();
  };

  watchDir(root, false);
  return {
    dispose: () => {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
      for (const node of dirs.values()) node.watcher.close();
      dirs.clear();
    },
  };
}

interface RootEntry {
  readonly listeners: Set<RawListener>;
  readonly source: Disposable;
}

class EventFan implements FileWatcher {
  private readonly create: Emitter<[string]>;
  private readonly change: Emitter<[string]>;
  private readonly remove: Emitter<[string]>;
  private readonly release: () => void;

  constructor(log: Log, release: () => void) {
    this.create = new Emitter('watcher', log);
    this.change = new Emitter('watcher', log);
    this.remove = new Emitter('watcher', log);
    this.release = release;
  }

  deliver(type: RawEventType, fsPath: string): void {
    if (type === 'create') this.create.fire(fsPath);
    else if (type === 'change') this.change.fire(fsPath);
    else this.remove.fire(fsPath);
  }

  onDidCreate(cb: (fsPath: string) => void): Disposable {
    return this.create.add(cb);
  }

  onDidChange(cb: (fsPath: string) => void): Disposable {
    return this.change.add(cb);
  }

  onDidDelete(cb: (fsPath: string) => void): Disposable {
    return this.remove.add(cb);
  }

  dispose(): void {
    this.release();
    this.create.clear();
    this.change.clear();
    this.remove.clear();
  }
}

/**
 * One watch shared per root, filtered by picomatch: recursive on the Windows tree host (Windows), startInotifyTree (Linux) or
 * @parcel/watcher (macOS), non-recursive fs.watch for direct-children globs.
 */
export class DesktopFileWatcherFactory implements FileWatcherFactory {
  private readonly roots = new Map<string, RootEntry>();
  private readonly folders: WorkspaceFolders;
  private readonly log: Log;
  private readonly windowsTree: FsWatchTreeHost;
  // @parcel/watcher subscribes and unsubscribes still running.
  private readonly work = new Set<Promise<unknown>>();
  private closed = false;
  private readonly track: TrackWork = (work) => {
    this.work.add(work);
    const settled = (): void => {
      this.work.delete(work);
    };
    work.then(settled, settled);
    return work;
  };

  // windowsTree runs every recursive watch on Windows.
  constructor(folders: WorkspaceFolders, log: Log, windowsTree: FsWatchTreeHost) {
    this.folders = folders;
    this.log = log;
    this.windowsTree = windowsTree;
  }

  // Never throws: a watch that cannot start is logged and fires nothing, as a VS Code watcher on a missing path does.
  watch(base: string, glob: string): FileWatcher {
    let release = (): void => undefined;
    const fan = new EventFan(this.log, () => release());
    try {
      const root = path.resolve(base);
      const matches = picomatch(glob, { dot: true, nocase: process.platform === 'win32' });
      const listener: RawListener = (type, fsPath) => {
        const relative = path.relative(root, fsPath);
        if (isStrictlyInside(relative) && matches(toGlobPath(relative))) fan.deliver(type, fsPath);
      };
      const { root: watched, recursive } = watchRoot(root, glob);
      release = this.subscribe(watched, recursive, listener);
    } catch (err) {
      this.log(`[watcher] could not watch ${glob} under ${base}: ${errorText(err)}`);
    }
    return fan;
  }

  // The glob is matched against each open project folder's relative paths, following the project list.
  watchWorkspace(glob: string): FileWatcher {
    const perFolder = new Map<string, FileWatcher>();
    const sync = (): void => {
      const wanted = new Map(this.folders.folders().map((folder) => [folderKey(folder.fsPath), folder.fsPath]));
      for (const [key, watcher] of perFolder) {
        if (wanted.has(key)) continue;
        watcher.dispose();
        perFolder.delete(key);
      }
      for (const [key, fsPath] of wanted) {
        if (perFolder.has(key)) continue;
        const watcher = this.watch(fsPath, glob);
        // Disposing the folder's watcher drops these listeners with it.
        watcher.onDidCreate((p) => fan.deliver('create', p));
        watcher.onDidChange((p) => fan.deliver('change', p));
        watcher.onDidDelete((p) => fan.deliver('delete', p));
        perFolder.set(key, watcher);
      }
    };
    const folderSubscription = this.folders.onDidChange(sync);
    const fan = new EventFan(this.log, () => {
      folderSubscription.dispose();
      for (const watcher of perFolder.values()) watcher.dispose();
      perFolder.clear();
    });
    sync();
    return fan;
  }

  // No rename is reported, the Files section's own included: a rename reaches watchers as delete + create.
  onDidRenameFiles(_cb: (renames: readonly FileRename[]) => void): Disposable {
    return { dispose: () => undefined };
  }

  /**
   * Stops every watch and settles once no @parcel/watcher subscribe or unsubscribe and no Windows tree scan is running, and the
   * Windows tree host has stopped; a watch made after it began fires nothing. The quit awaits it: a parcel completion while Node
   * frees its environment aborts the process.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.roots.values()) entry.source.dispose();
    this.roots.clear();
    await Promise.all([settlePending(() => this.work), this.windowsTree.close()]);
  }

  private subscribe(root: string, recursive: boolean, listener: RawListener): () => void {
    if (this.closed) return () => undefined;
    const key = `${recursive ? 'r' : 's'}:${folderKey(root)}`;
    let entry = this.roots.get(key);
    if (!entry) {
      const listeners = new Set<RawListener>();
      const emit: RawListener = (type, fsPath) => {
        for (const each of [...listeners]) each(type, fsPath);
      };
      const { log, track, windowsTree } = this;
      const source = watchWhileExists(root, (appeared, lost) => {
        // Its first scan reports what a root that appeared holds, and the events after it are diffed against that scan.
        if (recursive && USE_FS_WATCH_TREE) return windowsTree.start(root, appeared, emit, lost);
        let started: Disposable;
        if (!recursive) started = startShallow(root, emit, lost, log);
        else started = USE_INOTIFY_TREE ? startInotifyTree(root, emit, lost, log) : startParcel(root, emit, lost, log, track);
        let live = true;
        // Deferred, so a watcher whose directory appears while watch() runs has its listeners before the replay.
        if (appeared) queueMicrotask(() => {
          if (live) replayExisting(root, recursive, emit, log, (fsPath) => recursive && ignoredUnder(root, fsPath));
        });
        return {
          dispose: () => {
            live = false;
            started.dispose();
          },
        };
      }, log);
      entry = { listeners, source };
      this.roots.set(key, entry);
    }
    const current = entry;
    current.listeners.add(listener);
    return () => {
      current.listeners.delete(listener);
      if (current.listeners.size > 0 || this.roots.get(key) !== current) return;
      current.source.dispose();
      this.roots.delete(key);
    };
  }
}
