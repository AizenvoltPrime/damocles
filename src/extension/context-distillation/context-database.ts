import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { log } from '../logger';
import { getSqlEngine, createDatabaseWrapper } from '../memory/database';
import type { DatabaseInstance } from '../memory/types';
import type { EntryType, ToolCallRecord, ContextEntryRow } from './types';

const CONTEXT_DB_DIR = path.join(os.homedir(), '.damocles', 'context', 'distill');

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS context_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  prompt_index INTEGER NOT NULL,
  file_path TEXT,
  entry_type TEXT NOT NULL,
  tool_calls TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  tags TEXT,
  related_files TEXT DEFAULT '[]',
  low_relevance INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ce_session ON context_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_ce_prompt ON context_entries(session_id, prompt_index);

CREATE VIRTUAL TABLE IF NOT EXISTS context_entries_fts USING fts5(
  file_path, description, tags,
  content=context_entries, content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS ce_ai AFTER INSERT ON context_entries BEGIN
  INSERT INTO context_entries_fts(rowid, file_path, description, tags)
  VALUES (NEW.id, NEW.file_path, NEW.description, NEW.tags);
END;

CREATE TRIGGER IF NOT EXISTS ce_ad AFTER DELETE ON context_entries BEGIN
  INSERT INTO context_entries_fts(context_entries_fts, rowid, file_path, description, tags)
  VALUES ('delete', OLD.id, OLD.file_path, OLD.description, OLD.tags);
END;

CREATE TRIGGER IF NOT EXISTS ce_au AFTER UPDATE ON context_entries BEGIN
  INSERT INTO context_entries_fts(context_entries_fts, rowid, file_path, description, tags)
  VALUES ('delete', OLD.id, OLD.file_path, OLD.description, OLD.tags);
  INSERT INTO context_entries_fts(rowid, file_path, description, tags)
  VALUES (NEW.id, NEW.file_path, NEW.description, NEW.tags);
END;
`;

const MIGRATIONS: Record<number, string> = {
  1: SCHEMA_V1,
};

const CURRENT_VERSION = 1;

function getDbPath(sessionId: string): string {
  if (!fs.existsSync(CONTEXT_DB_DIR)) {
    fs.mkdirSync(CONTEXT_DB_DIR, { recursive: true });
  }
  return path.join(CONTEXT_DB_DIR, `${sessionId}.db`);
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

export function openContextDatabase(sessionId: string): DatabaseInstance | null {
  const engine = getSqlEngine();
  if (!engine) {
    log('[ContextDB] SQL engine not initialized');
    return null;
  }

  try {
    const dbPath = getDbPath(sessionId);
    let data: Buffer | undefined;

    if (fs.existsSync(dbPath)) {
      data = fs.readFileSync(dbPath);
    }

    const sqlDb = data
      ? new engine.Database(data)
      : new engine.Database();

    const db = createDatabaseWrapper(sqlDb, dbPath);
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
  } catch (err) {
    log('[ContextDB] Failed to open database for session %s: %O', sessionId, err);
    return null;
  }
}

export function insertEntry(
  db: DatabaseInstance,
  sessionId: string,
  promptIndex: number,
  filePath: string | null,
  entryType: EntryType,
  toolCalls: ToolCallRecord[],
): number {
  db.prepare(
    `INSERT INTO context_entries (session_id, prompt_index, file_path, entry_type, tool_calls, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, promptIndex, filePath, entryType, JSON.stringify(toolCalls), Date.now());

  const row = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number } | undefined;
  return row?.id ?? 0;
}

export function updateEntryDescription(
  db: DatabaseInstance,
  entryId: number,
  description: string,
  tags: string,
  relatedFiles: string[],
): void {
  db.prepare(
    `UPDATE context_entries SET description = ?, tags = ?, related_files = ? WHERE id = ?`
  ).run(description, tags, JSON.stringify(relatedFiles), entryId);
}

export function markLowRelevance(db: DatabaseInstance, entryId: number): void {
  db.prepare('UPDATE context_entries SET low_relevance = 1 WHERE id = ?').run(entryId);
}

export function insertSummary(
  db: DatabaseInstance,
  sessionId: string,
  promptIndex: number,
  summary: string,
  tags: string,
): void {
  db.prepare(
    `DELETE FROM context_entries WHERE session_id = ? AND prompt_index = ? AND entry_type = 'summary'`
  ).run(sessionId, promptIndex);
  db.prepare(
    `INSERT INTO context_entries (session_id, prompt_index, file_path, entry_type, tool_calls, description, tags, created_at)
     VALUES (?, ?, NULL, 'summary', '[]', ?, ?, ?)`
  ).run(sessionId, promptIndex, summary, tags, Date.now());
}

export function getEntriesForPrompt(
  db: DatabaseInstance,
  sessionId: string,
  promptIndex: number,
): ContextEntryRow[] {
  return db.prepare(
    `SELECT * FROM context_entries WHERE session_id = ? AND prompt_index = ? ORDER BY id`
  ).all(sessionId, promptIndex) as ContextEntryRow[];
}

export function getMaxPromptIndex(db: DatabaseInstance, sessionId: string): number {
  const row = db.prepare(
    'SELECT MAX(prompt_index) as max_idx FROM context_entries WHERE session_id = ?'
  ).get(sessionId) as { max_idx: number | null } | undefined;
  return row?.max_idx ?? -1;
}

export function getSummaryEntriesByPrompt(
  db: DatabaseInstance,
  sessionId: string,
): ContextEntryRow[] {
  return db.prepare(
    `SELECT * FROM context_entries WHERE session_id = ? AND entry_type = 'summary' ORDER BY prompt_index`
  ).all(sessionId) as ContextEntryRow[];
}
