import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTestMemoryDb } from './test-helpers';
import type { DatabaseInstance } from '../types';
import {
  sameWorkspace,
  matchKnownWorkspace,
  listKnownWorkspaces,
  workspaceContaining,
  attributeFilesToWorkspace,
} from '../workspaces';

const dbHolder = vi.hoisted(() => ({ path: '' }));
vi.mock('../database', async (importActual) => {
  const actual = await importActual<typeof import('../database')>();
  return {
    ...actual,
    openDatabaseAsync: vi.fn(async () => {
      const raw = new DatabaseSync(dbHolder.path, { timeout: 5000, enableForeignKeyConstraints: true });
      const db = actual.createDatabaseWrapper(raw);
      actual.runMigrations(db);
      return { db };
    }),
  };
});
vi.mock('../subcall-runner', () => ({
  createMemorySubCallRunner: () => ({ run: vi.fn(async () => ({ value: null, failure: 'no-model' as const })) }),
}));
vi.mock('../query-expansion', () => ({
  expandQuery: vi.fn(async () => [] as string[]),
  expandMemoryTerms: vi.fn(async () => [] as string[]),
  expandMemoryTermsWithStatus: vi.fn(async () => ({ terms: [] as string[], failed: false })),
  clearExpansionCache: vi.fn(() => {}),
}));

import { MemoryService } from '../index';
import { homeDirectory } from '../../workspace-folders/folder-registry';
import { createFakePlatform } from '../../../__mocks__/fake-platform';

describe('sameWorkspace', () => {
  it('ignores separators and trailing slashes, and case only on win32', () => {
    expect(sameWorkspace('c:\\GameDev\\damocles', 'C:/gamedev/damocles/', 'win32')).toBe(true);
    expect(sameWorkspace('/home/a/Repo', '/home/a/repo', 'linux')).toBe(false);
    expect(sameWorkspace('/home/a/repo/', '/home/a/repo', 'linux')).toBe(true);
  });

  it('matchKnownWorkspace returns the known spelling', () => {
    expect(matchKnownWorkspace('C:/GameDev/Damocles', ['c:\\GameDev\\damocles'], 'win32')).toBe('c:\\GameDev\\damocles');
    expect(matchKnownWorkspace('C:/GameDev/other', ['c:\\GameDev\\damocles'], 'win32')).toBeNull();
  });
});

describe('listKnownWorkspaces', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  function seed(id: string, workspace: string | null, forgotten = 0): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (id, kind, scope, content, content_hash, workspace, is_latest, forgotten, created_at, updated_at)
       VALUES (?, 'fact', 'project', 'c', ?, ?, 1, ?, ?, ?)`,
    ).run(id, id, workspace, forgotten, now, now);
  }

  it('lists live stored workspaces that still exist, then open folders not already listed', () => {
    seed('a', 'c:\\GameDev\\damocles');
    seed('b', 'c:\\GameDev\\gone');
    seed('c', 'c:\\GameDev\\forgotten', 1);
    seed('d', null);
    const exists = (p: string): boolean => p !== 'c:\\GameDev\\gone';

    expect(listKnownWorkspaces(db, ['C:/GameDev/damocles', 'c:\\GameDev\\new'], [], 'win32', exists)).toEqual([
      'c:\\GameDev\\damocles',
      'c:\\GameDev\\new',
    ]);
  });

  it('leaves out a non-project folder, stored or open, without checking that it exists', () => {
    seed('a', 'c:\\Users\\me');
    seed('b', 'c:\\GameDev\\damocles');
    const exists = vi.fn((p: string): boolean => p.length > 0);

    expect(listKnownWorkspaces(db, ['C:/Users/me/'], ['C:/Users/me'], 'win32', exists)).toEqual(['c:\\GameDev\\damocles']);
    expect(exists).toHaveBeenCalledTimes(1);
  });
});

describe('workspace attribution by files', () => {
  const known = ['c:\\GameDev\\damocles', 'c:\\GameDev\\psychic_smash', 'c:\\GameDev\\psychic_smash\\tools'];

  it('workspaceContaining picks the deepest known folder that holds the file', () => {
    expect(workspaceContaining('C:/GameDev/psychic_smash/tools/a.py', known, 'win32')).toBe('c:\\GameDev\\psychic_smash\\tools');
    expect(workspaceContaining('C:/GameDev/psychic_smash/src/gpu.cs', known, 'win32')).toBe('c:\\GameDev\\psychic_smash');
    expect(workspaceContaining('C:/GameDev/psychic_smashed/x.cs', known, 'win32')).toBeNull();
  });

  it('files under exactly one other workspace attribute there', () => {
    const files = ['C:/GameDev/psychic_smash/src/a.cs', 'c:\\GameDev\\psychic_smash\\src\\b.cs'];
    expect(attributeFilesToWorkspace(files, 'c:\\GameDev\\damocles', () => known, 'win32')).toBe('c:\\GameDev\\psychic_smash');
  });

  it('mixed, relative, unknown or current-workspace files keep the current workspace', () => {
    const current = 'c:\\GameDev\\damocles';
    expect(attributeFilesToWorkspace(['C:/GameDev/psychic_smash/a.cs', 'C:/GameDev/damocles/b.ts'], current, () => known, 'win32')).toBeNull();
    expect(attributeFilesToWorkspace(['C:/GameDev/psychic_smash/a.cs', 'src/b.ts'], current, () => known, 'win32')).toBeNull();
    expect(attributeFilesToWorkspace(['D:/elsewhere/a.cs'], current, () => known, 'win32')).toBeNull();
    expect(attributeFilesToWorkspace(['C:/GameDev/damocles/b.ts'], current, () => known, 'win32')).toBeNull();
    expect(attributeFilesToWorkspace([], current, () => known, 'win32')).toBeNull();
  });

  it('keeps files under a nested known workspace in the current one, without listing the known set', () => {
    const list = vi.fn(() => ['c:\\repo', 'c:\\repo\\packages\\a']);
    expect(attributeFilesToWorkspace(['C:/repo/packages/a/src/x.ts'], 'c:\\repo', list, 'win32')).toBeNull();
    expect(attributeFilesToWorkspace(['src/x.ts'], 'c:\\repo', list, 'win32')).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('moves files outside the current workspace to the parent workspace that holds them', () => {
    const nested = ['c:\\repo', 'c:\\repo\\packages\\a'];
    expect(attributeFilesToWorkspace(['C:/repo/packages/a/src/x.ts'], 'c:\\repo\\packages\\a', () => nested, 'win32')).toBeNull();
    expect(attributeFilesToWorkspace(['C:/repo/tools/build.ts'], 'c:\\repo\\packages\\a', () => nested, 'win32')).toBe('c:\\repo');
  });
});

describe('MemoryService.addObservation workspace attribution', () => {
  const PANEL = '/ws/panel';
  const OTHER = '/ws/other';
  let service: MemoryService;

  beforeEach(async () => {
    dbHolder.path = path.join(os.tmpdir(), `damocles-attrib-${crypto.randomUUID()}.db`);
    service = new MemoryService(createFakePlatform());
    service.setWorkspaceRoots([PANEL, OTHER]);
    await service.ensureInitialized();
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

  const save = (filesRead: string[], filesModified: string[] = []) =>
    service.addObservation('s1', PANEL, { type: 'fix', title: 'T', content: 'c', facts: ['a'], filesRead, filesModified });

  it('files an observation whose files all sit in another open workspace there', async () => {
    expect((await save([`${OTHER}/src/gpu.ts`], [`${OTHER}/src/clock.ts`]))!.workspace).toBe(OTHER);
  });

  it('keeps mixed, relative or file-less observations in the panel workspace', async () => {
    expect((await save([`${OTHER}/a.ts`, `${PANEL}/b.ts`]))!.workspace).toBe(PANEL);
    expect((await save([`${OTHER}/a.ts`, 'src/b.ts']))!.workspace).toBe(PANEL);
    expect((await save([]))!.workspace).toBe(PANEL);
  });

  it('never files an observation under the home-directory bucket of a folderless window', async () => {
    const home = homeDirectory();
    const bucket = await service.addObservation('s0', home, { type: 'fix', title: 'H', content: 'h', facts: ['a'], filesRead: [], filesModified: [] });
    expect(bucket!.workspace).toBe(home);

    expect((await save([path.join(home, '.claude', 'CLAUDE.md')]))!.workspace).toBe(PANEL);
  });
});
