import * as fs from 'fs';
import * as path from 'path';
import type { StoredSession } from '@shared/types/session';
import { initPiLoader, type PiCodingAgentModule } from '../pi-loader';
import { log } from '../../logger';
import { perfSpan } from '../../perf';
import { ensurePiSessionDir } from './session-dir';
import { PI_PROMPT_HISTORY_CAP, sessionFileMeta, type SessionFileMeta } from './metadata';
import {
  evictSessionMetaExcept,
  forgetSessionMeta,
  getSessionMeta,
  metaCacheKey,
  setSessionMeta,
  type SessionMetaEntry,
} from './session-meta-cache';

/** Extract the pi session id from a `<timestamp>_<id>.jsonl` filename. */
export function piSessionIdFromFile(filePath: string): string {
  const base = path.basename(filePath).replace(/\.jsonl$/i, '');
  const underscore = base.indexOf('_');
  return underscore >= 0 ? base.slice(underscore + 1) : base;
}

/** Session id to the file last seen for it. An entry can outlive its file, so `resolvePiSessionFile` checks
 *  the entry's dir and stats the file before trusting it. */
const sessionFileIndex = new Map<string, string>();

function indexSessionFile(filePath: string): void {
  sessionFileIndex.set(piSessionIdFromFile(filePath), filePath);
}

/** The cached entry for a file, if it was read from the file as it is now. */
function currentMeta(filePath: string, size: number, mtimeMs: number): SessionMetaEntry | undefined {
  const cached = getSessionMeta(filePath);
  return cached && cached.size === size && cached.mtimeMs === mtimeMs ? cached : undefined;
}

function readSessionFile(pi: PiCodingAgentModule, filePath: string, mtimeMs: number): SessionFileMeta {
  // The session dir is the file's own parent, never recomputed from a workspace cwd.
  return sessionFileMeta(pi.SessionManager.open(filePath, path.dirname(filePath)), mtimeMs);
}

/**
 * List every pi session for a workspace as webview `StoredSession`s, newest first (FR-1). Each file is
 * opened and read through the full metadata path so in-tree custom entries (the rename marker and the
 * tag) survive reloads — pi's streaming `list()` cannot see custom entries. Files whose size and mtime
 * match the metadata cache (in memory, or on disk from an earlier window) are not re-parsed.
 */
export async function listPiSessions(cwd: string): Promise<StoredSession[]> {
  const span = perfSpan('sessions.list');
  const dir = ensurePiSessionDir(cwd);
  let files: string[];
  try {
    files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    span.end({ files: 0 });
    return [];
  }
  // Stat every file at once: awaiting them one by one queues each behind whatever else holds the thread.
  const stats = await Promise.all(files.map((file) => fs.promises.stat(path.join(dir, file)).catch(() => null)));
  const sessions: StoredSession[] = [];
  const seenKeys = new Set<string>();
  let hits = 0;
  let misses = 0;
  let pi: PiCodingAgentModule | null | undefined;
  for (const [i, file] of files.entries()) {
    const stat = stats[i];
    if (!stat) continue; // vanished between readdir and stat
    const filePath = path.join(dir, file);
    seenKeys.add(metaCacheKey(filePath));
    indexSessionFile(filePath);
    const { mtimeMs, size } = stat;
    const cached = currentMeta(filePath, size, mtimeMs);
    if (cached) {
      hits++;
      if (cached.stored) sessions.push(cached.stored);
      continue;
    }
    misses++;
    if (pi === undefined) pi = await initPiLoader();
    if (!pi) continue;
    // Each parse is synchronous, so yield between them.
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const meta = readSessionFile(pi, filePath, mtimeMs);
      setSessionMeta(filePath, { size, mtimeMs, ...meta });
      if (meta.stored) sessions.push(meta.stored);
    } catch (err) {
      setSessionMeta(filePath, { size, mtimeMs, stored: null, prompts: [] });
      log('[session-store] listPiSessions: skipping %s: %O', file, err);
    }
  }
  evictSessionMetaExcept(dir, seenKeys);
  sessions.sort((a, b) => b.timestamp - a.timestamp);
  span.end({ files: files.length, misses, hits });
  return sessions;
}

/** Precise metadata for one pi session file (used by the watcher; cheaper than re-listing). */
export async function getPiSessionMetadataByFile(filePath: string): Promise<StoredSession | null> {
  let mtimeMs: number;
  let size: number;
  try {
    ({ mtimeMs, size } = await fs.promises.stat(filePath));
  } catch (err) {
    // pi's `SessionManager.open` of a missing path starts a new session there.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      forgetSessionMetadata(filePath);
      return null;
    }
    mtimeMs = Date.now();
    size = -1;
  }
  const pi = await initPiLoader();
  if (!pi) return null;
  try {
    const meta = readSessionFile(pi, filePath, mtimeMs);
    // Warms the list cache, so the rebuild this change triggers reuses this read. Negatives are cached
    // too, so both readers agree on what an entry means.
    setSessionMeta(filePath, { size, mtimeMs, ...meta });
    indexSessionFile(filePath);
    return meta.stored;
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
 * Metadata for `sessionId` from the live session holding it, recorded in the metadata cache against the
 * file's current size and mtime. Undefined when `source` does not hold that session's file (or
 * `expectedFile`, when given), the file does not exist yet, or the snapshot threw; the caller then reads
 * the file. Null means the session yields no row.
 * Precondition: this window's live manager is the file's only writer.
 */
export function readLiveSessionMetadata(
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
  setSessionMeta(file, { size: stat.size, mtimeMs: stat.mtimeMs, ...meta }, { schedule: false });
  indexSessionFile(file);
  return meta.stored;
}

/** The cached row for a file whose size and mtime match the cached read (null: the file yields no row),
 *  or undefined when nothing was cached for the file as it is now. */
export async function currentCachedRow(filePath: string): Promise<StoredSession | null | undefined> {
  if (!getSessionMeta(filePath)) return undefined;
  try {
    const { mtimeMs, size } = await fs.promises.stat(filePath);
    return currentMeta(filePath, size, mtimeMs)?.stored;
  } catch {
    return undefined;
  }
}

/** Drop a file's cached metadata, on disk too. Called on delete: the pre-delete metadata read re-warms
 *  the entry for a file that is about to vanish, and eviction otherwise waits for the next full list. */
export function forgetSessionMetadata(filePath: string): void {
  forgetSessionMeta(filePath);
  const id = piSessionIdFromFile(filePath);
  const indexed = sessionFileIndex.get(id);
  if (indexed !== undefined && metaCacheKey(indexed) === metaCacheKey(filePath)) sessionFileIndex.delete(id);
}

/** Resolve the on-disk file for a pi session id within a workspace, or null if absent. */
export async function resolvePiSessionFile(cwd: string, sessionId: string): Promise<string | null> {
  const dir = ensurePiSessionDir(cwd);
  const indexed = sessionFileIndex.get(sessionId);
  if (indexed !== undefined && metaCacheKey(path.dirname(indexed)) === metaCacheKey(dir)) {
    try {
      await fs.promises.stat(indexed);
      return indexed;
    } catch {
      sessionFileIndex.delete(sessionId);
    }
  }
  try {
    const files = await fs.promises.readdir(dir);
    const match = files.find((f) => f.endsWith('.jsonl') && piSessionIdFromFile(f) === sessionId);
    if (!match) return null;
    const filePath = path.join(dir, match);
    indexSessionFile(filePath);
    return filePath;
  } catch (err) {
    // A missing dir (no sessions yet) is normal; anything else is a real fault worth surfacing rather
    // than masking behind a bare null.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('[session-store] resolvePiSessionFile readdir failed for %s: %O', dir, err);
    }
    return null;
  }
}

/** Precise metadata for one pi session by id (marker-aware; used on rename/title/create upserts). */
export async function getPiSessionMetadata(cwd: string, sessionId: string): Promise<StoredSession | null> {
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  if (!filePath) return null;
  return getPiSessionMetadataByFile(filePath);
}

const PROMPT_HISTORY_STAT_BATCH = 16;

/**
 * Recent unique user prompts across the pi sessions of every folder in `cwds`, in the order of
 * `sessions` (newest first; the up-arrow prompt history). Reads only the pi tree (FR-1); the SDK
 * `extractPromptHistory` is never called on pi.
 */
export async function extractPiPromptHistory(cwds: readonly string[], sessions: StoredSession[]): Promise<string[]> {
  const span = perfSpan('promptHistory');
  let opened = 0;

  // One readdir per folder into an id→path map, so each session resolves in O(1). Resolving per session
  // via `resolvePiSessionFile` would readdir the whole store once per session, O(files²) on the hot path.
  const idToPath = new Map<string, string>();
  for (const cwd of cwds) {
    const dir = ensurePiSessionDir(cwd);
    try {
      const files = await fs.promises.readdir(dir);
      for (const f of files) {
        const id = piSessionIdFromFile(f);
        if (f.endsWith('.jsonl') && !idToPath.has(id)) idToPath.set(id, path.join(dir, f));
      }
    } catch {
      continue;
    }
  }

  const seen = new Set<string>();
  const history: string[] = [];
  const filePaths = sessions.map((session) => idToPath.get(session.id));
  let pi: PiCodingAgentModule | null | undefined;

  // Stat a batch at once (one by one queues each behind whatever else holds the thread), and only as many
  // batches as it takes to reach the cap.
  for (let start = 0; start < filePaths.length && history.length < PI_PROMPT_HISTORY_CAP; start += PROMPT_HISTORY_STAT_BATCH) {
    const batch = filePaths.slice(start, start + PROMPT_HISTORY_STAT_BATCH);
    const stats = await Promise.all(batch.map((filePath) => (filePath ? fs.promises.stat(filePath).catch(() => null) : null)));
    for (const [i, filePath] of batch.entries()) {
      if (history.length >= PI_PROMPT_HISTORY_CAP) break;
      const stat = stats[i];
      if (!filePath || !stat) continue; // no file, or it vanished
      const { mtimeMs, size } = stat;
      let prompts: string[];
      const cached = currentMeta(filePath, size, mtimeMs);
      if (cached) {
        prompts = cached.prompts;
      } else {
        if (pi === undefined) pi = await initPiLoader();
        if (!pi) continue;
        // Each parse is synchronous, so yield between them.
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          const meta = readSessionFile(pi, filePath, mtimeMs);
          opened++;
          setSessionMeta(filePath, { size, mtimeMs, ...meta });
          prompts = meta.prompts;
        } catch {
          continue; // an unreadable session file
        }
      }
      for (const p of prompts) {
        if (seen.has(p)) continue;
        seen.add(p);
        history.push(p);
        if (history.length >= PI_PROMPT_HISTORY_CAP) break;
      }
    }
  }
  span.end({ files: opened, prompts: history.length });
  return history;
}
