import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { normalizedContentHash } from '../types';
import type { DatabaseInstance } from '../types';

const dbHolder = vi.hoisted(() => ({ path: '' }));

vi.mock('../database', async (importActual) => {
  const actual = await importActual<typeof import('../database')>();
  return {
    ...actual,
    openDatabaseAsync: vi.fn(async () => {
      const raw = new DatabaseSync(dbHolder.path, { timeout: 5000, enableForeignKeyConstraints: true });
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA foreign_keys = ON');
      const db = actual.createDatabaseWrapper(raw);
      actual.runMigrations(db);
      return { db };
    }),
  };
});

vi.mock('../subcall-runner', () => ({
  createMemorySubCallRunner: () => ({ run: vi.fn(async () => ({ value: null, failure: 'no-model' as const })) }),
}));

// The backfill drives expandMemoryTermsWithStatus; control it per test.
const expansion = vi.hoisted(() => ({
  impl: async (_e: unknown): Promise<{ terms: string[]; failed: boolean }> => ({ terms: ['t'], failed: false }),
}));
vi.mock('../query-expansion', () => ({
  expandMemoryTerms: vi.fn(async () => ['t']),
  expandMemoryTermsWithStatus: vi.fn((e: unknown) => expansion.impl(e)),
  clearExpansionCache: vi.fn(),
  expandQuery: vi.fn(async () => []),
}));

import { MemoryService } from '../index';

function seedUnexpanded(db: DatabaseInstance, id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, search_terms, workspace, created_at, updated_at)
     VALUES (?, 'fact', 'project', ?, ?, ?, '[]', '/ws', ?, ?)`,
  ).run(id, `content ${id}`, normalizedContentHash(`content ${id}`), id, now, now);
}

function searchTerms(db: DatabaseInstance, id: string): string {
  return (db.prepare('SELECT search_terms FROM memories WHERE id = ?').get(id) as { search_terms: string }).search_terms;
}

describe('MemoryService search-term backfill (R12)', () => {
  let service: MemoryService;

  beforeEach(() => {
    dbHolder.path = path.join(os.tmpdir(), `damocles-backfill-${crypto.randomUUID()}.db`);
    expansion.impl = async () => ({ terms: ['syn'], failed: false });
    service = new MemoryService('/ext');
  });

  afterEach(() => {
    service.dispose();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbHolder.path + suffix); } catch { /* gone */ }
    }
  });

  it('drains the whole backlog in one launch (well past the old 100 cap)', async () => {
    await service.ensureInitialized();
    const db = service.database!;
    const ids = Array.from({ length: 250 }, () => crypto.randomUUID());
    for (const id of ids) seedUnexpanded(db, id);

    await (service as unknown as { runBackfill: (db: DatabaseInstance, s: AbortSignal, d?: number) => Promise<void> })
      .runBackfill(db, new AbortController().signal, 0);

    const remaining = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE search_terms = '[]'").get() as { n: number };
    expect(remaining.n).toBe(0);
    expect(searchTerms(db, ids[0]!)).toBe('["syn"]');
  }, 30000);

  it('CAS: a live edit during expansion is not overwritten with stale terms', async () => {
    await service.ensureInitialized();
    const db = service.database!;
    const id = crypto.randomUUID();
    seedUnexpanded(db, id);

    // While expanding, simulate a concurrent live edit that bumps updated_at (and sets real terms).
    expansion.impl = async () => {
      db.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?')
        .run('edited', Date.now() + 1000, id);
      db.prepare("UPDATE memories SET search_terms = '[\"live\"]' WHERE id = ?").run(id);
      return { terms: ['stale'], failed: false };
    };

    await (service as unknown as { runBackfill: (db: DatabaseInstance, s: AbortSignal, d?: number) => Promise<void> })
      .runBackfill(db, new AbortController().signal, 0);

    // The live edit's terms survive; the stale backfill terms did not overwrite them.
    expect(searchTerms(db, id)).toBe('["live"]');
  });

  it('circuit breaker stops after 3 consecutive all-failed batches', async () => {
    await service.ensureInitialized();
    const db = service.database!;
    const ids = Array.from({ length: 50 }, () => crypto.randomUUID());
    for (const id of ids) seedUnexpanded(db, id);

    expansion.impl = async () => ({ terms: [], failed: true });
    const mock = (await import('../query-expansion')).expandMemoryTermsWithStatus as ReturnType<typeof vi.fn>;
    mock.mockClear();

    await (service as unknown as { runBackfill: (db: DatabaseInstance, s: AbortSignal, d?: number) => Promise<void> })
      .runBackfill(db, new AbortController().signal, 0);

    // 3 failed batches of ≤5 → at most 15 expansion calls before the breaker trips; far fewer than 50.
    expect(mock.mock.calls.length).toBeLessThanOrEqual(15);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE search_terms = '[]'").get() as { n: number };
    expect(remaining.n).toBeGreaterThan(0);
  });

  it('aborting the signal stops the loop promptly', async () => {
    await service.ensureInitialized();
    const db = service.database!;
    for (let i = 0; i < 20; i++) seedUnexpanded(db, crypto.randomUUID());

    const ac = new AbortController();
    ac.abort();
    await (service as unknown as { runBackfill: (db: DatabaseInstance, s: AbortSignal, d?: number) => Promise<void> })
      .runBackfill(db, ac.signal, 0);

    const remaining = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE search_terms = '[]'").get() as { n: number };
    expect(remaining.n).toBe(20);
  });
});
