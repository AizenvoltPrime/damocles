import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { log } from '../logger';
import type { DatabaseInstance, PreparedStatement, RunResult } from './types';

const CURRENT_VERSION = 1;

/**
 * SQL that can mutate the database (DML + DDL). Used by the wrapper's `exec()` to decide whether a
 * write-through is needed: `getRowsModified()` does not count DDL, so a keyword check is the correct
 * (conservative) signal — any real mutation contains one of these, so it always persists; a provably
 * read-only exec (a bare SELECT/PRAGMA query) skips the multi-MB export.
 */
const MUTATING_SQL = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|REINDEX|VACUUM)\b/i;

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

/**
 * The memory DB file ({@link getDbPathAsync}) is GLOBAL — shared by every Damocles window/process. A
 * sql.js database is a whole-file snapshot held in WASM memory; a naive "export the snapshot and write
 * the file" loses cross-process writes: process B holding a pre-delete snapshot overwrites process A's
 * committed delete, resurrecting the row (last-writer-wins clobber). sql.js has no file locking, so the
 * wrapper makes DISK the source of truth via reload-before-write + synchronous write-through:
 *
 *   - Before every read and every write, {@link reloadIfChanged} re-loads the file when another process
 *     changed it (detected by a cheap mtime+size+change-counter signature), so we always operate on the
 *     latest committed state — a delete by another window is seen, not clobbered. The change counter
 *     (SQLite header bytes 24-27, see {@link fileSignature}) is what makes same-size writes — a row
 *     DELETE or equal-length UPDATE leaves the file byte size unchanged — detectable; mtime+size alone
 *     misses them on coarse-granularity filesystems.
 *   - Every mutation writes through to disk immediately (atomic temp-file + rename), so there is never an
 *     unflushed in-memory snapshot that a later reload would drop, and a concurrent process reloading sees
 *     our change. No debounce (the old 250ms timer was exactly the stale snapshot that caused the clobber).
 *
 * This is optimistic last-writer-wins at the FILE level: a true concurrent interleave of two writes in the
 * sub-millisecond rename window can still lose one side, but the common case (windows writing seconds apart)
 * is now correct. Real row-level concurrency would require a server DB; that is out of scope.
 */
function createWrapper(sqlDb: SqlJsDatabase, dbPath: string): DatabaseInstance {
  let db = sqlDb;
  let closed = false;
  /** >0 while a {@link transaction} is open: suppresses mid-sequence reloads and per-statement writes. */
  let txDepth = 0;
  /** Set when a statement/exec actually mutates the DB inside the open transaction; gates the single
   *  commit-time {@link writeToDisk}, so a read-only transaction does no multi-MB export at all. */
  let txDirty = false;
  let lastSig = fileSignature(dbPath);
  /**
   * Per-connection setter-form PRAGMAs (re-applied after a reload, which creates a fresh connection).
   * Keyed by pragma name so re-applying the same pragma overwrites rather than appends — without this
   * the list would grow unbounded across reloads, replaying every historical value each time.
   */
  const appliedPragmas = new Map<string, string>();

  /**
   * Reload the in-memory DB from disk when another process has written it since we last synced. Skipped
   * inside a transaction (reloading mid-sequence would discard uncommitted statements AND break the
   * read-modify-write atomicity the caller relies on) and when the engine is unavailable. Our own
   * write-through updates `lastSig`, so this never reloads our own changes — only genuinely external
   * ones. Re-applies per-connection PRAGMAs on the fresh handle so settings survive the reload.
   */
  function reloadIfChanged(): void {
    if (closed || txDepth > 0 || !sqlEngine) return;
    const sig = fileSignature(dbPath);
    if (sig === null || sig === lastSig) return;
    try {
      const data = fs.readFileSync(dbPath);
      const fresh = new sqlEngine.Database(data);
      for (const [name, value] of appliedPragmas) fresh.exec(`PRAGMA ${name} = ${value}`);
      db.close();
      db = fresh;
      lastSig = sig;
    } catch (err) {
      log(`[Memory] Reload-before-access failed (keeping current state): ${err}`);
    }
  }

  /**
   * Persist the current in-memory DB to disk synchronously via an atomic temp-file + rename (a crash
   * mid-write cannot leave a truncated/corrupt file). The post-write signature is taken from the temp
   * file's own stat BEFORE the rename, so a concurrent external write landing between our rename and a
   * later stat cannot be mistaken for ours (avoids a TOCTOU that would skip reloading their update).
   * Best-effort: a disk error is logged, not thrown, so an FS hiccup never aborts the in-memory
   * mutation that requested the flush.
   */
  function writeToDisk(): void {
    const tmpPath = `${dbPath}.${process.pid}.tmp`;
    try {
      const data = db.export();
      fs.writeFileSync(tmpPath, Buffer.from(data));
      // Compute the post-write signature from the temp file's stat + the bytes we actually wrote
      // (byte length and the in-header change counter), BEFORE the rename. Taking it from `data`
      // rather than re-reading after the rename closes a TOCTOU where a concurrent external write
      // landing between our rename and a later stat could be mistaken for ours and skip a reload.
      const written = fileSignatureOf(fs.statSync(tmpPath), data.byteLength, changeCounterOf(data));
      fs.renameSync(tmpPath, dbPath);
      lastSig = written;
    } catch (err) {
      log(`[Memory] Failed to persist database: ${err}`);
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        /* temp file may not exist */
      }
    }
  }

  return {
    prepare(sql: string): PreparedStatement {
      const isMutation = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql);

      return {
        run(...params: unknown[]): RunResult {
          reloadIfChanged();
          db.run(sql, params);
          const changes = db.getRowsModified();
          if (isMutation) {
            if (txDepth === 0) {
              writeToDisk();
            } else if (changes > 0) {
              // Inside a transaction: mark dirty only on a real mutation so an all-read-only
              // transaction flushes nothing at commit (see transaction()).
              txDirty = true;
            }
          }
          return { changes };
        },

        get(...params: unknown[]): Record<string, unknown> | undefined {
          reloadIfChanged();
          const stmt = db.prepare(sql);
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
          reloadIfChanged();
          const stmt = db.prepare(sql);
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
      reloadIfChanged();
      db.exec(sql);
      // `exec` runs arbitrary (possibly multi-statement) SQL. getRowsModified() does NOT count DDL
      // (CREATE/DROP/ALTER), so we cannot rely on it here; instead treat the exec as mutating unless
      // it is provably read-only (no DML/DDL/transaction keyword). This is conservative — a real
      // mutation always contains one of these keywords, so it always persists; a read-only exec
      // (e.g. a bare SELECT) skips the multi-MB export. Inside a transaction we only flag dirty so
      // the single commit-time flush still fires (see transaction()).
      if (!MUTATING_SQL.test(sql)) return;
      if (txDepth === 0) {
        writeToDisk();
      } else {
        txDirty = true;
      }
    },

    transaction<T>(fn: () => T): T {
      // Nested calls join the outer transaction: only the outermost reloads up front and writes once
      // at the end, so the whole sequence is one atomic, single-flush unit.
      if (txDepth > 0) return fn();
      reloadIfChanged();
      db.exec('BEGIN');
      txDepth++;
      txDirty = false;
      try {
        const result = fn();
        // A transaction must be synchronous: COMMIT fires here, before any returned Promise could
        // resolve, so an async fn would commit/flush a partial state and lose its later writes.
        // Reject it loudly (the catch below rolls back) rather than silently corrupt. All current
        // callers are synchronous; this is a guardrail against a future async one.
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          throw new Error(
            'transaction(fn) requires a synchronous callback; fn returned a thenable. ' +
              'Do async work (e.g. LLM calls) outside the transaction.',
          );
        }
        db.exec('COMMIT');
        txDepth--;
        // Only serialize the multi-MB DB when the transaction actually mutated it. A read-only or
        // empty transaction (common via the write-queue's per-item loops) flushes nothing — the
        // whole point of batching. A single real mutation anywhere inside sets txDirty.
        if (txDirty) writeToDisk();
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } finally {
          txDepth--;
        }
        throw err;
      }
    },

    pragma(value: string): unknown {
      // Remember setter-form PRAGMAs (e.g. `foreign_keys = ON`) so a reload's fresh connection keeps
      // them; query-form PRAGMAs are reads and must not be replayed. Keyed by pragma name so the
      // latest value of each wins (and the map cannot grow unbounded across repeated sets/reloads).
      if (value.includes('=')) {
        const eq = value.indexOf('=');
        const name = value.slice(0, eq).trim();
        const setting = value.slice(eq + 1).trim();
        if (name) appliedPragmas.set(name, setting);
      }
      const results = db.exec(`PRAGMA ${value}`);
      const firstResult = results[0];
      if (!firstResult || firstResult.values.length === 0) return undefined;
      const firstRow = firstResult.values[0];
      return firstRow ? firstRow[0] : undefined;
    },

    close(): void {
      if (closed) return;
      closed = true;
      // INVARIANT: no flush on close. Every mutation already wrote through to disk synchronously
      // (statement run / exec / transaction commit), so there is never an unpersisted in-memory
      // change here. Do NOT re-add a flush-on-close: a stale snapshot exported at close could
      // resurrect another process's committed delete — exactly the clobber write-through removed.
      db.close();
    },
  };
}

/** Byte offset of the SQLite "file change counter" in the database header (4-byte big-endian). */
const SQLITE_CHANGE_COUNTER_OFFSET = 24;
/** Bytes of the header we need to read to recover the change counter. */
const SQLITE_HEADER_PROBE_BYTES = 28;

/**
 * Read the SQLite file-format "file change counter" (header bytes 24-27, big-endian). SQLite increments
 * it on every commit regardless of whether the file's byte size changed, so it detects same-size writes
 * (row DELETEs, equal-length UPDATEs) that mtime+size alone would miss. Returns 0 for a buffer too short
 * to contain a header (e.g. a brand-new empty file), which is a fine sentinel — any real DB differs.
 */
function changeCounterOf(data: Uint8Array): number {
  if (data.length < SQLITE_CHANGE_COUNTER_OFFSET + 4) return 0;
  const o = SQLITE_CHANGE_COUNTER_OFFSET;
  return ((data[o]! << 24) | (data[o + 1]! << 16) | (data[o + 2]! << 8) | data[o + 3]!) >>> 0;
}

/** Read just the change counter from a file head without loading the whole (multi-MB) DB. */
function changeCounterOfFile(filePath: string): number {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(SQLITE_HEADER_PROBE_BYTES);
    const read = fs.readSync(fd, buf, 0, SQLITE_HEADER_PROBE_BYTES, 0);
    return changeCounterOf(buf.subarray(0, read));
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* fd already closed */
      }
    }
  }
}

/**
 * mtime+size+change-counter signature of a file for cheap cross-process change detection; null when
 * absent. The change counter (header bytes 24-27) is essential: a row DELETE or equal-length UPDATE
 * leaves both mtime (on coarse filesystems) and byte size unchanged, so without it another process's
 * same-size commit would be invisible and a later export would resurrect the deleted row. Reading 28
 * bytes from the file head is as cheap as the stat we already do.
 */
function fileSignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return fileSignatureOf(stat, undefined, changeCounterOfFile(filePath));
  } catch {
    return null;
  }
}

/**
 * Build a signature from an already-taken stat plus the known byte length and change counter — no extra
 * stat syscall. The change counter must be supplied by the caller (from the bytes it read/wrote) so the
 * signature is consistent with the exact image involved.
 */
function fileSignatureOf(
  stat: { mtimeMs: number; size: number },
  size: number | undefined,
  changeCounter: number,
): string {
  return `${stat.mtimeMs}:${size ?? stat.size}:${changeCounter}`;
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

    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);
    });
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
