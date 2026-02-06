import * as fs from 'fs/promises';
import * as path from 'path';
import { CONTEXT_DIR } from './context-store';
import { log } from '../logger';

const REGISTRY_PATH = path.join(CONTEXT_DIR, 'distill-sessions.json');

let cachedSet: Set<string> | null = null;

async function loadRegistry(): Promise<Set<string>> {
  if (cachedSet) return cachedSet;
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf-8');
    const ids = JSON.parse(raw) as string[];
    cachedSet = new Set(ids);
  } catch {
    cachedSet = new Set();
  }
  return cachedSet;
}

async function persistRegistry(set: Set<string>): Promise<void> {
  try {
    await fs.mkdir(CONTEXT_DIR, { recursive: true });
    await fs.writeFile(REGISTRY_PATH, JSON.stringify([...set]), 'utf-8');
  } catch (err) {
    log('[DistillRegistry] Failed to persist registry:', err);
  }
}

export async function registerDistillSession(sessionId: string): Promise<void> {
  const set = await loadRegistry();
  if (set.has(sessionId)) return;
  set.add(sessionId);
  await persistRegistry(set);
}

export async function isDistillSession(sessionId: string): Promise<boolean> {
  const set = await loadRegistry();
  return set.has(sessionId);
}

export async function getDistillSessionIds(): Promise<ReadonlySet<string>> {
  return loadRegistry();
}

export async function unregisterDistillSession(sessionId: string): Promise<void> {
  const set = await loadRegistry();
  if (!set.has(sessionId)) return;
  set.delete(sessionId);
  await persistRegistry(set);
}
