import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTestMemoryDb } from './test-helpers';
import type { DatabaseInstance } from '../types';
import type { MemorySubCallRunner, MemorySubCallResult } from '../subcall-runner';

// expandQuery reaches PiRuntime directly (not via the fake runner), so mock it out. Default to no
// synonyms so every non-expansion test in this file sees original-only behavior; the expansion suite
// overrides per-test.
vi.mock('../query-expansion', () => ({
  expandQuery: vi.fn(async () => [] as string[]),
  expandMemoryTerms: vi.fn(async () => [] as string[]),
  clearExpansionCache: vi.fn(() => {}),
}));

// Redirect MemoryService's DB open to a fixed temp path so the service and our assertions share one DB.
const dbHolder = vi.hoisted(() => ({ path: '' }));
vi.mock('../database', async (importActual) => {
  const actual = await importActual<typeof import('../database')>();
  return {
    ...actual,
    openDatabaseAsync: vi.fn(async () => {
      const raw = new DatabaseSync(dbHolder.path, { timeout: 5000, enableForeignKeyConstraints: true });
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA synchronous = NORMAL');
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

import { RetrievalManager } from '../managers/retrieval-manager';
import { expandQuery } from '../query-expansion';
import { MemoryService } from '../index';

const mockedExpandQuery = vi.mocked(expandQuery);

interface SeedRow {
  id: string;
  content: string;
  kind?: string;
  scope?: string;
  isLatest?: number;
  forgotten?: number;
  workspace?: string | null;
  sessionId?: string | null;
}

function seed(db: DatabaseInstance, row: SeedRow): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (id, kind, scope, content, title, content_hash, is_latest, forgotten, workspace, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.kind ?? 'fact',
    row.scope ?? 'project',
    row.content,
    null,
    row.id,
    row.isLatest ?? 1,
    row.forgotten ?? 0,
    row.workspace ?? null,
    row.sessionId ?? null,
    now,
    now,
  );
}

function gradingRunner(grades: Record<string, 'high' | 'medium' | 'low'>): MemorySubCallRunner {
  return {
    async run<T>(): Promise<MemorySubCallResult<T>> {
      const results = Object.entries(grades).map(([id, relevance]) => ({ id, relevance }));
      return { value: { results } as unknown as T };
    },
  };
}

const QUERY = 'how is the extension bundled';

// These rerank tests seed project rows and search without a workspace; opt out of scope filtering so
// the fixtures surface (scoping is exercised in its own suite).
const ALL: { allWorkspaces: true } = { allWorkspaces: true };

describe('RetrievalManager.search', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
    mockedExpandQuery.mockReset();
    mockedExpandQuery.mockResolvedValue([]);
  });

  it('reranks BM25 candidates by LLM relevance (F before N)', async () => {
    seed(db, { id: 'F', content: 'the build uses esbuild for the extension' });
    seed(db, { id: 'N', content: 'the extension activates on startup' });

    const manager = new RetrievalManager(db, gradingRunner({ F: 'high', N: 'low' }));
    const results = await manager.search({ query: QUERY, ...ALL });

    const ids = results.map(r => r.id);
    expect(ids).toContain('F');
    expect(ids).toContain('N');
    expect(ids.indexOf('F')).toBeLessThan(ids.indexOf('N'));
    expect(results.find(r => r.id === 'F')?.rerankRelevance).toBe('high');
  });

  it('keeps an ungraded row above an explicitly-low row on a partial grade', async () => {
    seed(db, { id: 'EL', content: 'the extension is bundled with esbuild at build time' });
    seed(db, { id: 'UG', content: 'the extension activates on startup' });

    const manager = new RetrievalManager(db, gradingRunner({ EL: 'low' }));
    const results = await manager.search({ query: QUERY, ...ALL });

    const ids = results.map(r => r.id);
    expect(ids.indexOf('UG')).toBeLessThan(ids.indexOf('EL'));
    expect(results.find(r => r.id === 'UG')?.rerankRelevance).toBeUndefined();
  });

  it('preserves BM25 order when the reranker grades nothing', async () => {
    seed(db, { id: 'TOP', content: 'the extension is bundled with esbuild at build time' });
    seed(db, { id: 'BOT', content: 'the extension activates on startup' });

    const manager = new RetrievalManager(db, gradingRunner({}));
    const results = await manager.search({ query: QUERY, ...ALL });

    const ids = results.map(r => r.id);
    expect(ids.indexOf('TOP')).toBeLessThan(ids.indexOf('BOT'));
    expect(results.every(r => r.rerankRelevance === undefined)).toBe(true);
  });

  it('degrades to BM25 order without a runner and does not throw', async () => {
    seed(db, { id: 'F', content: 'the build uses esbuild for the extension' });
    seed(db, { id: 'N', content: 'the extension activates on startup' });

    const manager = new RetrievalManager(db);
    const results = await manager.search({ query: QUERY, ...ALL });

    expect(results.length).toBe(2);
    expect(results.every(r => r.rerankRelevance === undefined)).toBe(true);
  });

  it('degrades to BM25 order when the reranker returns a malformed shape (M1)', async () => {
    seed(db, { id: 'F', content: 'the build uses esbuild for the extension' });
    seed(db, { id: 'N', content: 'the extension activates on startup' });

    const malformedRunner: MemorySubCallRunner = {
      async run<T>(): Promise<MemorySubCallResult<T>> {
        return { value: { garbage: 'no results field' } as unknown as T };
      },
    };
    const manager = new RetrievalManager(db, malformedRunner);
    const results = await manager.search({ query: QUERY, ...ALL });

    expect(results.length).toBe(2);
    expect(results.every(r => r.rerankRelevance === undefined)).toBe(true);
  });

  it('excludes superseded (is_latest=0) and forgotten rows', async () => {
    seed(db, { id: 'F', content: 'the build uses esbuild for the extension' });
    seed(db, { id: 'OLD', content: 'the old extension build configuration', isLatest: 0 });
    seed(db, { id: 'GONE', content: 'a forgotten extension build note', forgotten: 1 });

    const manager = new RetrievalManager(db);
    const results = await manager.search({ query: QUERY, ...ALL });

    const ids = results.map(r => r.id);
    expect(ids).toContain('F');
    expect(ids).not.toContain('OLD');
    expect(ids).not.toContain('GONE');
  });
});

describe('RetrievalManager.search — workspace + session scoping', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
    mockedExpandQuery.mockReset();
    mockedExpandQuery.mockResolvedValue([]);
    // All rows share the same term so scope, not lexical match, decides what surfaces.
    seed(db, { id: 'projA', scope: 'project', workspace: '/ws/A', content: 'the extension bundle for project A' });
    seed(db, { id: 'projB', scope: 'project', workspace: '/ws/B', content: 'the extension bundle for project B' });
    seed(db, { id: 'glob', scope: 'global', content: 'the extension bundle preference is global' });
    seed(db, { id: 'sessX', scope: 'session', sessionId: 'X', content: 'the extension bundle note in session X' });
    seed(db, { id: 'sessY', scope: 'session', sessionId: 'Y', content: 'the extension bundle note in session Y' });
  });

  it('returns this workspace + global + this session, never other workspaces or sessions', async () => {
    const manager = new RetrievalManager(db);
    const ids = (await manager.search({ query: QUERY, workspace: '/ws/A', sessionId: 'X' })).map(r => r.id);

    expect(ids).toEqual(expect.arrayContaining(['projA', 'glob', 'sessX']));
    expect(ids).not.toContain('projB');
    expect(ids).not.toContain('sessY');
  });

  it('allWorkspaces:true returns everything regardless of workspace/session', async () => {
    const manager = new RetrievalManager(db);
    const ids = (await manager.search({ query: QUERY, workspace: '/ws/A', sessionId: 'X', allWorkspaces: true })).map(r => r.id);

    expect(ids).toEqual(expect.arrayContaining(['projA', 'projB', 'glob', 'sessX', 'sessY']));
  });

  it('omitting sessionId excludes all session-scoped rows', async () => {
    const manager = new RetrievalManager(db);
    const ids = (await manager.search({ query: QUERY, workspace: '/ws/A' })).map(r => r.id);

    expect(ids).toEqual(expect.arrayContaining(['projA', 'glob']));
    expect(ids).not.toContain('sessX');
    expect(ids).not.toContain('sessY');
    expect(ids).not.toContain('projB');
  });
});

describe('RetrievalManager — tier kind exclusion for scope tiers', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
    mockedExpandQuery.mockReset();
    mockedExpandQuery.mockResolvedValue([]);
  });

  it("tiers:['global'] returns only global fact/preference/episode, not notes or observations", async () => {
    seed(db, { id: 'gFact', kind: 'fact', scope: 'global', content: 'a global fact about esbuild' });
    seed(db, { id: 'gPref', kind: 'preference', scope: 'global', content: 'a global preference for esbuild' });
    seed(db, { id: 'gEpisode', kind: 'episode', scope: 'global', content: 'a global episode about esbuild' });
    seed(db, { id: 'gNote', kind: 'note', scope: 'global', content: 'a global note about esbuild' });
    seed(db, { id: 'gObs', kind: 'observation', scope: 'global', content: 'a global observation about esbuild' });

    const manager = new RetrievalManager(db);
    const ids = (await manager.search({ query: 'esbuild', tiers: ['global'], allWorkspaces: true })).map(r => r.id);

    expect(ids).toEqual(expect.arrayContaining(['gFact', 'gPref', 'gEpisode']));
    expect(ids).not.toContain('gNote');
    expect(ids).not.toContain('gObs');
  });
});

describe('RetrievalManager.search — query expansion union', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
    mockedExpandQuery.mockReset();
    mockedExpandQuery.mockResolvedValue([]);
  });

  it('finds a memory matched only by an expanded synonym (union of original + expansion)', async () => {
    // The query's literal tokens miss this row; only the synonym "webpack" matches it.
    seed(db, { id: 'syn', content: 'the project is packaged with webpack' });
    mockedExpandQuery.mockResolvedValueOnce(['webpack']);

    const manager = new RetrievalManager(db);
    const ids = (await manager.search({ query: 'bundling strategy', allWorkspaces: true })).map(r => r.id);

    expect(ids).toContain('syn');
    expect(mockedExpandQuery).toHaveBeenCalledWith('bundling strategy');
  });

  it('fail-soft: expandQuery throwing leaves the original literal-match results unchanged', async () => {
    seed(db, { id: 'lit', content: 'the extension bundle uses esbuild' });
    seed(db, { id: 'syn', content: 'the project is packaged with webpack' });
    mockedExpandQuery.mockRejectedValueOnce(new Error('expansion unavailable'));

    const manager = new RetrievalManager(db);
    const ids = (await manager.search({ query: 'esbuild bundle', allWorkspaces: true })).map(r => r.id);

    expect(ids).toContain('lit');
    expect(ids).not.toContain('syn');
  });

  it('fail-soft: expandQuery returning [] leaves the original literal-match results unchanged', async () => {
    seed(db, { id: 'lit', content: 'the extension bundle uses esbuild' });
    seed(db, { id: 'syn', content: 'the project is packaged with webpack' });
    mockedExpandQuery.mockResolvedValueOnce([]);

    const manager = new RetrievalManager(db);
    const ids = (await manager.search({ query: 'esbuild bundle', allWorkspaces: true })).map(r => r.id);

    expect(ids).toContain('lit');
    expect(ids).not.toContain('syn');
  });
});

// A forgotten row is deliberately surfaced by an include_forgotten search, so an explicit-ID fetch
// must resolve it — without bumping its access count.
describe('MemoryService.getMemoryDetails — forgotten rows resolve on explicit fetch', () => {
  let service: MemoryService;

  beforeEach(() => {
    dbHolder.path = path.join(os.tmpdir(), `damocles-getdetails-${crypto.randomUUID()}.db`);
    service = new MemoryService('/ext');
    mockedExpandQuery.mockReset();
    mockedExpandQuery.mockResolvedValue([]);
  });

  afterEach(() => {
    service.dispose();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbHolder.path + suffix);
      } catch {
        /* already gone */
      }
    }
  });

  it('resolves a forgotten hit and does NOT bump its access_count', async () => {
    await service.ensureInitialized();
    const db = service.database!;
    seed(db, { id: 'gone', scope: 'global', forgotten: 1, content: 'a forgotten extension bundle note' });

    const hits = await service.searchMemories({ query: QUERY, includeForgotten: true, allWorkspaces: true });
    expect(hits.map(h => h.id)).toContain('gone');

    const entries = await service.getMemoryDetails(['gone']);
    expect(entries.map(e => e.id)).toContain('gone');

    const row = db.prepare('SELECT access_count FROM memories WHERE id = ?').get('gone') as { access_count: number };
    expect(row.access_count).toBe(0);
  });
});
