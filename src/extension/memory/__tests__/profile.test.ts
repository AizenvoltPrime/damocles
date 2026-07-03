import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTestMemoryDb } from './test-helpers';
import { ProfileManager, isUserProfileShape, truncateAtBoundary } from '../managers/profile-manager';
import { MemoryWriteQueue } from '../write-queue';
import type { DatabaseInstance } from '../types';
import type { MemorySubCallRunner, MemorySubCallResult } from '../subcall-runner';
import type { UserProfile } from '@shared/types/memory';

// Drive MemoryService init against a per-test temp DB so the T10 boolean wrapper is exercised
// end-to-end without touching the real ~/.damocles store or the model layer.
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

// The sub-call runner reaches PiRuntime; stub it so init never touches the model layer.
vi.mock('../subcall-runner', () => ({
  createMemorySubCallRunner: () => ({ run: vi.fn(async () => ({ value: null, failure: 'no-model' as const })) }),
}));

import { MemoryService } from '../index';

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

  // A hostile profile shape (missing static/dynamic, or non-string sections) must not throw at
  // value.static.slice(...) or write a section — updateProfile is a logged no-op.

  /** A runner returning an arbitrary (possibly malformed) value for the profile sub-call. */
  function hostileRunner(value: unknown): MemorySubCallRunner {
    return {
      async run<T>(): Promise<MemorySubCallResult<T>> {
        return { value: value as T };
      },
    };
  }

  it('isUserProfileShape accepts a well-formed profile and rejects hostile shapes', () => {
    expect(isUserProfileShape({ static: 'a', dynamic: 'b' })).toBe(true);
    expect(isUserProfileShape({ static: '', dynamic: '' })).toBe(true);
    expect(isUserProfileShape(null)).toBe(false);
    expect(isUserProfileShape({})).toBe(false);
    expect(isUserProfileShape({ static: 'a' })).toBe(false); // missing dynamic
    expect(isUserProfileShape({ static: 1, dynamic: 'b' })).toBe(false); // static not a string
    expect(isUserProfileShape({ static: 'a', dynamic: [] })).toBe(false); // dynamic not a string
  });

  const hostileProfileShapes: Array<{ name: string; value: unknown }> = [
    { name: 'missing dynamic', value: { static: 'durable facts' } },
    { name: 'missing static', value: { dynamic: 'recent activity' } },
    { name: 'static is a number', value: { static: 42, dynamic: 'x' } },
    { name: 'dynamic is an array', value: { static: 'x', dynamic: ['not', 'a', 'string'] } },
    { name: 'empty object', value: {} },
  ];

  for (const shape of hostileProfileShapes) {
    it(`updateProfile is a logged no-op (no throw, no write) on an invalid shape: ${shape.name}`, async () => {
      seedFact(db, 'f1', 'Uses esbuild for bundling', WORKSPACE);

      const manager = new ProfileManager(db, new MemoryWriteQueue(), hostileRunner(shape.value));
      // Resolves (never rejects).
      await expect(manager.updateProfile('project', WORKSPACE)).resolves.toBeUndefined();

      // No section written — the invalid shape was skipped.
      expect(sectionRows(db, WORKSPACE).size).toBe(0);
      const profile = manager.getProfile('project', WORKSPACE);
      expect(profile.static).toBe('');
      expect(profile.dynamic).toBe('');
    });
  }

  // During updateProfile's LLM call a user edits the 'static' section. The write queue serializes
  // that edit before the post-LLM commit; the CAS re-reads updated_at inside the commit, sees
  // 'static' moved, and SKIPS the LLM value for it (user wins) while 'dynamic' still gets the LLM value.

  /** Runner whose run() awaits and, mid-await, fires onMidCall — a concurrent edit landing mid-LLM. */
  function midCallEditRunner(value: UserProfile, onMidCall: () => Promise<void>): MemorySubCallRunner {
    return {
      async run<T>(): Promise<MemorySubCallResult<T>> {
        // Advance past a millisecond tick before the edit so its updated_at stamp is strictly greater
        // than the snapshot updateProfile captured at start (the ~45s call guarantees this gap in
        // production). Then settle so the edit commits before this call resolves.
        await new Promise(resolve => setTimeout(resolve, 5));
        await onMidCall();
        await new Promise(resolve => setTimeout(resolve, 5));
        return { value: value as unknown as T };
      },
    };
  }

  it('updateProfile CAS: a user edit mid-LLM-call to static wins; dynamic still takes the LLM value', async () => {
    // Seed both sections so updateProfile has a baseline updated_at to compare.
    const writeQueue = new MemoryWriteQueue(db);
    const seedManager = new ProfileManager(db, writeQueue, fixedRunner(PROFILE_VALUE));
    await seedManager.setProfileSection('project', WORKSPACE, 'static', 'ORIGINAL static text.');
    await seedManager.setProfileSection('project', WORKSPACE, 'dynamic', 'ORIGINAL dynamic text.');

    // The CAS compares millisecond updated_at stamps; without this gap the seed and mid-call edit
    // could collide within one millisecond and the edit would be undetectable.
    await new Promise(resolve => setTimeout(resolve, 5));

    const USER_EDIT = 'USER edited this static section while the LLM was running.';
    const LLM_VALUE: UserProfile = {
      static: 'LLM-regenerated static that MUST be discarded because the user edited.',
      dynamic: 'LLM-regenerated dynamic that SHOULD win.',
    };

    // The mid-call edit bumps 'static'; 'dynamic' stays untouched.
    const runner = midCallEditRunner(LLM_VALUE, () =>
      seedManager.setProfileSection('project', WORKSPACE, 'static', USER_EDIT),
    );
    const manager = new ProfileManager(db, writeQueue, runner);

    await manager.updateProfile('project', WORKSPACE);

    const profile = manager.getProfile('project', WORKSPACE);
    // static: the user's edit is preserved — the LLM value was skipped by the CAS.
    expect(profile.static).toBe(USER_EDIT);
    // dynamic: unchanged updated_at → the LLM value committed.
    expect(profile.dynamic).toBe(LLM_VALUE.dynamic);
  });
});

describe('truncateAtBoundary', () => {
  it('returns text unchanged when it is within the cap', () => {
    const text = 'Short enough.';
    expect(truncateAtBoundary(text, 100)).toBe(text);
    // Exact-length boundary is also unchanged.
    expect(truncateAtBoundary(text, text.length)).toBe(text);
  });

  it('cuts at a sentence boundary near the cap (no mid-sentence cut)', () => {
    const head = 'First sentence is complete. ';
    const tail = 'Second sentence runs on and on and on well past the character budget line.';
    const text = head + tail;
    const cap = head.length + 20; // lands inside the second sentence
    const result = truncateAtBoundary(text, cap);
    expect(result).toBe('First sentence is complete.');
    expect(result.length).toBeLessThanOrEqual(cap);
  });

  it('cuts at a word boundary when there is no sentence boundary (no partial word)', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
    const cap = 20; // lands inside a word
    const result = truncateAtBoundary(text, cap);
    expect(result.length).toBeLessThanOrEqual(cap);
    // Ends on a whole word (the next source char is a space).
    expect(text.startsWith(result)).toBe(true);
    expect(text[result.length]).toBe(' ');
    expect(result).toBe('alpha beta gamma');
  });

  it('hard-cuts at the cap when there is neither a sentence nor a word boundary', () => {
    const text = 'x'.repeat(500); // unbroken token
    const cap = 120;
    const result = truncateAtBoundary(text, cap);
    expect(result.length).toBe(cap);
    expect(result).toBe('x'.repeat(cap));
  });

  it('cuts at a newline boundary (dropping the newline)', () => {
    const text = 'Line one\n' + 'y'.repeat(400);
    const cap = 60;
    const result = truncateAtBoundary(text, cap);
    expect(result).toBe('Line one');
  });
});

// The panel uses this boolean as its save-confirmation signal: true only when the upsert committed,
// false when memory is disabled/init-failed (no profileManager) or the write throws.
describe('MemoryService.setProfileSection boolean contract', () => {
  let service: MemoryService;

  beforeEach(() => {
    dbHolder.path = path.join(os.tmpdir(), `damocles-profile-t10-${crypto.randomUUID()}.db`);
    service = new MemoryService('/ext');
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

  it('returns true when the upsert commits, and the section is readable back', async () => {
    await service.ensureInitialized();
    const ok = await service.setProfileSection('project', WORKSPACE, 'static', 'Saved static text.');
    expect(ok).toBe(true);
    expect(service.getProfile('project', WORKSPACE).static).toBe('Saved static text.');
  });

  it('returns false when the profile manager is unavailable (init failed / disabled)', async () => {
    // Latch the init-failed flag (the state ensureInitialized short-circuits to when _doInit fails,
    // leaving profileManager null) so the "no profileManager" branch returns false.
    (service as unknown as { _initFailed: boolean })._initFailed = true;

    const ok = await service.setProfileSection('project', WORKSPACE, 'static', 'Should not persist.');
    expect(ok).toBe(false);
  });
});
