import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StatementSync } from 'node:sqlite';
import { NO_PROJECT_KEY } from '../../shared/types/usage-stats';
import type { UsageDatabase } from './database';
import { normalizeModelKey, parseLedgerLine, parseSessionLine, type UsageLine } from './entry-parser';
import type { UsageStatsModel, UsageStatsProgress } from './worker-protocol';

export type FileKind = 'main' | 'subagent' | 'team' | 'background';

export type SessionPathClass =
  | { kind: 'main' }
  | { kind: 'subagent'; parentSessionId: string }
  | { kind: 'team'; parentSessionId: string; teamId: string }
  | { kind: 'skip' };

const SKIP_PATH: SessionPathClass = { kind: 'skip' };

/**
 * Classify a file under pi's sessions dir by the layout `agent-records.ts` builds. Team event logs
 * (`<parent>/teams/<teamId>.jsonl`), checkpoints and anything else are skipped.
 */
export function classifySessionPath(sessionsDir: string, filePath: string): SessionPathClass {
  const relative = path.relative(sessionsDir, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return SKIP_PATH;
  const parts = relative.split(/[\\/]/);
  if (!parts[parts.length - 1]!.endsWith('.jsonl')) return SKIP_PATH;
  if (parts.length === 2) return { kind: 'main' };
  if (parts.length === 4 && parts[2] === 'subagents') return { kind: 'subagent', parentSessionId: parts[1]! };
  if (parts.length === 6 && parts[2] === 'teams' && parts[4] === 'members') {
    return { kind: 'team', parentSessionId: parts[1]!, teamId: parts[3]! };
  }
  return SKIP_PATH;
}

/** Header `cwd`, resolved, and lowercased on win32 where paths are case-insensitive. */
export function projectKeyOf(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export interface IndexUsageOptions {
  db: UsageDatabase;
  sessionsDir: string;
  ledgerPath: string;
  models: readonly UsageStatsModel[];
  onProgress?: (progress: UsageStatsProgress) => void;
  log: (message: string) => void;
}

export interface IndexUsageSummary {
  filesTotal: number;
  filesRead: number;
  filesFailed: number;
}

interface FileRow {
  file_id: number;
  kind: FileKind;
  session_id: string | null;
  agent_session_id: string | null;
  session_started_ms: number | null;
  project_key: string | null;
  detail: string | null;
  model_provider: string | null;
  model_id: string | null;
  size: number;
  mtime_ms: number;
  byte_offset: number;
  tail_hash: string | null;
  missing: number;
  parse_errors: number;
}

interface Target {
  path: string;
  kind: FileKind;
  parentSessionId?: string;
}

/** Mutable per-file state carried across incremental reads through the `files` row. */
interface FileState {
  sessionId: string | null;
  agentSessionId: string | null;
  startedMs: number | null;
  projectKey: string | null;
  detail: string | null;
  modelProvider: string | null;
  modelId: string | null;
  parseErrors: number;
  /** False until a session file's header line has been read; ledger lines ignore it. */
  attributed: boolean;
}

const TAIL_BYTES = 1024;
const CHUNK_BYTES = 1 << 20;
const PROGRESS_INTERVAL_MS = 100;

function listSessionFiles(sessionsDir: string): Target[] {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir, { recursive: true, encoding: 'utf8' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const main: Target[] = [];
  const nested: Target[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const filePath = path.join(sessionsDir, name);
    const cls = classifySessionPath(sessionsDir, filePath);
    if (cls.kind === 'main') main.push({ path: filePath, kind: 'main' });
    else if (cls.kind !== 'skip') nested.push({ path: filePath, kind: cls.kind, parentSessionId: cls.parentSessionId });
  }
  const byPath = (a: Target, b: Target) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  // Main files first, so a nested file finds its parent session's start time already indexed.
  return [...main.sort(byPath), ...nested.sort(byPath)];
}

function tailHash(fd: number, end: number): string {
  const start = Math.max(0, end - TAIL_BYTES);
  const buf = Buffer.alloc(end - start);
  const read = fs.readSync(fd, buf, 0, buf.length, start);
  return createHash('sha1').update(buf.subarray(0, read)).digest('hex');
}

/** Calls `onLine` for each complete line in `[start, end)` and returns the offset after the last one. */
function readCompleteLines(fd: number, start: number, end: number, onLine: (line: string) => void): number {
  let pos = start;
  let consumed = start;
  let carry = Buffer.alloc(0);
  while (pos < end) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - pos));
    const read = fs.readSync(fd, chunk, 0, chunk.length, pos);
    if (read === 0) break;
    pos += read;
    const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
    let lineStart = 0;
    for (let nl = data.indexOf(0x0a, lineStart); nl !== -1; nl = data.indexOf(0x0a, lineStart)) {
      const lineEnd = nl > lineStart && data[nl - 1] === 0x0d ? nl - 1 : nl;
      if (lineEnd > lineStart) onLine(data.toString('utf8', lineStart, lineEnd));
      lineStart = nl + 1;
    }
    carry = data.subarray(lineStart);
    consumed = pos - carry.length;
  }
  return consumed;
}

const ENTRY_COLUMNS = [
  'entry_key', 'ts_ms', 'session_id', 'agent_session_id', 'session_started_ms', 'project_key', 'origin', 'kind', 'detail',
  'provider', 'model', 'model_key', 'input', 'output', 'cache_read', 'cache_write', 'cache_write_1h', 'reasoning',
  'cost_input', 'cost_output', 'cost_cache_read', 'cost_cache_write', 'cost_total', 'stop_reason', 'file_id',
] as const;

// A copied entry belongs to the oldest top-level session; equal start times fall back to session id, the
// nested file's own session id, then file path, so every scan order converges on the same row.
const UPSERT_ENTRY_SQL = `
INSERT INTO entries (${ENTRY_COLUMNS.join(', ')}) VALUES (${ENTRY_COLUMNS.map(() => '?').join(', ')})
ON CONFLICT(entry_key) DO UPDATE SET ${ENTRY_COLUMNS.filter((c) => c !== 'entry_key').map((c) => `${c} = excluded.${c}`).join(', ')}
WHERE (excluded.session_started_ms, coalesce(excluded.session_id, ''), coalesce(excluded.agent_session_id, ''), ?)
    < (entries.session_started_ms, coalesce(entries.session_id, ''), coalesce(entries.agent_session_id, ''),
       (SELECT path FROM files WHERE files.file_id = entries.file_id))`;

interface Statements {
  selectFile: StatementSync;
  insertFile: StatementSync;
  updateFile: StatementSync;
  upsertEntry: StatementSync;
  upsertProject: StatementSync;
  selectSession: StatementSync;
  upsertSession: StatementSync;
  setTitle: StatementSync;
  adoptNestedFiles: StatementSync;
  adoptNestedEntries: StatementSync;
}

function prepareStatements(db: UsageDatabase): Statements {
  return {
    selectFile: db.prepare('SELECT * FROM files WHERE path = ?'),
    insertFile: db.prepare('INSERT INTO files (path, kind) VALUES (?, ?) RETURNING file_id'),
    updateFile: db.prepare(`UPDATE files SET session_id = ?, agent_session_id = ?, session_started_ms = ?, project_key = ?, detail = ?,
      model_provider = ?, model_id = ?, size = ?, mtime_ms = ?, byte_offset = ?, tail_hash = ?, missing = 0, parse_errors = ?
      WHERE file_id = ?`),
    upsertEntry: db.prepare(UPSERT_ENTRY_SQL),
    upsertProject: db.prepare('INSERT INTO projects (project_key, cwd) VALUES (?, ?) ON CONFLICT(project_key) DO NOTHING'),
    selectSession: db.prepare('SELECT started_ms, project_key FROM sessions WHERE session_id = ?'),
    upsertSession: db.prepare(`INSERT INTO sessions (session_id, project_key, title, started_ms, file_id, missing) VALUES (?, ?, NULL, ?, ?, 0)
      ON CONFLICT(session_id) DO UPDATE SET project_key = excluded.project_key, started_ms = excluded.started_ms,
      file_id = excluded.file_id, missing = 0`),
    setTitle: db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?'),
    // A nested file indexed before its parent's main file fell back to its own header; re-anchor it to the parent.
    adoptNestedFiles: db.prepare(`UPDATE files SET session_started_ms = ?, project_key = ?
      WHERE session_id = ? AND kind IN ('subagent', 'team') AND (session_started_ms IS NOT ? OR project_key IS NOT ?)`),
    adoptNestedEntries: db.prepare(`UPDATE entries SET session_started_ms = ?, project_key = ?
      WHERE session_id = ? AND origin IN ('subagent', 'team') AND (session_started_ms <> ? OR project_key <> ?)`),
  };
}

function emptyState(): FileState {
  return {
    sessionId: null, agentSessionId: null, startedMs: null, projectKey: null, detail: null,
    modelProvider: null, modelId: null, parseErrors: 0, attributed: false,
  };
}

function stateFromRow(row: FileRow): FileState {
  return {
    sessionId: row.session_id,
    agentSessionId: row.agent_session_id,
    startedMs: row.session_started_ms,
    projectKey: row.project_key,
    detail: row.detail,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    parseErrors: row.parse_errors,
    attributed: row.session_started_ms !== null,
  };
}

class Indexer {
  private readonly db: UsageDatabase;
  private readonly stmts: Statements;
  readonly registryKeys: ReadonlySet<string>;

  constructor(db: UsageDatabase, models: readonly UsageStatsModel[]) {
    this.db = db;
    this.stmts = prepareStatements(db);
    this.registryKeys = new Set(models.map((m) => m.key));
  }

  /** Returns false when the file vanished before it could be read. */
  indexFile(target: Target): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    const unchanged = (row: FileRow | undefined, of: fs.Stats) =>
      row !== undefined && row.missing === 0 && row.size === of.size && row.mtime_ms === Math.floor(of.mtimeMs);
    if (unchanged(this.stmts.selectFile.get(target.path) as FileRow | undefined, stat)) return true;

    const fd = fs.openSync(target.path, 'r');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // Re-read the row and the size under the write lock: another window's scan may have indexed this file since the check above.
        const locked = fs.fstatSync(fd);
        const existing = this.stmts.selectFile.get(target.path) as FileRow | undefined;
        if (!unchanged(existing, locked)) this.readInto(target, existing, fd, locked.size, Math.floor(locked.mtimeMs));
        this.db.exec('COMMIT');
      } catch (err) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw err;
      }
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  private readInto(target: Target, existing: FileRow | undefined, fd: number, size: number, mtimeMs: number): void {
    const fileId = existing?.file_id ?? Number((this.stmts.insertFile.get(target.path, target.kind) as { file_id: number }).file_id);
    // A shrink, a changed tail or a reappearing file is a rewrite: reparse from byte 0; upserts make it idempotent.
    const resume =
      existing !== undefined &&
      existing.missing === 0 &&
      size >= existing.byte_offset &&
      existing.tail_hash === tailHash(fd, existing.byte_offset);
    const start = resume ? existing.byte_offset : 0;
    const state = resume ? stateFromRow(existing) : emptyState();

    const onLine: (line: string, first: boolean) => void = target.kind === 'background'
      ? (line) => this.ledgerLine(line, state, fileId, target.path)
      : (line, first) => this.sessionLine(line, first, state, fileId, target);
    let first = start === 0;
    const end = readCompleteLines(fd, start, size, (line) => {
      onLine(line, first);
      first = false;
    });

    this.stmts.updateFile.run(
      state.sessionId, state.agentSessionId, state.startedMs, state.projectKey, state.detail,
      state.modelProvider, state.modelId, size, mtimeMs, end, tailHash(fd, end), state.parseErrors, fileId,
    );
  }

  private sessionLine(line: string, first: boolean, state: FileState, fileId: number, target: Target): void {
    const parsed = parseSessionLine(line);
    if (first) {
      if (parsed.kind !== 'header') {
        state.parseErrors++;
        return;
      }
      this.attribute(parsed, state, fileId, target);
      return;
    }
    switch (parsed.kind) {
      case 'error':
        state.parseErrors++;
        return;
      case 'title':
        if (target.kind === 'main' && state.sessionId !== null) this.stmts.setTitle.run(parsed.name, state.sessionId);
        return;
      case 'launch':
        state.detail = parsed.detail;
        return;
      case 'model':
        state.modelProvider = parsed.provider;
        state.modelId = parsed.model;
        return;
      case 'usage':
        if (!state.attributed) return;
        if (parsed.entryKind === 'assistant' && parsed.provider && parsed.model) {
          state.modelProvider = parsed.provider;
          state.modelId = parsed.model;
        }
        this.upsertEntry(parsed, {
          sessionId: state.sessionId,
          agentSessionId: state.agentSessionId,
          startedMs: state.startedMs!,
          projectKey: state.projectKey!,
          origin: target.kind,
          detail: state.detail,
          provider: parsed.provider ?? state.modelProvider,
          model: parsed.model ?? state.modelId,
          fileId,
          filePath: target.path,
        });
        return;
      default:
        return;
    }
  }

  private attribute(header: Extract<ReturnType<typeof parseSessionLine>, { kind: 'header' }>, state: FileState, fileId: number, target: Target): void {
    const ownProjectKey = projectKeyOf(header.cwd);
    this.stmts.upsertProject.run(ownProjectKey, header.cwd);
    state.attributed = true;
    if (target.kind === 'main') {
      state.sessionId = header.id;
      state.startedMs = header.startedMs;
      state.projectKey = ownProjectKey;
      this.stmts.upsertSession.run(header.id, ownProjectKey, header.startedMs, fileId);
      this.stmts.adoptNestedFiles.run(header.startedMs, ownProjectKey, header.id, header.startedMs, ownProjectKey);
      this.stmts.adoptNestedEntries.run(header.startedMs, ownProjectKey, header.id, header.startedMs, ownProjectKey);
      return;
    }
    const parent = this.stmts.selectSession.get(target.parentSessionId!) as { started_ms: number; project_key: string } | undefined;
    state.sessionId = target.parentSessionId!;
    state.agentSessionId = header.id;
    state.startedMs = parent?.started_ms ?? header.startedMs;
    state.projectKey = parent?.project_key ?? ownProjectKey;
  }

  private ledgerLine(line: string, state: FileState, fileId: number, filePath: string): void {
    const parsed = parseLedgerLine(line);
    if (parsed.kind === 'error') {
      state.parseErrors++;
      return;
    }
    if (parsed.kind !== 'usage') return;
    const projectKey = parsed.cwd === null ? NO_PROJECT_KEY : projectKeyOf(parsed.cwd);
    this.stmts.upsertProject.run(projectKey, parsed.cwd);
    this.upsertEntry(parsed, {
      sessionId: parsed.sessionId,
      agentSessionId: null,
      // Ledger ids are unique per record, so the dedupe order never compares them.
      startedMs: parsed.tsMs,
      projectKey,
      origin: 'background',
      detail: parsed.purpose,
      provider: parsed.provider,
      model: parsed.model,
      fileId,
      filePath,
    });
  }

  private upsertEntry(
    line: UsageLine,
    at: {
      sessionId: string | null; agentSessionId: string | null; startedMs: number; projectKey: string; origin: FileKind;
      detail: string | null; provider: string | null; model: string | null; fileId: number; filePath: string;
    },
  ): void {
    const u = line.usage;
    const modelKey = at.provider && at.model ? normalizeModelKey(at.provider, at.model, this.registryKeys) : null;
    this.stmts.upsertEntry.run(
      `${line.id}|${line.timestamp}`, line.tsMs, at.sessionId, at.agentSessionId, at.startedMs, at.projectKey, at.origin,
      line.entryKind, at.detail, at.provider, at.model, modelKey, u.input, u.output, u.cacheRead, u.cacheWrite,
      u.cacheWrite1h, u.reasoning, u.cost.input, u.cost.output, u.cost.cacheRead, u.cost.cacheWrite, u.cost.total,
      line.stopReason, at.fileId, at.filePath,
    );
  }

  /** Spend rows stay; a vanished conversation loses its title and reads as deleted. */
  markMissing(seen: ReadonlySet<string>): void {
    const rows = this.db.prepare('SELECT file_id, path, kind, session_id FROM files WHERE missing = 0').all() as Array<{
      file_id: number; path: string; kind: FileKind; session_id: string | null;
    }>;
    const markFile = this.db.prepare('UPDATE files SET missing = 1 WHERE file_id = ?');
    const markSession = this.db.prepare('UPDATE sessions SET missing = 1, title = NULL WHERE session_id = ? AND file_id = ?');
    let clearedTitle = false;
    for (const row of rows) {
      if (seen.has(row.path)) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // `seen` comes from a listing taken at scan start; another window may have indexed a file created since.
        if (isGone(row.path)) {
          markFile.run(row.file_id);
          if (row.kind === 'main' && row.session_id !== null) {
            clearedTitle = Number(markSession.run(row.session_id, row.file_id).changes) > 0 || clearedTitle;
          }
        }
        this.db.exec('COMMIT');
      } catch (err) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw err;
      }
    }
    // secure_delete zeroes the database pages, but older WAL frames still hold the title until the WAL is truncated.
    if (clearedTitle) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
}

function isGone(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

const MODEL_REGISTRY_META_KEY = 'model_registry';

/**
 * Re-normalizes every row's `model_key` when the registry differs from the one the index was keyed with,
 * so one model never splits across a dated and a base key. Keys depend only on registry keys.
 */
function rekeyModels(db: UsageDatabase, registryKeys: ReadonlySet<string>): void {
  const fingerprint = createHash('sha1').update([...registryKeys].sort().join('\n')).digest('hex');
  const selectStored = db.prepare('SELECT value FROM meta WHERE key = ?');
  const isCurrent = () => (selectStored.get(MODEL_REGISTRY_META_KEY) as { value: string } | undefined)?.value === fingerprint;
  if (isCurrent()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another window with the same registry may have re-keyed since the check above.
    if (!isCurrent()) {
      const pairs = db.prepare('SELECT DISTINCT provider, model FROM entries WHERE provider IS NOT NULL AND model IS NOT NULL').all() as Array<{
        provider: string; model: string;
      }>;
      db.exec('CREATE TEMP TABLE IF NOT EXISTS model_keys (provider TEXT NOT NULL, model TEXT NOT NULL, model_key TEXT NOT NULL, PRIMARY KEY (provider, model))');
      db.exec('DELETE FROM temp.model_keys');
      const insert = db.prepare('INSERT INTO temp.model_keys (provider, model, model_key) VALUES (?, ?, ?)');
      for (const { provider, model } of pairs) insert.run(provider, model, normalizeModelKey(provider, model, registryKeys));
      db.exec(`UPDATE entries SET model_key = k.model_key FROM temp.model_keys k
        WHERE k.provider = entries.provider AND k.model = entries.model AND entries.model_key IS NOT k.model_key`);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(MODEL_REGISTRY_META_KEY, fingerprint);
    }
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * One incremental scan of `sessionsDir` and the ledger into `db`. Each file commits in its own
 * `BEGIN IMMEDIATE` transaction, so a second window's scan serializes on the write lock. A file that
 * fails is logged and retried on the next scan; the rest still index. So do the re-key and the tail
 * steps, which must not turn an indexed scan into an error.
 */
export async function indexUsage(options: IndexUsageOptions): Promise<IndexUsageSummary> {
  const { db, sessionsDir, ledgerPath, models, onProgress, log } = options;
  const failSoft = (step: string, run: () => void) => {
    try {
      run();
    } catch (err) {
      log(`[UsageStats] Could not ${step}; retrying on the next scan: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const targets = listSessionFiles(sessionsDir);
  if (fs.existsSync(ledgerPath)) targets.push({ path: ledgerPath, kind: 'background' });
  const indexer = new Indexer(db, models);
  failSoft('re-key models for the current registry', () => rekeyModels(db, indexer.registryKeys));
  const seen = new Set<string>();
  const summary: IndexUsageSummary = { filesTotal: targets.length, filesRead: 0, filesFailed: 0 };
  let lastProgressAt = 0;
  onProgress?.({ filesDone: 0, filesTotal: targets.length });

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    try {
      if (indexer.indexFile(target)) {
        seen.add(target.path);
        summary.filesRead++;
      }
    } catch (err) {
      seen.add(target.path);
      summary.filesFailed++;
      log(`[UsageStats] Could not index ${target.path}; retrying on the next scan: ${err instanceof Error ? err.message : String(err)}`);
    }
    const now = Date.now();
    if (onProgress && (i === targets.length - 1 || now - lastProgressAt >= PROGRESS_INTERVAL_MS)) {
      lastProgressAt = now;
      onProgress({ filesDone: i + 1, filesTotal: targets.length });
    }
    // Yield so the worker answers filter queries between files.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  failSoft('mark vanished files missing', () => indexer.markMissing(seen));
  failSoft('record the scan time', () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('indexed_at_ms', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(Date.now()));
  });
  return summary;
}
