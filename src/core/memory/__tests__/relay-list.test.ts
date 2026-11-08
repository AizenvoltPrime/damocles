import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

const dbHolder = vi.hoisted(() => ({ path: '' }));

vi.mock('../database', async (importActual) => {
  const actual = await importActual<typeof import('../database')>();
  return {
    ...actual,
    openDatabaseAsync: vi.fn(async () => {
      const raw = new DatabaseSync(dbHolder.path, { timeout: 5000, enableForeignKeyConstraints: true });
      raw.exec('PRAGMA journal_mode = WAL');
      const db = actual.createDatabaseWrapper(raw);
      actual.runMigrations(db);
      return { db };
    }),
  };
});

vi.mock('../subcall-runner', () => ({
  createMemorySubCallRunner: () => ({ run: vi.fn(async () => ({ value: null, failure: 'no-model' as const })) }),
  describeMemorySubCallModel: () => null,
}));

import { MemoryService } from '../index';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { installPlatform } from '../../platform-host';
import { createTestDbPath } from './test-helpers';
import { globalMemoryId } from '../global-memory-relay';
import { CLIENT_MEMORY_OFF, listedAfter, MAX_GLOBAL_MEMORY_LIST_BYTES, MAX_RELAYED_MEMORIES, type GlobalMemoryListPage, type GlobalMemoryListRequest } from '../../../shared/remote-user';
import type { DatabaseInstance } from '../types';

// This computer's core answering a remote core's user.memory.list, and the user-scope reads a remote chat's page makes of it.
let service: MemoryService;
let db: DatabaseInstance;
let platform: ReturnType<typeof createFakePlatform>;

interface Seed {
  readonly id: string;
  readonly kind?: string;
  readonly scope?: string;
  readonly createdAt: number;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly forgotten?: boolean;
  readonly latest?: boolean;
  readonly rootId?: string;
}

function seed(row: Seed): void {
  const content = row.content ?? `content of ${row.id}`;
  db.prepare(
    `INSERT INTO memories (id, kind, scope, content, content_hash, workspace, is_latest, forgotten, root_id, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.kind ?? 'note', row.scope ?? 'global', content, `hash-${row.id}`, row.scope === 'project' ? '/repo' : null, row.latest === false ? 0 : 1, row.forgotten ? 1 : 0, row.rootId ?? row.id, JSON.stringify(row.tags ?? []), row.createdAt, row.createdAt);
}

/** Every page from the start, each row strictly after the cursor and the row before it, and next the last row's key. */
async function listAll(request: Omit<GlobalMemoryListRequest, 'cursor'>): Promise<GlobalMemoryListPage[]> {
  const pages: GlobalMemoryListPage[] = [];
  let cursor = undefined as GlobalMemoryListRequest['cursor'];
  for (;;) {
    const asked = { ...request, ...(cursor ? { cursor } : {}) };
    const page = await service.relayList(asked);
    page.rows.reduce((previous, row) => {
      if (previous) expect(listedAfter(row, previous)).toBe(true);
      return row;
    }, cursor as GlobalMemoryListRequest['cursor']);
    if (page.next) expect(page.next).toEqual({ createdAt: page.rows.at(-1)!.createdAt, id: page.rows.at(-1)!.id });
    pages.push(page);
    if (!page.next) return pages;
    cursor = page.next;
  }
}

beforeEach(async () => {
  dbHolder.path = createTestDbPath();
  platform = createFakePlatform();
  installPlatform(platform);
  service = new MemoryService(platform);
  await service.ensureInitialized();
  db = service.database!;
});

afterEach(async () => {
  await service.dispose();
});

describe("this computer's user.memory.list", () => {
  it('lists only latest global rows of the kinds asked, forgotten ones included, created_at DESC then id DESC', async () => {
    seed({ id: 'n1', createdAt: 10 });
    seed({ id: 'n2', createdAt: 20, forgotten: true });
    seed({ id: 'n3', createdAt: 20 });
    seed({ id: 'old', createdAt: 30, latest: false });
    seed({ id: 'fact', kind: 'fact', createdAt: 40 });
    seed({ id: 'project-note', kind: 'note', scope: 'project', createdAt: 50 });
    const [page] = await listAll({ kinds: ['note'] });
    expect(page!.rows.map((row) => [row.id, row.forgotten ?? false])).toEqual([['n3', false], ['n2', true], ['n1', false]]);
    expect(page!.next).toBeUndefined();
  });

  it('matches the local notes list, tag rule and order alike', async () => {
    seed({ id: 'a', createdAt: 5, tags: ['Work'] });
    seed({ id: 'b', createdAt: 5, tags: ['home'] });
    seed({ id: 'c', createdAt: 7, tags: ['work', 'home'], forgotten: true });
    // its tags JSON holds "work" only inside another tag's text
    seed({ id: 'd', createdAt: 9, tags: ['a","work'] });
    const relayed = (await service.relayList({ kinds: ['note'], tags: ['work'] })).rows.map((row) => row.id);
    expect(relayed).toEqual(['c', 'a']);
    expect((await service.listNotes(['work'])).map((note) => note.id)).toEqual(relayed);
    expect((await service.relayList({ kinds: ['note'] })).rows.map((row) => row.id)).toEqual((await service.listNotes()).map((note) => note.id));
  });

  it('pages notes in the order an index gives, never sorting every global row', () => {
    const plan = (db.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM memories WHERE scope = 'global' AND is_latest = 1 AND kind IN (?) ORDER BY created_at DESC, id DESC LIMIT ?",
    ).all('note', 51) as Array<{ detail: string }>).map((step) => step.detail).join('\n');
    expect(plan).toContain('idx_memories_global_listing');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it("refuses an agent's list and search with CLIENT_MEMORY_OFF while memory is off here, and answers the automatic reads empty", async () => {
    seed({ id: 'n1', createdAt: 1 });
    seed({ id: 'p1', kind: 'preference', createdAt: 2 });
    await service.setProfileSection('global', '', 'static', 'likes tea');
    expect((await service.relayList({ kinds: ['note'] })).rows).toHaveLength(1);
    expect((await service.relayProfile()).preferences).toHaveLength(1);
    await platform.settings.update('damocles.memory.enabled', false, 'user');
    await expect(service.relayList({ kinds: ['note'] })).rejects.toThrow(CLIENT_MEMORY_OFF);
    await expect(service.relaySearch('content', 5, ['note'])).rejects.toThrow(CLIENT_MEMORY_OFF);
    expect(await service.relaySearch('content', 5, ['global'], true)).toEqual([]);
    expect(await service.relayResolve(['n1'])).toEqual([]);
    expect(await service.relayProfile()).toEqual({ profile: { static: '', dynamic: '' }, pinned: [], preferences: [] });
  });

  it('puts the tag a row was listed by inside the tag bound', async () => {
    seed({ id: 'many', createdAt: 1, tags: [...Array.from({ length: 70 }, (_, index) => `t${index}`), 'wanted'] });
    const [row] = (await service.relayList({ kinds: ['note'], tags: ['wanted'] })).rows;
    expect(row!.tags![0]).toBe('wanted');
    expect(row!.tags).toHaveLength(64);
  });

  it('pages at MAX_RELAYED_MEMORIES rows by keyset, each page strictly below the cursor', async () => {
    for (let index = 0; index < MAX_RELAYED_MEMORIES * 2 + 3; index++) seed({ id: `n${String(index).padStart(3, '0')}`, createdAt: Math.floor(index / 4) });
    const pages = await listAll({ kinds: ['note'] });
    expect(pages.map((page) => page.rows.length)).toEqual([MAX_RELAYED_MEMORIES, MAX_RELAYED_MEMORIES, 3]);
    const ids = pages.flatMap((page) => page.rows.map((row) => row.id));
    expect(new Set(ids).size).toBe(MAX_RELAYED_MEMORIES * 2 + 3);
    expect(pages[0]!.next).toEqual({ createdAt: pages[0]!.rows.at(-1)!.createdAt, id: pages[0]!.rows.at(-1)!.id });
  });

  it('keeps a page within the byte budget, sends a larger first row alone, and returns no next when nothing remains', async () => {
    const big = 'x'.repeat(Math.floor(MAX_GLOBAL_MEMORY_LIST_BYTES * 0.6));
    seed({ id: 'n1', createdAt: 3, content: big });
    seed({ id: 'n2', createdAt: 2, content: big });
    seed({ id: 'n3', createdAt: 1, content: 'small' });
    const pages = await listAll({ kinds: ['note'] });
    expect(pages.map((page) => page.rows.map((row) => row.id))).toEqual([['n1'], ['n2', 'n3']]);
    db.prepare("UPDATE memories SET content = ? WHERE id = 'n1'").run('y'.repeat(MAX_GLOBAL_MEMORY_LIST_BYTES + 10));
    expect((await service.relayList({ kinds: ['note'] })).rows.map((row) => row.id)).toEqual(['n1']);
  });
});

describe("this computer's user-scope reads for a remote chat's page", () => {
  it('lists the panel rows of global scope only', () => {
    seed({ id: 'note', createdAt: 1 });
    seed({ id: 'fact', kind: 'fact', createdAt: 2, forgotten: true });
    seed({ id: 'project', kind: 'fact', scope: 'project', createdAt: 3 });
    seed({ id: 'superseded', kind: 'fact', createdAt: 4, latest: false });
    expect(service.userScopeMemories().map((entry) => entry.id).sort()).toEqual(['fact', 'note']);
  });

  it('names only a global row of this store, never a project row, a relayed id or an unknown one', () => {
    seed({ id: 'note', createdAt: 1 });
    seed({ id: 'project', kind: 'fact', scope: 'project', createdAt: 2 });
    // a remote core's write keeps its uuid as the row id, so a global row of this store may carry a relayed id's form
    seed({ id: globalMemoryId('client-a', 'g1'), createdAt: 3 });
    expect(service.isUserScopeRow('note')).toBe(true);
    expect(service.isUserScopeRow('project')).toBe(false);
    expect(service.isUserScopeRow(globalMemoryId('client-a', 'note'))).toBe(false);
    expect(service.isUserScopeRow(globalMemoryId('client-a', 'g1'))).toBe(false);
    expect(service.isUserScopeRow('missing')).toBe(false);
  });

  it('answers a global row\'s history with its global versions only', () => {
    seed({ id: 'v1', kind: 'fact', createdAt: 1, latest: false, rootId: 'v1' });
    seed({ id: 'v2', kind: 'fact', createdAt: 2, rootId: 'v1' });
    db.prepare("UPDATE memories SET parent_id = 'v1', version = 2 WHERE id = 'v2'").run();
    expect(service.userScopeHistory('v2').map((entry) => entry.id)).toEqual(['v1', 'v2']);
  });
});
