// Host to session metadata worker and back (docs/invariants.md "Session store"). Pure: both sides import it.
import * as path from 'node:path';
import type { StoredSession } from '@shared/types/session';

export const SESSION_META_INDEX_WORKER_MARKER = 'damocles-session-meta-index-worker';

export interface SessionMetaIndexWorkerData {
  marker: typeof SESSION_META_INDEX_WORKER_MARKER;
  /** Holds the index file; the legacy JSON caches lived here too. */
  cacheDir: string;
  /** Absolute: a bare specifier does not resolve from the unpacked worker into app.asar. */
  piPackageDir: string;
}

/**
 * What one session file yielded, valid while the file's size and mtime both still match (pi appends, so a
 * size change catches a write within the mtime's resolution). `stored` is null when the file had no session
 * header or opening it threw; that is cached too, so an unreadable file costs one read per change.
 */
export interface SessionMetaEntry {
  size: number;
  mtimeMs: number;
  stored: StoredSession | null;
  /** Newest first, unique, capped: see `newestUniquePrompts`. */
  prompts: string[];
}

/**
 * The index key of a path. On Windows the same file reaches the readers with different drive-letter case
 * (`os.homedir()` gives `C:\…`, a VS Code `uri.fsPath` gives `c:\…`) on a case-insensitive FS, so win32 keys
 * are lowercased; other platforms stay verbatim.
 */
export function metaCacheKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Extract the pi session id from a `<timestamp>_<id>.jsonl` filename. */
export function piSessionIdFromFile(filePath: string): string {
  const base = path.basename(filePath).replace(/\.jsonl$/i, '');
  const underscore = base.indexOf('_');
  return underscore >= 0 ? base.slice(underscore + 1) : base;
}

export type MetaIndexRequest =
  | { type: 'list'; id: number; dir: string }
  | { type: 'meta'; id: number; file: string }
  | { type: 'cachedRow'; id: number; file: string }
  | { type: 'promptHistory'; id: number; dirs: string[]; sessionIds: string[] }
  | { type: 'put'; file: string; entry: SessionMetaEntry }
  | { type: 'forget'; file: string }
  /** Commits pending puts, closes the index and ends the worker. */
  | { type: 'close' };

export type MetaIndexEvent =
  /** A list's still-valid rows, and every session file it found; `parsing` files follow in `listBatch` events. */
  | { type: 'listed'; id: number; sessions: StoredSession[]; files: string[]; parsing: number }
  | { type: 'listBatch'; id: number; sessions: StoredSession[] }
  /** `complete` false: a file the list found yielded no row, as its parse could not finish, or the dir could not be read. */
  | { type: 'listDone'; id: number; complete: boolean }
  | { type: 'meta'; id: number; stored: StoredSession | null }
  /** `found` false: nothing cached for the file as it is now. */
  | { type: 'cachedRow'; id: number; found: boolean; stored: StoredSession | null }
  | { type: 'promptHistory'; id: number; prompts: string[]; opened: number }
  | { type: 'error'; id: number; message: string }
  | { type: 'log'; message: string };
