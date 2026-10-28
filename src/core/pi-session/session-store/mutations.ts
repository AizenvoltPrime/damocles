import * as fs from 'fs';
import * as path from 'path';
import { initPiLoader } from '../pi-loader';
import { log } from '../../logger';
import { deleteSessionCheckpointRefs, folderIdsInSessionFile, getRepoDir } from '../checkpoints';
import { DAMOCLES_HOME_DIR, findSessionPlanFiles } from '../../paths';
import { agentDataRoot, subagentsDir, teamsDir } from '../agent-records';
import { isSafeAgentPathId } from '../../../shared/agent-path-id';
import { resolvePiSessionFile, forgetSessionMetadata } from './reading';
import type { SessionMetaIndex } from './meta-index/client';
import { piSessionDir } from './session-dir';
import { DAMOCLES_USER_RENAMED_ENTRY, DAMOCLES_TAG_ENTRY } from './constants';
import { writeUnderSessionLease } from './session-lease';
import { muteAgentFilesUnder } from '../agent-file-owner';

/**
 * Rename a stored pi session: append a `session_info` name plus the `damocles-user-renamed` marker
 * (so the store maps the name to `customTitle`, outranking any AI title — US-012). File-based, mirroring
 * the SDK's file-level rename. For the currently-open session this updates the file directly; the live
 * in-memory name refreshes on its next reload, while the picker/header update immediately from the
 * re-listed metadata.
 */
export async function renamePiSession(cwd: string, sessionId: string, newName: string): Promise<void> {
  const pi = await initPiLoader();
  if (!pi) return;
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  if (!filePath) return;
  try {
    const sm = pi.SessionManager.open(filePath, path.dirname(filePath));
    sm.appendSessionInfo(newName);
    sm.appendCustomEntry(DAMOCLES_USER_RENAMED_ENTRY);
  } catch (err) {
    log('[session-store] renamePiSession failed for %s: %O', sessionId, err);
    throw err;
  }
}

/** `applyLive`'s answer when the title is not for the file: a live holder took it, or the caller's runtime retired. */
export type LiveTitleOutcome = 'live' | 'retired';

/** What `titleStoredPiSession` did with the title; `held` when a panel of this process holds the session with no live holder. */
export type StoredTitleOutcome = LiveTitleOutcome | 'titled' | 'named' | 'held' | 'leased' | 'missing';

/**
 * AI-title a stored pi session: `session_info` without the user-renamed marker, skipped when the file has a name.
 * Written under the writer lease a delete holds across its detach and rm, after an existence check, so a deleted
 * file is never recreated. `applyLive` runs in that same synchronous section; an answer leaves the file alone.
 */
export async function titleStoredPiSession(
  cwd: string,
  sessionId: string,
  title: string,
  applyLive: () => LiveTitleOutcome | null,
): Promise<StoredTitleOutcome> {
  const pi = await initPiLoader();
  const filePath = pi ? await resolvePiSessionFile(cwd, sessionId) : null;
  // No await from here to the lease, which `writeUnderSessionLease` takes before its first await: an await would let
  // a delete detach and rm in between.
  const live = applyLive();
  if (live) return live;
  if (!pi || !filePath) return 'missing';
  let outcome: StoredTitleOutcome = 'titled';
  const refusal = await writeUnderSessionLease(sessionId, async () => {
    if (!fs.existsSync(filePath)) {
      outcome = 'missing';
      return;
    }
    const sm = pi.SessionManager.open(filePath, path.dirname(filePath));
    if (sm.getSessionName()) {
      outcome = 'named';
      return;
    }
    sm.appendSessionInfo(title);
  });
  if (refusal) return refusal.kind === 'panel' ? 'held' : 'leased';
  return outcome;
}

/**
 * Set or clear the user tag on a stored pi session by appending a `damocles-tag` custom entry (latest
 * wins; `null` clears). File-based, mirroring the rename marker; the metadata reader folds the latest
 * tag into `StoredSession.tag`.
 */
export async function tagPiSession(cwd: string, sessionId: string, tag: string | null): Promise<void> {
  const pi = await initPiLoader();
  if (!pi) return;
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  if (!filePath) return;
  try {
    const sm = pi.SessionManager.open(filePath, path.dirname(filePath));
    sm.appendCustomEntry(DAMOCLES_TAG_ENTRY, { tag });
  } catch (err) {
    log('[session-store] tagPiSession failed for %s: %O', sessionId, err);
    throw err;
  }
}

/** The pre-session-subtree subagent transcript folder, `~/.damocles/pi/subagents/<encoded-cwd>/<sessionId>/`. */
function legacySubagentTranscriptDir(cwd: string, sessionId: string): string {
  const encodedCwd = cwd
    .replace(/^[A-Za-z]:[/\\]/, '')
    .replace(/[/\\:]/g, '-')
    .replace(/^-+/, '');
  return path.join(DAMOCLES_HOME_DIR, 'pi', 'subagents', encodedCwd, sessionId);
}

/** Removes the agent data in `sessionDir`, the directory that holds (or held) the session's file. */
async function deleteAgentData(cwd: string, sessionDir: string, sessionId: string): Promise<void> {
  // The id becomes a path segment, so anything that could climb out of the session dir is refused.
  if (!isSafeAgentPathId(sessionId)) {
    log('[session-store] agent data of session %s left in place: the id is not a safe path segment', sessionId);
    return;
  }
  // A held stopped run outlives its panel's detach, and an append after a partial removal would recreate its file.
  muteAgentFilesUnder(agentDataRoot(sessionDir, sessionId));
  for (const dir of [subagentsDir(sessionDir, sessionId), teamsDir(sessionDir, sessionId), legacySubagentTranscriptDir(cwd, sessionId)]) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch((err) => log('[session-store] delete agent data %s failed: %O', dir, err));
  }
  await fs.promises.rmdir(agentDataRoot(sessionDir, sessionId)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') log('[session-store] delete agent data root failed: %O', err);
  });
}

/**
 * Delete a stored pi session: its JSONL file, its legacy per-session checkpoint repo (US-010b), every
 * plan file it wrote (matched by the session's stable plan-id suffix within DAMOCLES_PLANS_DIR), its
 * subagent and team data, and then its checkpoint refs in its folder repos. The SDK store under
 * ~/.claude is never touched (FR-1). Best-effort + idempotent. Resolves once the file and data are gone;
 * `refsDeleted` settles when the refs are too, and never rejects.
 */
export async function deletePiSession(cwd: string, sessionId: string, index: Pick<SessionMetaIndex, 'forget'>): Promise<{ refsDeleted: Promise<void> }> {
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  // Read before the rm: the file names the folder repos holding the session's refs.
  const folderIds = filePath
    ? await folderIdsInSessionFile(filePath).catch((err: unknown) => {
      log('[session-store] reading the folder repos of session %s failed; only its own folder repo is cleaned: %O', sessionId, err);
      return new Set<string>();
    })
    : new Set<string>();
  // The checkpoint repo is named after the file, so without one it is left to the startup orphan prune.
  if (filePath) {
    const repoDir = getRepoDir(filePath);
    await fs.promises.rm(filePath, { force: true }).catch((err) => log('[session-store] delete session file failed: %O', err));
    forgetSessionMetadata(index, filePath);
    await fs.promises.rm(repoDir, { recursive: true, force: true }).catch((err) => log('[session-store] delete checkpoint repo failed: %O', err));
  }
  // Match by the session's stable plan-id suffix (not a slug recompute) so every plan file it wrote is
  // removed, including one bound before the slug settled, which a recompute would miss and orphan.
  for (const planPath of await findSessionPlanFiles(sessionId)) {
    await fs.promises.rm(planPath, { force: true }).catch((err) => log('[session-store] delete plan file failed: %O', err));
  }
  // Taken from the file, which a hand-off leaves in another folder's directory; the lookup cannot find it once it is gone.
  await deleteAgentData(cwd, filePath ? path.dirname(filePath) : piSessionDir(cwd), sessionId);
  // A folder lock can be held by another conversation's first baseline for minutes, so nothing waits on
  // this; refs it fails to remove are left to maintenance's orphan sweep (docs/invariants.md, "Checkpoints").
  // Every holder has detached, so no producer of this session writes a ref after this.
  const refsDeleted = deleteSessionCheckpointRefs(cwd, sessionId, folderIds).catch((err: unknown) => log('[session-store] delete checkpoint refs failed: %O', err));
  return { refsDeleted };
}
