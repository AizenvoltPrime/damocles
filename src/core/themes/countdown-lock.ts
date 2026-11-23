// The lock a Damocles app holds for as long as it counts a keep-changes countdown (docs/invariants.md "Desktop themes"). The
// apps that share the themes folder test it, so a start reverts only a countdown no running app counts.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { COUNTDOWN_OWNER } from '../../shared/themes/agent';
import { checkConfigPath, ConfigWriteRefused } from '../config/local-config-path';
import { LOCK_STALE_MS, LOCK_UPDATE_MS } from './write-lane';

// After this long a lock that is still held was refreshed since the last look, so its owner runs.
export const COUNTDOWN_RECHECK_MS: number = LOCK_STALE_MS + 2 * LOCK_UPDATE_MS;

/** The lock folder of `owner` under the themes root. */
export const countdownLockPath = (root: string, owner: string): string => path.join(root, `.countdown-${owner}`);

// On Windows a lock folder another process is removing fails mkdir with EPERM until it is gone.
const isBusy = (err: unknown): boolean => {
  const { code } = err as NodeJS.ErrnoException;
  return code === 'ELOCKED' || (process.platform === 'win32' && code === 'EPERM');
};

/** Each method runs inside the store's write lane. */
export interface CountdownLock {
  // this app, as a mark names it
  readonly owner: string;
  // this app counts a countdown: its lock is held until release
  hold(): Promise<void>;
  release(): Promise<void>;
  // whether no running app holds the lock of `owner`, another app; a lock its owner stopped refreshing is taken and let go
  gone(owner: string): Promise<boolean>;
}

export function createCountdownLock(root: string, owner: string, log?: (line: string) => void): CountdownLock {
  if (!COUNTDOWN_OWNER.test(owner)) throw new Error('The keep-changes countdown owner is not valid');
  const own = countdownLockPath(root, owner);
  const said = (what: string) => (err: unknown): void => log?.(`[themes] ${what}: ${err instanceof Error ? err.message : String(err)}`);
  // proper-lockfile keeps its locks by the file locked, so each lock names its own folder, never the root the lane locks
  const options = (lockfilePath: string) => ({ realpath: false, lockfilePath, stale: LOCK_STALE_MS, update: LOCK_UPDATE_MS });
  const checked = async (lockfilePath: string): Promise<void> => {
    if ((await checkConfigPath(root, lockfilePath)) !== 'ok') throw new ConfigWriteRefused(lockfilePath);
  };
  let wanted = false;
  let held: { readonly release: () => Promise<void> } | undefined;
  let taking: Promise<void> | undefined;
  const take = async (): Promise<void> => {
    await checked(own);
    // one core of this app runs at a time, so a lock at its own path is one a core that ended left
    await fs.rm(own, { recursive: true, force: true });
    const mine: { release: () => Promise<void> } = {
      release: await lockfile.lock(own, {
        ...options(own),
        onCompromised: (err) => {
          if (held !== mine) return;
          held = undefined;
          said('the keep-changes countdown lock was lost')(err);
          // an app that still counts takes its lock again, or a start elsewhere would take it for gone
          if (wanted) hold().catch(said('the keep-changes countdown lock was not taken again'));
        },
      }),
    };
    held = mine;
  };
  const hold = (): Promise<void> => {
    wanted = true;
    if (held) return Promise.resolve();
    taking ??= take().finally(() => {
      taking = undefined;
    });
    return taking;
  };
  return {
    owner,
    hold,
    async release() {
      wanted = false;
      await taking?.catch(() => undefined);
      const mine = held;
      held = undefined;
      // an unreleased lock only goes stale, after which a start takes its owner for gone, as it is
      await mine?.release().catch(said('the keep-changes countdown lock was not released'));
    },
    async gone(other) {
      const file = countdownLockPath(root, other);
      await checked(file);
      let release: () => Promise<void>;
      try {
        release = await lockfile.lock(file, { ...options(file), retries: 0, onCompromised: () => undefined });
      } catch (err) {
        if (isBusy(err)) return false;
        throw err;
      }
      await release().catch(said('the lock of a keep-changes countdown whose owner is gone was not removed'));
      return true;
    },
  };
}
