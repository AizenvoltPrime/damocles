import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { onTestFinished } from 'vitest';
import { createDatabaseWrapper, runMigrations } from '../database';
import { normalizedContentHash } from '../types';
import type { DatabaseInstance } from '../types';

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Path for a test's SQLite file in a fresh temp dir, removed when the current test finishes (after
 * `afterEach`). Call from a test or `beforeEach`. Whatever opened the file must be closed by then.
 */
export function createTestDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-memory-test-'));
  onTestFinished(() => removeDir(dir));
  return path.join(dir, 'memory.db');
}

/**
 * Fresh, fully-migrated memory DB on a unique temp file, using production's engine/wrapper/migrations.
 * Not `:memory:`, so cross-connection tests can reopen the same path. Closed and removed when the
 * current test finishes; call from a test or `beforeEach`.
 */
export async function createTestMemoryDb(): Promise<DatabaseInstance> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-memory-test-'));
  const raw = new DatabaseSync(path.join(dir, 'memory.db'), { timeout: 5000, enableForeignKeyConstraints: true });
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA foreign_keys = ON');
  const db = createDatabaseWrapper(raw);
  onTestFinished(() => {
    db.close();
    removeDir(dir);
  });
  runMigrations(db);
  return db;
}

/**
 * Content-hash integrity invariant: every content-bearing `memories` row must store
 * `content_hash === normalizedContentHash(content)`, else the exact-dedup key goes stale (a later
 * re-extraction of the old wording falsely strengthens the row while the new wording re-inserts a dup).
 *
 * Returns the ids whose stored hash disagrees with their current content; empty means the invariant
 * holds. Reuses production's {@link normalizedContentHash} so the test can't drift from the dedup key.
 * Rows with an empty `content_hash` (raw-seeded without one) are skipped.
 */
export function assertContentHashInvariant(db: DatabaseInstance): string[] {
  const rows = db
    .prepare("SELECT id, content, content_hash FROM memories WHERE content_hash != ''")
    .all() as Array<{ id: string; content: string; content_hash: string }>;
  return rows
    .filter((r) => r.content_hash !== normalizedContentHash(r.content))
    .map((r) => r.id);
}

/** The query and numbered candidates of a listwise rerank prompt; the candidates' JSON holds no raw newline, so the last marker is theirs. */
export function rerankPrompt(prompt: string): { query: string; candidates: Array<{ n: number; title: string | null; snippet: string }> } {
  const marker = '\n\nCandidates:\n';
  const at = prompt.lastIndexOf(marker);
  return {
    query: prompt.slice('Query: '.length, at),
    candidates: JSON.parse(prompt.slice(at + marker.length)) as Array<{ n: number; title: string | null; snippet: string }>,
  };
}

/** The numbered candidates of a listwise rerank prompt. */
export function rerankCandidates(prompt: string): Array<{ n: number; title: string | null; snippet: string }> {
  return rerankPrompt(prompt).candidates;
}

/** The listwise rerank's answer to `prompt`, grading each numbered candidate by its snippet; `low` leaves it unlisted. */
export function listwiseAnswer(
  prompt: string,
  gradeOf: (snippet: string) => 'high' | 'medium' | 'low',
): { direct: number[]; partial: number[] } {
  const items = rerankCandidates(prompt);
  return {
    direct: items.filter((item) => gradeOf(item.snippet) === 'high').map((item) => item.n),
    partial: items.filter((item) => gradeOf(item.snippet) === 'medium').map((item) => item.n),
  };
}
