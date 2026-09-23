import * as fs from 'fs';
import * as path from 'path';
import { initPiLoader } from '../pi-loader';
import { log } from '../../logger';
import { getRepoDir } from '../checkpoints';
import { DAMOCLES_HOME_DIR, findSessionPlanFiles } from '../../paths';
import { agentDataRoot, isSafeAgentPathId, subagentsDir, teamsDir } from '../agent-records';
import { ensurePiSessionDir } from './session-dir';
import { resolvePiSessionFile, forgetSessionMetadata } from './reading';
import { DAMOCLES_USER_RENAMED_ENTRY, DAMOCLES_TAG_ENTRY } from './constants';

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
    const sm = pi.SessionManager.open(filePath, ensurePiSessionDir(cwd));
    sm.appendSessionInfo(newName);
    sm.appendCustomEntry(DAMOCLES_USER_RENAMED_ENTRY);
  } catch (err) {
    log('[session-store] renamePiSession failed for %s: %O', sessionId, err);
    throw err;
  }
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
    const sm = pi.SessionManager.open(filePath, ensurePiSessionDir(cwd));
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

async function deleteAgentData(cwd: string, sessionId: string): Promise<void> {
  // The id becomes a path segment, so anything that could climb out of the session dir is refused.
  if (!isSafeAgentPathId(sessionId)) {
    log('[session-store] agent data of session %s left in place: the id is not a safe path segment', sessionId);
    return;
  }
  const sessionDir = ensurePiSessionDir(cwd);
  for (const dir of [subagentsDir(sessionDir, sessionId), teamsDir(sessionDir, sessionId), legacySubagentTranscriptDir(cwd, sessionId)]) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch((err) => log('[session-store] delete agent data %s failed: %O', dir, err));
  }
  await fs.promises.rmdir(agentDataRoot(sessionDir, sessionId)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') log('[session-store] delete agent data root failed: %O', err);
  });
}

/**
 * Delete a stored pi session: remove its JSONL file, its per-session checkpoint repo (US-010b), every
 * plan file it wrote (matched by the session's stable plan-id suffix within DAMOCLES_PLANS_DIR), and its
 * subagent and team data. The SDK store under ~/.claude is never touched (FR-1). Best-effort + idempotent.
 */
export async function deletePiSession(cwd: string, sessionId: string): Promise<void> {
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  // The checkpoint repo is named after the file, so without one it is left to the startup orphan prune.
  if (filePath) {
    const repoDir = getRepoDir(filePath);
    await fs.promises.rm(filePath, { force: true }).catch((err) => log('[session-store] delete session file failed: %O', err));
    forgetSessionMetadata(filePath);
    await fs.promises.rm(repoDir, { recursive: true, force: true }).catch((err) => log('[session-store] delete checkpoint repo failed: %O', err));
  }
  // Match by the session's stable plan-id suffix (not a slug recompute) so every plan file it wrote is
  // removed, including one bound before the slug settled, which a recompute would miss and orphan.
  for (const planPath of await findSessionPlanFiles(sessionId)) {
    await fs.promises.rm(planPath, { force: true }).catch((err) => log('[session-store] delete plan file failed: %O', err));
  }
  await deleteAgentData(cwd, sessionId);
}
