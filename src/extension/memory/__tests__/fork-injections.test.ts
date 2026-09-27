import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';

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
}));

import { MemoryService } from '../index';
import { openDatabaseAsync } from '../database';
import { deleteInjectionDatabaseFile } from '../injection-database';

function display(promptIndex: number): MemoryInjectionDisplay {
  return {
    version: 3,
    promptIndex,
    added: [],
    notices: [],
    carried: [],
    profile: { state: 'empty', tokens: 0, text: '' },
    compass: { state: 'disabled', text: '' },
    query: { terms: [`term-${promptIndex}`], dropped: [], mentionedIds: [], files: [] },
    gate: { considered: 0, passed: 0, unmatchedSkipped: 0, alreadyInContext: 0, overBudget: 0, preferencesDeferred: 0 },
    tokens: { memories: 0, notices: 0, profile: 0, compass: 0, total: 0, budget: 2000 },
    storeCounts: { session: 0, project: 0, global: 0, observations: 0, total: 0 },
    rerankApplied: false,
    exactText: `prompt ${promptIndex}`,
  };
}

describe('MemoryService.copySessionInjections', () => {
  let service: MemoryService;
  const sessionIds: string[] = [];
  const newSessionId = (): string => {
    const id = crypto.randomUUID();
    sessionIds.push(id);
    return id;
  };

  beforeEach(() => {
    dbHolder.path = path.join(os.tmpdir(), `damocles-fork-injections-${crypto.randomUUID()}.db`);
    vi.mocked(openDatabaseAsync).mockClear();
    service = new MemoryService('/ext');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    service.dispose();
    for (const id of sessionIds.splice(0)) await deleteInjectionDatabaseFile(id);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbHolder.path + suffix, { force: true });
  });

  it('gives the fork the records of the prompts it inherits and none after the fork point', async () => {
    const sourceId = newSessionId();
    const forkId = newSessionId();
    await service.ensureInitialized();
    for (const i of [0, 1, 2]) await service.persistMemoryInjection(sourceId, i, display(i));

    await expect(service.copySessionInjections(sourceId, forkId, 2)).resolves.toBe(2);

    expect(await service.getPersistedMemoryInjection(forkId, 0)).toEqual(display(0));
    expect(await service.getPersistedMemoryInjection(forkId, 1)).toEqual(display(1));
    expect(await service.getPersistedMemoryInjection(forkId, 2)).toBeUndefined();
  });

  it('copies nothing and never opens the store when memory is disabled', async () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation((() => ({
      get: (key: string, fallback?: unknown) => (key === 'enabled' ? false : fallback),
    })) as unknown as typeof vscode.workspace.getConfiguration);

    await expect(service.copySessionInjections(newSessionId(), newSessionId(), 3)).resolves.toBe(0);
    expect(openDatabaseAsync).not.toHaveBeenCalled();
  });
});
