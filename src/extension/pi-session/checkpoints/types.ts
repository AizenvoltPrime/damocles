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
 * Glob patterns written verbatim into the bare repo's `info/exclude`. `.git` is mandatory: we never
 * snapshot the user's real repo metadata.
 *
 * `.damocles/settings.json` and `.damocles/settings.local.json` are excluded because the permission
 * and MCP panels write them out of band, so a rewind must not revoke a grant made mid-turn.
 * `.damocles/mcp.local.json` is excluded for a different reason. It has a reader
 * (`mcp-config-import.ts`, the highest-precedence merge source) but no writer in the panel, and it is
 * a gitignored personal file holding `env` and `headers` credentials, which must never enter the
 * checkpoint repo.
 *
 * The rest of `.damocles` IS snapshotted, since project skills and commands live there and a rewind
 * that skipped them would silently leave agent-authored edits behind. Only repos created under
 * `CHECKPOINT_EXCLUDE_SET_VERSION` get this set; see `LEGACY_CHECKPOINT_EXCLUDES`. The remaining
 * patterns are performance excludes that keep heavy, regenerable trees out of every snapshot.
 */
export const DEFAULT_CHECKPOINT_EXCLUDES: readonly string[] = [
  '.git',
  '.damocles/settings.json',
  '.damocles/settings.local.json',
  '.damocles/mcp.local.json',
  'node_modules/',
  '.DS_Store',
  'dist/',
  'out/',
  'build/',
  'coverage/',
  '.cache/',
  '*.log',
];

/**
 * The exclude set every shadow repo used before `.damocles` content became snapshottable. A repo
 * whose older checkpoints were taken under this set has no `.damocles/skills`, `commands`, or
 * `agents` in those trees. Switching such a repo to `DEFAULT_CHECKPOINT_EXCLUDES` would make a rewind
 * to one of those checkpoints delete those directories, because `safeCheckout` stages everything and
 * then hard-resets to the target tree.
 */
export const LEGACY_CHECKPOINT_EXCLUDES: readonly string[] = [
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

/** Git config key holding the exclude-set version the shadow repo was created under. */
export const CHECKPOINT_EXCLUDE_VERSION_KEY = 'damocles.excludeSetVersion';

/** Version stamped on shadow repos created with `DEFAULT_CHECKPOINT_EXCLUDES`. */
export const CHECKPOINT_EXCLUDE_SET_VERSION = 1;

/**
 * A version-gated exclude set. `RepoManager.ensureReady` stamps `version` into the shadow repo's own
 * git config at the moment it creates the repo, and writes `patterns` only for a repo carrying that
 * stamp. A repo with an older stamp, or none at all, gets `legacyPatterns`.
 */
export interface CheckpointExcludeSet {
  readonly version: number;
  readonly patterns: readonly string[];
  readonly legacyPatterns: readonly string[];
}

/** The version-gated set every production checkpoint path hands to `ensureReady`. */
export const CHECKPOINT_EXCLUDE_SET: CheckpointExcludeSet = {
  version: CHECKPOINT_EXCLUDE_SET_VERSION,
  patterns: DEFAULT_CHECKPOINT_EXCLUDES,
  legacyPatterns: LEGACY_CHECKPOINT_EXCLUDES,
};
