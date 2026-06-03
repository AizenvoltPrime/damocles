import { describe, it, expect, beforeEach } from 'vitest';
import { createTestMemoryDb } from './test-helpers';
import { ProfileManager } from '../managers/profile-manager';
import { MemoryWriteQueue } from '../write-queue';
import type { DatabaseInstance } from '../types';
import type { MemorySubCallRunner, MemorySubCallResult } from '../subcall-runner';
import type { UserProfile } from '@shared/types/memory';

const WORKSPACE = '/repo/damocles';

const PROFILE_VALUE: UserProfile = {
  static: 'Prefers functional TypeScript; uses esbuild.',
  dynamic: 'Refactoring the memory module.',
};

function fixedRunner(value: UserProfile | null): MemorySubCallRunner {
  return {
    async run<T>(): Promise<MemorySubCallResult<T>> {
      return { value: value as unknown as T };
    },
  };
}

function seedFact(db: DatabaseInstance, id: string, content: string, workspace: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (id, kind, scope, content, content_hash, workspace, is_latest, forgotten, created_at, updated_at)
     VALUES (?, 'fact', 'project', ?, ?, ?, 1, 0, ?, ?)`,
  ).run(id, content, id, workspace, now, now);
}

function sectionRows(db: DatabaseInstance, workspace: string): Set<string> {
  const rows = db
    .prepare("SELECT section FROM memory_profile WHERE scope = 'project' AND workspace = ?")
    .all(workspace) as Array<{ section: string }>;
  return new Set(rows.map(row => row.section));
}

describe('ProfileManager', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('updateProfile writes both sections and getProfile reads them back', async () => {
    seedFact(db, 'f1', 'Uses esbuild for bundling', WORKSPACE);
    seedFact(db, 'f2', 'Refactoring memory module', WORKSPACE);

    const manager = new ProfileManager(db, new MemoryWriteQueue(), fixedRunner(PROFILE_VALUE));
    await manager.updateProfile('project', WORKSPACE);

    expect(sectionRows(db, WORKSPACE)).toEqual(new Set(['static', 'dynamic']));

    const profile = manager.getProfile('project', WORKSPACE);
    expect(profile.static).toBe(PROFILE_VALUE.static);
    expect(profile.dynamic).toBe(PROFILE_VALUE.dynamic);
  });

  it('buildProfileInjection wraps content and includes seeded static text', async () => {
    const manager = new ProfileManager(db, new MemoryWriteQueue(), fixedRunner(PROFILE_VALUE));
    await manager.updateProfile('project', WORKSPACE);

    const injection = manager.buildProfileInjection(WORKSPACE, 400);
    expect(injection).toContain('<user_profile>');
    expect(injection).toContain(PROFILE_VALUE.static);
  });

  it('buildProfileInjection trims dynamic first under a tiny token budget', async () => {
    const manager = new ProfileManager(db, new MemoryWriteQueue(), fixedRunner(PROFILE_VALUE));
    await manager.updateProfile('project', WORKSPACE);
    await manager.updateProfile('global', '');

    const tiny = manager.buildProfileInjection(WORKSPACE, 5);
    expect(tiny).toContain('<user_profile>');
    expect(tiny).not.toContain(PROFILE_VALUE.dynamic);
    expect(tiny).toContain(PROFILE_VALUE.static);
  });

  it('updateProfile writes nothing when the runner returns null (graceful degrade)', async () => {
    seedFact(db, 'f1', 'Uses esbuild for bundling', WORKSPACE);

    const manager = new ProfileManager(db, new MemoryWriteQueue(), fixedRunner(null));
    await manager.updateProfile('project', WORKSPACE);

    expect(sectionRows(db, WORKSPACE).size).toBe(0);

    const profile = manager.getProfile('project', WORKSPACE);
    expect(profile.static).toBe('');
    expect(profile.dynamic).toBe('');
  });
});
