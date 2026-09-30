import { rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { sqliteContentFingerprint } from '../../../__mocks__/sqlite-content';
import { MemoryService } from '../index';
import { MemoryReadOnlyError, MemoryWriteQueue } from '../write-queue';
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

const dbPath = path.join(os.homedir(), '.damocles', 'memory.v3.db');

function migrateFromAnotherApp(): number {
  const raw = new DatabaseSync(dbPath, { timeout: 5000 });
  const { v } = raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
  raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v + 1);
  raw.close();
  return v + 1;
}

const services: MemoryService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) {
    s.dispose();
    await vi.waitFor(() => expect((s as unknown as { db: unknown }).db).toBeNull());
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
});

describe('memory database migrated by a newer app while open', () => {
  it('goes read only at the next write, writes nothing, keeps reads and notifies once', async () => {
    const fake = createFakePlatform();
    const service = new MemoryService(fake);
    services.push(service);
    const seed = await service.addNote('seeded before the newer app migrated');
    expect(seed).not.toBeNull();

    const aheadVersion = migrateFromAnotherApp();
    const content = sqliteContentFingerprint(dbPath);

    // The first write finds the store ahead under its write lock and is refused.
    await expect(service.addNote('must not be written')).rejects.toBeInstanceOf(MemoryReadOnlyError);
    expect(await service.addNote('must not be written either')).toBeNull();
    expect(await service.deleteMemory(seed!.id)).toBe(false);
    expect(await service.setProfileSection('global', os.homedir(), 'static', 'x')).toBe(false);
    expect((await service.getMemoryDetails([seed!.id])).map((m) => m.id)).toEqual([seed!.id]);
    expect(service.listNotes().map((n) => n.id)).toEqual([seed!.id]);

    expect(fake.notifications.calls).toEqual([
      { level: 'warn', message: expect.stringContaining('the memory database') as string, actions: [] },
    ]);
    expect(sqliteContentFingerprint(dbPath)).toBe(content);
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    expect((raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(aheadVersion);
    raw.close();
  });

  it('a read that records access still answers when it is the write that finds the store ahead', async () => {
    const service = new MemoryService(createFakePlatform());
    services.push(service);
    const seed = await service.addNote('seeded before the newer app migrated');
    migrateFromAnotherApp();
    const content = sqliteContentFingerprint(dbPath);

    expect((await service.getMemoryDetails([seed!.id])).map((m) => m.id)).toEqual([seed!.id]);
    expect(await service.addNote('must not be written')).toBeNull();
    expect(sqliteContentFingerprint(dbPath)).toBe(content);
  });
});

describe('MemoryWriteQueue schema guard', () => {
  function fakeDb(): DatabaseInstance & { transactions: number } {
    const db = {
      transactions: 0,
      transaction<T>(fn: () => T): T {
        db.transactions++;
        return fn();
      },
    };
    return db as unknown as DatabaseInstance & { transactions: number };
  }

  it('checks inside the transaction, refuses once ahead without running the write, and reports it once', async () => {
    const db = fakeDb();
    let ahead = false;
    const onAhead = vi.fn();
    const queue = new MemoryWriteQueue(db, { isAhead: () => ahead, onAhead });
    const write = vi.fn(() => 'written');

    expect(await queue.run(write)).toBe('written');
    ahead = true;
    await expect(queue.run(write)).rejects.toBeInstanceOf(MemoryReadOnlyError);
    await expect(queue.run(write)).rejects.toBeInstanceOf(MemoryReadOnlyError);
    await expect(queue.runOutsideTransaction(write)).rejects.toBeInstanceOf(MemoryReadOnlyError);

    expect(write).toHaveBeenCalledTimes(1);
    expect(onAhead).toHaveBeenCalledTimes(1);
    // The refused write still opened its transaction, which is where it read the version; later ones never start one.
    expect(db.transactions).toBe(2);
  });

  it('refuses a statement run outside a transaction once the store is ahead', async () => {
    const onAhead = vi.fn();
    const queue = new MemoryWriteQueue(fakeDb(), { isAhead: () => true, onAhead });
    const vacuum = vi.fn();
    await expect(queue.runOutsideTransaction(vacuum)).rejects.toBeInstanceOf(MemoryReadOnlyError);
    expect(vacuum).not.toHaveBeenCalled();
    expect(onAhead).toHaveBeenCalledTimes(1);
  });

  it('a queue built read only refuses every write without asking the guard', async () => {
    const guard = { isAhead: vi.fn(() => true), onAhead: vi.fn() };
    const queue = new MemoryWriteQueue(fakeDb(), guard, true);
    await expect(queue.run(() => 1)).rejects.toBeInstanceOf(MemoryReadOnlyError);
    expect(guard.isAhead).not.toHaveBeenCalled();
    expect(guard.onAhead).not.toHaveBeenCalled();
  });
});
