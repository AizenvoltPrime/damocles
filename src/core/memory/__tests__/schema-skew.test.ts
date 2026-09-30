import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { sqliteContentFingerprint } from '../../../__mocks__/sqlite-content';
import { MemoryService } from '../index';
import { openInjectionDatabase, setInjectionDbDirForTests, injectionDbName } from '../injection-database';
import { InjectionManager } from '../managers/injection-manager';
import type { ProfileManager } from '../managers/profile-manager';
import type { MemorySubCallRunner } from '../subcall-runner';
import type { DatabaseInstance } from '../types';

// The service needs no model for these paths; the real runner would start pi.
vi.mock('../subcall-runner', () => ({
  createMemorySubCallRunner: () => ({ run: () => Promise.resolve({ value: null, failure: 'no-model' as const }) }),
  describeMemorySubCallModel: () => null,
}));
vi.mock('../query-expansion', () => ({
  expandQuery: vi.fn(async () => [] as string[]),
  expandMemoryTerms: vi.fn(async () => [] as string[]),
  expandMemoryTermsWithStatus: vi.fn(async () => ({ terms: [] as string[], failed: false })),
  clearExpansionCache: vi.fn(() => {}),
}));

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const walSize = (file: string): number => (existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0);

function stampSchemaVersion(dbPath: string, version: number): void {
  const raw = new DatabaseSync(dbPath);
  raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  raw.close();
}

function schemaVersion(dbPath: string): number {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  const row = raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
  raw.close();
  return row.v;
}

describe('memory database schema skew', () => {
  const dbPath = path.join(os.homedir(), '.damocles', 'memory.v3.db');

  it('the current version opens normally, and a store stamped one version ahead opens read only with one notice', async () => {
    const current = createFakePlatform();
    const writer = new MemoryService(current);
    const seed = await writer.addNote('seeded before the newer app migrated');
    expect(seed).not.toBeNull();
    expect(current.notifications.calls).toEqual([]);
    const currentVersion = schemaVersion(dbPath);
    writer.dispose();
    await vi.waitFor(() => expect((writer as unknown as { db: unknown }).db).toBeNull());

    stampSchemaVersion(dbPath, currentVersion + 1);
    const before = sha(dbPath);
    const content = sqliteContentFingerprint(dbPath);

    const skewed = createFakePlatform();
    const service = new MemoryService(skewed);
    await service.ensureInitialized();
    expect(skewed.notifications.calls).toEqual([
      { level: 'warn', message: expect.stringContaining('memory database') as string, actions: [] },
    ]);

    expect(service.listNotes().map((n) => n.id)).toContain(seed!.id);
    expect((await service.getMemoryDetails([seed!.id])).map((m) => m.id)).toEqual([seed!.id]);
    expect(await service.addNote('must not be written')).toBeNull();
    expect(await service.deleteMemory(seed!.id)).toBe(false);
    expect(await service.setProfileSection('global', os.homedir(), 'static', 'x')).toBe(false);

    // Once per store per session, however many services open it.
    const again = createFakePlatform();
    const second = new MemoryService(again);
    await second.ensureInitialized();
    expect(again.notifications.calls).toEqual([]);
    expect(skewed.notifications.calls).toHaveLength(1);

    expect(sqliteContentFingerprint(dbPath)).toBe(content);
    expect(sha(dbPath)).toBe(before);
    expect(walSize(dbPath)).toBe(0);
    expect(schemaVersion(dbPath)).toBe(currentVersion + 1);
    service.dispose();
    second.dispose();
  });
});

describe('memory injection database schema skew', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'damocles-injection-skew-'));
  setInjectionDbDirForTests(dir);
  const managers: InjectionManager[] = [];
  afterAll(() => {
    for (const m of managers) m.closeInjectionDatabases();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const display = (marker: string): MemoryInjectionDisplay => ({
    version: 3,
    promptIndex: 0,
    added: [],
    notices: [],
    carried: [],
    profile: { state: 'empty', tokens: 0, text: '' },
    compass: { state: 'disabled', text: '' },
    query: { terms: [], dropped: [], mentionedIds: [], files: [] },
    gate: { considered: 0, passed: 0, unmatchedSkipped: 0, alreadyInContext: 0, overBudget: 0, preferencesDeferred: 0 },
    tokens: { memories: 0, notices: 0, profile: 0, compass: 0, total: 0, budget: 2000 },
    storeCounts: { session: 0, project: 0, global: 0, observations: 0, total: 0 },
    rerankApplied: false,
    exactText: marker,
  });

  // Injection lifecycle paths touch only the per-session files, so the main-DB deps are unused.
  const manager = (notifications = createFakePlatform().notifications): InjectionManager => {
    const m = new InjectionManager(
      null as unknown as DatabaseInstance,
      null as unknown as ProfileManager,
      null as unknown as MemorySubCallRunner,
      createFakePlatform().settings,
      notifications,
    );
    managers.push(m);
    return m;
  };

  async function sessionAt(ahead: boolean): Promise<{ id: string; file: string; version: number }> {
    const id = randomUUID();
    const store = await openInjectionDatabase(id);
    expect(store?.readOnly).toBe(false);
    const m = manager();
    await m.persistInjection(id, 0, display('seeded'));
    m.closeInjectionDatabases();
    store!.db.close();
    const file = path.join(dir, `${injectionDbName(id)}.db`);
    const version = schemaVersion(file);
    if (ahead) stampSchemaVersion(file, version + 1);
    return { id, file, version };
  }

  it('the current version opens normally and records injections without a notice', async () => {
    const { id } = await sessionAt(false);
    const fake = createFakePlatform();
    const m = manager(fake.notifications);
    await m.persistInjection(id, 1, display('current'));
    expect((await m.getPersistedInjection(id, 1))?.exactText).toBe('current');
    expect(fake.notifications.calls).toEqual([]);
  });

  it('a store stamped one version ahead opens read only, keeps reads, writes nothing and notifies once', async () => {
    const first = await sessionAt(true);
    const second = await sessionAt(true);
    const store = await openInjectionDatabase(first.id);
    expect(store?.readOnly).toBe(true);
    store!.db.close();
    const before = sha(first.file);
    const content = sqliteContentFingerprint(first.file);

    const fake = createFakePlatform();
    const m = manager(fake.notifications);
    expect((await m.getPersistedInjection(first.id, 0))?.exactText).toBe('seeded');
    await m.persistInjection(first.id, 1, display('dropped'));
    expect(await m.getPersistedInjection(first.id, 1)).toBeUndefined();
    expect(await m.copySessionInjections(second.id, first.id, 5)).toBe(0);
    expect((await m.getPersistedInjection(second.id, 0))?.exactText).toBe('seeded');

    expect(fake.notifications.calls).toEqual([
      { level: 'warn', message: expect.stringContaining('memory injection records') as string, actions: [] },
    ]);
    expect(sqliteContentFingerprint(first.file)).toBe(content);
    expect(sha(first.file)).toBe(before);
    expect(walSize(first.file)).toBe(0);
    expect(schemaVersion(first.file)).toBe(first.version + 1);
  });
});
