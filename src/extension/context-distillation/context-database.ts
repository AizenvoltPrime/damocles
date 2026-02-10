import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { log } from '../logger';
import { getSqlEngine, createDatabaseWrapper } from '../memory/database';
import type { DatabaseInstance } from '../memory/types';
import type { EntryType, ToolCallRecord, ContextEntryRow, AnnotationResult } from './types';

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

const SCHEMA_V2 = `
ALTER TABLE context_entries ADD COLUMN confidence REAL DEFAULT NULL;
ALTER TABLE context_entries ADD COLUMN semantic_group TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS entry_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_entry_id INTEGER NOT NULL,
  target_entry_id INTEGER NOT NULL,
  link_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(source_entry_id, target_entry_id, link_type)
);
CREATE INDEX IF NOT EXISTS idx_el_source ON entry_links(source_entry_id);
CREATE INDEX IF NOT EXISTS idx_el_target ON entry_links(target_entry_id);

DROP TRIGGER IF EXISTS ce_ai;
DROP TRIGGER IF EXISTS ce_ad;
DROP TRIGGER IF EXISTS ce_au;
DROP TABLE IF EXISTS context_entries_fts;

CREATE VIRTUAL TABLE context_entries_fts USING fts5(
  file_path, description, tags, semantic_group,
  content=context_entries, content_rowid=id,
  tokenize='porter unicode61'
);

INSERT INTO context_entries_fts(rowid, file_path, description, tags, semantic_group)
  SELECT id, file_path, description, tags, semantic_group FROM context_entries;

CREATE TRIGGER ce_ai AFTER INSERT ON context_entries BEGIN
  INSERT INTO context_entries_fts(rowid, file_path, description, tags, semantic_group)
  VALUES (NEW.id, NEW.file_path, NEW.description, NEW.tags, NEW.semantic_group);
END;

CREATE TRIGGER ce_ad AFTER DELETE ON context_entries BEGIN
  INSERT INTO context_entries_fts(context_entries_fts, rowid, file_path, description, tags, semantic_group)
  VALUES ('delete', OLD.id, OLD.file_path, OLD.description, OLD.tags, OLD.semantic_group);
END;

CREATE TRIGGER ce_au AFTER UPDATE ON context_entries BEGIN
  INSERT INTO context_entries_fts(context_entries_fts, rowid, file_path, description, tags, semantic_group)
  VALUES ('delete', OLD.id, OLD.file_path, OLD.description, OLD.tags, OLD.semantic_group);
  INSERT INTO context_entries_fts(rowid, file_path, description, tags, semantic_group)
  VALUES (NEW.id, NEW.file_path, NEW.description, NEW.tags, NEW.semantic_group);
END;
`;

const MIGRATIONS: Record<number, string> = {
  1: SCHEMA_V1,
  2: SCHEMA_V2,
};

const CURRENT_VERSION = 2;

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

export function getRecentAnnotatedEntries(
  db: DatabaseInstance,
  sessionId: string,
  currentPromptIndex: number,
  limit = 30,
): ContextEntryRow[] {
  return db.prepare(
    `SELECT * FROM context_entries
     WHERE session_id = ?
       AND prompt_index < ?
       AND description IS NOT NULL
       AND low_relevance = 0
     ORDER BY prompt_index DESC, id DESC
     LIMIT ?`
  ).all(sessionId, currentPromptIndex, limit) as ContextEntryRow[];
}

export function applyAnnotations(
  db: DatabaseInstance,
  sessionId: string,
  promptIndex: number,
  result: AnnotationResult,
): void {
  const validIds = new Set(
    (db.prepare(
      `SELECT id FROM context_entries WHERE session_id = ? AND prompt_index = ?`
    ).all(sessionId, promptIndex) as Array<{ id: number }>).map(r => r.id)
  );

  db.exec('BEGIN');
  try {
    const updateEntry = db.prepare(
      `UPDATE context_entries
       SET description = ?, tags = ?, related_files = ?, confidence = ?, semantic_group = ?
       WHERE id = ? AND session_id = ?`
    );

    const markLow = db.prepare(
      `UPDATE context_entries SET low_relevance = 1 WHERE id = ? AND session_id = ?`
    );

    for (const ann of result.annotations) {
      if (!validIds.has(ann.entry_id)) continue;
      if (ann.low_relevance) {
        markLow.run(ann.entry_id, sessionId);
      }
      updateEntry.run(
        ann.description,
        ann.tags,
        JSON.stringify(ann.related_files),
        ann.confidence,
        ann.semantic_group,
        ann.entry_id,
        sessionId,
      );
    }

    const linkTargetIds = [...new Set(
      result.links
        .map(l => l.target_entry_id)
        .filter(id => !validIds.has(id))
    )];
    const validLinkIds = new Set(validIds);
    if (linkTargetIds.length > 0) {
      const placeholders = linkTargetIds.map(() => '?').join(',');
      const existing = db.prepare(
        `SELECT id FROM context_entries WHERE id IN (${placeholders})`
      ).all(...linkTargetIds) as Array<{ id: number }>;
      for (const row of existing) validLinkIds.add(row.id);
    }

    const insertLink = db.prepare(
      `INSERT OR IGNORE INTO entry_links (source_entry_id, target_entry_id, link_type, created_at)
       VALUES (?, ?, ?, ?)`
    );
    const now = Date.now();
    for (const link of result.links) {
      if (!validLinkIds.has(link.source_entry_id) || !validLinkIds.has(link.target_entry_id)) continue;
      insertLink.run(link.source_entry_id, link.target_entry_id, link.link_type, now);
    }

    if (result.prompt_summary) {
      insertSummary(db, sessionId, promptIndex, result.prompt_summary.summary, result.prompt_summary.tags);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getEntriesByIds(
  db: DatabaseInstance,
  entryIds: number[],
): ContextEntryRow[] {
  if (entryIds.length === 0) return [];
  const placeholders = entryIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM context_entries WHERE id IN (${placeholders})`
  ).all(...entryIds) as ContextEntryRow[];
}

export function getLinkedEntries(
  db: DatabaseInstance,
  entryIds: number[],
  currentPromptIndex: number,
  limit = 10,
): ContextEntryRow[] {
  if (entryIds.length === 0) return [];

  const placeholders = entryIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT DISTINCT ce.* FROM entry_links el
     JOIN context_entries ce ON (ce.id = el.target_entry_id OR ce.id = el.source_entry_id)
     WHERE (el.source_entry_id IN (${placeholders}) OR el.target_entry_id IN (${placeholders}))
       AND ce.id NOT IN (${placeholders})
       AND ce.low_relevance = 0
       AND ce.prompt_index < ?
     ORDER BY ce.prompt_index DESC
     LIMIT ?`
  ).all(...entryIds, ...entryIds, ...entryIds, currentPromptIndex, limit) as ContextEntryRow[];
}
