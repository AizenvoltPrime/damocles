import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { log } from '../logger';
import type { DatabaseInstance, PreparedStatement, RunResult } from './types';

const CURRENT_VERSION = 1;

/**
 * Clean baseline for the revamped memory store. This is a greenfield schema in its own
 * database file ({@link getDbPathAsync}); it deliberately shares no migration history with
 * the pre-revamp `memory.db`, so there is no legacy import and no version-chain coupling.
 */
const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fact','preference','observation','note','episode')),
  observation_type TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('session','project','global')),
  content TEXT NOT NULL,
  summary TEXT,
  title TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  facts TEXT NOT NULL DEFAULT '[]',
  observation_tags TEXT NOT NULL DEFAULT '[]',
  search_terms TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  is_latest INTEGER NOT NULL DEFAULT 1,
  parent_id TEXT,
  root_id TEXT,
  source_count INTEGER NOT NULL DEFAULT 1,
  is_inference INTEGER NOT NULL DEFAULT 0,
  is_static INTEGER NOT NULL DEFAULT 0,
  forget_after INTEGER,
  forgotten INTEGER NOT NULL DEFAULT 0,
  forget_reason TEXT,
  reprocessed INTEGER NOT NULL DEFAULT 1,
  session_id TEXT,
  workspace TEXT,
  files_read TEXT NOT NULL DEFAULT '[]',
  files_modified TEXT NOT NULL DEFAULT '[]',
  access_count INTEGER NOT NULL DEFAULT 0,
  file_change_count INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, title, summary, tags, facts, observation_tags, search_terms, files_read, files_modified,
  content=memories, content_rowid=rowid,
  tokenize='porter unicode61'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, title, summary, tags, facts, observation_tags, search_terms, files_read, files_modified)
  VALUES (NEW.rowid, NEW.content, NEW.title, NEW.summary, NEW.tags, NEW.facts, NEW.observation_tags, NEW.search_terms, NEW.files_read, NEW.files_modified);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, title, summary, tags, facts, observation_tags, search_terms, files_read, files_modified)
  VALUES ('delete', OLD.rowid, OLD.content, OLD.title, OLD.summary, OLD.tags, OLD.facts, OLD.observation_tags, OLD.search_terms, OLD.files_read, OLD.files_modified);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, title, summary, tags, facts, observation_tags, search_terms, files_read, files_modified)
  VALUES ('delete', OLD.rowid, OLD.content, OLD.title, OLD.summary, OLD.tags, OLD.facts, OLD.observation_tags, OLD.search_terms, OLD.files_read, OLD.files_modified);
  INSERT INTO memories_fts(rowid, content, title, summary, tags, facts, observation_tags, search_terms, files_read, files_modified)
  VALUES (NEW.rowid, NEW.content, NEW.title, NEW.summary, NEW.tags, NEW.facts, NEW.observation_tags, NEW.search_terms, NEW.files_read, NEW.files_modified);
END;

CREATE INDEX idx_memories_live ON memories(is_latest, forgotten, workspace) WHERE is_latest=1 AND forgotten=0;
CREATE INDEX idx_memories_scope ON memories(scope);
CREATE INDEX idx_memories_kind ON memories(kind);
CREATE INDEX idx_memories_workspace ON memories(workspace) WHERE workspace IS NOT NULL;
CREATE INDEX idx_memories_session ON memories(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_memories_root ON memories(root_id);
CREATE INDEX idx_memories_observation_type ON memories(observation_type) WHERE observation_type IS NOT NULL;
CREATE INDEX idx_memories_pinned ON memories(pinned) WHERE pinned=1;
CREATE INDEX idx_memories_content_hash ON memories(content_hash);
CREATE INDEX idx_memories_forget_after ON memories(forget_after) WHERE forget_after IS NOT NULL;

CREATE TABLE memory_edges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('UPDATES','EXTENDS','DERIVES','SUPERSEDES')),
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_edges_source ON memory_edges(source_id);
CREATE INDEX idx_edges_target ON memory_edges(target_id);
CREATE INDEX idx_edges_kind_pair ON memory_edges(kind, source_id, target_id);

CREATE TABLE memory_candidates (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  prompt_index INTEGER,
  user_text TEXT NOT NULL DEFAULT '',
  assistant_text TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '[]',
  salient INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0,
  reprocessed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_candidates_session ON memory_candidates(session_id);
CREATE INDEX idx_candidates_consumed ON memory_candidates(consumed) WHERE consumed=0;

CREATE TABLE memory_profile (
  scope TEXT NOT NULL CHECK (scope IN ('project','global')),
  workspace TEXT NOT NULL DEFAULT '',
  section TEXT NOT NULL CHECK (section IN ('static','dynamic')),
  content TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, workspace, section)
);

CREATE TABLE memory_retrievals (
  memory_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  retrieved_at INTEGER NOT NULL
);
CREATE INDEX idx_retrievals_memory ON memory_retrievals(memory_id);
CREATE INDEX idx_retrievals_workspace ON memory_retrievals(workspace, retrieved_at);
`;

const MIGRATIONS: Record<number, string> = {
  1: MIGRATION_V1,
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

export async function initSqlEngineAsync(extensionPath: string): Promise<boolean> {
  try {
    const wasmPath = path.join(extensionPath, 'node_modules', 'sql.js-fts5', 'dist', 'sql-wasm.wasm');
    const wasmBinary = await fs.promises.readFile(wasmPath);

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

async function getDbPathAsync(): Promise<string> {
  const dir = path.join(os.homedir(), '.damocles');
  await fs.promises.mkdir(dir, { recursive: true });
  return path.join(dir, 'memory.v2.db');
}

function createWrapper(sqlDb: SqlJsDatabase, dbPath: string): DatabaseInstance {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let writing = false;
  let pendingSave = false;
  let inFlightWrite: Promise<void> | null = null;
  let closed = false;

  function performAsyncWrite(): void {
    if (closed || writing) {
      if (!closed) pendingSave = true;
      return;
    }
    writing = true;
    const data = sqlDb.export();
    inFlightWrite = fs.promises.writeFile(dbPath, Buffer.from(data)).then(() => {
      writing = false;
      inFlightWrite = null;
      if (pendingSave) {
        pendingSave = false;
        performAsyncWrite();
      }
    }).catch((err) => {
      writing = false;
      inFlightWrite = null;
      log(`[Memory] Failed to persist database: ${err}`);
    });
  }

  function scheduleSave(): void {
    if (closed) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      performAsyncWrite();
    }, 250);
  }

  /** Synchronous authoritative write of the current DB state. Caller must ensure no async write is in flight. */
  function flushSync(): void {
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
      if (closed) return;
      closed = true;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (writing && inFlightWrite) {
        pendingSave = false;
        inFlightWrite.finally(() => {
          flushSync();
          sqlDb.close();
        });
      } else {
        flushSync();
        sqlDb.close();
      }
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

export function runMigrations(db: DatabaseInstance): void {
  const currentVersion = getCurrentVersion(db);

  for (let v = currentVersion + 1; v <= CURRENT_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;

    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
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

export async function openDatabaseAsync(): Promise<DatabaseInstance | null> {
  if (!sqlEngine) return null;

  try {
    const dbPath = await getDbPathAsync();
    let data: Buffer | undefined;

    try {
      data = await fs.promises.readFile(dbPath);
    } catch {
      // DB file doesn't exist yet — will create a new one
    }

    const sqlDb = data
      ? new sqlEngine.Database(data)
      : new sqlEngine.Database();

    const db = createWrapper(sqlDb, dbPath);

    runMigrations(db);

    return db;
  } catch (err) {
    log(`[Memory] Failed to open database: ${err}`);
    return null;
  }
}
