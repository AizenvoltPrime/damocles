import { describe, it, expect, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { createTestMemoryDb } from './test-helpers';
import { FactGraphManager } from '../managers/fact-graph-manager';
import { MemoryWriteQueue } from '../write-queue';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemorySubCallRequest, MemorySubCallResult, MemorySubCallRunner } from '../subcall-runner';

interface SeedOpts {
  id?: string;
  content: string;
  scope?: string;
  kind?: string;
  createdAt: number;
  version?: number;
  parentId?: string | null;
  rootId?: string | null;
}

function seedMemory(db: DatabaseInstance, opts: SeedOpts): MemoryRow {
  const id = opts.id ?? crypto.randomUUID();
  const scope = opts.scope ?? 'project';
  const kind = opts.kind ?? 'fact';
  const version = opts.version ?? 1;
  db.prepare(
    `INSERT INTO memories (id, kind, scope, content, version, is_latest, parent_id, root_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(id, kind, scope, opts.content, version, opts.parentId ?? null, opts.rootId ?? id, opts.createdAt, opts.createdAt);
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow;
}

function getRow(db: DatabaseInstance, id: string): MemoryRow {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow;
}

function countEdges(db: DatabaseInstance, kind: string, sourceId: string, targetId: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM memory_edges WHERE kind = ? AND source_id = ? AND target_id = ?',
  ).get(kind, sourceId, targetId) as { c: number };
  return row.c;
}

function countUpdatesEdges(db: DatabaseInstance, sourceId: string, targetId: string): number {
  return countEdges(db, 'UPDATES', sourceId, targetId);
}

/** Mock runner that always judges a candidate a contradiction. */
const contradictingRunner: MemorySubCallRunner = {
  async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
    return { value: { contradicts: true } as T };
  },
};

describe('FactGraphManager', () => {
  let db: DatabaseInstance;
  let manager: FactGraphManager;

  beforeEach(async () => {
    db = await createTestMemoryDb();
    manager = new FactGraphManager(db, new MemoryWriteQueue(), contradictingRunner);
  });

  it('supersedes a strictly-older contradicting fact idempotently', async () => {
    const a = seedMemory(db, { content: 'The build command is npm run build', createdAt: 1000 });
    const b = seedMemory(db, { content: 'The build command is npm run compile', createdAt: 1001 });

    const first = await manager.resolveConflict(b);
    expect(first.superseded).toEqual([a.id]);

    expect(countUpdatesEdges(db, b.id, a.id)).toBe(1);
    expect(getRow(db, a.id).is_latest).toBe(0);

    const bAfter = getRow(db, b.id);
    expect(bAfter.is_latest).toBe(1);
    expect(bAfter.version).toBe(2);
    expect(bAfter.parent_id).toBe(a.id);
    expect(bAfter.root_id).toBe(a.root_id);

    const second = await manager.resolveConflict(getRow(db, b.id));
    expect(second.superseded).toEqual([]);
    expect(countUpdatesEdges(db, b.id, a.id)).toBe(1);
    expect(getRow(db, b.id).version).toBe(2);
    expect(getRow(db, a.id).is_latest).toBe(0);
  });

  it('folds into one canonical lineage when contradicting facts from distinct roots', async () => {
    const a = seedMemory(db, { content: 'The primary database is Postgres', createdAt: 1000, version: 3 });
    const b = seedMemory(db, { content: 'The primary database is MySQL', createdAt: 1500, version: 1 });
    const c = seedMemory(db, { content: 'The primary database is SQLite', createdAt: 2000 });

    const result = await manager.resolveConflict(c);

    expect(result.superseded).toEqual([a.id, b.id]);

    const cAfter = getRow(db, c.id);
    expect(cAfter.is_latest).toBe(1);
    expect(getRow(db, a.id).is_latest).toBe(0);
    expect(getRow(db, b.id).is_latest).toBe(0);

    expect(cAfter.root_id).toBe(a.id);
    expect(cAfter.parent_id).toBe(a.id);
    expect(cAfter.version).toBe(4);

    expect(countEdges(db, 'UPDATES', c.id, a.id)).toBe(1);
    expect(countEdges(db, 'SUPERSEDES', c.id, b.id)).toBe(1);

    const historyIds = manager.getVersionHistory(c.id).map(r => r.id);
    expect(historyIds).toContain(a.id);
    expect(historyIds).toContain(c.id);

    const relatedIds = manager.getRelated(c.id, ['SUPERSEDES'], 2).map(r => r.id);
    expect(relatedIds).toContain(b.id);
  });

  it('hides the superseded fact from latest-only FTS retrieval (leak test)', async () => {
    const a = seedMemory(db, { content: 'The build command is npm run build', createdAt: 1000 });
    const b = seedMemory(db, { content: 'The build command is npm run compile', createdAt: 1001 });

    await manager.resolveConflict(b);

    const matches = db.prepare(
      `SELECT m.id FROM memories_fts fts
         JOIN memories m ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
          AND m.is_latest = 1 AND m.forgotten = 0`,
    ).all('"build"') as { id: string }[];

    const ids = matches.map(r => r.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
  });

  it('does not supersede when the new fact is older than the existing latest', async () => {
    const newer = seedMemory(db, { content: 'The deploy target is production', createdAt: 2000 });
    const older = seedMemory(db, { content: 'The deploy target is staging', createdAt: 1000 });

    const result = await manager.resolveConflict(older);

    expect(result.superseded).toEqual([]);
    expect(countUpdatesEdges(db, older.id, newer.id)).toBe(0);
    expect(getRow(db, newer.id).is_latest).toBe(1);
    expect(getRow(db, older.id).is_latest).toBe(1);
    expect(getRow(db, older.id).version).toBe(1);
  });

  it('terminates and de-duplicates over cyclic edges (getRelated)', () => {
    const a = seedMemory(db, { content: 'alpha node content', createdAt: 1000 });
    const b = seedMemory(db, { content: 'beta node content', createdAt: 1001 });

    manager.addEdge('EXTENDS', a.id, b.id);
    manager.addEdge('EXTENDS', b.id, a.id);

    const related = manager.getRelated(a.id, ['EXTENDS'], 5);
    expect(related.map(r => r.id)).toEqual([b.id]);
  });

  it('terminates over a parent_id cycle (getVersionHistory)', () => {
    const a = seedMemory(db, { content: 'alpha version content', createdAt: 1000 });
    const b = seedMemory(db, { content: 'beta version content', createdAt: 1001, parentId: a.id, rootId: a.id });
    db.prepare('UPDATE memories SET parent_id = ? WHERE id = ?').run(b.id, a.id);

    const history = manager.getVersionHistory(b.id);
    const ids = history.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids.length).toBe(2);
  });
});
