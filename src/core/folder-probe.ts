import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';

type FolderCheck = { result: Promise<boolean>; startedAt: number; settledAt: number | null };

export interface FolderProbeOptions {
  readonly access?: (folder: string) => Promise<unknown>;
  // monotonic, so a wall-clock step never stretches a wait or a cached answer
  readonly now?: () => number;
  // checks still running past timeoutMs at which no new folder's check starts: each holds a thread of the pool every file
  // system call shares, so the hung ones never take all of it
  readonly maxHung?: number;
}

/**
 * Whether a folder exists, each answer cached for `ttlMs`. A check still running after `timeoutMs` answers false, at once
 * for a caller that comes later, and keeps running to fill the cache: a disconnected mapped drive takes about 21 s to fail on
 * Windows, holding one libuv pool thread that long, so a caller never waits on it and concurrent callers share one check.
 * While `maxHung` checks hang, a folder with no check running answers false without one, and nothing is cached for it.
 */
export function createFolderProbe(timeoutMs: number, ttlMs: number, options: FolderProbeOptions = {}): (folder: string) => Promise<boolean> {
  const access = options.access ?? (folder => fs.promises.access(folder));
  const now = options.now ?? (() => performance.now());
  const maxHung = options.maxHung ?? Infinity;
  const checks = new Map<string, FolderCheck>();
  const hung = (at: number): number => [...checks.values()].filter(check => check.settledAt === null && at - check.startedAt >= timeoutMs).length;
  return async folder => {
    let check = checks.get(folder);
    if (!check || (check.settledAt !== null && now() - check.settledAt >= ttlMs)) {
      if (hung(now()) >= maxHung) return false;
      const started: FolderCheck = { result: access(folder).then(() => true, () => false), startedAt: now(), settledAt: null };
      void started.result.then(() => { started.settledAt = now(); });
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
