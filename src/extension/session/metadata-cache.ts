import * as fs from 'fs';
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

const INDEX_FILENAME = '.session-index.json';

let memoryIndex: SessionIndex | null = null;
let loadedSessionDir: string | null = null;

function getIndexPath(sessionDir: string): string {
  return path.join(sessionDir, INDEX_FILENAME);
}

export async function loadIndex(sessionDir: string): Promise<SessionIndex> {
  if (memoryIndex && loadedSessionDir === sessionDir) return memoryIndex;

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

export async function saveIndex(sessionDir: string): Promise<void> {
  if (!memoryIndex) return;

  const indexPath = getIndexPath(sessionDir);
  const tempPath = `${indexPath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;

  try {
    await fs.promises.writeFile(tempPath, JSON.stringify(memoryIndex));
    await fs.promises.rename(tempPath, indexPath);
  } catch (err) {
    log('[SessionCache] Failed to save index: %O', err);
    try { await fs.promises.unlink(tempPath); } catch {}
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
}

export function isSDKStale(entry: SessionIndexEntry): boolean {
  if (!entry.sdkFetchedAt) return true;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  return Date.now() - entry.sdkFetchedAt > ONE_DAY_MS;
}
