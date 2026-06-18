/**
 * Shared value/type vocabulary for the per-session git checkpoint engine. Everything here is
 * provider-agnostic plumbing: the producer, the repo wrapper, and the resolver all speak in terms
 * of these shapes. Kept deliberately small so the public barrel can re-export the whole surface.
 */

/** Environment overrides handed to every spawned git process so it targets the private bare repo. */
export interface ExecEnv {
  GIT_DIR: string;
  GIT_WORK_TREE: string;
  GIT_INDEX_FILE: string;
}

/**
 * Fail-soft return channel. The engine never throws across its public boundary (a few documented
 * exceptions aside); callers branch on `ok` instead of wrapping every call in try/catch.
 */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

/**
 * A git object id is 7–64 hex chars; checkpoint commits always are, since they come from
 * `git rev-parse`. Validating a ref before handing it to git enforces that invariant — a ref can
 * never be mistaken for a flag (`-…`) or carry path/option syntax (mirrors Compass's SAFE_GIT_REF).
 */
export function isHexCommit(ref: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(ref);
}

/** One file's contribution to a checkpoint diff, as reported by `git diff --numstat`. */
export interface FileChange {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

/**
 * A persisted checkpoint: the bracketing commits for a single turn plus enough metadata to drive
 * the rewind UI without re-querying git. `v` is a schema tag so future format changes can be
 * detected and rejected by the runtime guard.
 */
export interface CheckpointEntry {
  readonly v: 2;
  readonly kind: 'checkpoint';
  readonly turnId: string;
  readonly userEntryId: string;
  readonly beforeCommit: string;
  readonly afterCommit: string;
  readonly prompt: string;
  readonly fileCount: number;
  readonly fileChanges: readonly FileChange[];
  readonly createdAt: string;
}

/**
 * Outcome of restoring the work tree to an earlier commit. `checkout-failed` carries the git error
 * plus any secondary rollback error encountered while trying to undo a half-applied restore.
 */
export type SafeCheckoutResult =
  | { ok: true; safetyHash?: string }
  | { ok: false; reason: 'checkout-failed'; error: string; rollbackError?: string };

/**
 * Glob patterns written verbatim into the bare repo's `info/exclude`. `.git` and `.damocles/**`
 * are mandatory (we never want to snapshot the user's real repo metadata or our own state); the
 * rest are performance excludes that keep heavy, regenerable trees out of every snapshot.
 */
export const DEFAULT_CHECKPOINT_EXCLUDES: readonly string[] = [
  '.git',
  '.damocles/**',
  'node_modules/',
  '.DS_Store',
  'dist/',
  'out/',
  'build/',
  'coverage/',
  '.cache/',
  '*.log',
];
