import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../logger';
import { writeFileAtomic } from './atomic-write';
import { getCheckpointRecords } from './checkpoint-entry';
import { RepoManager } from './repo-manager';
import { folderIdFor, getFolderRepoDir, getGitDir, getIndexPath, isFolderId } from './resolver';
import { isHexCommit, isSafeRefId } from './types';
import type { CheckpointEntryV3, PreRewindRecord, Result, SkippedFile } from './types';

export const SESSION_REFS_ROOT = 'refs/damocles/sessions/';

/** `skipped` points at the manifest blob of a before-state or compaction snapshot. */
export type CheckpointRefPhase = 'before' | 'after' | 'snapshot' | 'skipped';

/** Pre-rewind refs live under this component, which `isSafeRefId` refuses as an entry id, so they never collide with one. */
const PRE_REWIND_COMPONENT = '_rewinds';

/** `refs/damocles/sessions/<sessionId>/`; throws on an id that is not ref-safe. */
export function sessionRefPrefix(sessionId: string): string {
  if (!isSafeRefId(sessionId)) throw new Error(`unsafe session id for a checkpoint ref: ${JSON.stringify(sessionId)}`);
  return `${SESSION_REFS_ROOT}${sessionId}/`;
}

/** `refs/damocles/sessions/<sessionId>/<entryKey>/<phase>`; throws on an id that is not ref-safe. */
export function checkpointRefName(sessionId: string, entryKey: string, phase: CheckpointRefPhase): string {
  if (!isSafeRefId(entryKey)) throw new Error(`unsafe entry id for a checkpoint ref: ${JSON.stringify(entryKey)}`);
  return `${sessionRefPrefix(sessionId)}${entryKey}/${phase}`;
}

/** `refs/damocles/sessions/<sessionId>/_rewinds/<id>/<part>`; throws on an id that is not ref-safe. */
export function preRewindRefName(sessionId: string, id: string, part: 'snapshot' | 'skipped'): string {
  if (!isSafeRefId(id)) throw new Error(`unsafe pre-rewind id for a checkpoint ref: ${JSON.stringify(id)}`);
  return `${sessionRefPrefix(sessionId)}${PRE_REWIND_COMPONENT}/${id}/${part}`;
}

/** The session id a checkpoint ref belongs to, or null for any other ref. */
export function sessionIdOfRef(ref: string): string | null {
  if (!ref.startsWith(SESSION_REFS_ROOT)) return null;
  const id = ref.slice(SESSION_REFS_ROOT.length).split('/')[0] ?? '';
  return isSafeRefId(id) ? id : null;
}

export interface FolderRepoHandle {
  readonly folderId: string;
  readonly repoDir: string;
  readonly repo: RepoManager;
}

/** The folder repo for `cwd`, as a handle; nothing is created until a snapshot runs. */
export function folderRepoFor(cwd: string): FolderRepoHandle {
  return folderRepoById(folderIdFor(cwd), cwd);
}

export function folderRepoById(folderId: string, cwd: string): FolderRepoHandle {
  if (!isFolderId(folderId)) throw new Error(`not a folder repo id: ${JSON.stringify(folderId)}`);
  const repoDir = getFolderRepoDir(folderId);
  return { folderId, repoDir, repo: new RepoManager(getGitDir(repoDir), getIndexPath(repoDir), cwd, { capturesTracked: true }) };
}

function registrationPath(repoDir: string, sessionId: string): string {
  return path.join(repoDir, 'sessions', `${sessionId}.json`);
}

/**
 * Record which session file owns a conversation's refs, so orphan detection can tell a deleted
 * conversation from a live one. Called under the folder lock before the session's first ref is written.
 */
export async function registerSession(repoDir: string, sessionId: string, sessionFile: string): Promise<void> {
  const file = registrationPath(repoDir, sessionId);
  if (fs.existsSync(file)) return;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify({ sessionFile })}\n`);
}

/**
 * Record, before a fork opens, that it still needs its own refs to the checkpoints it inherited from
 * each folder repo in `folderIds` (`pendingCopy`); `reconcilePendingCopiesLocked` makes the copy if the
 * background one never runs. A folder repo that is gone is skipped: it has nothing left to copy.
 */
export async function markForkCopyPending(sessionId: string, sessionFile: string, folderIds: ReadonlySet<string>): Promise<void> {
  if (!isSafeRefId(sessionId)) {
    log('[Checkpoints] fork %s: no pending copy recorded, the id is not ref-safe', sessionId);
    return;
  }
  for (const folderId of folderIds) {
    const repoDir = getFolderRepoDir(folderId);
    if (!fs.existsSync(path.join(getGitDir(repoDir), 'HEAD'))) continue;
    // No folder lock: the id is new, registerSession never overwrites, and a registration is deleted only with its session's refs (none yet) or, while pending, once its session file is gone.
    const file = registrationPath(repoDir, sessionId);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify({ sessionFile, pendingCopy: true })}\n`);
  }
}

export interface SessionRegistration {
  sessionFile: string;
  registeredAtMs: number;
  /** A fork whose inherited checkpoint refs are not copied yet. */
  pendingCopy: boolean;
}

/**
 * The session file a conversation registered and when (a fork registers when it is made), or null when
 * it registered none or the registration is unreadable, which is logged and treated as unregistered.
 */
export async function readSessionRegistration(repoDir: string, sessionId: string): Promise<SessionRegistration | null> {
  const file = registrationPath(repoDir, sessionId);
  let text: string;
  let registeredAtMs: number;
  try {
    text = await fs.promises.readFile(file, 'utf8');
    registeredAtMs = (await fs.promises.stat(file)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: { sessionFile?: unknown; pendingCopy?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch (err) {
    log('[Checkpoints] registration %s is not JSON, treated as unregistered: %s', file, err instanceof Error ? err.message : String(err));
    return null;
  }
  if (typeof parsed.sessionFile !== 'string') {
    log('[Checkpoints] registration %s names no session file, treated as unregistered', file);
    return null;
  }
  return { sessionFile: parsed.sessionFile, registeredAtMs, pendingCopy: parsed.pendingCopy === true };
}

/** Rewrite a pending registration without the flag. The caller holds the folder lock. */
async function clearPendingCopyLocked(repoDir: string, sessionId: string): Promise<void> {
  const registration = await readSessionRegistration(repoDir, sessionId);
  if (!registration?.pendingCopy) return;
  const file = registrationPath(repoDir, sessionId);
  await writeFileAtomic(file, `${JSON.stringify({ sessionFile: registration.sessionFile })}\n`);
  // The mtime dates the fork for maintenance's age eviction.
  const registeredAt = new Date(registration.registeredAtMs);
  await fs.promises.utimes(file, registeredAt, registeredAt);
}

/**
 * Point `sessionId`'s refs at each entry's commits and skipped manifest. An entry with an unsafe id, a
 * non-hex commit or a missing object is logged and skipped. Returns how many entries got refs. The
 * caller holds the folder lock.
 */
async function copyEntryRefsLocked(handle: FolderRepoHandle, sessionId: string, sessionFile: string, entries: readonly CheckpointEntryV3[]): Promise<number> {
  const updates: Array<{ ref: string; commit: string }> = [];
  let count = 0;
  for (const entry of entries) {
    const commits = entry.beforeCommit === entry.afterCommit ? [entry.beforeCommit] : [entry.beforeCommit, entry.afterCommit];
    const manifest = entry.skipped.manifest;
    if (!isSafeRefId(entry.userEntryId) || !commits.every(isHexCommit)) {
      log('[Checkpoints] fork: entry %s has an unsafe id or commit; not copied', entry.userEntryId);
      continue;
    }
    const present = await Promise.all([
      ...commits.map((c) => handle.repo.objectExists(c, 'commit')),
      ...(manifest === null ? [] : [handle.repo.objectExists(manifest, 'blob')]),
    ]);
    if (!present.every(Boolean)) {
      log('[Checkpoints] fork: objects of entry %s are gone from folder repo %s; not copied', entry.userEntryId, handle.folderId);
      continue;
    }
    updates.push({ ref: checkpointRefName(sessionId, entry.userEntryId, 'before'), commit: entry.beforeCommit });
    if (entry.afterCommit !== entry.beforeCommit) {
      updates.push({ ref: checkpointRefName(sessionId, entry.userEntryId, 'after'), commit: entry.afterCommit });
    }
    if (manifest !== null) updates.push({ ref: checkpointRefName(sessionId, entry.userEntryId, 'skipped'), commit: manifest });
    count++;
  }
  if (updates.length === 0) return 0;
  await registerSession(handle.repoDir, sessionId, sessionFile);
  await handle.repo.updateRefs(updates);
  return count;
}

/** Every entry object of a JSONL session file; a line that is not JSON is skipped the way pi's own reader skips it. */
async function readSessionFileEntries(sessionFile: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const line of (await fs.promises.readFile(sessionFile, 'utf8')).split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * Finish every fork copy recorded by `markForkCopyPending` in this folder repo: copy the refs of the
 * validated v3 checkpoints the fork's session file holds for this repo and clear the flag, or remove the
 * registration when the fork's session file is gone. Runs before anything in the same lock hold deletes
 * refs or prunes objects. The caller holds the folder lock.
 */
export async function reconcilePendingCopiesLocked(handle: FolderRepoHandle): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(path.join(handle.repoDir, 'sessions'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const sessionId = name.slice(0, -'.json'.length);
    if (!isSafeRefId(sessionId)) continue;
    const registration = await readSessionRegistration(handle.repoDir, sessionId);
    if (!registration?.pendingCopy) continue;
    if (!fs.existsSync(registration.sessionFile)) {
      await fs.promises.rm(registrationPath(handle.repoDir, sessionId), { force: true });
      log('[Checkpoints] pending fork copy of session %s dropped: its session file is gone', sessionId);
      continue;
    }
    const entries = getCheckpointRecords(await readSessionFileEntries(registration.sessionFile)).filter(
      (r): r is CheckpointEntryV3 => r.kind === 'checkpoint' && r.v === 3 && r.folderId === handle.folderId,
    );
    const copied = await copyEntryRefsLocked(handle, sessionId, registration.sessionFile, entries);
    await clearPendingCopyLocked(handle.repoDir, sessionId);
    log('[Checkpoints] reconciled the pending fork copy of session %s in folder repo %s: %d of %d checkpoints', sessionId, handle.folderId, copied, entries.length);
  }
}

/** Delete every ref of `sessionId` and its registration. The caller holds the folder lock and has run `reconcilePendingCopiesLocked` in this hold. */
export async function dropSessionRefsLocked(handle: FolderRepoHandle, sessionId: string): Promise<number> {
  const refs = (await handle.repo.listRefs(sessionRefPrefix(sessionId))).map((r) => r.ref);
  await handle.repo.deleteRefs(refs);
  await fs.promises.rm(registrationPath(handle.repoDir, sessionId), { force: true });
  return refs.length;
}

/** Give pending forks their refs, then delete every ref of `sessionId` and its registration. The caller holds the folder lock. */
export async function removeSessionRefsLocked(handle: FolderRepoHandle, sessionId: string): Promise<number> {
  await reconcilePendingCopiesLocked(handle);
  return dropSessionRefsLocked(handle, sessionId);
}

/**
 * The folder repos a session file's v3 checkpoints point into. A missing or unreadable file has none;
 * a line that is not JSON is skipped the way pi's own reader skips it.
 */
export async function folderIdsInSessionFile(sessionFile: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let text: string;
  try {
    text = await fs.promises.readFile(sessionFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ids;
    throw err;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"damocles-checkpoint"')) continue;
    let entry: { type?: unknown; customType?: unknown; data?: { v?: unknown; repo?: unknown; folderId?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const data = entry.data;
    if (entry.type === 'custom' && entry.customType === 'damocles-checkpoint' && data?.v === 3 && data.repo === 'folder' && typeof data.folderId === 'string' && isFolderId(data.folderId)) {
      ids.add(data.folderId);
    }
  }
  return ids;
}

/**
 * Delete a conversation's checkpoint refs from every folder repo it used: the one for `cwd` plus
 * `folderIds`, the ones its entries name (`folderIdsInSessionFile`). Each repo is handled under its own
 * lock, which can wait behind another conversation's baseline; one failure is logged and the rest still
 * run. The caller has already detached every holder of the session, so nothing re-creates the refs.
 */
export async function deleteSessionCheckpointRefs(cwd: string, sessionId: string, folderIds: ReadonlySet<string>): Promise<void> {
  if (!isSafeRefId(sessionId)) {
    log('[Checkpoints] refs of session %s left in place: the id is not ref-safe', sessionId);
    return;
  }
  for (const folderId of new Set([...folderIds, folderIdFor(cwd)])) {
    const handle = folderRepoById(folderId, cwd);
    if (!fs.existsSync(path.join(getGitDir(handle.repoDir), 'HEAD'))) continue;
    try {
      const removed = await handle.repo.withLock(() => removeSessionRefsLocked(handle, sessionId));
      log('[Checkpoints] deleted %d checkpoint refs of session %s in folder repo %s', removed, sessionId, folderId);
    } catch (err) {
      log('[Checkpoints] deleting checkpoint refs of session %s in folder repo %s failed: %O', sessionId, folderId, err);
    }
  }
}

/**
 * Give a forked conversation its own refs to the v3 checkpoints it inherited (commits and skipped
 * manifest), so they survive the parent's deletion, and clear the fork's pending-copy flag. Pre-rewind
 * snapshots are not inherited. Each object is checked to exist before it is referenced; an entry with a
 * missing one is logged and skipped. Returns how many entries got refs.
 */
export async function copyCheckpointRefs(
  cwd: string,
  childSessionId: string,
  childSessionFile: string,
  entries: readonly CheckpointEntryV3[],
): Promise<number> {
  const byFolder = new Map<string, CheckpointEntryV3[]>();
  for (const entry of entries) byFolder.set(entry.folderId, [...(byFolder.get(entry.folderId) ?? []), entry]);
  let copied = 0;
  for (const [folderId, group] of byFolder) {
    const handle = folderRepoById(folderId, cwd);
    if (!fs.existsSync(path.join(getGitDir(handle.repoDir), 'HEAD'))) {
      log('[Checkpoints] fork: folder repo %s is gone; %d inherited checkpoints are not rewindable', folderId, group.length);
      continue;
    }
    copied += await handle.repo.withLock(async () => {
      const count = await copyEntryRefsLocked(handle, childSessionId, childSessionFile, group);
      await clearPendingCopyLocked(handle.repoDir, childSessionId);
      return count;
    });
  }
  return copied;
}

/**
 * The full skipped list of a checkpoint or pre-rewind snapshot, read from its manifest blob without the
 * folder lock (the ref of the entry or record keeps the blob alive). The source must belong to `cwd`'s
 * folder repo, whose `folder.json` must name `cwd`. Never throws.
 */
export async function readSkippedManifest(source: Pick<CheckpointEntryV3 | PreRewindRecord, 'folderId' | 'skipped'>, cwd: string): Promise<Result<SkippedFile[]>> {
  if (source.folderId !== folderIdFor(cwd)) return { ok: false, error: `the checkpoint belongs to folder repo ${source.folderId}, not to ${cwd}` };
  const manifest = source.skipped.manifest;
  if (manifest === null) return { ok: true, value: [] };
  const handle = folderRepoById(source.folderId, cwd);
  if (!fs.existsSync(path.join(getGitDir(handle.repoDir), 'HEAD'))) return { ok: false, error: `the folder checkpoint repo is gone (${handle.repoDir})` };
  try {
    const mismatch = await handle.repo.folderMismatch(cwd);
    if (mismatch !== null) return { ok: false, error: mismatch };
    return { ok: true, value: await handle.repo.readManifest(manifest) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
