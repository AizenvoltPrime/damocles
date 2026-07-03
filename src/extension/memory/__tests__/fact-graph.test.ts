import { describe, it, expect, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { createTestMemoryDb, assertContentHashInvariant } from './test-helpers';
import { FactGraphManager } from '../managers/fact-graph-manager';
import { MemoryWriteQueue } from '../write-queue';
import { deleteMemoriesWithHygiene } from '../dedup-decay';
import { normalizedContentHash } from '../types';
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
    `INSERT INTO memories (id, kind, scope, content, content_hash, version, is_latest, parent_id, root_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    id,
    kind,
    scope,
    opts.content,
    normalizedContentHash(opts.content),
    version,
    opts.parentId ?? null,
    opts.rootId ?? id,
    opts.createdAt,
    opts.createdAt,
  );
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

/** Mock runner that always judges a contradiction. */
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

describe('FactGraphManager.editAsNewVersion (Slice 5 — version-chain edits + hash integrity)', () => {
  let db: DatabaseInstance;
  let manager: FactGraphManager;

  beforeEach(async () => {
    db = await createTestMemoryDb();
    // editAsNewVersion never invokes the runner (no LLM step); reuse the shared stub.
    manager = new FactGraphManager(db, new MemoryWriteQueue(db), contradictingRunner);
  });

  /** Live fact row with tags/title/pinned/source_count so CARRY is observable. */
  function seedFact(
    db: DatabaseInstance,
    opts: {
      content: string;
      tags?: string[];
      title?: string | null;
      pinned?: number;
      sourceCount?: number;
      version?: number;
      kind?: string;
      createdAt?: number;
    },
  ): MemoryRow {
    const id = crypto.randomUUID();
    const createdAt = opts.createdAt ?? 1000;
    db.prepare(
      `INSERT INTO memories (
         id, kind, scope, content, content_hash, title, tags,
         version, is_latest, root_id, source_count, pinned, created_at, updated_at
       ) VALUES (?, ?, 'project', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.kind ?? 'fact',
      opts.content,
      normalizedContentHash(opts.content),
      opts.title ?? null,
      JSON.stringify(opts.tags ?? []),
      opts.version ?? 1,
      id,
      opts.sourceCount ?? 1,
      opts.pinned ?? 0,
      createdAt,
      createdAt,
    );
    return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow;
  }

  it('inserts a new version row, demotes the old, and carries source_count/pinned/title', async () => {
    const old = seedFact(db, {
      content: 'The primary database is Postgres',
      tags: ['db', 'infra'],
      title: 'Primary DB',
      pinned: 1,
      sourceCount: 4,
      version: 2,
    });

    const newId = await manager.editAsNewVersion(old, 'The primary database is MySQL', undefined);

    expect(newId).not.toBe(old.id);
    const created = getRow(db, newId);
    const demoted = getRow(db, old.id);

    // New row is the live head of the chain.
    expect(created.is_latest).toBe(1);
    expect(created.version).toBe(old.version + 1);
    expect(created.parent_id).toBe(old.id);
    expect(created.root_id).toBe(old.root_id);
    expect(created.content).toBe('The primary database is MySQL');

    expect(created.content_hash).toBe(normalizedContentHash('The primary database is MySQL'));

    // CARRY: source_count, pin state, and title persist across the rewording.
    expect(created.source_count).toBe(old.source_count);
    expect(created.pinned).toBe(old.pinned);
    expect(created.title).toBe(old.title);

    // Old row demoted, not deleted.
    expect(demoted.is_latest).toBe(0);
    expect(demoted.content).toBe('The primary database is Postgres');

    expect(assertContentHashInvariant(db)).toEqual([]);
  });

  it('records an UPDATES edge new→old and exposes both in getVersionHistory (root→latest)', async () => {
    const old = seedFact(db, { content: 'The deploy target is staging', version: 1 });

    const newId = await manager.editAsNewVersion(old, 'The deploy target is production', undefined);

    // Edge direction matches resolveConflict: source=new, target=old.
    expect(countUpdatesEdges(db, newId, old.id)).toBe(1);
    expect(countUpdatesEdges(db, old.id, newId)).toBe(0);

    const history = manager.getVersionHistory(newId).map(r => r.id);
    expect(history).toEqual([old.id, newId]);
  });

  it('preserves the old tags when tags is undefined', async () => {
    const old = seedFact(db, { content: 'The cache TTL is 60 seconds', tags: ['cache', 'ttl'] });

    const newId = await manager.editAsNewVersion(old, 'The cache TTL is 120 seconds', undefined);

    const created = getRow(db, newId);
    expect(JSON.parse(created.tags)).toEqual(['cache', 'ttl']);
    expect(created.tags).toBe(old.tags); // byte-identical: old serialized JSON reused
    expect(assertContentHashInvariant(db)).toEqual([]);
  });

  it('replaces the tags when a new tags array (including empty) is provided', async () => {
    const old = seedFact(db, { content: 'The log level defaults to warn', tags: ['logging'] });

    const replacedId = await manager.editAsNewVersion(old, 'The log level defaults to info', ['level', 'info']);
    expect(JSON.parse(getRow(db, replacedId).tags)).toEqual(['level', 'info']);

    const clearedId = await manager.editAsNewVersion(getRow(db, replacedId), 'The log level defaults to debug', []);
    expect(JSON.parse(getRow(db, clearedId).tags)).toEqual([]);

    expect(assertContentHashInvariant(db)).toEqual([]);
  });

  it('lets a later exact-dedup of the EDITED wording key on the recomputed hash (chained edits)', async () => {
    const old = seedFact(db, { content: 'The API timeout is 30 seconds', sourceCount: 1 });

    const newId = await manager.editAsNewVersion(old, 'The API timeout is 45 seconds', undefined);
    const created = getRow(db, newId);

    // The stored hash equals the canonical hash of a whitespace/case variant of the edited wording —
    // the exact-dedup key now matches the live content.
    expect(created.content_hash).toBe(normalizedContentHash('  the   API   Timeout   is 45 SECONDS '));

    const oldWordingHash = normalizedContentHash('The API timeout is 30 seconds');
    expect(created.content_hash).not.toBe(oldWordingHash);

    expect(assertContentHashInvariant(db)).toEqual([]);
  });

  it('is atomic — a version chain built by repeated edits keeps exactly one is_latest head', async () => {
    let row = seedFact(db, { content: 'v1 content of the fact', version: 1 });
    const rootId = row.id;

    for (let i = 2; i <= 4; i++) {
      const nextId = await manager.editAsNewVersion(row, `v${i} content of the fact`, undefined);
      row = getRow(db, nextId);
      expect(row.version).toBe(i);
      expect(row.root_id).toBe(rootId);
    }

    const latest = db
      .prepare('SELECT id FROM memories WHERE root_id = ? AND is_latest = 1')
      .all(rootId) as { id: string }[];
    expect(latest.length).toBe(1);
    expect(latest[0]!.id).toBe(row.id);

    const history = manager.getVersionHistory(row.id).map(r => r.content);
    expect(history).toEqual([
      'v1 content of the fact',
      'v2 content of the fact',
      'v3 content of the fact',
      'v4 content of the fact',
    ]);

    expect(assertContentHashInvariant(db)).toEqual([]);
  });
});

describe('deleteMemoriesWithHygiene (Slice 6 — delete hygiene + parent promotion)', () => {
  let db: DatabaseInstance;
  let manager: FactGraphManager;

  beforeEach(async () => {
    db = await createTestMemoryDb();
    manager = new FactGraphManager(db, new MemoryWriteQueue(db), contradictingRunner);
  });

  /** Edges (either direction) still referencing `id` as source_id OR target_id. */
  function incidentEdgeCount(db: DatabaseInstance, id: string): number {
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM memory_edges WHERE source_id = ? OR target_id = ?')
      .get(id, id) as { c: number };
    return row.c;
  }

  function memoryExists(db: DatabaseInstance, id: string): boolean {
    return (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE id = ?').get(id) as { c: number }).c > 0;
  }

  /**
   * Mirrors index.ts `deleteMemory`'s atomic callback: promote the parent to is_latest=1 when
   * deleting a live chain head, then run the shared hygiene helper — all in one transaction. Tests
   * the pattern at the DB level without importing index.ts.
   */
  function deleteHeadWithPromotion(db: DatabaseInstance, id: string): void {
    db.transaction(() => {
      const row = db.prepare('SELECT id, parent_id, is_latest FROM memories WHERE id = ?').get(id) as
        | { id: string; parent_id: string | null; is_latest: number }
        | undefined;
      if (!row) return;
      if (row.is_latest === 1 && row.parent_id) {
        db.prepare('UPDATE memories SET is_latest = 1 WHERE id = ?').run(row.parent_id);
      }
      deleteMemoriesWithHygiene(db, [id]);
    });
  }

  it('deleting a superseding head removes all incident edges AND promotes the parent to is_latest=1', async () => {
    // A contradiction builds a two-version chain: b supersedes a → b is the head (parent_id=a) with
    // an UPDATES edge b→a.
    const a = seedMemory(db, { content: 'The build command is npm run build', createdAt: 1000 });
    const b = seedMemory(db, { content: 'The build command is npm run compile', createdAt: 1001 });
    await manager.resolveConflict(b);

    expect(getRow(db, b.id).is_latest).toBe(1);
    expect(getRow(db, b.id).parent_id).toBe(a.id);
    expect(countUpdatesEdges(db, b.id, a.id)).toBe(1);
    expect(incidentEdgeCount(db, b.id)).toBe(1);

    deleteHeadWithPromotion(db, b.id);

    // b gone, zero edges reference it.
    expect(memoryExists(db, b.id)).toBe(false);
    expect(incidentEdgeCount(db, b.id)).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM memory_edges WHERE source_id = ? OR target_id = ?').get(b.id, b.id) as { c: number }).c,
    ).toBe(0);

    // Parent promoted so the chain stays reachable.
    expect(getRow(db, a.id).is_latest).toBe(1);

    // History of the promoted parent is just [a], no dangling reference to b.
    const history = manager.getVersionHistory(a.id);
    expect(history.map(r => r.id)).toEqual([a.id]);
  });

  it('deleting a mid-chain non-head row removes its incident edges without changing any head', async () => {
    // A three-version chain a → b → c via repeated edits. c is the head; b is mid-chain.
    const a = seedMemory(db, { content: 'The cache TTL is 30 seconds', createdAt: 1000 });
    const bId = await manager.editAsNewVersion(getRow(db, a.id), 'The cache TTL is 60 seconds', undefined);
    const cId = await manager.editAsNewVersion(getRow(db, bId), 'The cache TTL is 120 seconds', undefined);

    // b is mid-chain (is_latest=0) with incident edges both sides: UPDATES b→a and UPDATES c→b.
    expect(getRow(db, cId).is_latest).toBe(1);
    expect(getRow(db, bId).is_latest).toBe(0);
    expect(countUpdatesEdges(db, bId, a.id)).toBe(1);
    expect(countUpdatesEdges(db, cId, bId)).toBe(1);
    expect(incidentEdgeCount(db, bId)).toBe(2);

    // b is not a head → no promotion; just hygiene delete in one transaction.
    db.transaction(() => deleteMemoriesWithHygiene(db, [bId]));

    // b and its incident edges (both directions) are gone.
    expect(memoryExists(db, bId)).toBe(false);
    expect(incidentEdgeCount(db, bId)).toBe(0);

    // Head untouched — still exactly one head in the chain.
    expect(getRow(db, cId).is_latest).toBe(1);
    const heads = db
      .prepare('SELECT id FROM memories WHERE root_id = ? AND is_latest = 1')
      .all(getRow(db, cId).root_id) as { id: string }[];
    expect(heads.map(h => h.id)).toEqual([cId]);
  });

  it('is a no-op on an empty id list (no malformed IN () query)', () => {
    expect(() => db.transaction(() => deleteMemoriesWithHygiene(db, []))).not.toThrow();
  });
});
