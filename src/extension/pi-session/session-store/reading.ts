import * as fs from 'fs';
import * as path from 'path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { StoredSession } from '@shared/types/session';
import { initPiLoader } from '../pi-loader';
import { log } from '../../logger';
import { ensurePiSessionDir } from './session-dir';
import { mapPiFieldsToStored, computePiSessionFields } from './metadata';
import { extractOriginalInputs } from './original-input';

const PI_PROMPT_HISTORY_CAP = 500;

/** Extract the pi session id from a `<timestamp>_<id>.jsonl` filename. */
export function piSessionIdFromFile(filePath: string): string {
  const base = path.basename(filePath).replace(/\.jsonl$/i, '');
  const underscore = base.indexOf('_');
  return underscore >= 0 ? base.slice(underscore + 1) : base;
}

/** mtime-keyed metadata cache (normalized absolute file path → last-seen mtime + computed metadata).
 *  Lets a list rebuild skip the synchronous full-file read of every UNCHANGED session — the rebuild
 *  fires on every rename/tag/delete/create, and without this each one re-parses the whole store. */
interface CachedMeta {
  mtimeMs: number;
  /** `null` when the file yielded no metadata — it had no session header, or opening it threw. Cached
   *  like a success so an UNREADABLE file also costs one synchronous full-file read per change rather
   *  than one per rebuild; the throwing variant additionally stops re-logging every rebuild. Only an
   *  mtime change re-reads it, which is what a repair (pi's migration rewrite) produces. */
  stored: StoredSession | null;
}
const metaCache = new Map<string, CachedMeta>();

/**
 * Normalize a path for cache keying. On Windows the SAME file reaches the two writers with different
 * drive-letter case — `listPiSessions` derives paths from `os.homedir()` (`C:\…`) while the watcher
 * feeds VS Code `uri.fsPath` (`c:\…`) into `getPiSessionMetadataByFile`. Keying on the raw string
 * would defeat cache warming AND leak entries (the eviction prefix never matches). Lowercasing on
 * win32 (a case-insensitive FS) collapses both spellings to one key; other platforms stay verbatim.
 */
function metaCacheKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * List every pi session for a workspace as webview `StoredSession`s, newest first (FR-1). Each file is
 * opened and read through the full metadata path so in-tree custom entries (the rename marker and the
 * tag) survive reloads — pi's streaming `list()` cannot see custom entries. Files whose mtime is
 * unchanged since the last read are served from `metaCache` rather than re-parsed.
 */
export async function listPiSessions(cwd: string): Promise<StoredSession[]> {
  const pi = await initPiLoader();
  if (!pi) return [];
  const dir = ensurePiSessionDir(cwd);
  let files: string[];
  try {
    files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const sessions: StoredSession[] = [];
  const seenKeys = new Set<string>();
  for (const file of files) {
    const filePath = path.join(dir, file);
    const key = metaCacheKey(filePath);
    seenKeys.add(key);
    // The async stat both yields to the event loop between files and feeds the cache key.
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.promises.stat(filePath)).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat
    }
    const cached = metaCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs) {
      if (cached.stored) sessions.push(cached.stored);
      continue;
    }
    try {
      const stored = storedFromManager(pi.SessionManager.open(filePath, dir), mtimeMs);
      metaCache.set(key, { mtimeMs, stored });
      if (stored) sessions.push(stored);
    } catch (err) {
      metaCache.set(key, { mtimeMs, stored: null });
      log('[session-store] listPiSessions: skipping %s: %O', file, err);
    }
  }
  // Evict cache entries for files removed from THIS dir; leave other workspaces' entries intact.
  const dirKeyPrefix = metaCacheKey(dir) + path.sep;
  for (const key of metaCache.keys()) {
    if (key.startsWith(dirKeyPrefix) && !seenKeys.has(key)) metaCache.delete(key);
  }
  return sessions.sort((a, b) => b.timestamp - a.timestamp);
}

/** Open a pi session file and build a marker-aware `StoredSession` from its ACTIVE branch. */
function storedFromManager(sm: SessionManager, mtimeMs: number): StoredSession | null {
  const header = sm.getHeader();
  if (!header) return null;
  const branch = sm.getBranch(sm.getLeafId() ?? undefined);
  const fields = computePiSessionFields(header, branch, sm.getSessionName(), mtimeMs);
  return mapPiFieldsToStored(fields);
}

/** Precise metadata for one pi session file (used by the watcher; cheaper than re-listing). */
export async function getPiSessionMetadataByFile(filePath: string): Promise<StoredSession | null> {
  const pi = await initPiLoader();
  if (!pi) return null;
  try {
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.promises.stat(filePath)).mtimeMs;
    } catch {
      mtimeMs = Date.now();
    }
    // The session dir is the file's own parent — never recomputed from a workspace cwd, so this can't
    // drift if pi's SessionManager.open ever requires dir === dirname(file) for branch resolution.
    const sm = pi.SessionManager.open(filePath, path.dirname(filePath));
    const stored = storedFromManager(sm, mtimeMs);
    // Warm the list cache (normalized key, so a watcher path with a different drive-letter case than
    // the list path still hits) so the subsequent rebuild this change triggers reuses this read.
    // Negatives are cached too, so both readers agree on what a cache entry means.
    metaCache.set(metaCacheKey(filePath), { mtimeMs, stored });
    return stored;
  } catch (err) {
    log('[session-store] getPiSessionMetadataByFile failed for %s: %O', filePath, err);
    return null;
  }
}

/** Drop a file's cached metadata. Called on delete: the pre-delete metadata read re-warms the entry
 *  for a file that is about to vanish, and eviction otherwise waits for the next full list. */
export function forgetSessionMetadata(filePath: string): void {
  metaCache.delete(metaCacheKey(filePath));
}

/** Resolve the on-disk file for a pi session id within a workspace, or null if absent. */
export async function resolvePiSessionFile(cwd: string, sessionId: string): Promise<string | null> {
  const dir = ensurePiSessionDir(cwd);
  try {
    const files = await fs.promises.readdir(dir);
    const match = files.find((f) => f.endsWith('.jsonl') && piSessionIdFromFile(f) === sessionId);
    return match ? path.join(dir, match) : null;
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

/**
 * Recent unique user prompts across the workspace's pi sessions, newest first (the up-arrow prompt
 * history). Reads only the pi tree (FR-1); the SDK `extractPromptHistory` is never called on pi.
 */
export async function extractPiPromptHistory(cwd: string, sessions: StoredSession[]): Promise<string[]> {
  const pi = await initPiLoader();
  if (!pi) return [];
  const dir = ensurePiSessionDir(cwd);

  // One readdir → id→path map, so each session resolves in O(1). Resolving per session via
  // `resolvePiSessionFile` would readdir the whole store once per session — O(files²) on the hot path.
  let idToPath: Map<string, string>;
  try {
    const files = await fs.promises.readdir(dir);
    idToPath = new Map(
      files.filter((f) => f.endsWith('.jsonl')).map((f) => [piSessionIdFromFile(f), path.join(dir, f)]),
    );
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const history: string[] = [];

  for (const session of sessions) {
    if (history.length >= PI_PROMPT_HISTORY_CAP) break;
    const filePath = idToPath.get(session.id);
    if (!filePath) continue;
    try {
      const sm = pi.SessionManager.open(filePath, dir);
      const branch = sm.getBranch(sm.getLeafId() ?? undefined);
      // A user message whose typed slash command was expanded is recorded here as what the user typed
      // (`/example what is the day`), not the stored expansion (`Hello day is Tuesday`).
      const originalInputs = extractOriginalInputs(branch);
      const prompts: string[] = [];
      // Walk the ACTIVE branch only (not getEntries(), which includes abandoned rewind/fork branches)
      // so prompts the user rewound away from don't leak back into up-arrow history.
      for (const entry of branch) {
        if (entry.type !== 'message') continue;
        const message = (entry as { message?: { role?: string; content?: unknown } }).message;
        if (message?.role !== 'user') continue;
        const original = originalInputs.get(entry.id);
        const text = original ?? (typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content.filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text').map((b) => b.text).join(' ')
            : '');
        const trimmed = text.trim();
        if (trimmed && !trimmed.startsWith('<')) prompts.push(trimmed);
      }
      // Newest-first within the session, then dedupe globally.
      for (let i = prompts.length - 1; i >= 0; i--) {
        const p = prompts[i]!;
        if (seen.has(p)) continue;
        seen.add(p);
        history.push(p);
        if (history.length >= PI_PROMPT_HISTORY_CAP) break;
      }
    } catch {
      // Skip an unreadable session file.
    }
  }
  return history;
}
