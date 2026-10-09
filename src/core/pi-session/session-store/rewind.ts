import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { RestorePoint, RewindHistoryItem, SkippedFile, SkippedFilesTarget, SkippedSummary } from '@shared/types/session';
import type { CheckpointEntry, FileChange, Result } from '../checkpoints';
import { initPiLoader } from '../pi-loader';
import {
  BULK_ADD_CONFIG,
  PORTABLE_CONFIG,
  RepoManager,
  folderIdFor,
  getCheckpointEntries,
  getFolderRepoDir,
  getFolderReposBaseDir,
  getNotRewindableEntries,
  getPreRewindEntries,
  getRepoDir,
  getGitDir,
  getIndexPath,
  parseDiffStats,
  execSafe,
  isHexCommit,
  excludeLineForPath,
  lstatFiles,
  readSkippedManifest,
} from '../checkpoints';
import { log } from '../../logger';
import { ensurePiSessionDir } from './session-dir';
import { resolvePiSessionFile } from './reading';
import { extractOriginalInputs } from './original-input';
import { extractTerminalAttachmentCounts } from './terminal-attachments';
import { storedTypedText } from './prompt-context';
import { promptTest } from './prompt-index';

/** `git show <commit>:<path>` failure messages that genuinely mean "this path is absent from the
 *  commit" (the file was created that turn) — as opposed to a real fault (bad commit, corrupt repo). */
const GIT_PATH_ABSENT = /does not exist in|exists on disk, but not in/i;

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
  capBytes: number,
): Promise<FileChange[][] | null> {
  if (beforeCommits.length === 0) return [];
  const gitDir = getGitDir(repoDir);
  if (!fs.existsSync(gitDir)) return null;
  // Only a folder repo captures the project's tracked files; a legacy repo is never widened.
  const repo = new RepoManager(gitDir, getIndexPath(repoDir), cwd, { capturesTracked: path.dirname(repoDir) === getFolderReposBaseDir() });

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
    // Files over the cap are kept out of the throwaway index, so the preview never hashes them.
    const listed = await execSafe('git', [...PORTABLE_CONFIG, 'ls-files', '-z', '--others', '--modified', '--exclude-standard'], env, cwd);
    if (!listed.ok) return null;
    const overCap = (await lstatFiles(cwd, listed.value.stdout.split('\0').filter(Boolean))).filter((f) => f.bytes > capBytes).map((f) => f.path);
    const protectFile = path.join(tmpDir, 'over-cap').replace(/\\/g, '/');
    await fs.promises.writeFile(protectFile, overCap.map(excludeLineForPath).join('\n') + '\n', 'utf8');
    if (overCap.length > 0) {
      const removed = await execSafe('git', [...PORTABLE_CONFIG, 'update-index', '-z', '--force-remove', '--stdin'], env, cwd, overCap.map((p) => `${p}\0`).join(''));
      if (!removed.ok) return null;
    }
    const staged = await execSafe('git', [...PORTABLE_CONFIG, ...BULK_ADD_CONFIG, '-c', `core.excludesFile=${protectFile}`, 'add', '-A'], env, cwd);
    if (!staged.ok) return null;
    await repo.stageTrackedForPreview(env, capBytes);
    const diffs: FileChange[][] = [];
    for (const commit of beforeCommits) {
      if (!isHexCommit(commit)) {
        diffs.push([]);
        continue;
      }
      const diff = await execSafe('git', [...PORTABLE_CONFIG, 'diff', '-R', '--no-renames', '--numstat', '--cached', commit], env, cwd);
      if (!diff.ok) {
        diffs.push([]);
        continue;
      }
      const changes = parseDiffStats(diff.value.stdout);
      // A rewind never touches a protected file, so the preview does not list it either.
      const kept = await repo.protectedAmong(commit, changes.map((c) => c.path), capBytes);
      diffs.push(changes.filter((c) => !kept.has(c.path)));
    }
    return diffs;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The user entry ids a `damocles-checkpoint` entry on `branch` references, first occurrence order. */
export function rewindableUserIdsOnBranch(branch: readonly unknown[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const cp of getCheckpointEntries(branch)) {
    if (seen.has(cp.userEntryId)) continue;
    seen.add(cp.userEntryId);
    ids.push(cp.userEntryId);
  }
  return ids;
}

/** The prompt entry ids on `branch`, the rewind points of a chat that takes no file checkpoints. */
export function promptUserIdsOnBranch(branch: readonly SessionEntry[]): string[] {
  return branch.filter(promptTest(branch)).map((entry) => entry.id);
}

/**
 * The `compaction` entries on a branch, in tree order, mapped to compaction rewind anchors
 * (`kind: 'compaction'`). Each one's parent is the last pre-compaction message; selecting it branches
 * the tree there to recover the full pre-compaction context (conversation-only, no file restore).
 */
export function getCompactionRewindItems(
  branch: readonly unknown[],
  cwd?: string,
  checkpointDiffs?: Map<string, readonly FileChange[]>,
): RewindHistoryItem[] {
  const out: RewindHistoryItem[] = [];
  for (const entry of branch) {
    const e = entry as { type?: string; id?: unknown; summary?: unknown; timestamp?: unknown };
    if (e.type !== 'compaction' || typeof e.id !== 'string') continue;
    const base = {
      kind: 'compaction' as const,
      messageId: e.id,
      content: (typeof e.summary === 'string' ? e.summary : '').slice(0, 200),
      timestamp: typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || 0 : 0,
    };
    const changes = checkpointDiffs?.get(e.id);
    if (!changes) {
      out.push({ ...base, filesAffected: 0 });
      continue;
    }
    // Mirror the prompt-item mapping in getPiRewindHistory exactly.
    const files = cwd ? changes.map((fc) => ({ path: path.resolve(cwd, fc.path), displayName: fc.path })) : [];
    const added = changes.reduce((sum, fc) => sum + fc.added, 0);
    const removed = changes.reduce((sum, fc) => sum + fc.removed, 0);
    out.push({
      ...base,
      filesAffected: changes.length,
      ...(files.length > 0 ? { files } : {}),
      ...(added || removed ? { linesChanged: { added, removed } } : {}),
    });
  }
  return out;
}

/** One checkpoint reduced to the fields the rewind partition needs (git/fs already resolved). */
export interface CheckpointRow {
  userEntryId: string;
  changes: readonly FileChange[];
  prompt: string;
  createdAt: string;
  skipped?: SkippedSummary;
}

/**
 * Split checkpoint rows (oldest→newest) into prompt anchors and a compaction-diff map. A checkpoint
 * keyed to a compaction entry enriches that anchor instead of leaking a phantom prompt row; the LAST
 * one per id wins (the shared invariant with `getPiFileCheckpointContent`'s newest-first
 * `.reverse().find`). Pure (no git/fs) so the last-wins ordering is unit-testable. Prompt items come
 * out oldest-first; the caller reverses.
 */
export function partitionCheckpointRows(
  rows: readonly CheckpointRow[],
  compactionIds: ReadonlySet<string>,
  originalInputs: ReadonlyMap<string, string>,
  cwd: string,
): { promptItemsOldestFirst: RewindHistoryItem[]; checkpointDiffsMap: Map<string, readonly FileChange[]> } {
  const promptItemsOldestFirst: RewindHistoryItem[] = [];
  const checkpointDiffsMap = new Map<string, readonly FileChange[]>();
  for (const row of rows) {
    if (compactionIds.has(row.userEntryId)) {
      checkpointDiffsMap.set(row.userEntryId, row.changes);
      continue;
    }
    const files = row.changes.map((fc) => ({ path: path.resolve(cwd, fc.path), displayName: fc.path }));
    const added = row.changes.reduce((sum, fc) => sum + fc.added, 0);
    const removed = row.changes.reduce((sum, fc) => sum + fc.removed, 0);
    promptItemsOldestFirst.push({
      kind: 'prompt' as const,
      messageId: row.userEntryId,
      content: (originalInputs.get(row.userEntryId) ?? row.prompt).slice(0, 200),
      timestamp: Date.parse(row.createdAt) || 0,
      filesAffected: row.changes.length,
      ...(files.length > 0 ? { files } : {}),
      ...(added || removed ? { linesChanged: { added, removed } } : {}),
      ...(row.skipped && row.skipped.totalCount > 0 ? { skipped: row.skipped } : {}),
    });
  }
  return { promptItemsOldestFirst, checkpointDiffsMap };
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
 * `fileCheckpoints` is false for a chat with no project folder: every prompt is then a conversation-only
 * anchor and no checkpoint repo is read.
 */
export async function getPiRewindHistory(
  cwd: string,
  sessionId: string,
  maxFileSizeBytes: number,
  fileCheckpoints = true,
): Promise<{ items: RewindHistoryItem[]; restorePoints: RestorePoint[] }> {
  const none = { items: [], restorePoints: [] };
  const pi = await initPiLoader();
  if (!pi) return none;
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  if (!filePath) return none;
  try {
    const sm = pi.SessionManager.open(filePath, ensurePiSessionDir(cwd));
    const branch = sm.getBranch(sm.getLeafId() ?? undefined);
    const checkpoints = [...getCheckpointEntries(branch)];
    // A turn's recorded prompt is pi's expanded slash-command body; show the original typed input when
    // a sidecar recorded it, so the rewind list matches the transcript/up-arrow/preview.
    const originalInputs = extractOriginalInputs(branch);
    const typedText = typedTextOf(branch);
    if (!fileCheckpoints) return { items: conversationOnlyRewindItems(branch, originalInputs, typedText), restorePoints: [] };
    // A checkpoint whose userEntryId matches a compaction entry is a compaction snapshot, not a prompt
    // turn: it must enrich the compaction anchor (below) instead of leaking a phantom empty-prompt row.
    const compactionIds = new Set<string>();
    for (const entry of branch) {
      const e = entry as { type?: string; id?: unknown };
      if (e.type === 'compaction' && typeof e.id === 'string') compactionIds.add(e.id);
    }
    // Restore points of this folder, from every branch: an undo restores files, whichever branch is open.
    const folderId = folderIdFor(cwd);
    const preRewinds = getPreRewindEntries(sm.getEntries()).filter((r) => r.folderId === folderId);
    // Prefer the live diff (what the rewind will actually do); fall back to the static per-turn diff
    // when the checkpoint repo/git is unavailable (e.g. sessions recorded before checkpoints existed).
    const liveDiffs = await liveDiffsPerTarget(
      cwd,
      [
        ...checkpoints.map((cp) => ({ repoDir: repoDirOf(cp, filePath), commit: cp.beforeCommit })),
        ...preRewinds.map((r) => ({ repoDir: getFolderRepoDir(r.folderId), commit: r.commit })),
      ],
      maxFileSizeBytes,
    );

    // Split checkpoints into prompt anchors and a compaction-diff map, preferring each turn's live diff.
    const rows: CheckpointRow[] = checkpoints.map((cp, i) => ({
      userEntryId: cp.userEntryId,
      changes: liveDiffs[i] ?? cp.fileChanges,
      prompt: typedText(cp.userEntryId, cp.prompt),
      createdAt: cp.createdAt,
      ...(cp.v === 3 ? { skipped: cp.skipped } : {}),
    }));
    const { promptItemsOldestFirst, checkpointDiffsMap } = partitionCheckpointRows(rows, compactionIds, originalInputs, cwd);
    const rewindable = new Set(checkpoints.map((c) => c.userEntryId));
    const notRewindableItems = getNotRewindableEntries(branch)
      .filter((r) => !rewindable.has(r.userEntryId) && !compactionIds.has(r.userEntryId))
      .map((r): RewindHistoryItem => ({
        kind: 'prompt',
        messageId: r.userEntryId,
        content: (originalInputs.get(r.userEntryId) ?? typedText(r.userEntryId, userEntryText(branch, r.userEntryId))).slice(0, 200),
        timestamp: Date.parse(r.createdAt) || 0,
        filesAffected: 0,
        notRewindable: { reason: r.reason, params: r.params },
      }));
    const restorePoints = preRewinds
      .map((r, i): RestorePoint => {
        const changes = liveDiffs[checkpoints.length + i] ?? [];
        const added = changes.reduce((sum, fc) => sum + fc.added, 0);
        const removed = changes.reduce((sum, fc) => sum + fc.removed, 0);
        return {
          id: r.id,
          createdAt: Date.parse(r.createdAt) || 0,
          target: r.target,
          skipped: r.skipped,
          filesAffected: changes.length,
          ...(changes.length > 0 ? { files: changes.map((fc) => ({ path: path.resolve(cwd, fc.path), displayName: fc.path })) } : {}),
          ...(added || removed ? { linesChanged: { added, removed } } : {}),
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    // Merge both anchor kinds newest-first. Prompt items were collected oldest-first (reverse to
    // newest-first); compaction items interleave by timestamp so each lands at its real point in time.
    const items = mergeRewindAnchorsNewestFirst(
      [...promptItemsOldestFirst.reverse(), ...notRewindableItems],
      getCompactionRewindItems(branch, cwd, checkpointDiffsMap),
    );
    return { items, restorePoints };
  } catch (err) {
    log('[session-store] getPiRewindHistory failed for %s: %O', sessionId, err);
    return none;
  }
}

/** Every prompt and compaction anchor, none restoring files, for a chat that takes no file checkpoints. Runs no git. */
function conversationOnlyRewindItems(
  branch: readonly SessionEntry[],
  originalInputs: ReadonlyMap<string, string>,
  typedText: (userEntryId: string, stored: string) => string,
): RewindHistoryItem[] {
  const prompts = branch.filter(promptTest(branch)).map((entry): RewindHistoryItem => ({
    kind: 'prompt',
    messageId: entry.id,
    content: (originalInputs.get(entry.id) ?? typedText(entry.id, userEntryText(branch, entry.id))).slice(0, 200),
    timestamp: Date.parse(entry.timestamp) || 0,
    filesAffected: 0,
    notRewindable: { reason: 'no-project', params: {} },
  }));
  return mergeRewindAnchorsNewestFirst(prompts.reverse(), getCompactionRewindItems(branch));
}

/** A user entry's stored text without the terminal attachment and IDE blocks Damocles put before it, as the transcript shows it. */
function typedTextOf(branch: readonly SessionEntry[]): (userEntryId: string, stored: string) => string {
  const attachmentCounts = extractTerminalAttachmentCounts(branch);
  return (userEntryId, stored) => storedTypedText(stored, attachmentCounts.get(userEntryId) ?? 0);
}

/** The text of the user message entry `id` on `branch`, or '' when it is not there. */
function userEntryText(branch: readonly unknown[], id: string): string {
  for (const entry of branch) {
    const e = entry as { type?: string; id?: unknown; message?: { role?: string; content?: unknown } };
    if (e.type !== 'message' || e.id !== id || e.message?.role !== 'user') continue;
    const content = e.message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join(' ');
  }
  return '';
}

/** The repo dir holding a checkpoint's commits: the legacy per-session repo for v2, the folder repo for v3. */
function repoDirOf(entry: CheckpointEntry, sessionFile: string): string {
  return entry.v === 3 ? getFolderRepoDir(entry.folderId) : getRepoDir(sessionFile);
}

/**
 * Each target commit's live restore diff, computed once per repo the targets use; null where the repo or
 * git is unavailable, so the caller falls back to the static per-turn diff.
 */
async function liveDiffsPerTarget(
  cwd: string,
  targets: ReadonlyArray<{ repoDir: string; commit: string }>,
  maxFileSizeBytes: number,
): Promise<Array<FileChange[] | null>> {
  const out: Array<FileChange[] | null> = targets.map(() => null);
  const byRepo = new Map<string, number[]>();
  targets.forEach((t, i) => {
    byRepo.set(t.repoDir, [...(byRepo.get(t.repoDir) ?? []), i]);
  });
  for (const [repoDir, indices] of byRepo) {
    try {
      const diffs = await computeLiveRewindDiffs(cwd, repoDir, indices.map((i) => targets[i]!.commit), maxFileSizeBytes);
      if (diffs) indices.forEach((i, k) => (out[i] = diffs[k] ?? null));
    } catch (err) {
      log('[session-store] live rewind diff for %s failed: %O', repoDir, err);
    }
  }
  return out;
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
    const gitDir = getGitDir(repoDirOf(cp, sessionFile));
    const rel = path.relative(cwd, filePath).replace(/\\/g, '/');
    const result = await execSafe('git', [...PORTABLE_CONFIG, `--git-dir=${gitDir}`, 'show', `${cp.beforeCommit}:${rel}`]);
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

/**
 * The full skipped list of a turn's v3 checkpoint (the last on the active branch, as the rewind uses) or
 * of a restore point (from any branch), read from the session file and the folder repo's manifest
 * without the folder lock. A v2 checkpoint records no list.
 */
export async function getPiSkippedFiles(cwd: string, sessionId: string, target: SkippedFilesTarget): Promise<Result<SkippedFile[]>> {
  const pi = await initPiLoader();
  if (!pi) return { ok: false, error: 'the pi runtime is unavailable' };
  const sessionFile = await resolvePiSessionFile(cwd, sessionId);
  if (!sessionFile) return { ok: false, error: `no session file for ${sessionId}` };
  try {
    const sm = pi.SessionManager.open(sessionFile, ensurePiSessionDir(cwd));
    if (target.kind === 'restore-point') {
      const record = getPreRewindEntries(sm.getEntries()).find((r) => r.id === target.id);
      return record ? await readSkippedManifest(record, cwd) : { ok: false, error: `no restore point ${target.id}` };
    }
    const cp = [...getCheckpointEntries(sm.getBranch(sm.getLeafId() ?? undefined))].reverse().find((c) => c.userEntryId === target.userEntryId);
    if (!cp) return { ok: false, error: `no checkpoint for ${target.userEntryId}` };
    if (cp.v !== 3) return { ok: false, error: `the checkpoint of ${target.userEntryId} records no skipped list` };
    return await readSkippedManifest(cp, cwd);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
