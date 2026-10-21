import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { formatPerfLine } from '../../shared/perf-line';
import { installWorkerLogRelay, log } from '../logger';
import { CREATE_FTS_SQL, copyDurableRows, createDatabaseWrapper, isCorruptionError, isSchemaAhead, openAndMigrate } from './database';
import {
  MEMORY_INTEGRITY_WORKER_MARKER,
  repairMarkerPath,
  type IntegrityEvent,
  type IntegrityRequest,
  type IntegrityResults,
  type IntegrityVerdict,
  type MemoryIntegrityWorkerData,
  type RepairMarker,
  type RepairOutcome,
} from './integrity-protocol';

type RawDatabase = InstanceType<typeof DatabaseSync>;

const FTS_TABLES = /^memories_fts(?:_|$)/;
const REBUILD_FTS = "INSERT INTO memories_fts(memories_fts) VALUES('rebuild')";
// integrity_check prefixes the first finding of each database with this line.
const DATABASE_HEADING = /^\*\*\* in database \w+ \*\*\*\n/;
const SQLITE_BUSY = 5;

function findings(raw: RawDatabase, pragma: string): string[] {
  const lines = (raw.prepare(pragma).all() as Array<Record<string, unknown>>).map((row) => String(Object.values(row)[0]));
  return lines.length === 1 && lines[0] === 'ok' ? [] : lines.map((line) => line.replace(DATABASE_HEADING, ''));
}

// From SQLite 3.44 integrity_check also runs FTS5's own check; every node:sqlite build ships 3.46 or later.
function verdictOf(raw: RawDatabase): IntegrityVerdict {
  try {
    if (isSchemaAhead(createDatabaseWrapper(raw))) return 'ahead';
    const all = findings(raw, 'PRAGMA integrity_check');
    if (all.length === 0) return 'ok';
    log(`[MemoryIntegrity] integrity_check found: ${all.join('; ').slice(0, 300)}`);
    // The full-text index rebuilds from `memories`. A table check skips the freelist and unused pages, so damage
    // there, like damage in any other table, is reported by no full-text table's own check and needs a quarantine.
    const indexFindings = new Set(
      (raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name)
        .filter((name) => FTS_TABLES.test(name))
        .flatMap((name) => findings(raw, `PRAGMA integrity_check("${name.replaceAll('"', '""')}")`)),
    );
    return all.every((finding) => indexFindings.has(finding)) ? 'fts' : 'corrupt';
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    log(`[MemoryIntegrity] Reading the database failed: ${err}`);
    return 'corrupt';
  }
}

function check(dbPath: string): IntegrityVerdict {
  const raw = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    return verdictOf(raw);
  } finally {
    raw.close();
  }
}

function rebuildFts(dbPath: string): IntegrityVerdict {
  const raw = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    if (isSchemaAhead(createDatabaseWrapper(raw))) return 'ahead';
    try {
      raw.exec(REBUILD_FTS);
    } catch {
      log('[MemoryIntegrity] In-place FTS rebuild failed; dropping and recreating the index');
      recreateFts(raw);
    }
    const verdict = verdictOf(raw);
    // A finding the rebuild left is not the index's.
    return verdict === 'fts' ? 'corrupt' : verdict;
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    log(`[MemoryIntegrity] FTS rebuild failed: ${err}`);
    return 'corrupt';
  } finally {
    raw.close();
  }
}

// One transaction, so a stop never leaves the store without the table every memory write trigger updates.
function recreateFts(raw: RawDatabase): void {
  raw.exec('BEGIN IMMEDIATE');
  try {
    raw.exec('DROP TABLE memories_fts');
    raw.exec(CREATE_FTS_SQL);
    raw.exec(REBUILD_FTS);
    raw.exec('COMMIT');
  } catch (err) {
    if (raw.isTransaction) raw.exec('ROLLBACK');
    throw err;
  }
}

/**
 * One repair at a time across every Damocles app, through an SQLite lock the OS releases when its process ends.
 * Short waits in a loop let a stop from the host land between them; the host's request timeout bounds the loop.
 */
function holdRepairLock(dbPath: string): () => void {
  const lock = new DatabaseSync(`${dbPath}.repair-lock`, { timeout: 250 });
  for (;;) {
    try {
      lock.exec('BEGIN EXCLUSIVE');
      return () => {
        lock.exec('ROLLBACK');
        lock.close();
      };
    } catch (err) {
      if ((((err as { errcode?: number }).errcode ?? 0) & 0xff) !== SQLITE_BUSY) {
        lock.close();
        throw err;
      }
    }
  }
}

function readMarker(dbPath: string): RepairMarker | null {
  let text: string;
  try {
    text = fs.readFileSync(repairMarkerPath(dbPath), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const salvageFrom = (JSON.parse(text) as RepairMarker | null)?.salvageFrom;
    return typeof salvageFrom === 'string' ? { salvageFrom } : {};
  } catch {
    // The host writes its marker in place, so a stop can cut it short; it still asks for a repair.
    return {};
  }
}

// Replaced whole, so a stop never leaves a marker without the quarantined file's name.
function writeMarker(dbPath: string, marker: RepairMarker): void {
  const file = repairMarkerPath(dbPath);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(marker));
  fs.renameSync(`${file}.tmp`, file);
}

function quarantinedFile(dbPath: string, marker: RepairMarker): string | null {
  const name = marker.salvageFrom;
  const prefix = `${path.basename(dbPath)}.corrupt-`;
  if (name === undefined || !name.startsWith(prefix) || !/^\d+$/.test(name.slice(prefix.length))) return null;
  return path.join(path.dirname(dbPath), name);
}

function repair(dbPath: string): RepairOutcome {
  const release = holdRepairLock(dbPath);
  try {
    const marker = readMarker(dbPath);
    // Another app finished the repair while this one waited for the lock.
    if (!marker) return { kind: 'intact' };
    const outcome = repairMarked(dbPath, marker);
    if (outcome.kind === 'intact' || outcome.kind === 'salvaged') fs.rmSync(repairMarkerPath(dbPath), { force: true });
    return outcome;
  } finally {
    release();
  }
}

/**
 * Every step can be stopped and resumed by the next repair: the marker names the quarantined file before the
 * store moves, and a quarantined file the marker names always holds every row, since moving it is the first change.
 */
function repairMarked(dbPath: string, marker: RepairMarker): RepairOutcome {
  const pending = quarantinedFile(dbPath, marker);
  if (pending && fs.existsSync(pending)) return salvage(dbPath, pending);
  if (!fs.existsSync(dbPath)) return { kind: 'intact' };
  let verdict = check(dbPath);
  if (verdict === 'fts') verdict = rebuildFts(dbPath);
  if (verdict === 'ok') return { kind: 'intact' };
  if (verdict === 'ahead') return { kind: 'ahead' };
  const quarantinePath = `${dbPath}.corrupt-${Date.now()}`;
  log(`[Memory] Database at ${dbPath} is damaged; quarantining to ${quarantinePath}`);
  writeMarker(dbPath, { salvageFrom: path.basename(quarantinePath) });
  try {
    fs.renameSync(dbPath, quarantinePath);
  } catch (err) {
    log(`[Memory] Failed to quarantine the damaged database at ${dbPath}: ${err}`);
    return { kind: 'failed' };
  }
  return salvage(dbPath, quarantinePath);
}

function salvage(dbPath: string, quarantinePath: string): RepairOutcome {
  const restored = fs.existsSync(dbPath) ? mergeInto(dbPath, quarantinePath) : buildFrom(dbPath, quarantinePath);
  if (restored === null) return { kind: 'ahead' };
  log(`[Memory] Salvage recovered ${restored} memories from the quarantined database`);
  return { kind: 'salvaged', quarantinedFrom: quarantinePath, salvagedMemories: restored };
}

/** Copies into a new store beside the path and moves it there complete, so the path never holds a partial store. */
function buildFrom(dbPath: string, quarantinePath: string): number {
  // A new store at the path would replay a WAL the quarantined file left behind.
  for (const suffix of ['-wal', '-shm']) moveIfPresent(`${dbPath}${suffix}`, `${quarantinePath}${suffix}`);
  const building = `${dbPath}.salvage`;
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${building}${suffix}`, { force: true });
  const { db } = openAndMigrate(building);
  let restored: number;
  try {
    restored = copyDurableRows(quarantinePath, db);
    // Folds the WAL into the file, so the move takes the whole store.
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  fs.renameSync(building, dbPath);
  return restored;
}

/** A store at the path is one an earlier salvage moved there, or one another app opened meanwhile; rows it has stay. */
function mergeInto(dbPath: string, quarantinePath: string): number | null {
  const { db, readOnly } = openAndMigrate(dbPath);
  try {
    return readOnly ? null : copyDurableRows(quarantinePath, db);
  } finally {
    db.close();
  }
}

function moveIfPresent(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Runs one request on the calling thread; the worker entry below is its only production caller. */
export function runIntegrityRequest<T extends IntegrityRequest>(request: T): IntegrityResults[T['type']] {
  const start = performance.now();
  const result = request.type === 'check' ? check(request.dbPath) : request.type === 'rebuildFts' ? rebuildFts(request.dbPath) : repair(request.dbPath);
  log(formatPerfLine('memory.integrity', performance.now() - start, { op: request.type, result: typeof result === 'string' ? result : result.kind }));
  return result as IntegrityResults[T['type']];
}

// The marker keeps a test runner's own worker thread from running a request on import.
const data = workerData as Partial<MemoryIntegrityWorkerData> | null | undefined;
if (!isMainThread && parentPort && data?.marker === MEMORY_INTEGRITY_WORKER_MARKER && data.request) {
  const port = parentPort;
  const post = (event: IntegrityEvent): void => port.postMessage(event);
  installWorkerLogRelay((message) => post({ type: 'log', message }));
  try {
    post({ type: 'result', result: runIntegrityRequest(data.request) });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}
