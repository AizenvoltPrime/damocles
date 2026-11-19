// Whether a folder is there, missing, or on a volume that does not answer (docs/invariants.md, "A project whose folder is not
// there"): the one rule every reader of a project folder's presence shares, in each process.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Disposable } from '../../platform/disposable';
import { PROCESS_HUNG_GATE, type HungGate } from '../folder-probe';

/** What a path is: `unreachable` when its volume does not answer, or its stat failed but as gone or did not answer in time. */
export type PathPresence = 'directory' | 'other' | 'missing' | 'unreachable';

/** A folder: there; gone (moved, renamed or deleted) from a volume that answers; or on a drive, share, WSL distro or mount that does not answer. */
export type FolderPresence = 'present' | 'missing' | 'unavailable';

/** A folder's presence, or `unchecked` when the hung gate started no stat for it (`onDidAdmit` says when one may start). */
export type FolderCheck = FolderPresence | 'unchecked';

/** What a path is, or `unchecked` when the hung gate started no stat for it. */
export type PathCheck = PathPresence | 'unchecked';

// A share or drive that stopped answering can hold a stat for a minute; past this its path reads as unreachable.
export const PRESENCE_TIMEOUT_MS = 3_000;

// A user action whose check the gate refused waits no longer than one check may take before it answers busy.
export const ADMIT_WAIT_MS: number = PRESENCE_TIMEOUT_MS;

export interface PresenceStat {
  isDirectory(): boolean;
  readonly dev: number | bigint;
}

export interface FolderPresenceProbeOptions {
  readonly stat?: (target: string) => Promise<PresenceStat>;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly gate?: HungGate;
  // monotonic, so a wall-clock step never stretches a wait
  readonly now?: () => number;
  /** The mount point recorded for a POSIX folder while it was there (`mountPointOf`); undefined: none recorded. */
  readonly recordedMount?: (folder: string) => Promise<string | undefined>;
}

export interface FolderPresenceProbe {
  presence(folder: string): Promise<FolderCheck>;
  path(target: string): Promise<PathCheck>;
  /** The drive, share, WSL distro or mount point the path's presence hangs on; undefined for a path on the system root. */
  volumeOf(target: string): Promise<string | undefined>;
  /** A folder whose check gave up on a stat that hung: that stat found its directory after all. Once per stat and folder. */
  onDidAnswerLate(listener: (folder: string) => void): Disposable;
  /** A check the gate refused may start now. */
  onDidAdmit(listener: () => void): Disposable;
}

type StatAnswer = { readonly presence: PathCheck; readonly dev?: number | bigint };
type RunningStat = { readonly result: Promise<StatAnswer>; readonly startedAt: number; readonly gaveUp: Set<string> };
type Volume = { readonly root: string; readonly mount: boolean };

const UNREACHABLE: StatAnswer = { presence: 'unreachable' };
const UNCHECKED: StatAnswer = { presence: 'unchecked' };

// The folders macOS and the Linux desktops mount a removable or network volume at, read when no mount point is recorded.
const CONVENTIONAL_MOUNT = /^(\/Volumes\/[^/]+|\/media\/[^/]+\/[^/]+|\/run\/media\/[^/]+\/[^/]+)(?:\/|$)/;

/**
 * Each path is stated at most once at a time, and a caller waits on the stat running for it; a folder is stated only once its
 * volume answered, so a volume that does not answer holds one stat however many folders lie on it. No stat starts while the
 * gate holds hung ones. A stat still running past `timeoutMs` answers unreachable at once and keeps running, and a folder
 * whose check gave up on it hears when it found its directory (`onDidAnswerLate`).
 */
export function createFolderPresenceProbe(options: FolderPresenceProbeOptions = {}): FolderPresenceProbe {
  const stat = options.stat ?? ((target: string) => fs.promises.stat(target));
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? PRESENCE_TIMEOUT_MS;
  const gate = options.gate ?? PROCESS_HUNG_GATE;
  const now = options.now ?? (() => performance.now());
  const running = new Map<string, RunningStat>();
  const listeners = new Set<(folder: string) => void>();

  const started = (target: string): RunningStat | undefined => {
    const found = running.get(target);
    if (found) return found;
    if (!gate.admits()) return undefined;
    const result = stat(target).then(
      (found): StatAnswer => ({ presence: found.isDirectory() ? 'directory' : 'other', dev: found.dev }),
      (err: NodeJS.ErrnoException): StatAnswer => (err.code === 'ENOENT' || err.code === 'ENOTDIR' ? { presence: 'missing' } : UNREACHABLE),
    );
    const entry: RunningStat = { result, startedAt: now(), gaveUp: new Set() };
    running.set(target, entry);
    gate.track(result, timeoutMs);
    void result.then((answer) => {
      running.delete(target);
      if (answer.presence !== 'directory') return;
      for (const folder of entry.gaveUp) for (const listener of [...listeners]) listener(folder);
    });
    return entry;
  };

  // The stat's answer within the call's deadline and the stat's own; `folder` is the check it serves.
  const answer = async (target: string, deadline: number, folder: string): Promise<StatAnswer> => {
    const entry = started(target);
    if (!entry) return UNCHECKED;
    const left = Math.min(deadline, entry.startedAt + timeoutMs) - now();
    if (left <= 0) {
      entry.gaveUp.add(folder);
      return UNREACHABLE;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // after a stall the timer phase runs before the poll phase, so one poll turn lets an answer that already came in win
    const expired = new Promise<undefined>((resolve) => { timer = setTimeout(() => setImmediate(resolve, undefined), left); });
    try {
      const got = await Promise.race([entry.result, expired]);
      if (got) return got;
      entry.gaveUp.add(folder);
      return UNREACHABLE;
    } finally {
      clearTimeout(timer);
    }
  };

  const volume = async (target: string): Promise<Volume | undefined> => {
    if (platform === 'win32') {
      const root = path.win32.parse(target).root;
      return root ? { root, mount: false } : undefined;
    }
    const recorded = await options.recordedMount?.(target);
    if (recorded !== undefined && path.posix.dirname(recorded) !== recorded) return { root: recorded, mount: true };
    const conventional = CONVENTIONAL_MOUNT.exec(path.posix.normalize(target))?.[1];
    return conventional === undefined ? undefined : { root: conventional, mount: false };
  };

  // A recorded mount point answers only while it is still one: a folder whose device differs from its parent's.
  const volumeAnswers = async ({ root, mount }: Volume, deadline: number, folder: string): Promise<boolean | 'unchecked'> => {
    const found = await answer(root, deadline, folder);
    if (found.presence === 'unchecked') return 'unchecked';
    if (found.presence !== 'directory') return false;
    if (!mount) return true;
    const parent = await answer(path.posix.dirname(root), deadline, folder);
    if (parent.presence === 'unchecked') return 'unchecked';
    return parent.presence === 'directory' && parent.dev !== found.dev;
  };

  const pathCheck = async (target: string): Promise<PathCheck> => {
    const deadline = now() + timeoutMs;
    const on = await volume(target);
    const answers = on && (await volumeAnswers(on, deadline, target));
    if (answers === 'unchecked') return 'unchecked';
    if (on && !answers) return 'unreachable';
    if (on?.root === target) return 'directory';
    return (await answer(target, deadline, target)).presence;
  };

  return {
    path: pathCheck,
    presence: async (folder) => {
      const found = await pathCheck(folder);
      return found === 'unchecked' ? 'unchecked' : folderPresenceOf(found);
    },
    volumeOf: async (target) => (await volume(target))?.root,
    onDidAnswerLate: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    onDidAdmit: (listener) => gate.onDidAdmit(listener),
  };
}

export interface AdmitWaitOptions {
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * `check`'s answer for a user action: when the gate refused it, `check` once more after the gate admits or `waitMs` passed,
 * whichever comes first. An answer still `unchecked` then is the caller's to refuse as busy; an abort rejects with its reason.
 */
export async function checkWhenAdmitted<T extends string>(check: () => Promise<T>, gate: Pick<FolderPresenceProbe, 'onDidAdmit'>, options: AdmitWaitOptions = {}): Promise<T> {
  const { signal } = options;
  signal?.throwIfAborted();
  let admitted = (): void => undefined;
  const admission = new Promise<void>((resolve) => { admitted = resolve; });
  // subscribed before the first check, so an admission while it runs is not missed
  const subscription = gate.onDidAdmit(() => admitted());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted = (): void => undefined;
  try {
    const first = await check();
    if (first !== 'unchecked') return first;
    signal?.throwIfAborted();
    const expired = new Promise<void>((resolve) => { timer = setTimeout(resolve, options.waitMs ?? ADMIT_WAIT_MS); });
    const abort = new Promise<never>((_, reject) => { aborted = () => reject(signal?.reason); });
    signal?.addEventListener('abort', aborted, { once: true });
    await Promise.race([admission, expired, abort]);
    return await check();
  } finally {
    subscription.dispose();
    clearTimeout(timer);
    signal?.removeEventListener('abort', aborted);
  }
}

/** A folder's presence by what its path is: anything there but a directory is no project folder. */
export function folderPresenceOf(found: PathPresence): FolderPresence {
  return found === 'directory' ? 'present' : found === 'unreachable' ? 'unavailable' : 'missing';
}

/**
 * The mount point a present POSIX folder lies on: the deepest folder at or above it whose device differs from its parent's, else
 * the system root. Each folder on the way is stated once.
 */
export async function mountPointOf(folder: string, stat: (target: string) => Promise<PresenceStat> = (target) => fs.promises.stat(target)): Promise<string> {
  let dir = path.posix.resolve(folder);
  let dev = (await stat(dir)).dev;
  for (;;) {
    const parent = path.posix.dirname(dir);
    if (parent === dir) return dir;
    const parentDev = (await stat(parent)).dev;
    if (parentDev !== dev) return dir;
    dir = parent;
    dev = parentDev;
  }
}
