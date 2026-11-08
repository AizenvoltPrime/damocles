import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

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
import { createFakePlatform, type FakeFileWatcherFactory } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { installPlatform } from '../../platform-host';
import { CREDENTIAL_CLIENT_ABSENT, USER_SCOPE_UNAVAILABLE } from '../../../shared/remote-user';
import { globalMemoryChangeReason, globalMemoryClosedReason, globalMemoryReadReason, globalMemoryUnavailableReason } from '../../user-scope';
import { buildMemoryPiTools } from '../../pi-session/tools/memory-tools';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { englishText } from '../../../shared/localized-text';
import { createTestDbPath } from './test-helpers';
import { applyDecaySweep, promoteEpisodes, purgeForgottenRows, EPISODE_PROMOTE_ACCESS } from '../dedup-decay';
import { getUnexpandedMemoryRows } from '../database';
import { beginAuditRun, gradesToProposals, runAudit, type AuditRunDeps } from '../audit';
import { QUALITY_AUDIT_FORGET_REASON } from '../../../shared/types/memory-audit';
import { readLiveInjections } from '../../pi-session/live-injections';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemoryWriteQueue } from '../write-queue';
import type { FactGraphManager } from '../managers/fact-graph-manager';
import type { ObservationManager } from '../managers/observation-manager';
import type { FileChangeTracker } from '../managers/file-change-tracker';
import type { ProfileManager } from '../managers/profile-manager';

// On a daemon's core global memory is the client's: it relays there or waits in the client's outbox, and is never written here.
const WORKSPACE = '/srv/app';
let service: MemoryService;
let fileWatchers: FakeFileWatcherFactory;
let fake: ReturnType<typeof createFakeRemoteHost>;
let outboxDir: string;

const globalRows = (): number => {
  const raw = new DatabaseSync(dbHolder.path);
  try {
    return (raw.prepare("SELECT count(*) AS n FROM memories WHERE scope = 'global'").get() as { n: number }).n;
  } finally {
    raw.close();
  }
};

beforeEach(async () => {
  dbHolder.path = createTestDbPath();
  fake = createFakeRemoteHost();
  const platform = { ...createFakePlatform(), remote: fake.remote };
  fileWatchers = platform.fileWatchers;
  installPlatform(platform);
  outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  service = new MemoryService({ ...platform, outboxDir });
  service.setWorkspaceRoots([WORKSPACE]);
  await service.ensureInitialized();
});

afterEach(async () => {
  await service.dispose();
  installPlatform(createFakePlatform());
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

describe('global memory on a daemon\'s core', () => {
  it('writes a global save and a note on the attached client, and no global row here', async () => {
    const saved = await service.saveMemory({ content: 'the user prefers tabs', kind: 'preference', scope: 'global' });
    await service.addNote('a note');
    const writes = vi.mocked(fake.remote.memoryApply).mock.calls.map(([clientId, entries]) => [clientId, entries.map((entry) => [entry.write.kind, entry.write.content])]);
    expect(writes).toEqual([['client-a', [['preference', 'the user prefers tabs']]], ['client-a', [['note', 'a note']]]]);
    expect(saved?.id).toBe(`global:client-a:${vi.mocked(fake.remote.memoryApply).mock.calls[0]![1][0]!.write.uuid}`);
    expect(globalRows()).toBe(0);
  });

  it('holds a global save in the client\'s outbox while the client is away, and no global row here', async () => {
    fake.set('clientAuth', 'client-a', undefined);
    await service.saveMemory({ content: 'the user prefers tabs', kind: 'preference', scope: 'global' });
    expect(fake.remote.memoryApply).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(outboxDir, 'client-a.jsonl'), 'utf8')).toContain('the user prefers tabs');
    expect(globalRows()).toBe(0);
  });

  it('keeps project memories working on the target', async () => {
    const saved = await service.saveMemory({ content: 'the build uses esbuild', kind: 'fact', scope: 'project', workspace: WORKSPACE });
    expect(saved).toMatchObject({ scope: 'project', workspace: WORKSPACE });
  });

  it('aborts any write path that would add a global row through its connection', async () => {
    const db = (service as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    const now = Date.now();
    expect(() => db.prepare("INSERT INTO memories (id, scope, kind, content, content_hash, created_at, updated_at) VALUES (?, 'global', 'fact', 'x', 'h', ?, ?)").run(crypto.randomUUID(), now, now)).toThrow(USER_SCOPE_UNAVAILABLE);
    const project = await service.saveMemory({ content: 'rescope me', kind: 'fact', scope: 'project', workspace: WORKSPACE });
    expect(() => db.prepare("UPDATE memories SET scope = 'global', workspace = NULL WHERE id = ?").run(project!.id)).toThrow(USER_SCOPE_UNAVAILABLE);
    expect(() => db.prepare("INSERT INTO memory_profile (scope, workspace, section, content, updated_at) VALUES ('global', '', 'static', 'x', ?)").run(now)).toThrow(USER_SCOPE_UNAVAILABLE);
    expect(globalRows()).toBe(0);
  });

  it('aborts any statement that would change or delete a global row the target already holds', () => {
    const raw = new DatabaseSync(dbHolder.path);
    const now = Date.now();
    const id = crypto.randomUUID();
    raw.prepare("INSERT INTO memories (id, scope, kind, content, content_hash, created_at, updated_at) VALUES (?, 'global', 'fact', 'kept', 'h', ?, ?)").run(id, now, now);
    raw.prepare("INSERT INTO memory_profile (scope, workspace, section, content, updated_at) VALUES ('global', '', 'static', 'kept', ?)").run(now);
    raw.close();
    const db = (service as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    expect(() => db.prepare("UPDATE memories SET content = 'changed' WHERE id = ?").run(id)).toThrow(USER_SCOPE_UNAVAILABLE);
    expect(() => db.prepare("UPDATE memories SET scope = 'project', workspace = ? WHERE id = ?").run(WORKSPACE, id)).toThrow(USER_SCOPE_UNAVAILABLE);
    expect(() => db.prepare('DELETE FROM memories WHERE id = ?').run(id)).toThrow(USER_SCOPE_UNAVAILABLE);
    expect(() => db.prepare("UPDATE memory_profile SET scope = 'project', workspace = ? WHERE scope = 'global'").run(WORKSPACE)).toThrow(USER_SCOPE_UNAVAILABLE);
    expect(() => db.prepare("DELETE FROM memory_profile WHERE scope = 'global'").run()).toThrow(USER_SCOPE_UNAVAILABLE);
    expect(globalRows()).toBe(1);
  });

  it('answers a global-only search with the closed reason while no client is attached, and reads no global row the target holds', async () => {
    const raw = new DatabaseSync(dbHolder.path);
    const now = Date.now();
    raw.prepare("INSERT INTO memories (id, scope, kind, content, content_hash, created_at, updated_at) VALUES (?, 'global', 'fact', 'kiwi orchard notes', 'h1', ?, ?)").run(crypto.randomUUID(), now, now);
    raw.close();
    await service.saveMemory({ content: 'kiwi build cache', kind: 'fact', scope: 'project', workspace: WORKSPACE });
    fake.set('clientAuth', 'client-a', undefined);
    await expect(service.searchMemories({ query: 'kiwi', tiers: ['global'] })).rejects.toThrow(englishText(globalMemoryClosedReason()));
    const results = await service.searchMemories({ query: 'kiwi', workspace: WORKSPACE });
    expect(results.map((result) => result.tier)).toEqual(['project']);
    expect(service.getPanelMemories(null, WORKSPACE).map((entry) => entry.scope)).toEqual(['project']);
  });

  describe('with global rows the target already holds', () => {
    let globalId: string;
    let noteId: string;
    let projectId: string;
    const globalRow = (id: string): Record<string, unknown> => {
      const raw = new DatabaseSync(dbHolder.path);
      try {
        return raw.prepare('SELECT content, forgotten, pinned, access_count FROM memories WHERE id = ?').get(id) as Record<string, unknown>;
      } finally {
        raw.close();
      }
    };

    beforeEach(async () => {
      globalId = crypto.randomUUID();
      noteId = crypto.randomUUID();
      const raw = new DatabaseSync(dbHolder.path);
      const now = Date.now();
      raw.prepare("INSERT INTO memories (id, scope, kind, content, content_hash, created_at, updated_at) VALUES (?, 'global', 'fact', 'kiwi orchard notes', 'h1', ?, ?)").run(globalId, now, now);
      raw.prepare("INSERT INTO memories (id, scope, kind, content, content_hash, created_at, updated_at) VALUES (?, 'global', 'note', 'kiwi note', 'h2', ?, ?)").run(noteId, now, now);
      raw.close();
      projectId = (await service.saveMemory({ content: 'kiwi build cache', kind: 'fact', scope: 'project', workspace: WORKSPACE }))!.id;
      const edges = new DatabaseSync(dbHolder.path);
      edges.prepare("INSERT INTO memory_edges (id, kind, source_id, target_id, created_at) VALUES (?, 'EXTENDS', ?, ?, ?)").run(crypto.randomUUID(), projectId, globalId, now);
      edges.close();
    });

    it("lists the acting client's notes through its relay and none of the target's own global rows", async () => {
      vi.mocked(fake.remote.memoryList).mockResolvedValueOnce({ rows: [{ id: 'n1', kind: 'note', content: 'their note', contentHash: 'h', tags: ['work'], createdAt: 2, updatedAt: 3, forgotten: true }] });
      const notes = await service.listNotes(['work']);
      expect(notes).toEqual([expect.objectContaining({ id: 'global:client-a:n1', tier: 'note', scope: 'global', content: 'their note', tags: ['work'], forgotten: true })]);
      expect(fake.remote.memoryList).toHaveBeenCalledWith('client-a', { kinds: ['note'], tags: ['work'] });
      expect(notes.map((note) => note.id)).not.toContain(noteId);
    });

    it('answers the notes list with the closed reason while no client is attached', async () => {
      fake.set('clientAuth', 'client-a', undefined);
      await expect(service.listNotes()).rejects.toThrow(englishText(globalMemoryClosedReason()));
      expect(fake.remote.memoryList).not.toHaveBeenCalled();
    });

    it("refuses this computer's user-scope reads, which a remote chat's page makes only of this computer's core", () => {
      expect(() => service.userScopeMemories()).toThrow(USER_SCOPE_UNAVAILABLE);
      expect(() => service.isUserScopeRow(globalId)).toThrow(USER_SCOPE_UNAVAILABLE);
      expect(() => service.userScopeHistory(globalId)).toThrow(USER_SCOPE_UNAVAILABLE);
      expect(() => service.userScopeRelated(globalId)).toThrow(USER_SCOPE_UNAVAILABLE);
    });

    it('refuses the history and the neighbours of a global row, and leaves global neighbours out of a project row\'s', () => {
      expect(() => service.getMemoryHistory(globalId)).toThrow(USER_SCOPE_UNAVAILABLE);
      expect(() => service.getRelatedMemories(globalId)).toThrow(USER_SCOPE_UNAVAILABLE);
      expect(service.getMemoryHistory(projectId).map((entry) => entry.id)).toEqual([projectId]);
      expect(service.getRelatedMemories(projectId)).toEqual([]);
    });

    it('refuses every change that names a global row by id, and changes none', async () => {
      await expect(service.forgetMemory(globalId, 'chain', true)).rejects.toThrow(USER_SCOPE_UNAVAILABLE);
      await expect(service.forgetMemory(globalId, 'version')).rejects.toThrow(USER_SCOPE_UNAVAILABLE);
      await expect(service.unforgetMemory(globalId)).rejects.toThrow(USER_SCOPE_UNAVAILABLE);
      await expect(service.pinMemory(globalId)).rejects.toThrow(USER_SCOPE_UNAVAILABLE);
      await expect(service.unpinMemory(globalId)).rejects.toThrow(USER_SCOPE_UNAVAILABLE);
      await expect(service.updateMemory(globalId, 'rewritten')).rejects.toThrow(USER_SCOPE_UNAVAILABLE);
      await expect(service.updateMemory(noteId, 'rewritten')).rejects.toThrow(USER_SCOPE_UNAVAILABLE);
      await expect(service.deleteMemory(globalId)).rejects.toThrow(USER_SCOPE_UNAVAILABLE);
      expect(globalRow(globalId)).toEqual({ content: 'kiwi orchard notes', forgotten: 0, pinned: 0, access_count: 0 });
      expect(globalRow(noteId)).toMatchObject({ content: 'kiwi note' });
    });

    it('forgets by content only among the rows it may read', async () => {
      const forgotten = await service.forgetMemory('kiwi orchard notes', 'version');
      expect(forgotten.forgotten).toBe(1);
      expect(globalRow(globalId)).toMatchObject({ forgotten: 0 });
      expect(globalRow(projectId)).toMatchObject({ forgotten: 1 });
    });

    it('returns and counts no global row among the details asked for', async () => {
      expect((await service.getMemoryDetails([globalId, projectId])).map((entry) => entry.id)).toEqual([projectId]);
      expect(globalRow(globalId)).toMatchObject({ access_count: 0 });
    });

    it('gives a search the project results it asks for, with no global row taking a slot', async () => {
      const results = await service.searchMemories({ query: 'kiwi', workspace: WORKSPACE, limit: 1 });
      expect(results.map((result) => result.id)).toEqual([projectId]);
    });
  });

  describe('a relayed global id, which names a row of the client', () => {
    const relayed = `global:client-a:${crypto.randomUUID()}`;
    const reason = englishText(globalMemoryChangeReason());
    let target: string;
    const state = (): Record<string, unknown> => {
      const raw = new DatabaseSync(dbHolder.path);
      try {
        return raw.prepare('SELECT content, forgotten, pinned FROM memories WHERE id = ?').get(target) as Record<string, unknown>;
      } finally {
        raw.close();
      }
    };

    beforeEach(async () => {
      // a target row the content match of "global" would hit
      target = (await service.saveMemory({ content: 'the global npm install lives in /usr/local', kind: 'fact', scope: 'project', workspace: WORKSPACE }))!.id;
    });

    afterEach(() => {
      expect(state()).toEqual({ content: 'the global npm install lives in /usr/local', forgotten: 0, pinned: 0 });
    });

    it('forgets nothing on the target and answers the reason', async () => {
      await expect(service.forgetMemory(relayed, 'chain')).rejects.toThrow(reason);
      await expect(service.forgetMemory(relayed, 'version', true)).rejects.toThrow(reason);
    });

    it('edits nothing and answers the reason', async () => {
      await expect(service.updateMemory(relayed, 'rewritten')).rejects.toThrow(reason);
    });

    it('restores nothing and answers the reason', async () => {
      await expect(service.unforgetMemory(relayed)).rejects.toThrow(reason);
    });

    it('pins and unpins nothing and answers the reason', async () => {
      await expect(service.pinMemory(relayed)).rejects.toThrow(reason);
      await expect(service.unpinMemory(relayed)).rejects.toThrow(reason);
    });

    it('answers its history with the reason to look at it on the computer', () => {
      expect(() => service.getMemoryHistory(relayed)).toThrow(englishText(globalMemoryReadReason()));
    });

    it('answers its neighbours with the reason to look at it on the computer', () => {
      expect(() => service.getRelatedMemories(relayed)).toThrow(englishText(globalMemoryReadReason()));
    });

    it('resets no staleness and answers the reason', async () => {
      await expect(service.resetObservationStaleness(relayed)).rejects.toThrow(reason);
    });

    it('deletes nothing and answers the reason', async () => {
      await expect(service.deleteMemory(relayed)).rejects.toThrow(reason);
    });

    it('answers the model\'s forget_memory with the reason', async () => {
      const tools = buildMemoryPiTools({ pi: { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule, memoryService: service, getSessionId: () => 'sess-1', workspace: WORKSPACE }) as unknown as Array<{ name: string; execute: (id: string, input: Record<string, unknown>) => Promise<unknown> }>;
      const forget = tools.find((tool) => tool.name === 'ForgetMemory')!;
      await expect(forget.execute('call-1', { target: relayed })).rejects.toThrow(reason);
    });
  });

  it('reads and writes no global profile', async () => {
    expect(service.getProfile('global', '')).toEqual({ static: '', dynamic: '' });
    expect(await service.setProfileSection('global', '', 'static', 'x')).toBe(false);
  });

  describe('maintenance and every other write path leave the target\'s global rows alone', () => {
    interface Internals {
      db: DatabaseInstance;
      writeQueue: MemoryWriteQueue;
      factGraph: FactGraphManager;
      observationManager: ObservationManager;
      fileChangeTracker: FileChangeTracker;
    }
    const internals = (): Internals => service as unknown as Internals;
    const DAY = 24 * 60 * 60 * 1000;

    const raw = <T>(use: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(dbHolder.path);
      try {
        return use(db);
      } finally {
        db.close();
      }
    };
    const insertMemory = (fields: Record<string, SQLInputValue>): string => {
      const id = crypto.randomUUID();
      const now = Date.now();
      const row: Record<string, SQLInputValue> = { id, kind: 'fact', content: `memory ${id}`, content_hash: id, created_at: now, updated_at: now, ...fields };
      const cols = Object.keys(row);
      raw((db) => db.prepare(`INSERT INTO memories (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row)));
      return id;
    };
    const both = (fields: Record<string, SQLInputValue>): { global: string; project: string } => ({
      global: insertMemory({ scope: 'global', ...fields }),
      project: insertMemory({ scope: 'project', workspace: WORKSPACE, ...fields }),
    });
    const row = (id: string): MemoryRow | undefined => raw((db) => db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined);

    it('decays only project episodes', async () => {
      const ids = both({ kind: 'episode', forget_after: Date.now() - DAY });
      expect(await applyDecaySweep(internals().db, internals().writeQueue)).toEqual({ forgotten: 1 });
      expect(row(ids.global)?.forgotten).toBe(0);
      expect(row(ids.project)?.forgotten).toBe(1);
    });

    it('promotes only project episodes', async () => {
      const ids = both({ kind: 'episode', forget_after: Date.now() + DAY, access_count: EPISODE_PROMOTE_ACCESS });
      expect(await promoteEpisodes(internals().db, internals().writeQueue)).toEqual({ promoted: 1 });
      expect(row(ids.global)?.forget_after).not.toBeNull();
      expect(row(ids.project)?.forget_after).toBeNull();
    });

    it('purges only project rows', async () => {
      const old = Date.now() - 200 * DAY;
      const ids = both({ forgotten: 1, forget_reason: 'merged', created_at: old, updated_at: old });
      expect(await purgeForgottenRows(internals().db, internals().writeQueue)).toEqual({ purged: 1 });
      expect(row(ids.global)).toBeDefined();
      expect(row(ids.project)).toBeUndefined();
    });

    it('re-checks only project conflicts', async () => {
      const ids = both({ needs_conflict_check: 1 });
      expect(await internals().factGraph.sweepConflictChecks()).toBe(1);
      expect(row(ids.global)?.needs_conflict_check).toBe(1);
      expect(row(ids.project)?.needs_conflict_check).toBe(0);
    });

    it('backfills search terms only for project rows', () => {
      const ids = both({});
      expect(getUnexpandedMemoryRows(internals().db, 10).map((r) => r.id)).toEqual([ids.project]);
    });

    it('normalizes stored paths only on project rows', async () => {
      const ids = both({ kind: 'observation', files_read: JSON.stringify(['src\\a.ts']) });
      await internals().writeQueue.run(() => internals().observationManager.normalizeStoredFilePaths());
      expect(row(ids.global)?.files_read).toBe(JSON.stringify(['src\\a.ts']));
      expect(row(ids.project)?.files_read).toBe(JSON.stringify(['src/a.ts']));
    });

    it('moves only project rows to a renamed session', async () => {
      const ids = both({ session_id: 'old-session' });
      await service.migrateSessionId('old-session', 'new-session');
      expect(row(ids.global)?.session_id).toBe('old-session');
      expect(row(ids.project)?.session_id).toBe('new-session');
    });

    it('counts a file change only on project observations', async () => {
      const file = `${WORKSPACE}/src/a.ts`;
      const ids = both({ kind: 'observation', workspace: WORKSPACE, files_read: JSON.stringify([file]) });
      internals().fileChangeTracker.setWorkspaceRoots([WORKSPACE]);
      fileWatchers.fireRename([{ oldPath: file, newPath: `${WORKSPACE}/src/b.ts` }]);
      await new Promise((resolve) => setImmediate(resolve));
      await internals().writeQueue.run(() => undefined);
      expect(row(ids.global)?.file_change_count).toBe(0);
      expect(row(ids.project)?.file_change_count).toBe(1);
    });

    it('refuses to reset a global observation\'s staleness with the reason', async () => {
      const id = insertMemory({ scope: 'global', kind: 'observation', file_change_count: 3 });
      await expect(service.resetObservationStaleness(id)).rejects.toThrow(englishText(globalMemoryUnavailableReason()));
      expect(row(id)?.file_change_count).toBe(3);
    });

    it('prunes only the project buckets\' old retrievals', async () => {
      const ids = both({});
      const old = Date.now() - 40 * DAY;
      raw((db) => db.prepare("INSERT INTO memory_retrievals (memory_id, workspace, retrieved_at) VALUES (?, '__damocles_global_scope__', ?), (?, ?, ?)")
        .run(ids.global, old, ids.project, WORKSPACE, old));
      await service.recordRetrievals([ids.project], WORKSPACE);
      expect(raw((db) => db.prepare('SELECT memory_id FROM memory_retrievals WHERE retrieved_at = ?').all(old))).toEqual([{ memory_id: ids.global }]);
    });

    it('injects no global row for a mentioned id, its own or a chain head\'s', async () => {
      const mentionedGlobal = insertMemory({ scope: 'global', content: 'kiwi orchard secret' });
      const oldVersion = insertMemory({ scope: 'project', workspace: WORKSPACE, is_latest: 0, content: 'kiwi build cache first' });
      insertMemory({ scope: 'global', content: 'kiwi global head', root_id: oldVersion, parent_id: oldVersion, version: 2 });
      const result = await service.buildInjectionContext({
        sessionId: null,
        workspace: WORKSPACE,
        activeFile: null,
        prompt: `compare ${mentionedGlobal} with ${oldVersion}`,
        live: readLiveInjections([]),
        promptIndex: 0,
      });
      expect(result?.text).not.toContain('kiwi orchard secret');
      expect(result?.text).not.toContain('kiwi global head');
      expect(result?.mentionedIds).toEqual([oldVersion]);
    });

    it('injects only the project rows this target pins, never a global row it holds pinned', async () => {
      insertMemory({ scope: 'global', pinned: 1, content: 'kiwi pinned global' });
      insertMemory({ scope: 'project', workspace: WORKSPACE, pinned: 1, content: 'kiwi pinned project' });
      const result = await service.buildInjectionContext({ sessionId: null, workspace: WORKSPACE, activeFile: null, prompt: 'unrelated words', live: readLiveInjections([]), promptIndex: 0 });
      expect(result?.text).toContain('kiwi pinned project');
      expect(result?.text).not.toContain('kiwi pinned global');
    });

    describe('the quality audit', () => {
      let project: string;
      let global: string;
      let sibling: string;
      const now = Date.now();
      const state = (scope: string, forgotten = 0): Record<string, unknown> => ({
        scope, workspace: scope === 'project' ? WORKSPACE : null, session_id: null, kind: 'fact', forget_after: null,
        forgotten, forget_reason: forgotten ? QUALITY_AUDIT_FORGET_REASON : null,
      });
      const insertProposal = (fields: Record<string, SQLInputValue>): string => {
        const id = crypto.randomUUID();
        const proposal: Record<string, SQLInputValue> = { id, run_id: 'run-1', reason: 'r', status: 'pending', created_at: now, ...fields };
        const cols = Object.keys(proposal);
        raw((db) => db.prepare(`INSERT INTO memory_audit_proposals (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(proposal)));
        return id;
      };
      const memoryProposal = (id: string, action: string, before: Record<string, unknown>): Record<string, SQLInputValue> => ({
        memory_id: id, action, snapshot_hash: id, snapshot_updated_at: now, before_state: JSON.stringify(before),
      });
      const globalProfile = (): unknown => raw((db) => db.prepare("SELECT content FROM memory_profile WHERE scope = 'global'").get());

      beforeEach(() => {
        project = insertMemory({ scope: 'project', workspace: WORKSPACE, created_at: now, updated_at: now });
        global = insertMemory({ scope: 'global', created_at: now, updated_at: now });
        sibling = insertMemory({ scope: 'global', root_id: project, is_latest: 0 });
        raw((db) => {
          db.prepare("INSERT INTO memory_profile (scope, workspace, section, content, updated_at) VALUES ('global', '', 'static', 'likes tea', ?), ('project', ?, 'static', 'uses esbuild', ?)")
            .run(now, WORKSPACE, now);
          db.prepare("INSERT INTO memory_audit_runs (id, status, holder, heartbeat_at, started_at, finished_at, rubric_version) VALUES ('run-1', 'completed', 'another-core', ?, ?, ?, 1)")
            .run(now, now, now);
        });
      });

      it('grades and counts no global row or profile', async () => {
        expect((await service.getAuditState())?.estimate).toMatchObject({ memoryCount: 1, profileCount: 1 });
        expect(service.getAuditSummary()?.eligibleCount).toBe(1);
      });

      describe('a rescope to global', () => {
        const auditInternals = (): Internals & { profileManager: ProfileManager } => service as unknown as Internals & { profileManager: ProfileManager };
        const globals = (): { drain(clientId: string): Promise<void> } => (service as unknown as { globals: { drain(clientId: string): Promise<void> } }).globals;
        const outbox = (): string => fs.readFileSync(path.join(outboxDir, 'client-a.jsonl'), 'utf8');
        const rescope = (): string => insertProposal(memoryProposal(project, 'rescope_global', { row: state('project'), toClient: true }));

        it('is proposed, and recorded as a write to the accepting client', async () => {
          const grades = { grades: [{ id: project, verdict: 'rescope', targetScope: 'global', reason: 'about the user' }] };
          expect(gradesToProposals([row(project)!], grades, [WORKSPACE])).toMatchObject([{ action: 'rescope_global' }]);
          const { db, writeQueue, profileManager } = auditInternals();
          const deps: AuditRunDeps = { db, writeQueue, profileManager, runner: { run: async <T>() => ({ value: grades as T }) }, holder: 'this-core', knownWorkspaces: [WORKSPACE] };
          const plan = await beginAuditRun(deps);
          await runAudit(deps, plan!, new AbortController().signal, () => {});
          const proposal = raw((db) => db.prepare("SELECT before_state FROM memory_audit_proposals WHERE action = 'rescope_global' AND run_id = ?").get(plan!.runId)) as { before_state: string };
          expect(JSON.parse(proposal.before_state)).toMatchObject({ toClient: true, row: { scope: 'project' } });
          expect((await service.getAuditState())?.proposals).toMatchObject([{ action: 'rescope_global', memoryId: project, status: 'pending' }]);
        });

        it('writes the row on the attached client under the proposal\'s id and forgets the target\'s chain', async () => {
          const before = globalRows();
          const id = rescope();
          expect(await service.applyAudit('run-1', [id], [])).toEqual({ applied: 1, stale: 0, rejected: 0 });
          expect(vi.mocked(fake.remote.memoryApply).mock.calls).toEqual([['client-a', [{ end: 0, write: { uuid: id, kind: 'fact', content: `memory ${project}` } }]]]);
          expect(row(project)).toMatchObject({ scope: 'project', forgotten: 1, forget_reason: QUALITY_AUDIT_FORGET_REASON });
          expect(row(sibling)?.forgotten).toBe(0);
          expect(globalRows()).toBe(before);
          expect((await service.getAuditState())?.proposals).toMatchObject([{ id, status: 'applied' }]);
        });

        it('queues the row in the client\'s outbox while the client is away and forgets the target\'s chain', async () => {
          fake.set('clientAuth', 'client-a', undefined);
          const id = rescope();
          expect(await service.applyAudit('run-1', [id], [])).toEqual({ applied: 1, stale: 0, rejected: 0 });
          expect(fake.remote.memoryApply).not.toHaveBeenCalled();
          expect(outbox().trim().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([{ uuid: id, kind: 'fact', content: `memory ${project}` }]);
          expect(row(project)).toMatchObject({ forgotten: 1, forget_reason: QUALITY_AUDIT_FORGET_REASON });
        });

        it('reaches the client once however often it is applied and however its drain is cut', async () => {
          fake.set('clientAuth', 'client-a', undefined);
          const id = rescope();
          const results = await Promise.all([service.applyAudit('run-1', [id], []), service.applyAudit('run-1', [id], [])]);
          expect(results.sort((a, b) => a.applied - b.applied)).toEqual([{ applied: 0, stale: 0, rejected: 0 }, { applied: 1, stale: 0, rejected: 0 }]);
          // the client applies each uuid once, as memory_applied_writes makes it; the first drain is cut before its acknowledgement
          const applied = new Map<string, string>();
          let cut = true;
          vi.mocked(fake.remote.memoryApply).mockImplementation(async (_clientId, entries) => {
            for (const entry of entries) if (!applied.has(entry.write.uuid)) applied.set(entry.write.uuid, entry.write.content);
            if (cut) {
              cut = false;
              fake.set('clientAuth', 'client-a', undefined);
              throw new Error(CREDENTIAL_CLIENT_ABSENT);
            }
            return { through: entries.at(-1)!.end };
          });
          fake.set('clientAuth', 'client-a', { providers: {} });
          await globals().drain('client-a');
          expect(outbox()).toContain(id);
          fake.set('clientAuth', 'client-a', { providers: {} });
          await globals().drain('client-a');
          expect(vi.mocked(fake.remote.memoryApply)).toHaveBeenCalledTimes(2);
          expect([...applied]).toEqual([[id, `memory ${project}`]]);
          expect(fs.existsSync(path.join(outboxDir, 'client-a.jsonl'))).toBe(false);
        });

        it('records only the client and whether the write was queued as where it went', async () => {
          const id = rescope();
          await service.applyAudit('run-1', [id], []);
          const proposal = raw((db) => db.prepare('SELECT before_state FROM memory_audit_proposals WHERE id = ?').get(id)) as { before_state: string };
          expect((JSON.parse(proposal.before_state) as { wroteTo: unknown }).wroteTo).toEqual({ clientId: 'client-a', queued: false });
        });

        it('counts a proposal whose write the client refused as failed, keeps it pending, and applies the rest', async () => {
          const refused = rescope();
          const other = insertMemory({ scope: 'project', workspace: WORKSPACE, created_at: now, updated_at: now });
          const accepted = insertProposal(memoryProposal(other, 'rescope_global', { row: state('project'), toClient: true }));
          vi.mocked(fake.remote.memoryApply).mockRejectedValueOnce(new Error('the client refused the write'));
          expect(await service.applyAudit('run-1', [refused, accepted], [])).toEqual({ applied: 1, stale: 0, rejected: 0, failed: 1 });
          expect((await service.getAuditState())?.proposals).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: refused, status: 'pending' }),
            expect.objectContaining({ id: accepted, status: 'applied' }),
          ]));
          expect(row(project)?.forgotten).toBe(0);
          expect(row(other)?.forgotten).toBe(1);
        });

        it('is left in place by a revert, since the row lives on the client now', async () => {
          const id = rescope();
          await service.applyAudit('run-1', [id], []);
          expect(await service.revertAudit('run-1')).toEqual({ reverted: 0, skipped: 1 });
          expect(row(project)?.forgotten).toBe(1);
        });
      });

      it('shows, counts and applies only another core\'s proposals that touch no global row or profile', async () => {
        const forgetProject = insertProposal(memoryProposal(project, 'forget', { row: state('project') }));
        const hidden = [
          insertProposal(memoryProposal(global, 'forget', { row: state('global') })),
          insertProposal(memoryProposal(project, 'rescope_global', { row: state('project') })),
          insertProposal({
            action: 'profile_rewrite', profile_scope: 'global', profile_workspace: '',
            proposed_text: JSON.stringify({ static: 'likes coffee', dynamic: '' }),
            before_state: JSON.stringify({ profile: { static: { content: 'likes tea', updatedAt: now }, dynamic: null } }),
          }),
        ];
        expect((await service.getAuditState())?.proposals.map((p) => p.id)).toEqual([forgetProject]);
        expect(service.getAuditSummary()?.pendingCount).toBe(1);
        expect(await service.applyAudit('run-1', [...hidden, forgetProject], [])).toEqual({ applied: 1, stale: 0, rejected: 0 });
        expect(row(project)).toMatchObject({ scope: 'project', forgotten: 1 });
        expect(row(global)?.forgotten).toBe(0);
        expect(row(sibling)?.forgotten).toBe(0);
        expect(globalProfile()).toEqual({ content: 'likes tea' });
      });

      it('reverts another core\'s apply without restoring a global row', async () => {
        raw((db) => db.prepare('UPDATE memories SET forgotten = 1, forget_reason = ? WHERE id IN (?, ?)').run(QUALITY_AUDIT_FORGET_REASON, project, sibling));
        insertProposal({
          ...memoryProposal(project, 'forget', {
            row: state('project'),
            applied: state('project', 1),
            forgotten: [{ id: project, forget_reason: null }, { id: sibling, forget_reason: null }],
          }),
          status: 'applied',
          decided_at: now,
        });
        insertProposal({
          ...memoryProposal(global, 'rescope_global', { row: state('project'), applied: state('global') }),
          status: 'applied',
          decided_at: now,
        });
        expect(await service.revertAudit('run-1')).toEqual({ reverted: 1, skipped: 0 });
        expect(row(project)?.forgotten).toBe(0);
        expect(row(sibling)?.forgotten).toBe(1);
        expect(row(global)?.scope).toBe('global');
      });
    });
  });
});
