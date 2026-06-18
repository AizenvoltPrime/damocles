import * as fs from 'fs';
import * as path from 'path';

/**
 * How long a lock's heartbeat may lapse before we treat its owner as dead and break it. A live
 * holder refreshes the lock's mtime every `HEARTBEAT_INTERVAL_MS`, so a lapse this long means the
 * holder's event loop is wedged or the process died mid-operation — not merely a slow git op.
 */
const STALE_LOCK_MS = 30_000;

/** How often a live holder refreshes its lock's mtime — comfortably inside the stale threshold. */
const HEARTBEAT_INTERVAL_MS = 10_000;

/** How long to wait between attempts to acquire a contended lock. */
const POLL_INTERVAL_MS = 50;

/** Owner-pid file written inside the lock dir, so a stale lock is only broken when its owner is gone. */
const OWNER_PID_FILE = 'owner.pid';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function lockPath(repoDir: string): string {
  return path.join(repoDir, '.checkpoint-lock');
}

/** Record the acquiring process's pid inside the lock dir (best-effort). */
async function writeOwnerPid(dir: string): Promise<void> {
  await fs.promises.writeFile(path.join(dir, OWNER_PID_FILE), String(process.pid), 'utf8').catch(() => undefined);
}

/**
 * Whether the lock's recorded owner process is still alive (`kill(pid, 0)` is a liveness probe, not a
 * real signal). A missing/garbage pid file is treated as NOT alive, so a legacy or partially-written
 * lock still gets broken once stale — only a confirmed-live owner is spared.
 */
async function ownerAlive(dir: string): Promise<boolean> {
  let pid: number;
  try {
    pid = Number.parseInt(await fs.promises.readFile(path.join(dir, OWNER_PID_FILE), 'utf8'), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but we may not signal it → still alive. ESRCH → gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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
 * re-acquiring. This closes the TOCTOU where two waiters both observe staleness and both acquire.
 */
async function breakStaleLock(dir: string): Promise<void> {
  const graveyard = `${dir}.stale-${process.pid}-${Date.now()}`;
  try {
    await fs.promises.rename(dir, graveyard);
  } catch {
    // ENOENT: already broken/released by someone else. Any other error (e.g. a transient Windows
    // EPERM while the holder exits): leave it — the caller re-checks age and retries after a poll.
    return;
  }
  await fs.promises.rm(graveyard, { recursive: true, force: true }).catch(() => undefined);
}

/** Age of the lock directory in ms (since its last heartbeat), or `null` when it has vanished. */
async function lockAge(dir: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(dir);
    return Date.now() - stat.mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Timing overrides for the lock — production uses the module defaults; tests inject tiny values. */
export interface LockTiming {
  staleLockMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
}

/**
 * Run `fn` while holding an exclusive, cross-process advisory lock on `repoDir`. The lock is a
 * subdirectory created via atomic `mkdir`; concurrent callers poll until it frees. While `fn` runs we
 * heartbeat the lock's mtime, so a legitimately slow git op is never mistaken for a crash; only a
 * holder whose heartbeat has lapsed past ~30s (dead process / wedged event loop) is force-broken, and
 * that break is atomic so two waiters can't both win it. The lock is always released in `finally`.
 */
export async function withRepoLock<T>(repoDir: string, fn: () => Promise<T>, timing?: LockTiming): Promise<T> {
  const staleMs = timing?.staleLockMs ?? STALE_LOCK_MS;
  const heartbeatMs = timing?.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const pollMs = timing?.pollMs ?? POLL_INTERVAL_MS;
  const dir = lockPath(repoDir);
  await fs.promises.mkdir(repoDir, { recursive: true });

  for (;;) {
    if (await tryAcquire(dir)) break;
    const age = await lockAge(dir);
    if (age === null) continue;
    // Break a lapsed lock ONLY when its owner process is truly gone. A live-but-wedged holder (a >30s
    // event-loop stall) keeps its pid alive, so we wait it out rather than run a second git against the
    // shared index and corrupt it.
    if (age > staleMs && !(await ownerAlive(dir))) {
      await breakStaleLock(dir);
    }
    await sleep(pollMs);
  }
  await writeOwnerPid(dir);

  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.promises.utimes(dir, now, now).catch(() => undefined);
  }, heartbeatMs);
  // Never let the heartbeat timer alone keep the process alive.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await removeLock(dir).catch(() => undefined);
  }
}
