import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { StoredSession } from '@shared/types/session';
import { SESSION_META_CACHE_DIR } from '../../paths';
import { log } from '../../logger';

/** Bump when `sessionFileMeta`'s output or this file's layout changes; the extension version covers releases. */
const SESSION_META_SCHEMA = 2;
const FLUSH_DEBOUNCE_MS = 2000;
/** Another app version's cache file for the same dir is pruned once it has not been written for this long. */
const FOREIGN_VERSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What one session file yielded, valid while the file's size and mtime both still match (pi appends, so a
 * size change catches a write within the mtime's resolution). `stored` is `null` when the file had no
 * session header or opening it threw; that is cached too, so an unreadable file costs one read per change.
 */
export interface SessionMetaEntry {
  size: number;
  mtimeMs: number;
  stored: StoredSession | null;
  /** Newest first, unique, capped: see `newestUniquePrompts`. */
  prompts: string[];
}

interface CacheFile {
  schema: number;
  extensionVersion: string;
  entries: Record<string, SessionMetaEntry>;
}

interface DirCache {
  entries: Map<string, SessionMetaEntry>;
  /** Bumped on every change; the dir needs a write while it differs from `savedVersion`. */
  version: number;
  savedVersion: number;
}

/** Normalized session dir to its entries, loaded from disk on first use. */
const dirs = new Map<string, DirCache>();
let extensionVersion = 'unversioned';
/** Dirs whose other-version cache files this process has already pruned. */
const prunedDirs = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;
/** The debounced write in progress; a debounce that fires meanwhile re-arms instead of starting a second. */
let flushInFlight: Promise<void> | null = null;

/** Must be set before the first lookup: a dir already loaded keeps the version it was loaded under. */
export function setSessionMetaCacheVersion(version: string): void {
  extensionVersion = version;
}

/**
 * Normalize a path for cache keying. On Windows the same file reaches the readers with different
 * drive-letter case (`os.homedir()` gives `C:\…`, a VS Code `uri.fsPath` gives `c:\…`), and the FS is
 * case-insensitive, so win32 keys are lowercased; other platforms stay verbatim.
 */
export function metaCacheKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** The version as a file name segment; the cache directory is shared by every installed app version. */
function versionSegment(): string {
  return extensionVersion.replace(/[^A-Za-z0-9._-]/g, '_');
}

// One file per app version, so two apps on different versions sharing a folder each keep a valid cache.
function cacheFileOf(dirKey: string): string {
  return path.join(SESSION_META_CACHE_DIR, `${path.basename(dirKey)}.${versionSegment()}.json`);
}

/** Whether `name` is a cache file of `dirKey` for some other app version, or the pre-versioning `<dir>.json`. */
function isForeignVersionFile(name: string, dirKey: string): boolean {
  const prefix = path.basename(dirKey);
  if (name === `${prefix}.json`) return true;
  if (!name.startsWith(`${prefix}.`) || !name.endsWith('.json')) return false;
  const version = name.slice(prefix.length + 1, -'.json'.length);
  // An encoded dir name ends in `--`, so a segment holding `--` belongs to a longer dir name.
  return version !== versionSegment() && /^[A-Za-z0-9._-]+$/.test(version) && !version.includes('--');
}

/** Remove other versions' files for `dirKey` untouched for 30 days; the versions still in use keep writing theirs. */
function pruneForeignVersions(dirKey: string): void {
  if (prunedDirs.has(dirKey)) return;
  prunedDirs.add(dirKey);
  const cutoff = Date.now() - FOREIGN_VERSION_MAX_AGE_MS;
  try {
    for (const name of fs.readdirSync(SESSION_META_CACHE_DIR)) {
      if (!isForeignVersionFile(name, dirKey)) continue;
      const file = path.join(SESSION_META_CACHE_DIR, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch (err) {
    // Another version's writer can replace or remove its file meanwhile; the next process retries.
    log('[session-store] pruning other versions of session metadata cache %s failed: %O', dirKey, err);
  }
}

function isEntry(value: unknown): value is SessionMetaEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<SessionMetaEntry>;
  return typeof e.size === 'number'
    && typeof e.mtimeMs === 'number'
    && (e.stored === null || (typeof e.stored === 'object' && typeof e.stored?.id === 'string'))
    && Array.isArray(e.prompts) && e.prompts.every((p) => typeof p === 'string');
}

function loadDir(dirKey: string): Map<string, SessionMetaEntry> {
  const file = cacheFileOf(dirKey);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log('[session-store] session metadata cache %s unreadable, rebuilding: %O', file, err);
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.schema !== SESSION_META_SCHEMA || parsed.extensionVersion !== extensionVersion) {
      log('[session-store] session metadata cache %s has schema %s / version %s, expected %s / %s; rebuilding', file, parsed.schema, parsed.extensionVersion, SESSION_META_SCHEMA, extensionVersion);
      return new Map();
    }
    const entries = new Map<string, SessionMetaEntry>();
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (!isEntry(entry)) throw new Error(`malformed entry for ${key}`);
      // Two session dirs with one basename share a cache file; each keeps only its own entries.
      if (path.dirname(key) === dirKey) entries.set(key, entry);
    }
    return entries;
  } catch (err) {
    log('[session-store] session metadata cache %s is corrupt, rebuilding: %O', file, err);
    return new Map();
  }
}

function dirCache(dirKey: string): DirCache {
  let dir = dirs.get(dirKey);
  if (!dir) {
    dir = { entries: loadDir(dirKey), version: 0, savedVersion: 0 };
    dirs.set(dirKey, dir);
  }
  return dir;
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (flushInFlight) {
      scheduleFlush();
      return;
    }
    flushInFlight = flushChangedDirsAsync().finally(() => {
      flushInFlight = null;
    });
  }, FLUSH_DEBOUNCE_MS);
  flushTimer.unref();
}

function tempFileOf(file: string): string {
  return `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
}

function contentOf(dir: DirCache): string {
  const content: CacheFile = { schema: SESSION_META_SCHEMA, extensionVersion, entries: Object.fromEntries(dir.entries) };
  return JSON.stringify(content);
}

/** Atomic: a reader in another window sees the old file or the new one. Last writer wins, which is safe
 *  because every entry is checked against its own file's size and mtime before use. */
function flushDir(dirKey: string, dir: DirCache): void {
  const file = cacheFileOf(dirKey);
  const tmp = tempFileOf(file);
  const version = dir.version;
  try {
    fs.mkdirSync(SESSION_META_CACHE_DIR, { recursive: true });
    fs.writeFileSync(tmp, contentOf(dir));
    fs.renameSync(tmp, file);
    dir.savedVersion = Math.max(dir.savedVersion, version);
    pruneForeignVersions(dirKey);
  } catch (err) {
    // EPERM/EBUSY when another window has the file open; the dir stays changed, so the next flush retries.
    log('[session-store] session metadata cache write to %s failed: %O', file, err);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The temp file name is unique, so a leftover is only litter.
    }
  }
}

/** `flushDir` off the extension host thread, except for the serialization. */
async function flushDirAsync(dirKey: string, dir: DirCache): Promise<void> {
  const file = cacheFileOf(dirKey);
  const tmp = tempFileOf(file);
  const version = dir.version;
  try {
    const content = contentOf(dir);
    await fs.promises.mkdir(SESSION_META_CACHE_DIR, { recursive: true });
    await fs.promises.writeFile(tmp, content);
    await fs.promises.rename(tmp, file);
    dir.savedVersion = Math.max(dir.savedVersion, version);
    pruneForeignVersions(dirKey);
  } catch (err) {
    log('[session-store] session metadata cache write to %s failed: %O', file, err);
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function flushChangedDirsAsync(): Promise<void> {
  for (const [dirKey, dir] of dirs) if (dir.version !== dir.savedVersion) await flushDirAsync(dirKey, dir);
}

/** The entry for `filePath`, whatever the file looks like now; callers compare size and mtime. */
export function getSessionMeta(filePath: string): SessionMetaEntry | undefined {
  const key = metaCacheKey(filePath);
  return dirCache(path.dirname(key)).entries.get(key);
}

/** `schedule: false` leaves the write to the next scheduled flush or dispose, for updates that repeat through a turn. */
export function setSessionMeta(filePath: string, entry: SessionMetaEntry, options?: { schedule?: boolean }): void {
  const key = metaCacheKey(filePath);
  const dir = dirCache(path.dirname(key));
  dir.entries.set(key, entry);
  dir.version++;
  if (options?.schedule !== false) scheduleFlush();
}

export function forgetSessionMeta(filePath: string): void {
  const key = metaCacheKey(filePath);
  const dir = dirCache(path.dirname(key));
  if (!dir.entries.delete(key)) return;
  dir.version++;
  scheduleFlush();
}

/** Drop the entries of `sessionDir` whose key is not in `keep`, i.e. files no longer in the dir. */
export function evictSessionMetaExcept(sessionDir: string, keep: ReadonlySet<string>): void {
  const dir = dirCache(metaCacheKey(sessionDir));
  let evicted = false;
  for (const key of dir.entries.keys()) {
    if (keep.has(key)) continue;
    dir.entries.delete(key);
    evicted = true;
  }
  if (!evicted) return;
  dir.version++;
  scheduleFlush();
}

/** Write every changed dir now. Synchronous, so it completes when called from a dispose. */
export function flushSessionMetaCache(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const [dirKey, dir] of dirs) if (dir.version !== dir.savedVersion) flushDir(dirKey, dir);
}

/** Resolves once the debounced write in progress, if any, has finished. For tests. */
export function sessionMetaCacheWriteSettled(): Promise<void> {
  return flushInFlight ?? Promise.resolve();
}

/** Forget the in-memory layer without writing, as a new window starts. For tests and benchmarks. */
export function resetSessionMetaCacheMemory(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  dirs.clear();
  prunedDirs.clear();
}
