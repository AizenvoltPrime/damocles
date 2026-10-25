// One daemon per user and host: the mkdir lock in the run folder, which works on NFS too, keeps one owner for every git
// queue (docs/invariants.md "Damocles Core owns every git queue"). The lock decides a race between two starting daemons.
import * as lockfile from 'proper-lockfile';
import type { RunPaths } from './token';

// proper-lockfile refreshes the lock's mtime this often, and another start takes over a lock older than LOCK_STALE_MS
export const LOCK_UPDATE_MS = 5_000;
export const LOCK_STALE_MS = 20_000;
// a daemon shutting down holds the lock until its last step; its core's close (3 s), the pty host's (2 s) and the
// connections' end (2 s) are the steps with a limit
export const SHUTDOWN_MAX_MS = 10_000;
// a start that finds the lock held waits this long: a crashed daemon's lock turns stale within LOCK_STALE_MS + LOCK_UPDATE_MS,
// and a daemon shutting down releases it within SHUTDOWN_MAX_MS
export const LOCK_WAIT_MS: number = LOCK_STALE_MS + LOCK_UPDATE_MS + SHUTDOWN_MAX_MS;
const LOCK_RETRY_MS = 500;

export type DaemonLock = { readonly held: true; release(): Promise<void> } | { readonly held: false };

/** Takes the daemon lock, waiting up to waitMs while another daemon holds it; onCompromised fires if the lock is lost while held. */
export async function acquireDaemonLock(paths: RunPaths, onCompromised: (error: Error) => void, waitMs: number = LOCK_WAIT_MS): Promise<DaemonLock> {
  try {
    const release = await lockfile.lock(paths.runDir, {
      lockfilePath: paths.lockFile,
      realpath: false,
      retries: { retries: Math.ceil(waitMs / LOCK_RETRY_MS), factor: 1, minTimeout: LOCK_RETRY_MS, maxTimeout: LOCK_RETRY_MS },
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      onCompromised,
    });
    return { held: true, release };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOCKED') return { held: false };
    throw err;
  }
}
