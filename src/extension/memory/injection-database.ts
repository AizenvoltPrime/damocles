import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { log } from '../logger';
import { getSqlEngine, createDatabaseWrapper } from './database';
import type { DatabaseInstance } from './types';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';

const INJECTION_DB_DIR = path.join(os.homedir(), '.damocles', 'context', 'memory');
const CURRENT_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS memory_injections (
  prompt_index INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

const MIGRATIONS: Record<number, string> = {
  1: SCHEMA_V1,
};

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[\/\\:]/g, '_');
}

async function getDbPathAsync(sessionId: string): Promise<string> {
  await fs.mkdir(INJECTION_DB_DIR, { recursive: true });
  return path.join(INJECTION_DB_DIR, `${sanitizeSessionId(sessionId)}.db`);
}

function getCurrentVersion(db: DatabaseInstance): number {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get();
  if (!tableExists) return 0;

  const row = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}

function runMigrations(db: DatabaseInstance): void {
  const currentVersion = getCurrentVersion(db);
  for (let v = currentVersion + 1; v <= CURRENT_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;
    db.exec(sql);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);
  }
}

export async function openInjectionDatabase(sessionId: string): Promise<DatabaseInstance | undefined> {
  const engine = getSqlEngine();
  if (!engine) {
    log('[InjectionDB] SQL engine not initialized');
    return undefined;
  }

  try {
    const dbPath = await getDbPathAsync(sessionId);
    let data: Buffer | undefined;

    try {
      data = await fs.readFile(dbPath);
    } catch {
      /* file does not exist yet */
    }

    const sqlDb = data
      ? new engine.Database(data)
      : new engine.Database();

    const db = createDatabaseWrapper(sqlDb, dbPath);
    runMigrations(db);
    return db;
  } catch (err) {
    log('[InjectionDB] Failed to open database for session %s: %O', sessionId, err);
    return undefined;
  }
}

export function insertMemoryInjection(
  db: DatabaseInstance,
  promptIndex: number,
  display: MemoryInjectionDisplay,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO memory_injections (prompt_index, data, created_at)
     VALUES (?, ?, ?)`
  ).run(promptIndex, JSON.stringify(display), Date.now());
}

export function getMemoryInjection(
  db: DatabaseInstance,
  promptIndex: number,
): MemoryInjectionDisplay | undefined {
  const row = db.prepare(
    'SELECT data FROM memory_injections WHERE prompt_index = ?'
  ).get(promptIndex) as { data: string } | undefined;

  if (!row) return undefined;

  try {
    return JSON.parse(row.data) as MemoryInjectionDisplay;
  } catch (err) {
    log('[InjectionDB] Failed to parse injection data for prompt %d: %O', promptIndex, err);
    return undefined;
  }
}
