import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { log } from '../logger';
import type { DatabaseInstance, PreparedStatement, RunResult } from './types';

const CURRENT_VERSION = 5;

const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('session', 'project', 'global', 'note', 'observation')),
  content TEXT NOT NULL,
  session_id TEXT,
  workspace TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  observation_type TEXT,
  title TEXT,
  facts TEXT DEFAULT '[]',
  observation_tags TEXT DEFAULT '[]',
  files_read TEXT DEFAULT '[]',
  files_modified TEXT DEFAULT '[]',
  access_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace) WHERE workspace IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_tier_workspace ON memories(tier, workspace);
CREATE INDEX IF NOT EXISTS idx_memories_observation_type ON memories(observation_type) WHERE observation_type IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, title, tags, facts, observation_tags, files_read, files_modified,
  content=memories, content_rowid=rowid,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, title, tags, facts, observation_tags, files_read, files_modified)
  VALUES (NEW.rowid, NEW.content, NEW.title, NEW.tags, NEW.facts, NEW.observation_tags, NEW.files_read, NEW.files_modified);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, title, tags, facts, observation_tags, files_read, files_modified)
  VALUES ('delete', OLD.rowid, OLD.content, OLD.title, OLD.tags, OLD.facts, OLD.observation_tags, OLD.files_read, OLD.files_modified);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, title, tags, facts, observation_tags, files_read, files_modified)
  VALUES ('delete', OLD.rowid, OLD.content, OLD.title, OLD.tags, OLD.facts, OLD.observation_tags, OLD.files_read, OLD.files_modified);
  INSERT INTO memories_fts(rowid, content, title, tags, facts, observation_tags, files_read, files_modified)
  VALUES (NEW.rowid, NEW.content, NEW.title, NEW.tags, NEW.facts, NEW.observation_tags, NEW.files_read, NEW.files_modified);
END;
`;

const MIGRATION_V2 = `DELETE FROM memories WHERE tier = 'auto-summary';`;

const MIGRATION_V3 = `
ALTER TABLE memories ADD COLUMN file_change_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN search_terms TEXT DEFAULT '[]';

CREATE TABLE IF NOT EXISTS fts_score_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('memory', 'distill')),
  workspace TEXT NOT NULL,
  peak_score REAL NOT NULL,
  mean_score REAL NOT NULL,
  spread_ratio REAL NOT NULL,
  match_ratio REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_score_history_lookup ON fts_score_history(source, workspace, created_at);

DROP TRIGGER IF EXISTS memories_ai;
DROP TRIGGER IF EXISTS memories_ad;
DROP TRIGGER IF EXISTS memories_au;
DROP TABLE IF EXISTS memories_fts;
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, title, tags, facts, observation_tags, files_read, files_modified, search_terms,
  content=memories, content_rowid=rowid,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, title, tags, facts, observation_tags, files_read, files_modified, search_terms)
  VALUES (NEW.rowid, NEW.content, NEW.title, NEW.tags, NEW.facts, NEW.observation_tags, NEW.files_read, NEW.files_modified, NEW.search_terms);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, title, tags, facts, observation_tags, files_read, files_modified, search_terms)
  VALUES ('delete', OLD.rowid, OLD.content, OLD.title, OLD.tags, OLD.facts, OLD.observation_tags, OLD.files_read, OLD.files_modified, OLD.search_terms);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, title, tags, facts, observation_tags, files_read, files_modified, search_terms)
  VALUES ('delete', OLD.rowid, OLD.content, OLD.title, OLD.tags, OLD.facts, OLD.observation_tags, OLD.files_read, OLD.files_modified, OLD.search_terms);
  INSERT INTO memories_fts(rowid, content, title, tags, facts, observation_tags, files_read, files_modified, search_terms)
  VALUES (NEW.rowid, NEW.content, NEW.title, NEW.tags, NEW.facts, NEW.observation_tags, NEW.files_read, NEW.files_modified, NEW.search_terms);
END;

INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
`;

const MIGRATION_V4 = `
ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned) WHERE pinned = 1;

CREATE TABLE IF NOT EXISTS memory_retrievals (
  memory_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  retrieved_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retrievals_memory ON memory_retrievals(memory_id);
CREATE INDEX IF NOT EXISTS idx_retrievals_workspace ON memory_retrievals(workspace, retrieved_at);
`;

const MIGRATION_V5 = `
DROP TABLE IF EXISTS fts_score_history;
CREATE TABLE fts_score_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('memory', 'recall')),
  workspace TEXT NOT NULL,
  peak_score REAL NOT NULL,
  mean_score REAL NOT NULL,
  spread_ratio REAL NOT NULL,
  match_ratio REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_score_history_lookup ON fts_score_history(source, workspace, created_at);
`;

const MIGRATIONS: Record<number, string> = {
  1: MIGRATION_V1,
  2: MIGRATION_V2,
  3: MIGRATION_V3,
  4: MIGRATION_V4,
  5: MIGRATION_V5,
};

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): SqlJsDatabase;
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  prepare(sql: string): SqlJsStatement;
  getRowsModified(): number;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatement {
  bind(params?: unknown[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): boolean;
}

let sqlEngine: SqlJsStatic | null = null;

export function getSqlEngine(): SqlJsStatic | null {
  return sqlEngine;
}

export { createWrapper as createDatabaseWrapper };

export async function initSqlEngine(extensionPath: string): Promise<boolean> {
  try {
    const wasmPath = path.join(extensionPath, 'node_modules', 'sql.js-fts5', 'dist', 'sql-wasm.wasm');
    const wasmBinary = fs.readFileSync(wasmPath);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const initSqlJs = require('sql.js-fts5');
    sqlEngine = await initSqlJs({ wasmBinary });

    log('[Memory] SQL engine initialized successfully');
    return true;
  } catch (err) {
    log(`[Memory] Failed to initialize SQL engine: ${err}`);
    return false;
  }
}

function getDbPath(): string {
  const dir = path.join(os.homedir(), '.damocles');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'memory.db');
}

function createWrapper(sqlDb: SqlJsDatabase, dbPath: string): DatabaseInstance {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let writing = false;
  let pendingSave = false;

  function performAsyncWrite(): void {
    if (writing) {
      pendingSave = true;
      return;
    }
    writing = true;
    const data = sqlDb.export();
    fs.promises.writeFile(dbPath, Buffer.from(data)).then(() => {
      writing = false;
      if (pendingSave) {
        pendingSave = false;
        performAsyncWrite();
      }
    }).catch((err) => {
      writing = false;
      log(`[Memory] Failed to persist database: ${err}`);
    });
  }

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      performAsyncWrite();
    }, 250);
  }

  function flushSave(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const data = sqlDb.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }

  return {
    prepare(sql: string): PreparedStatement {
      const isMutation = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql);

      return {
        run(...params: unknown[]): RunResult {
          sqlDb.run(sql, params);
          const changes = sqlDb.getRowsModified();
          if (isMutation) scheduleSave();
          return { changes };
        },

        get(...params: unknown[]): Record<string, unknown> | undefined {
          const stmt = sqlDb.prepare(sql);
          try {
            if (params.length) stmt.bind(params);
            if (stmt.step()) {
              return stmt.getAsObject();
            }
            return undefined;
          } finally {
            stmt.free();
          }
        },

        all(...params: unknown[]): Record<string, unknown>[] {
          const stmt = sqlDb.prepare(sql);
          try {
            if (params.length) stmt.bind(params);
            const results: Record<string, unknown>[] = [];
            while (stmt.step()) {
              results.push(stmt.getAsObject());
            }
            return results;
          } finally {
            stmt.free();
          }
        },
      };
    },

    exec(sql: string): void {
      sqlDb.exec(sql);
      scheduleSave();
    },

    pragma(value: string): unknown {
      const results = sqlDb.exec(`PRAGMA ${value}`);
      const firstResult = results[0];
      if (!firstResult || firstResult.values.length === 0) return undefined;
      const firstRow = firstResult.values[0];
      return firstRow ? firstRow[0] : undefined;
    },

    close(): void {
      flushSave();
      sqlDb.close();
    },
  };
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

export function updateSearchTerms(db: DatabaseInstance, id: string, terms: string[]): void {
  db.prepare('UPDATE memories SET search_terms = ? WHERE id = ?').run(JSON.stringify(terms), id);
}

export function getUnexpandedMemoryIds(db: DatabaseInstance, limit: number): string[] {
  const rows = db.prepare(
    "SELECT id FROM memories WHERE search_terms = '[]' ORDER BY updated_at DESC LIMIT ?"
  ).all(limit) as { id: string }[];
  return rows.map(r => r.id);
}

export function openDatabase(): DatabaseInstance | null {
  if (!sqlEngine) return null;

  try {
    const dbPath = getDbPath();
    let data: Buffer | undefined;

    if (fs.existsSync(dbPath)) {
      data = fs.readFileSync(dbPath);
    }

    const sqlDb = data
      ? new sqlEngine.Database(data)
      : new sqlEngine.Database();

    const db = createWrapper(sqlDb, dbPath);

    db.pragma('foreign_keys = ON');

    runMigrations(db);

    return db;
  } catch (err) {
    log(`[Memory] Failed to open database: ${err}`);
    return null;
  }
}
