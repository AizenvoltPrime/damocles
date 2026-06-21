import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { RewindHistoryItem } from '@shared/types/session';
import type { FileChange } from '../checkpoints';
import { initPiLoader } from '../pi-loader';
import { getCheckpointEntries, getRepoDir, getGitDir, getIndexPath, parseDiffStats, execSafe, isHexCommit } from '../checkpoints';
import { log } from '../../logger';
import { ensurePiSessionDir } from './session-dir';
import { resolvePiSessionFile } from './reading';
import { extractOriginalInputs } from './original-input';

/** `git show <commit>:<path>` failure messages that genuinely mean "this path is absent from the
 *  commit" (the file was created that turn) — as opposed to a real fault (bad commit, corrupt repo). */
const GIT_PATH_ABSENT = /does not exist in|exists on disk, but not in/i;

/** Config applied to every preview-diff git call so line counts and paths match the checkpoint repo. */
const PREVIEW_GIT_CONFIG: readonly string[] = [
  '-c', 'core.autocrlf=false',
  '-c', 'core.quotepath=false',
  '-c', 'core.longpaths=true',
];

/**
 * The TRUE set of files a rewind to each `beforeCommit` would change: the live diff between the
 * current work tree and the target commit — not the turn's own `beforeCommit→afterCommit` diff.
 * This is what makes the preview honest about files the user deleted since (re-added on rewind) and
 * files created since (removed on rewind), matching what `safeCheckout` actually does.
 *
 * The work tree is staged once into a throwaway index (seeded from the live checkpoint index for a
 * warm stat cache, so the stage is cheap on large repos); each commit is then a fast tree-only
 * `diff --cached -R` (reversed → the rewind's own add/remove perspective). Returns null when the
 * repo/git is unavailable, so the caller falls back to the static per-turn counts.
 */
async function computeLiveRewindDiffs(
  cwd: string,
  repoDir: string,
  beforeCommits: readonly string[],
): Promise<FileChange[][] | null> {
  if (beforeCommits.length === 0) return [];
  const gitDir = getGitDir(repoDir);
  if (!fs.existsSync(gitDir)) return null;

  // A unique temp DIR per call (mkdtemp is atomic) so concurrent rewind-history requests from two
  // panels can never share an index path — each gets its own, and the cleanup only removes its own.
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'damocles-rewind-'));
  const tmpIndex = path.join(tmpDir, 'index');
  try {
    await fs.promises.copyFile(getIndexPath(repoDir), tmpIndex);
  } catch {
    // No warm index to seed from — the stage still works, just re-hashes from scratch.
  }
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: cwd, GIT_INDEX_FILE: tmpIndex };
  try {
    const staged = await execSafe('git', [...PREVIEW_GIT_CONFIG, 'add', '-A'], env, cwd);
    if (!staged.ok) return null;
    const diffs: FileChange[][] = [];
    for (const commit of beforeCommits) {
      if (!isHexCommit(commit)) {
        diffs.push([]);
        continue;
      }
      const diff = await execSafe('git', [...PREVIEW_GIT_CONFIG, 'diff', '-R', '--no-renames', '--numstat', '--cached', commit], env, cwd);
      diffs.push(diff.ok ? [...parseDiffStats(diff.value.stdout)] : []);
    }
    return diffs;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The pi user-entry ids that have a persisted checkpoint on the active branch — the rewind-eligible
 * set for a resumed session (US-013). A turn is rewindable only if a `damocles-checkpoint` entry
 * references its user entry, so live and replayed eligibility share the same key (the pi entry id,
 * FR-3). Empty for sessions recorded before checkpoints existed.
 */
export async function getPiRewindableUserIds(cwd: string, sessionId: string): Promise<string[]> {
  const pi = await initPiLoader();
  if (!pi) return [];
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  if (!filePath) return [];
  try {
    const sm = pi.SessionManager.open(filePath, ensurePiSessionDir(cwd));
    const branch = sm.getBranch(sm.getLeafId() ?? undefined);
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const cp of getCheckpointEntries(branch)) {
      if (seen.has(cp.userEntryId)) continue;
      seen.add(cp.userEntryId);
      ids.push(cp.userEntryId);
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * The `compaction` entries on a branch, in tree order, mapped to compaction rewind anchors
 * (`kind: 'compaction'`). Each one's parent is the last pre-compaction message; selecting it branches
 * the tree there to recover the full pre-compaction context (conversation-only, no file restore).
 */
export function getCompactionRewindItems(branch: readonly unknown[]): RewindHistoryItem[] {
  const out: RewindHistoryItem[] = [];
  for (const entry of branch) {
    const e = entry as { type?: string; id?: unknown; summary?: unknown; timestamp?: unknown };
    if (e.type !== 'compaction' || typeof e.id !== 'string') continue;
    out.push({
      kind: 'compaction',
      messageId: e.id,
      content: (typeof e.summary === 'string' ? e.summary : '').slice(0, 200),
      timestamp: typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || 0 : 0,
      filesAffected: 0,
    });
  }
  return out;
}

/** Merge prompt and compaction anchors into one newest-first list (stable on equal timestamps). */
export function mergeRewindAnchorsNewestFirst(
  promptItemsNewestFirst: readonly RewindHistoryItem[],
  compactionItems: readonly RewindHistoryItem[],
): RewindHistoryItem[] {
  return [...promptItemsNewestFirst, ...compactionItems].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Rewind history for a resumed pi session (US-013c): a `RewindHistoryItem` per checkpoint AND per
 * compaction point, newest first. Prompt items carry file-change counts from each checkpoint's
 * `fileChanges` (paths cwd-joined so the diff viewer can fetch before/after content). Compaction items
 * (`kind: 'compaction'`) carry the pi compaction entry id + summary and never restore files — selecting
 * one branches the tree at the compaction's parent to recover the full pre-compaction context.
 */
export async function getPiRewindHistory(cwd: string, sessionId: string): Promise<RewindHistoryItem[]> {
  const pi = await initPiLoader();
  if (!pi) return [];
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  if (!filePath) return [];
  try {
    const sm = pi.SessionManager.open(filePath, ensurePiSessionDir(cwd));
    const branch = sm.getBranch(sm.getLeafId() ?? undefined);
    const checkpoints = [...getCheckpointEntries(branch)];
    // A turn's recorded prompt is pi's expanded slash-command body; show the original typed input when
    // a sidecar recorded it, so the rewind list matches the transcript/up-arrow/preview.
    const originalInputs = extractOriginalInputs(branch);
    // Prefer the live diff (what the rewind will actually do); fall back to the static per-turn diff
    // when the checkpoint repo/git is unavailable (e.g. sessions recorded before checkpoints existed).
    const liveDiffs = await computeLiveRewindDiffs(cwd, getRepoDir(filePath), checkpoints.map((c) => c.beforeCommit));

    const promptItems: RewindHistoryItem[] = checkpoints.map((cp, i) => {
      const changes = liveDiffs?.[i] ?? cp.fileChanges;
      const files = changes.map((fc) => ({ path: path.resolve(cwd, fc.path), displayName: fc.path }));
      const added = changes.reduce((sum, fc) => sum + fc.added, 0);
      const removed = changes.reduce((sum, fc) => sum + fc.removed, 0);
      return {
        kind: 'prompt' as const,
        messageId: cp.userEntryId,
        content: (originalInputs.get(cp.userEntryId) ?? cp.prompt).slice(0, 200),
        timestamp: Date.parse(cp.createdAt) || 0,
        filesAffected: changes.length,
        ...(files.length > 0 ? { files } : {}),
        ...(added || removed ? { linesChanged: { added, removed } } : {}),
      };
    });

    // Merge both anchor kinds newest-first. Prompt items were collected oldest-first (reverse to
    // newest-first); compaction items interleave by timestamp so each lands at its real point in time.
    return mergeRewindAnchorsNewestFirst(promptItems.reverse(), getCompactionRewindItems(branch));
  } catch {
    return [];
  }
}

/**
 * The pre-turn content of a file for the rewind diff viewer (US-013c): `git show <beforeCommit>:<path>`
 * from the session's bare checkpoint repo. Returns '' ONLY when the path was genuinely absent from the
 * checkpoint (file created that turn → empty "before"), and null when there is no checkpoint OR the
 * git read failed for any other reason — so the caller falls back to opening the live file instead of
 * rendering the whole current file as added on a transient error (mirrors the SDK path's create vs
 * unknown distinction).
 */
export async function getPiFileCheckpointContent(
  cwd: string,
  sessionId: string,
  userMessageId: string,
  filePath: string,
): Promise<string | null> {
  const pi = await initPiLoader();
  if (!pi) return null;
  const sessionFile = await resolvePiSessionFile(cwd, sessionId);
  if (!sessionFile) return null;
  try {
    const sm = pi.SessionManager.open(sessionFile, ensurePiSessionDir(cwd));
    const branch = sm.getBranch(sm.getLeafId() ?? undefined);
    const cp = [...getCheckpointEntries(branch)].reverse().find((c) => c.userEntryId === userMessageId);
    if (!cp || !isHexCommit(cp.beforeCommit)) return null;
    const gitDir = getGitDir(getRepoDir(sessionFile));
    const rel = path.relative(cwd, filePath).replace(/\\/g, '/');
    const result = await execSafe('git', [`--git-dir=${gitDir}`, 'show', `${cp.beforeCommit}:${rel}`]);
    if (result.ok) {
      // A NUL byte means binary content — the text diff viewer would render mojibake, so return null
      // and let the caller just open the live file instead of diffing.
      return result.value.stdout.includes('\0') ? null : result.value.stdout;
    }
    if (GIT_PATH_ABSENT.test(result.error)) return '';
    log('[session-store] getPiFileCheckpointContent git show failed for %s: %s', rel, result.error);
    return null;
  } catch {
    return null;
  }
}
