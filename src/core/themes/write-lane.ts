import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { LocalizedError } from '../../shared/localized-text';
import { checkConfigPath, ConfigWriteRefused } from '../config/local-config-path';
import { errorTextOf, l } from '../l10n';

// The stale and wait settings of memory-outbox.ts and design-state.ts: a holder that stops refreshing for 20 s is gone.
export const LOCK_STALE_MS = 20_000;
export const LOCK_UPDATE_MS = 2_000;
const LOCK_WAIT = { retries: 150, factor: 1.3, minTimeout: 5, maxTimeout: 250, randomize: true };

export const LOCK_NAME = '.lock';

/** Runs every write to the theme store one at a time in this process, each holding the store's lock against other processes. */
export interface WriteLane {
  run<T>(body: () => Promise<T>): Promise<T>;
  // throws once the running body's lock was lost; a writer calls it immediately before each rename or delete
  held(): void;
}

/** The lane of the store at `root`; the dev and packaged apps share `~/.damocles`, so the lock is a folder both honour. */
export function createWriteLane(root: string, log?: (line: string) => void): WriteLane {
  let tail: Promise<unknown> = Promise.resolve();
  // of the one body that runs now
  let lost: Error | undefined;
  const lockfilePath = path.join(root, LOCK_NAME);
  const locked = async <T>(body: () => Promise<T>): Promise<T> => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if ((await checkConfigPath(root, lockfilePath)) !== 'ok') throw new ConfigWriteRefused(lockfilePath);
    lost = undefined;
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(root, {
        realpath: false,
        lockfilePath,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
        retries: LOCK_WAIT,
        onCompromised: (err) => {
          lost = err;
        },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOCKED') throw new LocalizedError(l('Another Damocles is changing the themes. Try again in a moment.'), { cause: err });
      throw new LocalizedError(l('Damocles could not lock the theme folder: {0}', errorTextOf(err)), { cause: err });
    }
    try {
      return await body();
    } finally {
      // the body's outcome stands whatever the release does: its writes landed or failed, and an unreleased lock only goes stale
      if (!lost) {
        await release().catch((err: unknown) => log?.(`[themes] the lock on ${root} was not released; it goes stale in ${LOCK_STALE_MS / 1000} s: ${err instanceof Error ? err.message : String(err)}`));
      }
      lost = undefined;
    }
  };
  return {
    run<T>(body: () => Promise<T>): Promise<T> {
      const next = tail.then(() => locked(body));
      tail = next.catch(() => undefined);
      return next;
    },
    held() {
      if (lost) throw new LocalizedError(l('The lock on the theme folder was lost, so the change stopped before its next write. Try again.'), { cause: lost });
    },
  };
}
