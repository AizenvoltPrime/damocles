import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The usage index is the only record of deleted conversations' spend, so it is never rebuilt: migrations are additive only. */

export type UsageDatabase = InstanceType<typeof DatabaseSync>;

const MIGRATION_V1 = `
CREATE TABLE files (
  file_id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  session_id TEXT,
  agent_session_id TEXT,
  session_started_ms INTEGER,
  project_key TEXT,
  detail TEXT,
  model_provider TEXT,
  model_id TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  tail_hash TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  parse_errors INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_files_session ON files(session_id);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  title TEXT,
  started_ms INTEGER NOT NULL,
  file_id INTEGER,
  missing INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE projects (
  project_key TEXT PRIMARY KEY,
  cwd TEXT
);

CREATE TABLE entries (
  entry_key TEXT PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  session_id TEXT,
  agent_session_id TEXT,
  session_started_ms INTEGER NOT NULL,
  project_key TEXT NOT NULL,
  origin TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  provider TEXT,
  model TEXT,
  model_key TEXT,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cache_write_1h INTEGER NOT NULL,
  reasoning INTEGER NOT NULL,
  cost_input REAL NOT NULL,
  cost_output REAL NOT NULL,
  cost_cache_read REAL NOT NULL,
  cost_cache_write REAL NOT NULL,
  cost_total REAL NOT NULL,
  stop_reason TEXT,
  file_id INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_entries_ts ON entries(ts_ms);
CREATE INDEX idx_entries_session ON entries(session_id);
CREATE INDEX idx_entries_model ON entries(model_key);
CREATE INDEX idx_entries_project ON entries(project_key);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Entry i migrates user_version i to i + 1. Append only; never edit a shipped entry.
const MIGRATIONS: readonly string[] = [MIGRATION_V1];

const userVersion = (db: UsageDatabase): number => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);

function migrate(db: UsageDatabase, log: (message: string) => void): void {
  const current = userVersion(db);
  if (current > MIGRATIONS.length) {
    log(`[UsageStats] Index schema v${current} is newer than this build's v${MIGRATIONS.length}; reading it as is`);
    return;
  }
  if (current === MIGRATIONS.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-read under the write lock: another window may have migrated since the read above.
    for (let version = userVersion(db); version < MIGRATIONS.length; version++) {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

function openAndMigrate(dbPath: string, log: (message: string) => void, quickCheck: boolean): UsageDatabase {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    // Zeroes a cleared title instead of leaving it in free page space.
    db.exec('PRAGMA secure_delete = ON');
    migrate(db, log);
    if (quickCheck) {
      const check = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
      if (check.length !== 1 || check[0]!.quick_check !== 'ok') {
        throw Object.assign(new Error(`quick_check failed: ${check.map((r) => r.quick_check).join('; ').slice(0, 200)}`), { errcode: 11 });
      }
    }
    return db;
  } catch (err) {
    // A corrupt file still opens and holds a Windows file lock until closed, which blocks the rename aside.
    db.close();
    throw err;
  }
}

/** SQLITE_CORRUPT or SQLITE_NOTADB only; busy, locked and I/O faults may leave readable data and are rethrown. */
export function isCorruption(err: unknown): boolean {
  const errcode = (err as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === 'number') {
    const primary = errcode & 0xff;
    return primary === 11 || primary === 26;
  }
  return /file is not a database|database disk image is malformed/i.test(err instanceof Error ? err.message : String(err));
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Deletes every moved-aside copy except `keepPath` and its WAL siblings; each copy holds every title it ever had. */
function pruneAsideCopies(dbPath: string, keepPath: string, log: (message: string) => void): void {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.corrupt-`;
  const keep = path.basename(keepPath);
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix) || name === keep || name.startsWith(`${keep}-`)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch (err) {
      log(`[UsageStats] Could not remove old corrupt index copy ${name}: ${messageOf(err)}`);
    }
  }
}

export interface OpenUsageDatabaseOptions {
  /** Run `PRAGMA quick_check`, which reads the whole file. Corruption it skips still surfaces from real statements. */
  quickCheck?: boolean;
}

/**
 * Open the index at `dbPath`, creating it when absent. A corrupt file and its WAL siblings are moved aside
 * to `<dbPath>.corrupt-<ms>` and a fresh index is created; the next scan rebuilds it from the files still
 * on disk, so only the spend of conversations whose files were deleted is lost. Only the newest aside copy
 * is kept. Any other failure throws.
 */
export function openUsageDatabase(dbPath: string, log: (message: string) => void, options: OpenUsageDatabaseOptions = {}): UsageDatabase {
  const quickCheck = options.quickCheck ?? true;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  try {
    return openAndMigrate(dbPath, log, quickCheck);
  } catch (err) {
    if (!isCorruption(err)) throw err;
    const asidePath = `${dbPath}.corrupt-${Date.now()}`;
    log(
      `[UsageStats] Usage index ${dbPath} is corrupt (${messageOf(err)}); moving it to ${asidePath}. ` +
        'A fresh index is rebuilt from the session files and the sub-call ledger; spend of conversations whose files were deleted is lost.',
    );
    try {
      // WAL first: a WAL left beside a fresh index would be replayed into it.
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(`${dbPath}${suffix}`)) fs.renameSync(`${dbPath}${suffix}`, `${asidePath}${suffix}`);
      }
      fs.renameSync(dbPath, asidePath);
    } catch (renameErr) {
      // Windows refuses the rename while another window's worker holds the file open.
      throw new Error(
        `The usage index ${dbPath} is corrupt, and another VS Code window has it open, so it cannot be moved aside. ` +
          `Close /stats in the other windows, or wait two minutes for their index to close, then retry (${messageOf(renameErr)}).`,
      );
    }
    pruneAsideCopies(dbPath, asidePath, log);
    return openAndMigrate(dbPath, log, quickCheck);
  }
}
