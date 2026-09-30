/**
 * Shared value/type vocabulary for the per-session git checkpoint engine. Everything here is
 * provider-agnostic plumbing: the producer, the repo wrapper, and the resolver all speak in terms
 * of these shapes. Kept deliberately small so the public barrel can re-export the whole surface.
 */

import type { NotRewindableParams, NotRewindableReason, PreRewindTarget, SkippedSummary } from '@shared/types/session';

export type {
  NotRewindableParams,
  NotRewindableReason,
  PreRewindTarget,
  SkippedSummary,
  SkippedFile,
  SkippedPattern,
  SkippedTally,
  SkipReason,
} from '@shared/types/session';

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
 * An id placed in a ref name (session id, user entry id, compaction entry id). Refusing everything
 * else keeps flag, path, `..`, `@{` and `.lock` syntax out of `refs/damocles/...`.
 */
export function isSafeRefId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

/**
 * A persisted checkpoint whose commits live in the conversation's legacy per-session repo
 * (`getRepoDir(sessionFile)`). Only read; new turns write `CheckpointEntryV3`.
 */
export interface CheckpointEntryV2 {
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
 * A checkpoint in the shared folder repo `folders/<folderId>`. Its commits stay alive only through the
 * conversation's refs (`checkpointRefName`). `skipped` describes the before-state snapshot.
 */
export interface CheckpointEntryV3 extends Omit<CheckpointEntryV2, 'v'> {
  readonly v: 3;
  readonly repo: 'folder';
  readonly folderId: string;
  readonly skipped: SkippedSummary;
}

export type CheckpointEntry = CheckpointEntryV2 | CheckpointEntryV3;

/** A turn that has no usable baseline. Persisted under the same custom type as checkpoints. */
export interface NotRewindableRecord {
  readonly v: 3;
  readonly kind: 'not-rewindable';
  readonly userEntryId: string;
  readonly reason: NotRewindableReason;
  readonly params: NotRewindableParams;
  readonly createdAt: string;
}

/** The records of a turn; a fork carries these for every turn it inherits. */
export type CheckpointRecord = CheckpointEntry | NotRewindableRecord;

/**
 * The folder's state just before a restore applied, kept under the conversation's refs
 * (`preRewindRefName`) so an undo can restore it. A fork never inherits one.
 */
export interface PreRewindRecord {
  readonly v: 3;
  readonly kind: 'pre-rewind';
  readonly id: string;
  readonly folderId: string;
  readonly commit: string;
  readonly skipped: SkippedSummary;
  readonly target: PreRewindTarget;
  readonly createdAt: string;
}

/** Every record kind persisted under the `damocles-checkpoint` custom type. */
export type StoredCheckpointRecord = CheckpointRecord | PreRewindRecord;

/**
 * Outcome of restoring the work tree to an earlier commit. `checkout-failed` carries the git error
 * plus any secondary rollback error encountered while trying to undo a half-applied restore.
 */
export type SafeCheckoutResult =
  | { ok: true }
  | { ok: false; reason: 'checkout-failed'; error: string; rollbackError?: string };

/**
 * Outcome of a rewind or an undo. Every reason but `checkout-failed` changed no file. `preRewind` is the
 * snapshot taken before the restore applied; `rollbackError` means the folder may be partly restored.
 */
export type RestoreResult =
  | { ok: true; preRewind: PreRewindRecord }
  | { ok: false; reason: 'checkout-failed'; error: string; rollbackError?: string; preRewind: PreRewindRecord }
  | { ok: false; reason: 'snapshot-failed' | 'unavailable'; error: string; preRewind: null }
  | { ok: false; reason: 'aborted'; preRewind: null };

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
 * `CHECKPOINT_EXCLUDE_SET_VERSION` get `DEFAULT_CHECKPOINT_EXCLUDES`; see `LEGACY_CHECKPOINT_EXCLUDES`.
 * These always win: no snapshot captures them, even when the project's git tracks them.
 */
export const SECURITY_CHECKPOINT_EXCLUDES: readonly string[] = [
  '.git',
  '.damocles/settings.json',
  '.damocles/settings.local.json',
  '.damocles/mcp.local.json',
];

/** Heavy, regenerable trees. A file the project's own git tracks is captured even under one of these. */
export const PERFORMANCE_CHECKPOINT_EXCLUDES: readonly string[] = [
  'node_modules/',
  '.DS_Store',
  'dist/',
  'out/',
  'build/',
  'coverage/',
  '.cache/',
  '*.log',
];

export const DEFAULT_CHECKPOINT_EXCLUDES: readonly string[] = [...SECURITY_CHECKPOINT_EXCLUDES, ...PERFORMANCE_CHECKPOINT_EXCLUDES];

/**
 * The exclude set every shadow repo used before `.damocles` content became snapshottable. A repo
 * whose older checkpoints were taken under this set has no `.damocles/skills`, `commands`, or
 * `agents` in those trees. Switching such a repo to `DEFAULT_CHECKPOINT_EXCLUDES` would make a rewind
 * to one of those checkpoints delete those directories, because `safeCheckout` deletes every path the
 * target tree lacks that the repo does not ignore.
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

/** The version-gated set of the per-session repos. */
export const CHECKPOINT_EXCLUDE_SET: CheckpointExcludeSet = {
  version: CHECKPOINT_EXCLUDE_SET_VERSION,
  patterns: DEFAULT_CHECKPOINT_EXCLUDES,
  legacyPatterns: LEGACY_CHECKPOINT_EXCLUDES,
};

/**
 * Media, archives, model weights and environment caches: large, regenerable or binary content no
 * checkpoint copies. Images and PDFs stay out of this list because agents edit icons and docs; the
 * size cap covers large ones. A skip matched by one of these is reported with reason `category`.
 */
export const CATEGORY_CHECKPOINT_EXCLUDES: readonly string[] = [
  ...['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'opus', 'm4a', 'aiff', 'wma'],
  ...['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'dmg', 'img'],
  ...['onnx', 'safetensors', 'gguf', 'ggml', 'pt', 'pth', 'ckpt', 'h5', 'pb', 'tflite', 'npy', 'npz'],
].map((ext) => `*.${ext}`).concat([
  '__pycache__/',
  '.venv/',
  'venv/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.gradle/',
  'target/',
  '.next/',
  '.nuxt/',
  '.turbo/',
]);

/** Version stamped on folder repos, created with `FOLDER_CHECKPOINT_EXCLUDES`. */
export const FOLDER_CHECKPOINT_EXCLUDE_SET_VERSION = 2;

export const FOLDER_CHECKPOINT_EXCLUDES: readonly string[] = [...DEFAULT_CHECKPOINT_EXCLUDES, ...CATEGORY_CHECKPOINT_EXCLUDES];

/**
 * The set every folder repo is created with. A folder repo only ever exists under this version or a
 * later one, so `legacyPatterns` is the version-1 set it would fall back to.
 */
export const FOLDER_CHECKPOINT_EXCLUDE_SET: CheckpointExcludeSet = {
  version: FOLDER_CHECKPOINT_EXCLUDE_SET_VERSION,
  patterns: FOLDER_CHECKPOINT_EXCLUDES,
  legacyPatterns: DEFAULT_CHECKPOINT_EXCLUDES,
};
