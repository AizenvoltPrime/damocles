import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../logger';
import { createDatabaseWrapper } from './database';
import type { DatabaseInstance } from './types';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';

let injectionDbDir = path.join(os.homedir(), '.damocles', 'context', 'memory');

/** Redirect the injection-DB directory. Test-only: keeps the sweep from touching the real store. */
export function setInjectionDbDirForTests(dir: string): void {
  injectionDbDir = dir;
}

const CURRENT_VERSION = 2;

const STALE_DB_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DB_SIBLINGS = ['.db', '.db-wal', '.db-shm'] as const;

// prompt_index PK + INSERT OR REPLACE = latest-wins: re-injecting a prompt index (rewind) overwrites
// the prior record for that index.
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS memory_injections (
  prompt_index INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// The persisted display JSON changed shape, so old v1 blobs no longer parse; wipe them (schema is
// otherwise unchanged).
const SCHEMA_V2 = `
DELETE FROM memory_injections;
`;

const MIGRATIONS: Record<number, string> = {
  1: SCHEMA_V1,
  2: SCHEMA_V2,
};

// Pre-hash scheme: distinct ids whose forbidden chars collapse to the same chars (e.g. `a/b`, `a_b`)
// map to one name and clobber each other.
function legacySanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[/\\:]/g, '_');
}

// A raw-id sha256 suffix disambiguates ids that share a sanitized base. `-` cannot appear in the
// hex suffix, so it unambiguously separates base from hash.
function sanitizeSessionId(sessionId: string): string {
  const base = legacySanitizeSessionId(sessionId);
  const hash = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

// Sanitized base name (no directory, no extension) for a raw session id. Callers cross-reference
// sweep results (which are base names, since a raw id can't be recovered from the one-way hash).
export function injectionDbName(sessionId: string): string {
  return sanitizeSessionId(sessionId);
}

function baseName(sessionId: string): string {
  return path.join(injectionDbDir, sanitizeSessionId(sessionId));
}

async function unlinkIgnoreMissing(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function renameIgnoreMissing(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// One-time pickup: an existing pre-hash file is renamed to the hashed name so a session opened before
// this scheme keeps its records. Runs only when the new name is absent and the legacy name is present.
async function migrateLegacyName(sessionId: string): Promise<void> {
  const legacyBase = path.join(injectionDbDir, legacySanitizeSessionId(sessionId));
  const newBase = baseName(sessionId);
  if (legacyBase === newBase) return;
  if (await fileExists(`${newBase}.db`)) return;
  if (!(await fileExists(`${legacyBase}.db`))) return;
  for (const ext of DB_SIBLINGS) {
    await renameIgnoreMissing(`${legacyBase}${ext}`, `${newBase}${ext}`);
  }
}

async function getDbPathAsync(sessionId: string): Promise<string> {
  await fs.mkdir(injectionDbDir, { recursive: true });
  await migrateLegacyName(sessionId);
  return `${baseName(sessionId)}.db`;
}

export async function deleteInjectionDatabaseFile(sessionId: string): Promise<void> {
  const base = baseName(sessionId);
  for (const ext of DB_SIBLINGS) {
    await unlinkIgnoreMissing(`${base}${ext}`);
  }
}

export async function renameInjectionDatabaseFile(oldId: string, newId: string): Promise<void> {
  const oldBase = baseName(oldId);
  const newBase = baseName(newId);
  if (oldBase === newBase) return;
  // Migration is authoritative: drop any stale destination so the source records win.
  await deleteInjectionDatabaseFile(newId);
  for (const ext of DB_SIBLINGS) {
    await renameIgnoreMissing(`${oldBase}${ext}`, `${newBase}${ext}`);
  }
}

// Deletes the trio for any DB whose main-file mtime is older than maxAgeMs, bounding unbounded
// accumulation of never-explicitly-deleted sessions. Returns the swept base names.
export async function sweepStaleInjectionDatabases(maxAgeMs: number = STALE_DB_MAX_AGE_MS): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(injectionDbDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const cutoff = Date.now() - maxAgeMs;
  const swept: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.db')) continue;
    const dbPath = path.join(injectionDbDir, entry);
    let stat;
    try {
      stat = await fs.stat(dbPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // raced with a concurrent delete
      throw err;
    }
    if (stat.mtimeMs >= cutoff) continue;
    const base = dbPath.slice(0, -'.db'.length);
    for (const ext of DB_SIBLINGS) {
      await unlinkIgnoreMissing(`${base}${ext}`);
    }
    swept.push(entry.slice(0, -'.db'.length));
  }
  return swept;
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
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);
    });
  }
}

export async function openInjectionDatabase(sessionId: string): Promise<DatabaseInstance | undefined> {
  try {
    const dbPath = await getDbPathAsync(sessionId);

    const raw = new DatabaseSync(dbPath, { timeout: 5000 });
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = NORMAL');
    raw.exec('PRAGMA busy_timeout = 5000');
    raw.exec('PRAGMA foreign_keys = ON');

    const db = createDatabaseWrapper(raw);
    runMigrations(db);
    return db;
  } catch (err) {
    // Per-session injection DBs are disposable: a failure just disables injection display for that
    // session — no quarantine, no escalation.
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
