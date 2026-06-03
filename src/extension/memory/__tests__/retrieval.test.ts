import { describe, it, expect, beforeEach } from 'vitest';
import { createTestMemoryDb } from './test-helpers';
import { RetrievalManager } from '../managers/retrieval-manager';
import type { DatabaseInstance } from '../types';
import type { MemorySubCallRunner, MemorySubCallResult } from '../subcall-runner';

interface SeedRow {
  id: string;
  content: string;
  kind?: string;
  scope?: string;
  isLatest?: number;
  forgotten?: number;
}

function seed(db: DatabaseInstance, row: SeedRow): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (id, kind, scope, content, title, content_hash, is_latest, forgotten, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.kind ?? 'fact',
    row.scope ?? 'project',
    row.content,
    null,
    row.id,
    row.isLatest ?? 1,
    row.forgotten ?? 0,
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

describe('RetrievalManager.search', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('reranks BM25 candidates by LLM relevance (F before N)', async () => {
    seed(db, { id: 'F', content: 'the build uses esbuild for the extension' });
    seed(db, { id: 'N', content: 'the extension activates on startup' });

    const manager = new RetrievalManager(db, gradingRunner({ F: 'high', N: 'low' }));
    const results = await manager.search({ query: QUERY });

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
    const results = await manager.search({ query: QUERY });

    const ids = results.map(r => r.id);
    expect(ids.indexOf('UG')).toBeLessThan(ids.indexOf('EL'));
    expect(results.find(r => r.id === 'UG')?.rerankRelevance).toBeUndefined();
  });

  it('preserves BM25 order when the reranker grades nothing', async () => {
    seed(db, { id: 'TOP', content: 'the extension is bundled with esbuild at build time' });
    seed(db, { id: 'BOT', content: 'the extension activates on startup' });

    const manager = new RetrievalManager(db, gradingRunner({}));
    const results = await manager.search({ query: QUERY });

    const ids = results.map(r => r.id);
    expect(ids.indexOf('TOP')).toBeLessThan(ids.indexOf('BOT'));
    expect(results.every(r => r.rerankRelevance === undefined)).toBe(true);
  });

  it('degrades to BM25 order without a runner and does not throw', async () => {
    seed(db, { id: 'F', content: 'the build uses esbuild for the extension' });
    seed(db, { id: 'N', content: 'the extension activates on startup' });

    const manager = new RetrievalManager(db);
    const results = await manager.search({ query: QUERY });

    expect(results.length).toBe(2);
    expect(results.every(r => r.rerankRelevance === undefined)).toBe(true);
  });

  it('excludes superseded (is_latest=0) and forgotten rows', async () => {
    seed(db, { id: 'F', content: 'the build uses esbuild for the extension' });
    seed(db, { id: 'OLD', content: 'the old extension build configuration', isLatest: 0 });
    seed(db, { id: 'GONE', content: 'a forgotten extension build note', forgotten: 1 });

    const manager = new RetrievalManager(db);
    const results = await manager.search({ query: QUERY });

    const ids = results.map(r => r.id);
    expect(ids).toContain('F');
    expect(ids).not.toContain('OLD');
    expect(ids).not.toContain('GONE');
  });
});
