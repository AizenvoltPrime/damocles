import * as fs from 'fs/promises';
import * as path from 'path';
import { CONTEXT_DIR } from './types';
import { log } from '../logger';

const DISTILL_DB_DIR = path.join(CONTEXT_DIR, 'distill');

let cachedSet: Set<string> | null = null;
let loadingPromise: Promise<Set<string>> | null = null;

async function loadRegistry(): Promise<Set<string>> {
  if (cachedSet) return cachedSet;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const files = await fs.readdir(DISTILL_DB_DIR);
      cachedSet = new Set(
        files.filter(f => f.endsWith('.db')).map(f => f.slice(0, -3))
      );
      log('[DistillRegistry] loadRegistry: scanned %d distill DBs from disk', cachedSet.size);
    } catch {
      cachedSet = new Set();
      log('[DistillRegistry] loadRegistry: distill directory not found, starting empty');
    }
    loadingPromise = null;
    return cachedSet;
  })();
  return loadingPromise;
}

export async function registerDistillSession(sessionId: string): Promise<void> {
  const set = await loadRegistry();
  set.add(sessionId);
}

export async function isDistillSession(sessionId: string): Promise<boolean> {
  const set = await loadRegistry();
  if (set.has(sessionId)) return true;

  const dbPath = path.join(DISTILL_DB_DIR, `${sessionId}.db`);
  const exists = await fs.access(dbPath).then(() => true, () => false);
  if (exists) {
    set.add(sessionId);
    return true;
  }
  return false;
}

export async function getDistillSessionIds(): Promise<ReadonlySet<string>> {
  return loadRegistry();
}

export async function unregisterDistillSession(sessionId: string): Promise<void> {
  const set = await loadRegistry();
  set.delete(sessionId);
}
