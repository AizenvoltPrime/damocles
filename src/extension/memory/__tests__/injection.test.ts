import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestMemoryDb } from './test-helpers';
import { InjectionManager, __test as injectionInternals } from '../managers/injection-manager';
import { deleteInjectionDatabaseFile, setInjectionDbDirForTests } from '../injection-database';
import { ProfileManager } from '../managers/profile-manager';
import { MemoryWriteQueue } from '../write-queue';
import type { DatabaseInstance } from '../types';
import type { MemorySubCallRequest, MemorySubCallResult, MemorySubCallRunner } from '../subcall-runner';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';
import { subCallSpy } from './subcall-spy';

const WORKSPACE = '/repo/damocles';

// Isolate injection-DB files in a throwaway dir so tests never touch the real ~/.damocles store.
setInjectionDbDirForTests(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-injection-test-')));

// The vscode mock's getConfiguration().get returns the passed default, so these mirror the config defaults.
const CATALOG_TOKEN_BUDGET = 2000;
const SESSION_LIMIT = 15;
const PROJECT_LIMIT = 15;
const GLOBAL_LIMIT = 10;
const OBSERVATION_LIMIT = 20;

interface RerankItem {
  id: string;
  title: string | null;
  snippet: string;
}

/** The JSON candidate list embedded after "Candidates:\n" in the rerank prompt. */
function parseRerankItems(prompt: string): RerankItem[] {
  const marker = 'Candidates:\n';
  const index = prompt.indexOf(marker);
  if (index < 0) return [];
  return JSON.parse(prompt.slice(index + marker.length)) as RerankItem[];
}

interface RunnerHandle {
  runner: MemorySubCallRunner;
  run: ReturnType<typeof vi.fn>;
}

/** Stub runner: rerank grades every candidate `low` (order-preserving), profile returns fixed sections. */
function makeRunner(): RunnerHandle {
  const run = subCallSpy(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
    if (req.purpose === 'profile') return { value: { static: 'durable facts', dynamic: 'recent focus' } as T };
    if (req.purpose === 'rerank') {
      const items = parseRerankItems(req.prompt);
      return { value: { results: items.map(i => ({ id: i.id, relevance: 'low' as const })) } as T };
    }
    return { value: { contradicts: false, merged_ids: [], content: '' } as T };
  });
  return { runner: { run }, run };
}

const openManagers = new Set<InjectionManager>();

function makeManager(db: DatabaseInstance): { injection: InjectionManager; handle: RunnerHandle } {
  const handle = makeRunner();
  const profileManager = new ProfileManager(db, new MemoryWriteQueue(), handle.runner);
  const injection = new InjectionManager(db, profileManager, handle.runner);
  openManagers.add(injection);
  return { injection, handle };
}

interface SeedFields {
  id?: string;
  kind?: string;
  scope?: string;
  content?: string;
  title?: string | null;
  workspace?: string | null;
  sessionId?: string | null;
  filesRead?: string[];
  filesModified?: string[];
  pinned?: number;
  updatedAt?: number;
}

function seed(db: DatabaseInstance, fields: SeedFields): string {
  const id = fields.id ?? crypto.randomUUID();
  const now = fields.updatedAt ?? Date.now();
  const kind = fields.kind ?? 'fact';
  const scope = fields.scope ?? 'project';
  db.prepare(
    `INSERT INTO memories
       (id, kind, scope, content, title, content_hash, version, is_latest, root_id, workspace,
        session_id, files_read, files_modified, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    kind,
    scope,
    fields.content ?? 'content ' + id,
    fields.title ?? null,
    id,
    id,
    fields.workspace ?? null,
    fields.sessionId ?? null,
    JSON.stringify(fields.filesRead ?? []),
    JSON.stringify(fields.filesModified ?? []),
    fields.pinned ?? 0,
    now,
    now,
  );
  return id;
}

function allEntryStrings(context: string): string[] {
  return context
    .split('\n')
    .filter(line => line.trimStart().startsWith('- '));
}

describe('InjectionManager — Slice 12 catalog bounding + fairness', () => {
  let db: DatabaseInstance;
  // Every session id a test hands to persistInjection/buildMemoryCatalog spawns a real injection DB
  // file under ~/.damocles; track them and delete the trio afterwards so tests leave nothing behind.
  const touchedSessions = new Set<string>();

  beforeEach(async () => {
    db = await createTestMemoryDb();
    touchedSessions.clear();
    openManagers.clear();
  });

  afterEach(async () => {
    // Close handles first so Windows releases the file lock before we delete the trio.
    for (const m of openManagers) m.closeInjectionDatabases();
    openManagers.clear();
    for (const sessionId of touchedSessions) {
      await deleteInjectionDatabaseFile(sessionId);
    }
  });

  it('R3: bounds a 5,000-row store by BOTH per-group entry limits AND aggregate token budget', async () => {
    const now = Date.now();
    // Descending updated_at so the per-scope pool queries (LIMIT 3*limit) have deterministic recency.
    const insert = db.prepare(
      `INSERT INTO memories
         (id, kind, scope, content, title, content_hash, version, is_latest, root_id, workspace,
          session_id, files_read, files_modified, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, '[]', '[]', 0, ?, ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        const id = `row-${i}`;
        const bucket = i % 3;
        const scope = bucket === 0 ? 'project' : bucket === 1 ? 'global' : 'project';
        const kind = bucket === 2 ? 'observation' : 'fact';
        const title = kind === 'observation' ? `Observation ${i}` : null;
        // Long enough that an unbounded catalog would blow the 2000-token budget.
        const content = `Memory entry number ${i} — ${'lorem ipsum dolor sit amet '.repeat(6)}`;
        const ts = now - i * 1000;
        insert.run(id, kind, scope, content, title, id, id, WORKSPACE, null, ts, ts);
      }
    });

    const { injection } = makeManager(db);
    const { metadata } = await injection.buildMemoryCatalog(null, WORKSPACE, null, undefined);
    expect(metadata).not.toBeNull();
    const groups = metadata!.groups;

    const byLabel = (label: string): (typeof groups)[number] => {
      const found = groups.find(g => g.label === label);
      if (!found) throw new Error(`no '${label}' group in the memory catalog`);
      return found;
    };
    // Row bound: each group ≤ its configured limit.
    expect(byLabel('session').entries.length).toBeLessThanOrEqual(SESSION_LIMIT);
    expect(byLabel('project').entries.length).toBeLessThanOrEqual(PROJECT_LIMIT);
    expect(byLabel('global').entries.length).toBeLessThanOrEqual(GLOBAL_LIMIT);
    expect(byLabel('observations').entries.length).toBeLessThanOrEqual(OBSERVATION_LIMIT);

    // Token bound: summed tokens across the 4 groups (no pinned here) ≤ budget.
    const summedGroupTokens = groups.reduce(
      (sum, g) => sum + g.entries.reduce((s, e) => s + e.estimatedTokens, 0),
      0,
    );
    expect(summedGroupTokens).toBeLessThanOrEqual(CATALOG_TOKEN_BUDGET);
    expect(summedGroupTokens).toBeGreaterThan(0);
  });

  it('R8: a ≥2-segment path suffix earns full proximity; a bare filename earns only partial', async () => {
    const activeFile = 'src/foo/index.ts';
    // FULL: shares the 2-segment suffix "foo/index.ts".
    const fullId = seed(db, {
      id: 'prox-full',
      content: 'touches foo/index.ts during the refactor',
      workspace: WORKSPACE,
    });
    // PARTIAL: bare filename match on an unrelated index.ts.
    const partialId = seed(db, {
      id: 'prox-partial',
      content: 'edited bar/index.ts in an unrelated module',
      workspace: WORKSPACE,
    });

    const { injection } = makeManager(db);
    const { metadata } = await injection.buildMemoryCatalog(null, WORKSPACE, activeFile, undefined);
    const project = metadata!.groups.find(g => g.label === 'project')!;

    const full = project.entries.find(e => e.id === fullId)!;
    const partial = project.entries.find(e => e.id === partialId)!;
    expect(full).toBeDefined();
    expect(partial).toBeDefined();

    // Graded proximity: full path suffix → 1, bare filename → 0.4; propagates into the overall score.
    expect(full.scoreBreakdown.fileProximity).toBe(1);
    expect(partial.scoreBreakdown.fileProximity).toBeCloseTo(0.4, 5);
    expect(full.score).toBeGreaterThan(partial.score);
  });

  it('R9: an existing prompt-0 injection row suppresses profile + handoff re-injection', async () => {
    const sessionId = 'session-restart';
    touchedSessions.add(sessionId);
    const wq = new MemoryWriteQueue();
    const now = Date.now();
    db.prepare(
      `INSERT INTO memory_profile (scope, workspace, section, content, updated_at) VALUES ('project', ?, 'static', ?, ?)`,
    ).run(WORKSPACE, 'The user prefers functional TypeScript.', now);
    // An observation so handoff would have something to surface.
    seed(db, { kind: 'observation', scope: 'session', sessionId, title: 'Prior work', content: 'did things', workspace: WORKSPACE });

    const persisted: MemoryInjectionDisplay = {
      groups: [],
      totalTokensUsed: 0,
      ftsQuery: null,
      hasHandoffContext: false,
      hasProfile: false,
      rerankApplied: false,
      pinnedEntries: [],
      pinnedBudget: 500,
      pinnedTokensUsed: 0,
    };

    const profileManager = new ProfileManager(db, wq, makeRunner().runner);
    const injection = new InjectionManager(db, profileManager, makeRunner().runner);
    await injection.persistInjection(sessionId, 0, persisted);

    const { metadata } = await injection.buildMemoryCatalog(sessionId, WORKSPACE, null, undefined);
    expect(metadata!.hasProfile).toBe(false);
    expect(metadata!.hasHandoffContext).toBe(false);
    expect(injection.isFirstMessageOfSession(sessionId)).toBe(false);

    injection.closeInjectionDatabases();
  });

  it('does not leak a reopened injection DB when dispose races an in-flight open (deep nit)', async () => {
    const sessionId = 'session-dispose-race-' + crypto.randomUUID();
    touchedSessions.add(sessionId);
    const { injection } = makeManager(db);

    // Kick off an open, then dispose before it resolves — the late open must not repopulate the cache.
    const inflight = injection.getPersistedInjection(sessionId, 0);
    injection.closeInjectionDatabases();
    await inflight;

    // A subsequent access after dispose still returns undefined and opens nothing persistent.
    const after = await injection.getPersistedInjection(sessionId, 0);
    expect(after).toBeUndefined();
    // No handle cached: a second close is a clean no-op (would throw on a double-closed handle).
    expect(() => injection.closeInjectionDatabases()).not.toThrow();
  });

  it('R9 control: with NO persisted injection row, first message DOES inject profile', async () => {
    const sessionId = 'session-fresh-' + crypto.randomUUID();
    touchedSessions.add(sessionId);
    const now = Date.now();
    db.prepare(
      `INSERT INTO memory_profile (scope, workspace, section, content, updated_at) VALUES ('project', ?, 'static', ?, ?)`,
    ).run(WORKSPACE, 'The user prefers functional TypeScript.', now);

    const { injection } = makeManager(db);
    const { metadata } = await injection.buildMemoryCatalog(sessionId, WORKSPACE, null, undefined);
    expect(metadata!.hasProfile).toBe(true);

    injection.closeInjectionDatabases();
  });

  it('R11: rerank pool includes ≥2 entries from every non-empty group', async () => {
    const sessionId = 'session-pool';
    touchedSessions.add(sessionId);
    // 4 populated groups, each with several members.
    for (let i = 0; i < 5; i++) {
      seed(db, { kind: 'fact', scope: 'session', sessionId, content: `session note ${i}`, workspace: null });
      seed(db, { kind: 'fact', scope: 'project', content: `project note ${i}`, workspace: WORKSPACE });
      seed(db, { kind: 'fact', scope: 'global', content: `global note ${i}` });
      seed(db, { kind: 'observation', scope: 'project', title: `Obs ${i}`, content: `observation ${i}`, workspace: WORKSPACE });
    }

    const { injection, handle } = makeManager(db);
    // A userPrompt + blocking injectMode triggers the rerank path; override rerank.injectMode via a spy.
    const cfgSpy = vi.spyOn(vscode.workspace, 'getConfiguration');
    cfgSpy.mockImplementation((() => ({
      get: (key: string, defaultValue?: unknown) =>
        key === 'rerank.injectMode' ? 'blocking' : defaultValue,
      update: () => Promise.resolve(),
    })) as unknown as typeof vscode.workspace.getConfiguration);

    try {
      await injection.buildMemoryCatalog(sessionId, WORKSPACE, null, 'note observation');
    } finally {
      cfgSpy.mockRestore();
    }

    const rerankCall = handle.run.mock.calls.find(
      ([req]) => (req as MemorySubCallRequest).purpose === 'rerank',
    );
    expect(rerankCall).toBeDefined();
    const items = parseRerankItems((rerankCall![0] as MemorySubCallRequest).prompt);

    const countFor = (needle: string) => items.filter(it => it.snippet.includes(needle)).length;
    expect(countFor('session note')).toBeGreaterThanOrEqual(2);
    expect(countFor('project note')).toBeGreaterThanOrEqual(2);
    expect(countFor('global note')).toBeGreaterThanOrEqual(2);
    const obsRows = db.prepare("SELECT id FROM memories WHERE kind = 'observation'").all() as Array<{ id: string }>;
    const obsIds = new Set(obsRows.map(r => r.id));
    expect(items.filter(it => obsIds.has(it.id)).length).toBeGreaterThanOrEqual(2);
  });

  it('M1: a malformed rerank shape keeps BM25 order and does not throw', async () => {
    const sessionId = 'session-malformed-rerank';
    touchedSessions.add(sessionId);
    for (let i = 0; i < 3; i++) {
      seed(db, { kind: 'fact', scope: 'project', content: `project note ${i}`, workspace: WORKSPACE });
    }

    const handle = makeRunner();
    handle.run.mockImplementation(async (req: MemorySubCallRequest) => {
      if (req.purpose === 'rerank') return { value: { garbage: 'no results field' } };
      return { value: { static: 's', dynamic: 'd' } };
    });
    const profileManager = new ProfileManager(db, new MemoryWriteQueue(), handle.runner);
    const injection = new InjectionManager(db, profileManager, handle.runner);
    openManagers.add(injection);

    const cfgSpy = vi.spyOn(vscode.workspace, 'getConfiguration');
    cfgSpy.mockImplementation((() => ({
      get: (key: string, defaultValue?: unknown) =>
        key === 'rerank.injectMode' ? 'blocking' : defaultValue,
      update: () => Promise.resolve(),
    })) as unknown as typeof vscode.workspace.getConfiguration);

    try {
      const { context } = await injection.buildMemoryCatalog(sessionId, WORKSPACE, null, 'project note');
      expect(context).toContain('project note');
    } finally {
      cfgSpy.mockRestore();
    }
  });

  it('R14: every catalog entry string contains its [id], including short entries', async () => {
    seed(db, { id: 'short-1', content: 'tiny', workspace: WORKSPACE });
    seed(db, { id: 'short-2', content: 'also short', scope: 'global' });
    seed(db, { id: 'obs-1', kind: 'observation', title: 'An observation', content: 'body', workspace: WORKSPACE });

    const { injection } = makeManager(db);
    const { context } = await injection.buildMemoryCatalog(null, WORKSPACE, null, undefined);

    const entries = allEntryStrings(context);
    expect(entries.length).toBeGreaterThan(0);
    for (const line of entries) {
      expect(line).toMatch(/\[[^\]]+\]/); // contains a [id] token
    }
    expect(context).toContain('[short-1]');
    expect(context).toContain('[short-2]');
    expect(context).toContain('[obs-1]');
  });

  it('R15: a large-then-small pinned set still injects the small entry (continue, not break)', async () => {
    // pinnedTokenBudget=500. A ~2400-char entry (~600 tokens) alone exceeds it; `break` would drop
    // the tiny entry after it, `continue` keeps it.
    const bigContent = 'x'.repeat(2400);
    seed(db, { id: 'pinned-big', content: bigContent, workspace: WORKSPACE, pinned: 1, updatedAt: Date.now() });
    seed(db, { id: 'pinned-small', content: 'small pinned note', workspace: WORKSPACE, pinned: 1, updatedAt: Date.now() - 1000 });

    const { injection } = makeManager(db);
    const { context, metadata } = await injection.buildMemoryCatalog(null, WORKSPACE, null, undefined);

    const pinnedIds = new Set(metadata!.pinnedEntries.map(e => e.id));
    expect(pinnedIds.has('pinned-small')).toBe(true);
    expect(pinnedIds.has('pinned-big')).toBe(false); // over-budget, skipped
    expect(context).toContain('[pinned-small]');
    expect(metadata!.pinnedTokensUsed).toBeLessThanOrEqual(metadata!.pinnedBudget);
  });
});

describe('enforceTokenBudget — respects rerank relevance over raw BM25 score (deep nit)', () => {
  interface MiniScored {
    memory: { id: string };
    score: number;
    estimatedTokens: number;
    rerankRelevance?: 'high' | 'medium' | 'low';
  }
  const mk = (id: string, score: number, tokens: number, rel?: 'high' | 'medium' | 'low'): MiniScored =>
    ({ memory: { id }, score, estimatedTokens: tokens, ...(rel ? { rerankRelevance: rel } : {}) });

  function idsOf(g: ReturnType<typeof injectionInternals.enforceTokenBudget>): Set<string> {
    const out = new Set<string>();
    for (const label of ['session', 'project', 'global', 'observations'] as const) {
      for (const s of g[label]) out.add((s.memory as { id: string }).id);
    }
    return out;
  }

  it('drops a high-BM25 ungraded entry before a rerank-promoted low-BM25 one', () => {
    // Budget fits exactly one 100-token entry. Without the fix, the low-BM25 'promoted' (rerank=high)
    // would be dropped first by raw score; with the fix, the ungraded high-BM25 'raw' is dropped.
    const groups = {
      session: [] as MiniScored[],
      project: [mk('promoted', 0.1, 100, 'high'), mk('raw', 0.9, 100)],
      global: [] as MiniScored[],
      observations: [] as MiniScored[],
    };
    const result = injectionInternals.enforceTokenBudget(
      groups as unknown as Parameters<typeof injectionInternals.enforceTokenBudget>[0],
      100,
    );
    const kept = idsOf(result);
    expect(kept.has('promoted')).toBe(true);
    expect(kept.has('raw')).toBe(false);
  });

  it('is a no-op when everything already fits', () => {
    const groups = {
      session: [mk('a', 0.5, 10)],
      project: [mk('b', 0.4, 10, 'low')],
      global: [] as MiniScored[],
      observations: [] as MiniScored[],
    };
    const result = injectionInternals.enforceTokenBudget(
      groups as unknown as Parameters<typeof injectionInternals.enforceTokenBudget>[0],
      1000,
    );
    expect(idsOf(result)).toEqual(new Set(['a', 'b']));
  });
});
