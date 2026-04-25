import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../logger';

export interface SessionIndexEntry {
  preview: string;
  messageCount: number;
  isRecall: boolean;
  slug?: string;
  planPath?: string;
  customTitle?: string;
  mtime: number;
  size: number;
  tag?: string;
  createdAt?: number;
  sdkFetchedAt?: number;
}

interface SessionIndex {
  version: 1;
  sessions: Record<string, SessionIndexEntry>;
}

const CACHE_DIR = path.join(os.homedir(), '.damocles', 'cache', 'session-index');
const LEGACY_INDEX_FILENAME = '.session-index.json';
const RENAME_RETRY_DELAYS_MS = [30, 60, 120, 240];
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

let memoryIndex: SessionIndex | null = null;
let loadedSessionDir: string | null = null;
const legacyCleanedDirs = new Set<string>();

let writeChain: Promise<void> = Promise.resolve();
let chainTail: Promise<void> | null = null;
let trailingDir: string | null = null;

/**
 * Resolve the cache file for a session directory to a Damocles-owned path.
 *
 * The session-index cache is Damocles-private metadata. Writing it into the
 * session directory itself (`~/.claude/projects/<workspace>/`) causes atomic
 * renames to fail with EPERM on Windows when a peer process — typically the
 * Claude Code VS Code extension's SDK subprocess, which reads and writes the
 * same directory — holds a file handle at the moment we try to rename over
 * the previous copy. Keeping the cache under `~/.damocles/cache/` removes the
 * contention entirely; Damocles is the only writer.
 */
function getIndexPath(sessionDir: string): string {
  return path.join(CACHE_DIR, `${path.basename(sessionDir)}.json`);
}

async function cleanupLegacyIndex(sessionDir: string): Promise<void> {
  if (legacyCleanedDirs.has(sessionDir)) return;
  legacyCleanedDirs.add(sessionDir);
  try {
    await fs.promises.unlink(path.join(sessionDir, LEGACY_INDEX_FILENAME));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    log('[SessionCache] Failed to remove legacy index in %s: %O', sessionDir, err);
  }
}

export async function loadIndex(sessionDir: string): Promise<SessionIndex> {
  if (memoryIndex && loadedSessionDir === sessionDir) return memoryIndex;

  await cleanupLegacyIndex(sessionDir);

  try {
    const data = await fs.promises.readFile(getIndexPath(sessionDir), 'utf-8');
    const parsed = JSON.parse(data) as SessionIndex;
    if (parsed.version === 1 && parsed.sessions) {
      memoryIndex = parsed;
      loadedSessionDir = sessionDir;
      return memoryIndex;
    }
  } catch {
  }

  memoryIndex = { version: 1, sessions: {} };
  loadedSessionDir = sessionDir;
  return memoryIndex;
}

/**
 * Persist the in-memory index to disk via atomic write-and-rename.
 *
 * Concurrent callers are coalesced through a single chain: while a save is
 * pending for the same session dir, subsequent calls attach to the queued
 * trailing save instead of stacking parallel renames. Because the index is
 * shared in memory, a single late write captures the cumulative state of any
 * intermediate updates, so coalescing is loss-free.
 *
 * The rename itself uses a short backoff retry on transient Windows file-handle
 * contention (EPERM/EBUSY/EACCES) — typically caused by AV scanners or the OS
 * indexer briefly holding a handle on the destination after the previous write.
 */
export async function saveIndex(sessionDir: string): Promise<void> {
  if (!memoryIndex) return;

  if (chainTail && trailingDir === sessionDir) {
    return chainTail;
  }

  trailingDir = sessionDir;
  const next = writeChain.then(
    () => {
      trailingDir = null;
      return performSave(sessionDir);
    },
    () => {
      trailingDir = null;
      return performSave(sessionDir);
    },
  );
  const wrapped: Promise<void> = next.finally(() => {
    if (chainTail === wrapped) chainTail = null;
  });
  chainTail = wrapped;
  writeChain = wrapped;
  return wrapped;
}

async function performSave(sessionDir: string): Promise<void> {
  if (!memoryIndex) return;

  const indexPath = getIndexPath(sessionDir);
  const tempPath = `${indexPath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;

  try {
    await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    await fs.promises.writeFile(tempPath, JSON.stringify(memoryIndex));
    await renameWithRetryOnContention(tempPath, indexPath);
  } catch (err) {
    log('[SessionCache] Failed to save index: %O', err);
    try { await fs.promises.unlink(tempPath); } catch {}
  }
}

async function renameWithRetryOnContention(tempPath: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tempPath, destination);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const transient = code !== undefined && TRANSIENT_RENAME_ERROR_CODES.has(code);
      if (!transient || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]!));
    }
  }
}

export function getEntry(sessionId: string): SessionIndexEntry | undefined {
  return memoryIndex?.sessions[sessionId];
}

export function isFresh(entry: SessionIndexEntry, mtime: number, size: number): boolean {
  return entry.mtime === mtime && entry.size === size;
}

export function updateEntry(sessionId: string, data: Partial<SessionIndexEntry> & { mtime: number; size: number }): void {
  if (!memoryIndex) return;
  const existing = memoryIndex.sessions[sessionId];
  memoryIndex.sessions[sessionId] = { ...existing, ...data } as SessionIndexEntry;
}

export function removeEntry(sessionId: string): void {
  if (!memoryIndex) return;
  delete memoryIndex.sessions[sessionId];
}

export async function touchEntry(_sessionDir: string, sessionId: string, filePath: string): Promise<void> {
  if (!memoryIndex?.sessions[sessionId]) return;
  try {
    const stat = await fs.promises.stat(filePath);
    memoryIndex.sessions[sessionId]!.mtime = stat.mtime.getTime();
    memoryIndex.sessions[sessionId]!.size = stat.size;
  } catch {}
}

export function clearMemoryCache(): void {
  memoryIndex = null;
  loadedSessionDir = null;
  legacyCleanedDirs.clear();
  writeChain = Promise.resolve();
  chainTail = null;
  trailingDir = null;
}

export function isSDKStale(entry: SessionIndexEntry): boolean {
  if (!entry.sdkFetchedAt) return true;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  return Date.now() - entry.sdkFetchedAt > ONE_DAY_MS;
}
