import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';
import { createTestMemoryDb } from './test-helpers';
import { MemoryWriteQueue } from '../write-queue';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemorySubCallRequest, MemorySubCallResult, MemorySubCallRunner } from '../subcall-runner';
import { FactGraphManager } from '../managers/fact-graph-manager';
import { ProfileManager } from '../managers/profile-manager';
import { RetrievalManager } from '../managers/retrieval-manager';
import { InjectionManager } from '../managers/injection-manager';
import { runConsolidation, type ConsolidationCtx } from '../consolidation';

const WORKSPACE = '/repo/damocles';
const SESSION_ID = 'session-integration';

interface CountRow {
  count: number;
}

interface ExtractedMemorySeed {
  kind: string;
  content: string;
  scope: string;
  tags?: string[];
  forget_after?: number;
}

interface RerankItem {
  id: string;
  title: string | null;
  snippet: string;
}

function seedCandidate(db: DatabaseInstance, sessionId: string, userText: string, assistantText: string): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO memory_candidates (id, session_id, prompt_index, user_text, assistant_text, files, salient, consumed, reprocessed, created_at)
     VALUES (?, ?, ?, ?, ?, '[]', 0, 0, 0, ?)`,
  ).run(id, sessionId, 0, userText, assistantText, Date.now());
  return id;
}

function seedMemory(
  db: DatabaseInstance,
  fields: { id?: string; kind?: string; scope?: string; content: string; workspace?: string | null; createdAt: number },
): MemoryRow {
  const id = fields.id ?? crypto.randomUUID();
  const kind = fields.kind ?? 'fact';
  const scope = fields.scope ?? 'project';
  db.prepare(
    `INSERT INTO memories (id, kind, scope, content, content_hash, version, is_latest, root_id, workspace, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
  ).run(id, kind, scope, fields.content, id, id, fields.workspace ?? null, fields.createdAt, fields.createdAt);
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow;
}

function countLiveMemories(db: DatabaseInstance, scope: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM memories WHERE is_latest = 1 AND forgotten = 0 AND scope = ?')
    .get(scope) as CountRow;
  return row.count;
}

function countUnconsumedCandidates(db: DatabaseInstance): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM memory_candidates WHERE consumed = 0').get() as CountRow;
  return row.count;
}

function countConsumedCandidates(db: DatabaseInstance): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM memory_candidates WHERE consumed = 1').get() as CountRow;
  return row.count;
}

function parseRerankItems(prompt: string): RerankItem[] {
  const marker = 'Candidates:\n';
  const index = prompt.indexOf(marker);
  if (index < 0) return [];
  return JSON.parse(prompt.slice(index + marker.length)) as RerankItem[];
}

interface RunnerHandle {
  runner: MemorySubCallRunner;
  run: ReturnType<typeof vi.fn>;
  onNoModel: ReturnType<typeof vi.fn>;
}

/**
 * Builds a mock runner answering each purpose with a canned value: `extract` returns the supplied
 * memory list, `merge` (used for both near-dup merge and conflict judgement) reports no
 * contradiction/merge, `profile` returns fixed sections, and `rerank` grades each candidate by the
 * supplied relevance map (defaulting to `low`). Records every call and exposes `onNoModel`.
 */
function makeRunner(
  extractMemories: ExtractedMemorySeed[],
  relevanceById: Record<string, 'high' | 'medium' | 'low'> = {},
): RunnerHandle {
  const run = vi.fn(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
    if (req.purpose === 'extract') return { value: { memories: extractMemories } as T };
    if (req.purpose === 'profile') return { value: { static: 'durable facts', dynamic: 'recent focus' } as T };
    if (req.purpose === 'rerank') {
      const items = parseRerankItems(req.prompt);
      const results = items.map(item => ({ id: item.id, relevance: relevanceById[item.id] ?? 'low' }));
      return { value: { results } as T };
    }
    return { value: { contradicts: false, merged_ids: [], content: '' } as T };
  });
  const onNoModel = vi.fn();
  return { runner: { run }, run, onNoModel };
}

function makeCtx(
  db: DatabaseInstance,
  handle: RunnerHandle,
  overrides: Partial<ConsolidationCtx> = {},
): ConsolidationCtx {
  const writeQueue = new MemoryWriteQueue();
  return {
    db,
    writeQueue,
    runner: handle.runner,
    factGraph: new FactGraphManager(db, writeQueue, handle.runner),
    profileManager: new ProfileManager(db, writeQueue, handle.runner),
    reason: 'switch',
    sessionId: SESSION_ID,
    workspace: WORKSPACE,
    autoExtractEnabled: true,
    onNoModel: handle.onNoModel,
    ...overrides,
  };
}

const ESBUILD_CONTENT = 'The project bundles the extension with esbuild.';

describe('memory integration — full consolidate → retrieve → inject loop', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('enqueue → claim → extract → dedup → retrieve → inject (one project fact)', async () => {
    seedCandidate(db, SESSION_ID, 'Which bundler did we choose?', 'We decided to use esbuild.');
    seedCandidate(db, SESSION_ID, 'Why esbuild?', 'It is fast and bundles the extension cleanly.');
    seedCandidate(db, SESSION_ID, 'Confirm the choice.', 'esbuild bundles the extension.');

    const esbuildFact: ExtractedMemorySeed = {
      kind: 'fact',
      content: ESBUILD_CONTENT,
      scope: 'project',
      tags: ['build'],
    };
    const handle = makeRunner([esbuildFact]);

    await runConsolidation(makeCtx(db, handle));

    expect(countLiveMemories(db, 'project')).toBe(1);
    expect(countConsumedCandidates(db)).toBe(3);
    expect(countUnconsumedCandidates(db)).toBe(0);

    const stored = db
      .prepare('SELECT * FROM memories WHERE is_latest = 1 AND forgotten = 0')
      .get() as MemoryRow;
    expect(stored.scope).toBe('project');
    expect(stored.is_latest).toBe(1);
    expect(stored.content).toBe(ESBUILD_CONTENT);
    expect(stored.workspace).toBe(WORKSPACE);

    const retrieval = new RetrievalManager(db, handle.runner);
    const results = await retrieval.search({ query: 'how is the extension bundled' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.find(r => r.id === stored.id)).toBeDefined();

    const injection = new InjectionManager(
      db,
      new ProfileManager(db, new MemoryWriteQueue(), handle.runner),
      handle.runner,
    );
    const catalog = await injection.buildMemoryCatalog(SESSION_ID, WORKSPACE, null, 'bundling');
    expect(catalog.context).toContain(ESBUILD_CONTENT);
  });

  it('ranks the relevant extracted fact first via the rerank sub-call', async () => {
    seedCandidate(db, SESSION_ID, 'How is it bundled?', 'esbuild bundles the extension.');

    const esbuildFact: ExtractedMemorySeed = { kind: 'fact', content: ESBUILD_CONTENT, scope: 'project', tags: ['build'] };
    const handle = makeRunner([esbuildFact]);
    await runConsolidation(makeCtx(db, handle));

    const esbuildId = (db.prepare('SELECT id FROM memories').get() as { id: string }).id;
    const noiseRow = seedMemory(db, {
      content: 'The extension activates lazily on first command.',
      workspace: WORKSPACE,
      createdAt: Date.now(),
    });

    const rerankHandle = makeRunner([], { [esbuildId]: 'high', [noiseRow.id]: 'low' });
    const retrieval = new RetrievalManager(db, rerankHandle.runner);
    const results = await retrieval.search({ query: 'how is the extension bundled' });

    const ids = results.map(r => r.id);
    expect(ids).toContain(esbuildId);
    expect(ids).toContain(noiseRow.id);
    expect(ids.indexOf(esbuildId)).toBeLessThan(ids.indexOf(noiseRow.id));
    expect(results.find(r => r.id === esbuildId)?.rerankRelevance).toBe('high');
  });

  it('conflict → version chain; retrieval and catalog return only the latest', async () => {
    const oldFact = seedMemory(db, {
      content: 'The project bundles the extension with webpack.',
      workspace: WORKSPACE,
      createdAt: 1000,
    });

    seedCandidate(db, SESSION_ID, 'What bundler now?', 'We switched to esbuild.');

    const newFact: ExtractedMemorySeed = {
      kind: 'fact',
      content: 'The project bundles the extension with esbuild.',
      scope: 'project',
      tags: ['build'],
    };

    const contradictHandle: RunnerHandle = {
      onNoModel: vi.fn(),
      run: vi.fn(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
        if (req.purpose === 'extract') return { value: { memories: [newFact] } as T };
        if (req.purpose === 'profile') return { value: { static: '', dynamic: '' } as T };
        if (req.purpose === 'merge') return { value: { contradicts: true, merged_ids: [] } as T };
        if (req.purpose === 'rerank') return { value: { results: [] } as T };
        return { value: null };
      }),
      runner: { run: vi.fn() },
    };
    contradictHandle.runner = { run: contradictHandle.run };

    await runConsolidation(makeCtx(db, contradictHandle));

    const newRow = db
      .prepare('SELECT * FROM memories WHERE content = ?')
      .get(newFact.content) as MemoryRow;
    const oldRow = db.prepare('SELECT * FROM memories WHERE id = ?').get(oldFact.id) as MemoryRow;

    expect(oldRow.is_latest).toBe(0);
    expect(newRow.is_latest).toBe(1);
    expect(newRow.version).toBe(2);
    expect(newRow.parent_id).toBe(oldFact.id);

    const edge = db
      .prepare("SELECT COUNT(*) AS count FROM memory_edges WHERE kind = 'UPDATES' AND source_id = ? AND target_id = ?")
      .get(newRow.id, oldFact.id) as CountRow;
    expect(edge.count).toBe(1);

    const retrieval = new RetrievalManager(db);
    const results = await retrieval.search({ query: 'bundles the extension' });
    const retrievedIds = results.map(r => r.id);
    expect(retrievedIds).toContain(newRow.id);
    expect(retrievedIds).not.toContain(oldFact.id);

    const injection = new InjectionManager(
      db,
      new ProfileManager(db, new MemoryWriteQueue(), contradictHandle.runner),
      contradictHandle.runner,
    );
    const catalog = await injection.buildMemoryCatalog(SESSION_ID, WORKSPACE, null, 'bundles');
    expect(catalog.context).toContain('esbuild');
    expect(catalog.context).not.toContain('webpack');
  });

  it('graceful degrade — no-model extract releases candidates for retry, creates no memories, calls onNoModel once', async () => {
    seedCandidate(db, SESSION_ID, 'Anything durable?', 'Maybe.');
    seedCandidate(db, SESSION_ID, 'And this?', 'Sure.');

    const degradeHandle: RunnerHandle = {
      onNoModel: vi.fn(),
      run: vi.fn(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
        if (req.purpose === 'extract') return { value: null, failure: 'no-model' };
        return { value: null };
      }),
      runner: { run: vi.fn() },
    };
    degradeHandle.runner = { run: degradeHandle.run };

    await expect(runConsolidation(makeCtx(db, degradeHandle))).resolves.toBeUndefined();

    const total = db.prepare('SELECT COUNT(*) AS count FROM memories').get() as CountRow;
    expect(total.count).toBe(0);
    expect(countConsumedCandidates(db)).toBe(0);
    expect(degradeHandle.onNoModel).toHaveBeenCalledTimes(1);
  });

  it('graceful degrade — retrieval without a runner returns BM25 order, no rerank, no throw', async () => {
    seedMemory(db, { content: 'the build uses esbuild for the extension', workspace: WORKSPACE, createdAt: Date.now() });
    seedMemory(db, { content: 'the extension activates on startup', workspace: WORKSPACE, createdAt: Date.now() });

    const retrieval = new RetrievalManager(db);
    const results = await retrieval.search({ query: 'how is the extension bundled' });

    expect(results.length).toBe(2);
    expect(results.every(r => r.rerankRelevance === undefined)).toBe(true);
  });

  it('graceful degrade — catalog with injectMode off issues no rerank sub-call', async () => {
    seedMemory(db, { content: ESBUILD_CONTENT, workspace: WORKSPACE, createdAt: Date.now() });
    seedMemory(db, { content: 'the extension lazily activates on first command', workspace: WORKSPACE, createdAt: Date.now() });

    const handle = makeRunner([]);
    const injection = new InjectionManager(
      db,
      new ProfileManager(db, new MemoryWriteQueue(), handle.runner),
      handle.runner,
    );
    const catalog = await injection.buildMemoryCatalog(SESSION_ID, WORKSPACE, null, 'bundling');

    expect(catalog.context).toContain(ESBUILD_CONTENT);
    expect(catalog.metadata?.rerankApplied).toBe(false);
    const rerankCalls = handle.run.mock.calls.filter(([req]) => (req as MemorySubCallRequest).purpose === 'rerank');
    expect(rerankCalls).toHaveLength(0);
  });

  it('scoping — global/session/project extracted memories land with the requested scope', async () => {
    seedCandidate(db, SESSION_ID, 'Capture preferences', 'Multiple scopes.');

    const memories: ExtractedMemorySeed[] = [
      { kind: 'preference', content: 'The user prefers two-space indentation everywhere.', scope: 'global' },
      { kind: 'fact', content: 'This workspace pins Node 20 for builds.', scope: 'project' },
      { kind: 'episode', content: 'Currently refactoring the memory module integration tests.', scope: 'session' },
    ];
    const handle = makeRunner(memories);

    await runConsolidation(makeCtx(db, handle));

    const globalRow = db.prepare("SELECT * FROM memories WHERE scope = 'global'").get() as MemoryRow;
    const projectRow = db.prepare("SELECT * FROM memories WHERE scope = 'project'").get() as MemoryRow;
    const sessionRow = db.prepare("SELECT * FROM memories WHERE scope = 'session'").get() as MemoryRow;

    expect(globalRow.scope).toBe('global');
    expect(globalRow.kind).toBe('preference');
    expect(globalRow.workspace).toBeNull();

    expect(projectRow.scope).toBe('project');
    expect(projectRow.kind).toBe('fact');
    expect(projectRow.workspace).toBe(WORKSPACE);

    expect(sessionRow.scope).toBe('session');
    expect(sessionRow.kind).toBe('episode');
  });
});
