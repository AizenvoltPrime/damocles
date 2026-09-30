import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../logger';
import { folderKey } from '../../workspace-folders/folder-key';

/**
 * How long a lock's heartbeat may lapse before we treat its owner as dead and break it. A live
 * holder refreshes the lock's mtime every `HEARTBEAT_INTERVAL_MS`, so a lapse this long means the
 * holder's event loop is wedged or the process died mid-operation — not merely a slow git op.
 */
const STALE_LOCK_MS = 30_000;

/**
 * A waiter that polled this long without seeing the heartbeat move breaks the lock even when its recorded
 * pid is alive: a live holder never misses this many heartbeats, so the pid was reused by another process.
 */
const HARD_STALE_LOCK_MS = 10 * 60_000;

/** How often a live holder refreshes its lock's mtime — comfortably inside the stale threshold. */
const HEARTBEAT_INTERVAL_MS = 10_000;

/** How long to wait between attempts to acquire a contended lock. */
const POLL_INTERVAL_MS = 50;

/** Owner-pid file written inside the lock dir, so a stale lock is only broken when its owner is gone. */
const OWNER_PID_FILE = 'owner.pid';

/** Beside the lock dir: written before a stale lock is broken, consumed by the next holder. */
const TAKEOVER_MARKER = '.checkpoint-lock-takeover';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function lockPath(repoDir: string): string {
  return path.join(repoDir, '.checkpoint-lock');
}

/** A wait for the lock ended by the caller's signal before the lock was held. */
export class LockWaitAbortedError extends Error {
  constructor() {
    super('stopped waiting for the checkpoint lock');
    this.name = 'LockWaitAbortedError';
  }
}

/** Record the acquiring process's pid inside the lock dir (best-effort). */
async function writeOwnerPid(dir: string): Promise<void> {
  await fs.promises.writeFile(path.join(dir, OWNER_PID_FILE), String(process.pid), 'utf8').catch(() => undefined);
}

/** `kill(pid, 0)` is a liveness probe, not a signal; EPERM means the process exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether the lock's recorded owner process is still alive. A missing/garbage pid file is treated as
 * NOT alive, so a partially-written lock still gets broken once stale.
 */
async function ownerAlive(dir: string): Promise<boolean> {
  let pid: number;
  try {
    pid = Number.parseInt(await fs.promises.readFile(path.join(dir, OWNER_PID_FILE), 'utf8'), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return pidAlive(pid);
}

/**
 * `fs.mkdir` is atomic on every platform we target, so a successful create is an uncontended
 * acquisition. An `EEXIST` means someone else holds it — we then decide whether to wait or break it.
 */
async function tryAcquire(dir: string): Promise<boolean> {
  try {
    await fs.promises.mkdir(dir, { recursive: false });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Remove a lock directory we hold (recursive — it carries the owner-pid file). Idempotent. */
async function removeLock(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

/**
 * Break a lock believed stale, ATOMICALLY: rename it to a unique sibling first, then remove that.
 * `rename` over an existing target is a single atomic op, so when several waiters race to break the
 * same lock exactly one wins the rename and clears the path; the losers get `ENOENT` and fall back to
 * re-acquiring. The takeover marker goes down first, so whichever process acquires next learns of it.
 */
async function breakStaleLock(dir: string, why: string): Promise<void> {
  await fs.promises.writeFile(path.join(path.dirname(dir), TAKEOVER_MARKER), `${process.pid} ${new Date().toISOString()}\n`, 'utf8');
  const graveyard = `${dir}.stale-${process.pid}-${Date.now()}`;
  try {
    await fs.promises.rename(dir, graveyard);
  } catch {
    // ENOENT: already broken/released by someone else. Any other error (e.g. a transient Windows
    // EPERM while the holder exits): leave it — the caller re-checks age and retries after a poll.
    return;
  }
  log('[Checkpoints] broke the stale lock %s: %s', dir, why);
  await fs.promises.rm(graveyard, { recursive: true, force: true }).catch(() => undefined);
}

/** Consume the takeover marker; true when a stale holder was broken since the last holder saw it. */
async function consumeTakeoverMarker(repoDir: string): Promise<boolean> {
  try {
    await fs.promises.unlink(path.join(repoDir, TAKEOVER_MARKER));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** The lock directory's mtime (its last heartbeat), or `null` when it has vanished. */
async function lockMtime(dir: string): Promise<number | null> {
  try {
    return (await fs.promises.stat(dir)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Resolve with `wait`, or reject with `LockWaitAbortedError` once `signal` aborts first. */
async function unlessAborted(wait: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return wait;
  if (signal.aborted) throw new LockWaitAbortedError();
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      wait,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new LockWaitAbortedError());
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Callers in this process queue here in arrival order before contending for the directory lock, so two
 * sessions sharing a folder repo never poll against each other. Keyed by `folderKey` so two spellings
 * of one directory share a queue.
 */
const inProcessTails = new Map<string, Promise<void>>();

/** Lock options: `signal` bounds the wait; the timings are module defaults that tests shrink. */
export interface LockOptions {
  signal?: AbortSignal;
  staleLockMs?: number;
  hardStaleLockMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
}

/** What the holder learns on acquisition. */
export interface LockHold {
  /** A stale holder was broken since the previous holder released, so its git children may have died mid-write. */
  readonly tookOver: boolean;
}

/**
 * Run `fn` while holding an exclusive, cross-process advisory lock on `repoDir`. The lock is a
 * subdirectory created via atomic `mkdir`; concurrent callers poll until it frees. While `fn` runs we
 * heartbeat the lock's mtime, so a legitimately slow git op is never mistaken for a crash. A holder
 * whose heartbeat lapsed past `STALE_LOCK_MS` is broken once its pid is gone, and regardless of its pid
 * once this waiter has polled `HARD_STALE_LOCK_MS` without seeing the heartbeat move; the break is
 * atomic so two waiters can't both win it.
 * `signal` ends the wait with `LockWaitAbortedError` only before the lock is held; `fn` then always
 * runs to completion. The lock is always released in `finally`.
 */
export async function withRepoLock<T>(repoDir: string, fn: (hold: LockHold) => Promise<T>, options?: LockOptions): Promise<T> {
  const key = folderKey(repoDir);
  const previous = inProcessTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  // Chained on `previous`, so an aborted waiter still keeps everyone behind it after its predecessor.
  const tail = previous.then(() => mine);
  inProcessTails.set(key, tail);
  try {
    await unlessAborted(previous, options?.signal);
    return await withDirLock(repoDir, fn, options);
  } finally {
    release();
    if (inProcessTails.get(key) === tail) inProcessTails.delete(key);
  }
}

async function withDirLock<T>(repoDir: string, fn: (hold: LockHold) => Promise<T>, options?: LockOptions): Promise<T> {
  const staleMs = options?.staleLockMs ?? STALE_LOCK_MS;
  const hardStaleMs = options?.hardStaleLockMs ?? HARD_STALE_LOCK_MS;
  const heartbeatMs = options?.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const pollMs = options?.pollMs ?? POLL_INTERVAL_MS;
  const signal = options?.signal;
  const dir = lockPath(repoDir);
  await fs.promises.mkdir(repoDir, { recursive: true });

  // The hard bound counts only this waiter's own polls of an unchanged heartbeat, never wall-clock
  // age, so a system suspend counts as one poll and never makes a live holder look stale.
  let seenMtimeMs: number | null = null;
  let unchangedMs = 0;
  for (;;) {
    if (signal?.aborted) throw new LockWaitAbortedError();
    if (await tryAcquire(dir)) break;
    const heartbeat = await lockMtime(dir);
    if (heartbeat === null) continue;
    if (heartbeat !== seenMtimeMs) {
      seenMtimeMs = heartbeat;
      unchangedMs = 0;
    }
    const age = Date.now() - heartbeat;
    // A live holder within the hard bound is waited out rather than broken, since a second git on the
    // shared index would corrupt it.
    if (unchangedMs > hardStaleMs) {
      await breakStaleLock(dir, `its heartbeat did not move for ${Math.round(unchangedMs / 1000)} s of polling`);
    } else if (age > staleMs && !(await ownerAlive(dir))) {
      await breakStaleLock(dir, `its owner is gone and its heartbeat lapsed ${Math.round(age / 1000)} s ago`);
    }
    await sleep(pollMs);
    unchangedMs += pollMs;
  }
  await writeOwnerPid(dir);

  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.promises.utimes(dir, now, now).catch(() => undefined);
  }, heartbeatMs);
  // Never let the heartbeat timer alone keep the process alive.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    const tookOver = await consumeTakeoverMarker(repoDir);
    return await fn({ tookOver });
  } finally {
    clearInterval(heartbeat);
    await removeLock(dir).catch(() => undefined);
  }
}
