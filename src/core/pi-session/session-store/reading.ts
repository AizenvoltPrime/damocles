import * as fs from 'fs';
import * as path from 'path';
import type { StoredSession } from '@shared/types/session';
import { log } from '../../logger';
import { perfSpan } from '../../perf';
import { ensurePiSessionDir, piSessionDir } from './session-dir';
import { worktreeSessionFolders } from '../../worktrees/personal-config';
import type { SessionFileMeta } from './metadata';
import type { SessionMetaIndex } from './meta-index/client';
import { metaCacheKey, piSessionIdFromFile } from './meta-index/protocol';

/** Session id to the file last seen for it. An entry can outlive its file and belong to another folder's lookup, so a
 *  reader checks that the entry's dir is one of its lookup dirs and that the file exists before trusting it. */
const sessionFileIndex = new Map<string, string>();

function indexSessionFile(filePath: string): void {
  sessionFileIndex.set(piSessionIdFromFile(filePath), filePath);
}

/** A list's first answer, and when the rows of the files it parses have all reached `onParsed`. */
export interface PiSessionList {
  /** Newest first. */
  sessions: StoredSession[];
  /** Resolves once no parsed row follows: true when every file the list found yielded its row, false when the list ended early or a parse could not finish (logged); never rejects. */
  parsed: Promise<boolean>;
}

/**
 * List every pi session for a workspace as webview `StoredSession`s (FR-1) from the session metadata index: `sessions`
 * holds the rows whose file's size and mtime still match. The worker parses the other files with pi's full metadata
 * path, so in-tree custom entries (the rename marker and the tag) survive reloads, and hands their rows to `onParsed`
 * in batches after this resolves.
 */
export async function listPiSessions(index: SessionMetaIndex, cwd: string, onParsed: (sessions: StoredSession[]) => void): Promise<PiSessionList> {
  const span = perfSpan('sessions.list');
  const parseSpan = perfSpan('sessions.listParsed');
  // Never created here: the worker lists a missing dir as empty, and a registry folder's dir is only ever created by its sessions (AD12).
  const dir = piSessionDir(cwd);
  let batches = 0;
  let rows = 0;
  let ended!: (complete: boolean) => void;
  const parsed = new Promise<boolean>((resolve) => { ended = resolve; });
  const listed = await index.list(dir, {
    batch: (sessions) => {
      batches++;
      rows += sessions.length;
      onParsed(sessions);
    },
    end: (complete) => {
      parseSpan.end({ rows, batches, complete });
      ended(complete);
    },
  });
  for (const file of listed.files) indexSessionFile(file);
  span.end({ files: listed.files.length, misses: listed.parsing, hits: listed.files.length - listed.parsing });
  return { sessions: [...listed.sessions].sort((a, b) => b.timestamp - a.timestamp), parsed };
}

/** Precise metadata for one pi session file (used by the watcher; cheaper than re-listing). */
export async function getPiSessionMetadataByFile(index: SessionMetaIndex, filePath: string): Promise<StoredSession | null> {
  try {
    const stored = await index.meta(filePath);
    if (stored) indexSessionFile(filePath);
    return stored;
  } catch (err) {
    log('[session-store] getPiSessionMetadataByFile failed for %s: %O', filePath, err);
    return null;
  }
}

/** A live session's in-memory view of the file it persists to. */
export interface LiveSessionMetaSource {
  /** The file the session persists to, or undefined when it has none. */
  liveSessionFile(): string | undefined;
  /** The file's metadata as `sessionFileMeta` reads it, taken from the in-memory manager; null without a session. */
  storedMetadata(mtimeMs: number): SessionFileMeta | null;
}

/**
 * Metadata for `sessionId` from the live session holding it, put into the session metadata index against the
 * file's current size and mtime. Undefined when `source` does not hold that session's file (or
 * `expectedFile`, when given), the file does not exist yet, or the snapshot threw; the caller then reads
 * the file. Null means the session yields no row.
 * Precondition: this window's live manager is the file's only writer.
 */
export function readLiveSessionMetadata(
  index: SessionMetaIndex,
  source: LiveSessionMetaSource,
  sessionId: string,
  expectedFile?: string,
): StoredSession | null | undefined {
  const file = source.liveSessionFile();
  if (!file || piSessionIdFromFile(file) !== sessionId) return undefined;
  if (expectedFile !== undefined && metaCacheKey(file) !== metaCacheKey(expectedFile)) return undefined;
  // Synchronous from here on, so pi cannot append between the stat and the snapshot.
  let stat: fs.Stats;
  try {
    // eslint-disable-next-line damocles/no-sync -- the stat and the snapshot run back to back (docs/invariants.md "Session store")
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  let meta: SessionFileMeta | null;
  try {
    meta = source.storedMetadata(stat.mtimeMs);
  } catch (err) {
    log('[session-store] live session metadata failed for %s: %O', file, err);
    return undefined;
  }
  if (!meta) return undefined;
  index.put(file, { size: stat.size, mtimeMs: stat.mtimeMs, ...meta });
  indexSessionFile(file);
  return meta.stored;
}

/** The indexed row for a file whose size and mtime match the indexed read (null: the file yields no row),
 *  or undefined when nothing was indexed for the file as it is now. Never reads the file. */
export function currentCachedRow(index: SessionMetaIndex, filePath: string): Promise<StoredSession | null | undefined> {
  return index.cachedRow(filePath);
}

/** Drop a file's indexed metadata. Called on delete: the pre-delete metadata read re-warms the row for a
 *  file that is about to vanish, and eviction otherwise waits for the next full list. */
export function forgetSessionMetadata(index: Pick<SessionMetaIndex, 'forget'>, filePath: string): void {
  index.forget(filePath);
  const id = piSessionIdFromFile(filePath);
  const indexed = sessionFileIndex.get(id);
  if (indexed !== undefined && metaCacheKey(indexed) === metaCacheKey(filePath)) sessionFileIndex.delete(id);
}

/**
 * The session directories a session of `cwd` can live in (slice 12a rule 1): `cwd`'s own, then, for a folder of a project with
 * worktree chats, the project's and each of its registry folders'. A session file stays where it was created, and a hand-off
 * moves a chat between those folders without moving it.
 */
export function sessionLookupDirs(cwd: string): string[] {
  const dirs = [piSessionDir(cwd), ...worktreeSessionFolders(cwd).map((folder) => piSessionDir(folder))];
  return [...new Map(dirs.map((dir) => [metaCacheKey(dir), dir])).values()];
}

/** The file the index remembers for `sessionId`, when it lies in one of `dirs`. */
function indexedIn(dirs: readonly string[], sessionId: string): string | undefined {
  const indexed = sessionFileIndex.get(sessionId);
  return indexed !== undefined && dirs.some((dir) => metaCacheKey(path.dirname(indexed)) === metaCacheKey(dir)) ? indexed : undefined;
}

/** Resolve the on-disk file for a pi session id within a workspace and its worktree folders, or null if absent. */
export async function resolvePiSessionFile(cwd: string, sessionId: string): Promise<string | null> {
  const dirs = sessionLookupDirs(cwd);
  const indexed = indexedIn(dirs, sessionId);
  if (indexed !== undefined) {
    try {
      await fs.promises.stat(indexed);
      return indexed;
    } catch {
      sessionFileIndex.delete(sessionId);
    }
  }
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await fs.promises.readdir(dir);
    } catch (err) {
      // A missing dir (no sessions yet) is normal; anything else is a real fault worth surfacing rather
      // than masking behind a bare null.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log('[session-store] resolvePiSessionFile readdir failed for %s: %O', dir, err);
      continue;
    }
    const match = files.find((f) => f.endsWith('.jsonl') && piSessionIdFromFile(f) === sessionId);
    if (!match) continue;
    const filePath = path.join(dir, match);
    indexSessionFile(filePath);
    return filePath;
  }
  return null;
}

/**
 * The directory of an existing session's file, where its subagent, team and fork data live (AD12 Sessions), found as
 * resolvePiSessionFile finds it; a session with no file yet takes `cwd`'s own directory, where pi creates it.
 */
export function piSessionDirOf(cwd: string, sessionId: string): string {
  const dirs = sessionLookupDirs(cwd);
  const indexed = indexedIn(dirs, sessionId);
  if (indexed !== undefined && fs.existsSync(indexed)) return path.dirname(indexed);
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log('[session-store] piSessionDirOf readdir failed for %s: %O', dir, err);
      continue;
    }
    const match = files.find((f) => f.endsWith('.jsonl') && piSessionIdFromFile(f) === sessionId);
    if (match) {
      indexSessionFile(path.join(dir, match));
      return dir;
    }
  }
  return ensurePiSessionDir(cwd);
}

/** Precise metadata for one pi session by id (marker-aware; used on rename/title/create upserts). */
export async function getPiSessionMetadata(index: SessionMetaIndex, cwd: string, sessionId: string): Promise<StoredSession | null> {
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  if (!filePath) return null;
  return getPiSessionMetadataByFile(index, filePath);
}

/**
 * Recent unique user prompts across the pi sessions of every folder in `cwds`, in the order of
 * `sessions` (newest first; the up-arrow prompt history). Reads only the pi tree (FR-1); the SDK
 * `extractPromptHistory` is never called on pi.
 */
export async function extractPiPromptHistory(index: SessionMetaIndex, cwds: readonly string[], sessions: StoredSession[]): Promise<string[]> {
  const span = perfSpan('promptHistory');
  const dirs = [...new Set(cwds.flatMap((cwd) => sessionLookupDirs(cwd)))];
  const { prompts, opened } = await index.promptHistory(dirs, sessions.map((session) => session.id));
  span.end({ files: opened, prompts: prompts.length });
  return prompts;
}
