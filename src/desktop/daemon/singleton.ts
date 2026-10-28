// One daemon per user and host: the mkdir lock in the run folder, which works on NFS too, keeps one owner for every git
// queue (docs/invariants.md "Damocles Core owns every git queue"). The lock decides a race between two starting daemons.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as lockfile from 'proper-lockfile';
import { LOCK_STALE_MS, LOCK_UPDATE_MS, LOCK_WAIT_MS, TAKEOVER_STALE_MS } from './lock-timing';
import { goneFromThisHost, type RunPaths } from './token';

const LOCK_RETRY_MS = 500;
const TAKEOVER_RETRY_MS = 50;

export type DaemonLock = { readonly held: true; release(): Promise<void> } | { readonly held: false };

const ownerLine = (): string => `${os.hostname()} ${process.pid}\n`;

// Windows refuses a mkdir (EPERM) while a holder's release is still removing the same folder
const busy = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ELOCKED' || (code === 'EPERM' && process.platform === 'win32');
};

/** Whether the owner file names a process of this host that has ended, so the lock has no holder. */
async function holderGone(paths: RunPaths): Promise<boolean> {
  const owner = /^(\S+) (\d+)\n$/.exec(await fs.readFile(paths.lockOwnerFile, 'utf8').catch(() => ''));
  return owner !== null && goneFromThisHost(owner[1], Number(owner[2]));
}

/** Runs `take` under the takeover lock; ELOCKED when another start holds it past the deadline. */
async function underTakeover<T>(paths: RunPaths, deadline: number, take: () => Promise<T>): Promise<T> {
  let release: () => Promise<void>;
  for (;;) {
    try {
      // proper-lockfile keeps it fresh while held, so only a start that died inside leaves it to turn stale. It tracks held
      // locks by resource, so this one's is its own path, not the run folder the daemon lock guards.
      release = await lockfile.lock(paths.lockTakeover, { lockfilePath: paths.lockTakeover, realpath: false, stale: TAKEOVER_STALE_MS, onCompromised: () => undefined });
      break;
    } catch (err) {
      if (!busy(err) || Date.now() >= deadline) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, TAKEOVER_RETRY_MS));
  }
  try {
    return await take();
  } finally {
    await release();
  }
}

/** The lock, or the lock of a holder gone from this host replaced, with this process's owner file written beside it. */
async function takeLock(paths: RunPaths, onCompromised: (error: Error) => void): Promise<() => Promise<void>> {
  const options = { lockfilePath: paths.lockFile, realpath: false, stale: LOCK_STALE_MS, update: LOCK_UPDATE_MS, onCompromised };
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(paths.runDir, options);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ELOCKED' || !(await holderGone(paths))) throw err;
    await fs.rm(paths.lockFile, { recursive: true, force: true });
    release = await lockfile.lock(paths.runDir, options);
  }
  // every reader holds the takeover lock too, so none sees it half written
  try {
    await fs.writeFile(paths.lockOwnerFile, ownerLine());
  } catch (err) {
    await release();
    throw err;
  }
  return release;
}

/**
 * Takes the daemon lock; onCompromised fires if the lock is lost while held. A lock whose owner file names a process of this
 * host that has ended is taken at once. While another daemon holds it, a holder that answers on its endpoint is serving and
 * the start gives up at once. One that does not answer (still starting, shutting down, which closes its endpoint before it
 * releases the lock, or one the start cannot judge) is waited for up to waitMs.
 */
export async function acquireDaemonLock(paths: RunPaths, onCompromised: (error: Error) => void, holderAnswers: () => Promise<boolean>, waitMs: number = LOCK_WAIT_MS): Promise<DaemonLock> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const release = await underTakeover(paths, deadline, () => takeLock(paths, onCompromised));
      return {
        held: true,
        release: async () => {
          if ((await fs.readFile(paths.lockOwnerFile, 'utf8').catch(() => '')) === ownerLine()) await fs.rm(paths.lockOwnerFile, { force: true });
          await release();
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ELOCKED' && !(busy(err) && Date.now() < deadline)) throw err;
    }
    if (Date.now() >= deadline || (await holderAnswers())) return { held: false };
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}
