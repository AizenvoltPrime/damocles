import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../logger';
import type { DatabaseInstance, PreparedStatement, RunResult } from './types';

type NodeDatabaseSync = InstanceType<typeof DatabaseSync>;

type SqlParam = null | number | bigint | string | Buffer | Uint8Array;

const CURRENT_VERSION = 3;

// Shared so the desynced-index heal can DROP + recreate the FTS table with identical DDL.
const CREATE_FTS_SQL = `CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, title, summary, tags, facts, observation_tags, search_terms, files_read, files_modified,
  content=memories, content_rowid=rowid,
  tokenize='porter unicode61'
);`;

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

${CREATE_FTS_SQL}

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

// Cross-window consolidation lease: `claimed_by`/`claimed_at` let reclaim tell a live claim in another
// window from a crash-stranded one. Both default NULL on existing rows (treated as expired).
const MIGRATION_V2 = `
ALTER TABLE memory_candidates ADD COLUMN claimed_by TEXT;
ALTER TABLE memory_candidates ADD COLUMN claimed_at INTEGER;
`;

// Deferred conflict re-checks: rows the contradiction judge couldn't decide (judge unavailable) are
// flagged so a later sweep re-decides them, so a transient outage never leaves contradicting facts
// co-latest. Partial index keeps the sweep scan O(flagged) and empty in the all-clear case.
const MIGRATION_V3 = `
ALTER TABLE memories ADD COLUMN needs_conflict_check INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_memories_needs_conflict_check ON memories(needs_conflict_check) WHERE needs_conflict_check = 1;
`;

const MIGRATIONS: Record<number, string> = {
  1: MIGRATION_V1,
  2: MIGRATION_V2,
  3: MIGRATION_V3,
};

export interface OpenDatabaseOptions {
  /**
   * Called with the running count of consecutive failed mutations on each failure, and once with `0`
   * when a success breaks a failure streak. Never called for pure reads.
   */
  onPersistFailure?: (consecutiveFailures: number) => void;
}

export interface OpenDatabaseResult {
  db: DatabaseInstance;
  /** Set only when a corrupt file was renamed aside and a fresh DB created in its place. */
  quarantinedFrom?: string;
  /** Memories recovered by the salvage rebuild (set only when salvage ran; the store is not empty). */
  salvagedMemories?: number;
}

export { createWrapper as createDatabaseWrapper };

/**
 * Adapt a node:sqlite {@link DatabaseSync} connection to {@link DatabaseInstance}. WAL-mode, so a
 * `COMMIT` is durable the moment it returns (no snapshot/export).
 *
 * A mutation is counted for `onPersistFailure` exactly once at its outermost level: `transaction()`
 * always counts; a bare `exec()`/`run()` counts only outside a transaction (`txDepth === 0`), since
 * inside one the enclosing `transaction()` owns the outcome. Reads never touch the counter.
 */
function createWrapper(db: NodeDatabaseSync, onPersistFailure?: (n: number) => void): DatabaseInstance {
  let closed = false;
  let txDepth = 0;
  let consecutiveFailures = 0;

  function noteSuccess(): void {
    if (consecutiveFailures > 0) {
      consecutiveFailures = 0;
      onPersistFailure?.(0);
    }
  }

  function noteFailure(): void {
    consecutiveFailures++;
    onPersistFailure?.(consecutiveFailures);
  }

  return {
    prepare(sql: string): PreparedStatement {
      const stmt = db.prepare(sql);

      return {
        run(...params: unknown[]): RunResult {
          const tracked = txDepth === 0;
          try {
            const r = stmt.run(...(params as SqlParam[]));
            if (tracked) noteSuccess();
            return { changes: Number(r.changes) };
          } catch (err) {
            if (tracked) noteFailure();
            throw err;
          }
        },

        get(...params: unknown[]): unknown {
          return stmt.get(...(params as SqlParam[]));
        },

        all(...params: unknown[]): unknown[] {
          return stmt.all(...(params as SqlParam[]));
        },
      };
    },

    exec(sql: string): void {
      const tracked = txDepth === 0;
      try {
        db.exec(sql);
        if (tracked) noteSuccess();
      } catch (err) {
        if (tracked) noteFailure();
        throw err;
      }
    },

    pragma(value: string): unknown {
      // Setter-form PRAGMAs (contain '=') are writes with no result; query-form return a single row.
      if (value.includes('=')) {
        db.exec(`PRAGMA ${value}`);
        return undefined;
      }
      const row = db.prepare(`PRAGMA ${value}`).get() as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const values = Object.values(row);
      return values.length ? values[0] : undefined;
    },

    transaction<T>(fn: () => T): T {
      if (txDepth > 0) return fn(); // nested calls join the outer transaction
      // BEGIN IMMEDIATE takes the write lock up front so concurrent writers serialize via busy_timeout.
      // A failure here (sustained lock contention that outlasts busy_timeout) is a persist failure too.
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch (err) {
        noteFailure();
        throw err;
      }
      txDepth++;
      try {
        const result = fn();
        // COMMIT fires synchronously here, so an async fn would commit partial state and lose its
        // later writes — reject a thenable loudly (rolled back) rather than corrupt.
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          throw new Error(
            'transaction(fn) requires a synchronous callback; fn returned a thenable. ' +
              'Do async work (e.g. LLM calls) outside the transaction.',
          );
        }
        db.exec('COMMIT');
        txDepth--;
        noteSuccess();
        return result;
      } catch (err) {
        try {
          // SQLITE_CORRUPT and friends auto-abort the transaction; a blind ROLLBACK would then throw
          // "cannot rollback" and mask the real error.
          if (db.isTransaction) db.exec('ROLLBACK');
        } finally {
          txDepth--;
        }
        noteFailure();
        throw err;
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      // Fold the WAL back into the main file. PASSIVE (not TRUNCATE) so a reader in another window
      // can't make deactivate() block for the full busy_timeout; WAL data is already durable, so an
      // incomplete checkpoint is harmless and must not block the close.
      try {
        db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      } catch {
        /* best-effort */
      }
      db.close();
    },
  };
}

// v3 isolates the node:sqlite (WAL) engine in its own file. The sql.js build rewrites its DB file
// whole from memory, so two builds sharing one file corrupt it (WAL frames against replaced pages).
// v2 is imported once at v3 creation and left untouched for older builds.
async function getDbPathAsync(): Promise<string> {
  const dir = path.join(os.homedir(), '.damocles');
  await fs.promises.mkdir(dir, { recursive: true });
  return path.join(dir, 'memory.v3.db');
}

function getLegacyV2Path(): string {
  return path.join(os.homedir(), '.damocles', 'memory.v2.db');
}

function applyPragmas(raw: NodeDatabaseSync): void {
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec('PRAGMA foreign_keys = ON');
}

/** True when the on-disk file exists and has content (an empty/first-run file is not corrupt). */
function fileExistsNonEmpty(dbPath: string): boolean {
  try {
    return fs.statSync(dbPath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Classify an open/migrate error as data corruption vs a transient/uncertain fault. Only corruption
 * justifies renaming the file aside; when uncertain, return false so readable data is never destroyed.
 */
function isCorruptionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  // node:sqlite reports the SQLite result code numerically on `errcode` (the string `code` is the
  // generic 'ERR_SQLITE_ERROR'); mask off the extended bits so CORRUPT_VTAB (267) etc. still match.
  const errcode = (err as { errcode?: number })?.errcode;
  if (typeof errcode === 'number') {
    const primary = errcode & 0xff;
    if (primary === 5 || primary === 6 || primary === 10) return false; // BUSY / LOCKED / IOERR
    if (primary === 11 || primary === 26) return true; // CORRUPT / NOTADB
  }
  // Transient IO/permission faults: readable data may still be intact, do NOT quarantine.
  if (/SQLITE_BUSY|SQLITE_IOERR|EACCES|ENOSPC|EBUSY|EAGAIN/i.test(code)) return false;
  if (/SQLITE_CORRUPT|SQLITE_NOTADB/i.test(code)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /file is not a database|malformed|corrupt|not a database/i.test(message);
}

/**
 * Rename the DB file and its `-wal`/`-shm` siblings aside to a quarantine path. Missing siblings are
 * fine, but a failure to move the MAIN file (e.g. EBUSY/EPERM when a sibling window holds it) means
 * the "fresh" open would reopen the same corrupt file — surface that by throwing.
 */
function quarantineFiles(dbPath: string, quarantinePath: string): void {
  fs.renameSync(dbPath, quarantinePath); // main file: a failure here must not be swallowed
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.renameSync(`${dbPath}${suffix}`, `${quarantinePath}${suffix}`);
    } catch {
      /* sibling may not exist; best-effort */
    }
  }
}

function baseTableReadable(raw: NodeDatabaseSync): boolean {
  try {
    raw.prepare('SELECT rowid FROM memories').all();
    return true;
  } catch {
    return false;
  }
}

/**
 * Full-database verification at open. Runtime-only corruption (e.g. a torn page in one table) can
 * pass open+migrate and then fail every consolidation write forever — quick_check catches it up
 * front so the salvage path runs instead. Throws a corruption-classified error on any finding.
 */
function verifyIntegrity(raw: NodeDatabaseSync): void {
  const rows = raw.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
  if (rows.length === 1 && rows[0]!.quick_check === 'ok') return;
  const detail = rows.map((r) => r.quick_check).join('; ').slice(0, 200);
  const err = new Error(`quick_check failed: ${detail}`) as Error & { code: string };
  err.code = 'SQLITE_CORRUPT';
  throw err;
}

/**
 * A desynced `memories_fts` external-content index throws SQLITE_CORRUPT on every FTS op — including
 * the write triggers, so ALL writes fail — while the base rows stay intact and rebuildable. When the
 * FTS probe errors but the base table still reads, rebuild rather than quarantine the whole store;
 * fall back to DROP + recreate if the shadow b-tree is too corrupt for an in-place rebuild. A base
 * table that is also unreadable is genuine page corruption — rethrow so quarantine handles it.
 */
function healFtsIndexIfDesynced(raw: NodeDatabaseSync): void {
  try {
    raw.prepare("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')").run();
    return;
  } catch (err) {
    if (!baseTableReadable(raw)) throw err;
  }
  log('[Memory] FTS index desynced from base table; rebuilding');
  try {
    raw.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  } catch {
    log('[Memory] In-place FTS rebuild failed; dropping and recreating the index');
    raw.exec('DROP TABLE memories_fts');
    raw.exec(CREATE_FTS_SQL);
    raw.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  }
}

/**
 * Open, apply pragmas, wrap, and migrate at an explicit path. May throw. On failure the connection is
 * closed before rethrowing: a corrupt file still opens and holds an OS file lock (the parse error
 * surfaces on first pragma/query), and on Windows that lock blocks the quarantine rename with EBUSY.
 */
function openAndMigrate(dbPath: string, options?: OpenDatabaseOptions): DatabaseInstance {
  const raw = new DatabaseSync(dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
  try {
    applyPragmas(raw);
    const wrapped = createWrapper(raw, options?.onPersistFailure);
    runMigrations(wrapped);
    healFtsIndexIfDesynced(raw);
    verifyIntegrity(raw);
    return wrapped;
  } catch (err) {
    try {
      raw.close();
    } catch {
      /* best-effort: release the file lock so a corrupt file can be quarantined */
    }
    throw err;
  }
}

/**
 * Durable tables copied row-by-row during a salvage or v2 import. `memory_candidates` is deliberately
 * absent: it is a transient raw-turn buffer (regenerable), and in practice it is the hot-write table
 * most likely to hold the torn page that made the source unreadable.
 */
const SALVAGE_TABLES = ['memories', 'memory_edges', 'memory_retrievals', 'memory_profile'] as const;

/**
 * Copy every readable durable row from `sourcePath` (a corrupt or legacy DB) into the freshly-migrated
 * `dest`, then rebuild the FTS index from the copied rows. Per-table: a table whose pages are torn is
 * skipped whole (its data is unreadable anyway) without failing the rest. Returns the number of
 * memories recovered.
 */
function copyDurableRows(sourcePath: string, dest: DatabaseInstance): number {
  const src = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5000 });
  try {
    let memories = 0;
    for (const table of SALVAGE_TABLES) {
      let rows: Record<string, unknown>[];
      try {
        rows = src.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
      } catch (err) {
        log(`[Memory] Salvage: table ${table} is unreadable, skipping: ${err}`);
        continue;
      }
      if (rows.length === 0) continue;
      const cols = Object.keys(rows[0]!);
      const insert = dest.prepare(
        `INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      );
      dest.transaction(() => {
        for (const row of rows) insert.run(...cols.map((c) => row[c] as SqlParam));
      });
      if (table === 'memories') memories = rows.length;
    }
    dest.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    return memories;
  } finally {
    src.close();
  }
}

/**
 * Open the memory DB at an explicit path with pragmas, migrations, and corrupt-file recovery. NEVER
 * throws. On corruption the file is set aside and a fresh store is created; a salvage pass then copies
 * every readable durable row back from the quarantined file (only the transient candidate buffer and
 * any physically unreadable table are lost), so quarantine no longer means losing all memories.
 * Returns `null` only when the store cannot be opened at all.
 */
export async function openMemoryDatabaseAt(
  dbPath: string,
  options?: OpenDatabaseOptions,
): Promise<OpenDatabaseResult | null> {
  try {
    const db = openAndMigrate(dbPath, options);
    return { db };
  } catch (err) {
    if (fileExistsNonEmpty(dbPath) && isCorruptionError(err)) {
      const quarantinePath = `${dbPath}.corrupt-${Date.now()}`;
      log(`[Memory] Database at ${dbPath} is corrupt (${err}); quarantining to ${quarantinePath}`);
      try {
        quarantineFiles(dbPath, quarantinePath);
      } catch (moveErr) {
        // Could not move the corrupt file aside (e.g. another window holds it) — reopening would just
        // re-hit the same corruption, so disable rather than loop on a broken store.
        log(`[Memory] Failed to quarantine corrupt database at ${dbPath}: ${moveErr}`);
        return null;
      }
      try {
        const db = openAndMigrate(dbPath, options);
        let salvaged = 0;
        try {
          salvaged = copyDurableRows(quarantinePath, db);
          log(`[Memory] Salvage recovered ${salvaged} memories from the quarantined database`);
        } catch (salvageErr) {
          // Fresh store stays usable even when nothing could be copied back.
          log(`[Memory] Salvage from quarantined database failed: ${salvageErr}`);
        }
        return { db, quarantinedFrom: quarantinePath, salvagedMemories: salvaged };
      } catch (freshErr) {
        // Fresh DB failed too — not recoverable corruption of an old file; do not loop.
        log(`[Memory] Failed to create fresh database after quarantine: ${freshErr}`);
        return null;
      }
    }
    // First-run failure, transient IO, or uncertain error: never destroy readable data.
    log(`[Memory] Failed to open database at ${dbPath}: ${err}`);
    return null;
  }
}

/**
 * Resolve the shared `~/.damocles/memory.v3.db` path and open it. On first run, durable rows are
 * imported once from the legacy v2 file (left untouched — older sql.js builds keep using it, so the
 * two engines never write the same file). NEVER throws — `null` on failure.
 */
export async function openDatabaseAsync(options?: OpenDatabaseOptions): Promise<OpenDatabaseResult | null> {
  const dbPath = await getDbPathAsync();
  const importFromV2 = !fileExistsNonEmpty(dbPath) && fileExistsNonEmpty(getLegacyV2Path());
  const opened = await openMemoryDatabaseAt(dbPath, options);
  if (opened && importFromV2) {
    try {
      const imported = copyDurableRows(getLegacyV2Path(), opened.db);
      log(`[Memory] Imported ${imported} memories from legacy memory.v2.db`);
    } catch (err) {
      log(`[Memory] Legacy v2 import failed (starting with an empty v3 store): ${err}`);
    }
  }
  return opened;
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
  for (let v = getCurrentVersion(db) + 1; v <= CURRENT_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;

    db.transaction(() => {
      // Re-check under the write lock: a sibling window may have applied this migration between our
      // outside-lock read and BEGIN IMMEDIATE. Without this the loser re-runs the DDL and fails with
      // "table already exists", aborting init and disabling memory until reload.
      if (getCurrentVersion(db) >= v) return;
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);
    });
  }
}

/**
 * Writes expanded search terms only if the row's `updated_at` still matches the value read
 * before the (slow, async) expansion, so a live edit landing meanwhile is not overwritten with stale
 * terms. Returns true when the write applied.
 */
export function updateSearchTermsIfUnchanged(
  db: DatabaseInstance,
  id: string,
  terms: string[],
  expectedUpdatedAt: number,
): boolean {
  const result = db
    .prepare('UPDATE memories SET search_terms = ? WHERE id = ? AND updated_at = ?')
    .run(JSON.stringify(terms), id, expectedUpdatedAt);
  return result.changes > 0;
}

export interface UnexpandedRow {
  id: string;
  updated_at: number;
}

/**
 * Keyset page of rows still lacking search terms, ordered `(updated_at, id)` descending. Passing the
 * last row of the previous page as `after` advances past it in O(log n) — the cursor moves
 * monotonically past written/skipped rows, so the backfill never re-scans them (a bare OFFSET/LIMIT
 * would be O(n²) as the skipped tail grows).
 */
export function getUnexpandedMemoryRows(
  db: DatabaseInstance,
  limit: number,
  after?: UnexpandedRow,
): UnexpandedRow[] {
  if (after) {
    return db
      .prepare(
        `SELECT id, updated_at FROM memories
          WHERE search_terms = '[]'
            AND (updated_at < ? OR (updated_at = ? AND id < ?))
          ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(after.updated_at, after.updated_at, after.id, limit) as UnexpandedRow[];
  }
  return db
    .prepare("SELECT id, updated_at FROM memories WHERE search_terms = '[]' ORDER BY updated_at DESC, id DESC LIMIT ?")
    .all(limit) as UnexpandedRow[];
}
