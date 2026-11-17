import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';

type FolderCheck = { result: Promise<boolean>; startedAt: number; settledAt: number | null };

/**
 * The file system checks of a process that may hang, counted together: each still running past its timeout holds a thread of
 * the libuv pool every file system call shares, so no new check starts while `maxHung` of them hang.
 */
export interface HungGate {
  /** Whether a new check may start now. */
  admits(): boolean;
  /** Counts `check` from now until it settles; it hangs once `timeoutMs` passed. */
  track(check: Promise<unknown>, timeoutMs: number): void;
}

export function createHungGate(maxHung: number, now: () => number = () => performance.now()): HungGate {
  const running = new Set<{ readonly hungAt: number }>();
  return {
    admits: () => {
      const at = now();
      let hung = 0;
      for (const check of running) if (at >= check.hungAt) hung++;
      return hung < maxHung;
    },
    track: (check, timeoutMs) => {
      const entry = { hungAt: now() + timeoutMs };
      running.add(entry);
      const settled = (): void => { running.delete(entry); };
      check.then(settled, settled);
    },
  };
}

// Half of libuv's default pool of four (UV_THREADPOOL_SIZE is never set), so hung drive, share and folder checks leave the
// rest to every other file system call of the process.
export const PROCESS_HUNG_GATE: HungGate = createHungGate(2);

export interface FolderProbeOptions {
  readonly access?: (folder: string) => Promise<unknown>;
  // monotonic, so a wall-clock step never stretches a wait or a cached answer
  readonly now?: () => number;
  // no gate: every check starts
  readonly gate?: HungGate;
}

/**
 * Whether a folder exists, each answer cached for `ttlMs`. A check still running after `timeoutMs` answers false, at once
 * for a caller that comes later, and keeps running to fill the cache: a disconnected mapped drive takes about 21 s to fail on
 * Windows, holding one libuv pool thread that long, so a caller never waits on it and concurrent callers share one check.
 * While the gate admits no check, a folder with no check running answers false without one, and nothing is cached for it.
 */
export function createFolderProbe(timeoutMs: number, ttlMs: number, options: FolderProbeOptions = {}): (folder: string) => Promise<boolean> {
  const access = options.access ?? (folder => fs.promises.access(folder));
  const now = options.now ?? (() => performance.now());
  const gate = options.gate;
  const checks = new Map<string, FolderCheck>();
  return async folder => {
    let check = checks.get(folder);
    if (!check || (check.settledAt !== null && now() - check.settledAt >= ttlMs)) {
      if (gate && !gate.admits()) return false;
      const started: FolderCheck = { result: access(folder).then(() => true, () => false), startedAt: now(), settledAt: null };
      void started.result.then(() => { started.settledAt = now(); });
      gate?.track(started.result, timeoutMs);
      checks.set(folder, started);
      check = started;
    }
    if (check.settledAt !== null) return check.result;
    const left = timeoutMs - (now() - check.startedAt);
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // after a stall the timer phase runs before the poll phase, so one poll turn lets an answer that already came in win
    const late = new Promise<boolean>(resolve => { timer = setTimeout(() => setImmediate(resolve, false), left); });
    try {
      return await Promise.race([check.result, late]);
    } finally {
      clearTimeout(timer);
    }
  };
}
