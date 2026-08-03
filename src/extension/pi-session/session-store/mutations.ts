import * as fs from 'fs';
import { initPiLoader } from '../pi-loader';
import { log } from '../../logger';
import { getRepoDir } from '../checkpoints';
import { findSessionPlanFiles } from '../../paths';
import { ensurePiSessionDir } from './session-dir';
import { resolvePiSessionFile, getPiSessionMetadataByFile, forgetSessionMetadata } from './reading';
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

/**
 * Delete a stored pi session: remove its JSONL file, its per-session checkpoint repo (US-010b), AND every
 * plan file it wrote (matched by the session's stable plan-id suffix within DAMOCLES_PLANS_DIR).
 * The SDK store under ~/.claude is never touched (FR-1). Best-effort + idempotent.
 */
export async function deletePiSession(cwd: string, sessionId: string): Promise<void> {
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  if (!filePath) return;
  const repoDir = getRepoDir(filePath);
  // Read metadata before removing the file so the plan path resolves from the same first-message slug.
  const metadata = await getPiSessionMetadataByFile(filePath);
  await fs.promises.rm(filePath, { force: true }).catch((err) => log('[session-store] delete session file failed: %O', err));
  // The metadata read above re-warmed the cache for a file that no longer exists; drop it here rather
  // than waiting for the next full list to sweep it.
  forgetSessionMetadata(filePath);
  await fs.promises.rm(repoDir, { recursive: true, force: true }).catch((err) => log('[session-store] delete checkpoint repo failed: %O', err));
  if (metadata) {
    // Match by the session's stable plan-id suffix (not a slug recompute) so every plan file it wrote is
    // removed — including one bound before the slug settled, which a recompute would miss and orphan.
    for (const planPath of await findSessionPlanFiles(metadata.id)) {
      await fs.promises.rm(planPath, { force: true }).catch((err) => log('[session-store] delete plan file failed: %O', err));
    }
  }
}
