import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { initSqlEngineAsync, getSqlEngine, createDatabaseWrapper, runMigrations } from '../database';
import type { DatabaseInstance } from '../types';

/**
 * Open a fresh, fully-migrated memory database backed by a unique temp file,
 * for unit/integration tests. Reuses the production engine init, wrapper, and
 * migration runner so tests exercise the real schema. Each call is isolated.
 */
export async function createTestMemoryDb(): Promise<DatabaseInstance> {
  await initSqlEngineAsync(process.cwd());
  const engine = getSqlEngine();
  if (!engine) throw new Error('SQL engine failed to initialize for tests');
  const sqlDb = new engine.Database();
  const dbPath = path.join(os.tmpdir(), `damocles-memory-test-${crypto.randomUUID()}.db`);
  const db = createDatabaseWrapper(sqlDb, dbPath);
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
