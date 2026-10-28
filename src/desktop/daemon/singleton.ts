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
// a start whose lock holder does not answer waits this long: a crashed daemon's lock turns stale within LOCK_STALE_MS +
// LOCK_UPDATE_MS, and a daemon shutting down releases it within SHUTDOWN_MAX_MS
export const LOCK_WAIT_MS: number = LOCK_STALE_MS + LOCK_UPDATE_MS + SHUTDOWN_MAX_MS;
const LOCK_RETRY_MS = 500;

export type DaemonLock = { readonly held: true; release(): Promise<void> } | { readonly held: false };

/**
 * Takes the daemon lock; onCompromised fires if the lock is lost while held. While another daemon holds it, a holder that
 * answers on its endpoint is serving and the start gives up at once. One that does not answer (crashed, still starting, or
 * shutting down, which closes its endpoint before it releases the lock) is waited for up to waitMs.
 */
export async function acquireDaemonLock(paths: RunPaths, onCompromised: (error: Error) => void, holderAnswers: () => Promise<boolean>, waitMs: number = LOCK_WAIT_MS): Promise<DaemonLock> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const release = await lockfile.lock(paths.runDir, { lockfilePath: paths.lockFile, realpath: false, stale: LOCK_STALE_MS, update: LOCK_UPDATE_MS, onCompromised });
      return { held: true, release };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows refuses the mkdir (EPERM) while a holder's release is still removing the lock folder
      const releasing = code === 'EPERM' && process.platform === 'win32' && Date.now() < deadline;
      if (code !== 'ELOCKED' && !releasing) throw err;
    }
    if (Date.now() >= deadline || (await holderAnswers())) return { held: false };
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}
