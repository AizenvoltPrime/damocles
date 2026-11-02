// Snapshot polling (docs/invariants.md "File watching modes"): a recursive root is compared every POLL_INTERVAL_MS with
// @parcel/watcher's writeSnapshot and getEventsSince, as VS Code's startPolling does; a direct-children watch compares its
// listing. Neither holds an inotify watch, and @parcel/watcher's subscribe is never used here.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Options } from '@parcel/watcher';
import { errorText, RECURSIVE_IGNORE, type Log, type RawListener, type StartedWatch, type TrackWork } from '../watch-worker/fs-watch-tree';

export const POLL_INTERVAL_MS = 5000;
// the crawl alone, with no native watch backend that would probe for watchman
const SNAPSHOT_OPTIONS: Options = { ignore: RECURSIVE_IGNORE, backend: 'brute-force' };

export interface SnapshotApi {
  writeSnapshot(dir: string, snapshot: string, options: Options): Promise<string>;
  getEventsSince(dir: string, snapshot: string, options: Options): Promise<ReadonlyArray<{ readonly path: string; readonly type: 'create' | 'update' | 'delete' }>>;
}

export interface PollingDeps {
  readonly snapshots: () => Promise<SnapshotApi>;
  readonly tmpdir: () => string;
  readonly intervalMs: number;
}

const exists = (target: string): Promise<boolean> => fs.promises.stat(target).then(() => true, () => false);

const defaultDeps: PollingDeps = { snapshots: () => import('@parcel/watcher'), tmpdir: () => os.tmpdir(), intervalMs: POLL_INTERVAL_MS };

/**
 * Polls root's tree. ready settles once the first snapshot is written, since only changes after it are reported. The snapshots
 * live in a 0700 fs.mkdtemp folder under the OS temp folder, deleted when the watch ends; lost() runs once root is gone, and
 * failed(err) when the first snapshot cannot be taken of a root that is there, as a start that throws.
 */
export function startPolling(root: string, emit: RawListener, lost: () => void, failed: (err: unknown) => void, log: Log, track: TrackWork, deps: PollingDeps = defaultDeps): StartedWatch {
  let disposed = false;
  let timer: NodeJS.Timeout | undefined;
  // the poll running now, which dispose waits for before the folder goes
  let running: Promise<void> = Promise.resolve();
  const folder = fs.promises.mkdtemp(path.join(deps.tmpdir(), 'damocles-poll-'));
  // two snapshot files in turn: the next is written before the events since the current are read, so a change between the two
  // reads is reported twice at most, never lost
  let current = 'a';
  // a failure that persists is logged once, until a poll succeeds again
  let failing = false;

  const schedule = (): void => {
    if (disposed) return;
    timer = setTimeout(() => {
      running = poll();
      void track(running);
    }, deps.intervalMs);
  };

  const poll = async (): Promise<void> => {
    if (disposed) return;
    if (!(await exists(root))) {
      lost();
      return;
    }
    try {
      const [snapshots, dir] = await Promise.all([deps.snapshots(), folder]);
      const next = current === 'a' ? 'b' : 'a';
      await snapshots.writeSnapshot(root, path.join(dir, next), SNAPSHOT_OPTIONS);
      if (disposed) return;
      const events = await snapshots.getEventsSince(root, path.join(dir, current), SNAPSHOT_OPTIONS);
      current = next;
      failing = false;
      if (disposed) return;
      for (const event of events) emit(event.type === 'update' ? 'change' : event.type, event.path);
    } catch (err) {
      if (!failing) log(`[watcher] polling ${root} failed: ${errorText(err)}`);
      failing = true;
      if (!(await exists(root))) {
        lost();
        return;
      }
    }
    schedule();
  };

  const first = track((async () => {
    const [snapshots, dir] = await Promise.all([deps.snapshots(), folder]);
    if (disposed) return;
    await snapshots.writeSnapshot(root, path.join(dir, current), SNAPSHOT_OPTIONS);
  })()).then(schedule, async (err: unknown) => {
    if (disposed) return;
    if (await exists(root)) failed(err);
    else lost();
  });
  running = first;

  return {
    ready: first,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      // a folder mkdtemp could not make failed the start, which said so
      const removed = folder.then((dir) => running.then(() => fs.promises.rm(dir, { recursive: true, force: true })), () => undefined);
      track(removed).catch((err: unknown) => log(`[watcher] could not delete the snapshots of ${root}: ${errorText(err)}`));
    },
  };
}

interface Listed {
  readonly isDir: boolean;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

async function listing(dir: string): Promise<Map<string, Listed>> {
  const entries = new Map<string, Listed>();
  for (const name of await fs.promises.readdir(dir)) {
    const stat = await fs.promises.lstat(path.join(dir, name)).catch((err: NodeJS.ErrnoException) => {
      // removed between the listing and its stat: absent from this listing
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });
    if (stat) entries.set(name, { isDir: stat.isDirectory(), ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  return entries;
}

// A folder's own mtime moves with every entry made or removed inside it, which a native shallow watch never reports.
const changed = (before: Listed, now: Listed): boolean =>
  before.ino !== now.ino || before.isDir !== now.isDir || (!now.isDir && (before.mtimeMs !== now.mtimeMs || before.size !== now.size));

/**
 * Polls dir's direct children: creates, deletes, and a change when a child's inode, or a file's mtime or size, moved. ready
 * after the first listing; failed(err) when that listing fails while dir is there.
 */
export function startShallowPolling(dir: string, emit: RawListener, lost: () => void, failed: (err: unknown) => void, log: Log, track: TrackWork, intervalMs: number = POLL_INTERVAL_MS): StartedWatch {
  let disposed = false;
  let timer: NodeJS.Timeout | undefined;
  let known = new Map<string, Listed>();
  let failing = false;

  const schedule = (): void => {
    if (!disposed) timer = setTimeout(() => void track(poll()), intervalMs);
  };

  const poll = async (): Promise<void> => {
    let now: Map<string, Listed>;
    try {
      now = await listing(dir);
    } catch (err) {
      if (disposed) return;
      if (!(await exists(dir))) {
        for (const name of known.keys()) emit('delete', path.join(dir, name));
        known.clear();
        lost();
        return;
      }
      if (!failing) log(`[watcher] polling ${dir} failed: ${errorText(err)}`);
      failing = true;
      schedule();
      return;
    }
    failing = false;
    if (disposed) return;
    for (const [name, entry] of now) {
      const before = known.get(name);
      if (!before) emit('create', path.join(dir, name));
      else if (changed(before, entry)) emit('change', path.join(dir, name));
    }
    for (const name of known.keys()) if (!now.has(name)) emit('delete', path.join(dir, name));
    known = now;
    schedule();
  };

  const ready = track(listing(dir)).then((first) => {
    known = first;
    schedule();
  }, async (err: unknown) => {
    if (disposed) return;
    if (await exists(dir)) failed(err);
    else lost();
  });

  return {
    ready,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
