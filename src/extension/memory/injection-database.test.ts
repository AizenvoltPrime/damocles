import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  injectionDbName,
  openInjectionDatabase,
  insertMemoryInjection,
  getMemoryInjection,
  deleteInjectionDatabaseFile,
  renameInjectionDatabaseFile,
  sweepStaleInjectionDatabases,
  setInjectionDbDirForTests,
} from './injection-database';
import { InjectionManager } from './managers/injection-manager';
import type { DatabaseInstance } from './types';
import type { ProfileManager } from './managers/profile-manager';
import type { MemorySubCallRunner } from './subcall-runner';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';

// Redirect to a throwaway dir so the no-maxAge sweep test can NEVER delete real user injection DBs.
const INJECTION_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-injection-test-'));
setInjectionDbDirForTests(INJECTION_DB_DIR);
const SIBLINGS = ['.db', '.db-wal', '.db-shm'] as const;

beforeAll(() => {
  setInjectionDbDirForTests(INJECTION_DB_DIR);
});

// Distinguishing marker rides on ftsQuery so latest-wins / round-trip reads can be told apart.
function makeDisplay(marker: string): MemoryInjectionDisplay {
  return {
    groups: [],
    totalTokensUsed: 0,
    ftsQuery: marker,
    hasHandoffContext: false,
    hasProfile: false,
    rerankApplied: false,
    pinnedEntries: [],
    pinnedBudget: 500,
    pinnedTokensUsed: 0,
  };
}

function newBasePath(id: string): string {
  return path.join(INJECTION_DB_DIR, injectionDbName(id));
}

// Pre-hash name, computed inline (the impl does not export it).
function legacyBasePath(id: string): string {
  return path.join(INJECTION_DB_DIR, id.replace(/[/\\:]/g, '_'));
}

function dbExists(basePath: string): boolean {
  return fs.existsSync(`${basePath}.db`);
}

// A fresh InjectionManager: its lifecycle methods only touch injection-DB files, so the main-DB /
// profile / runner deps are never exercised and can be null.
function makeManager(): InjectionManager {
  return new InjectionManager(
    null as unknown as DatabaseInstance,
    null as unknown as ProfileManager,
    null as unknown as MemorySubCallRunner,
  );
}

// Track every id + directly-opened handle + manager so afterEach can release locks and remove files.
const createdIds = new Set<string>();
const openHandles: DatabaseInstance[] = [];
const managers: InjectionManager[] = [];
const allRunIds = new Set<string>();

function trackId(id: string): string {
  createdIds.add(id);
  allRunIds.add(id);
  return id;
}

function uniqueId(): string {
  return trackId(randomUUID());
}

afterEach(async () => {
  for (const db of openHandles.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const mgr of managers.splice(0)) {
    mgr.closeInjectionDatabases();
  }
  // Handles are closed above, so the fs unlinks below succeed even on Windows.
  for (const id of createdIds) {
    await deleteInjectionDatabaseFile(id);
    for (const ext of SIBLINGS) {
      const legacy = `${legacyBasePath(id)}${ext}`;
      if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
    }
  }
  for (const id of createdIds) {
    expect(dbExists(newBasePath(id))).toBe(false);
    expect(dbExists(legacyBasePath(id))).toBe(false);
  }
  createdIds.clear();
});

// Final guard: no file this run generated may linger in the shared injection directory.
afterAll(() => {
  const leaked: string[] = [];
  for (const id of allRunIds) {
    for (const base of [newBasePath(id), legacyBasePath(id)]) {
      for (const ext of SIBLINGS) {
        if (fs.existsSync(`${base}${ext}`)) leaked.push(`${base}${ext}`);
      }
    }
  }
  expect(leaked).toEqual([]);
});

describe('injectionDbName filename scheme', () => {
  it('disambiguates ids that share a sanitized base via a sha256 suffix', () => {
    // `a/b` and `a_b` collapse to the same sanitized base but must not share a file.
    const nameSlash = injectionDbName('a/b');
    const nameUnderscore = injectionDbName('a_b');

    expect(nameSlash).not.toBe(nameUnderscore);
    expect(nameSlash.startsWith('a_b-')).toBe(true);
    expect(nameUnderscore.startsWith('a_b-')).toBe(true);
    expect(path.join(INJECTION_DB_DIR, `${nameSlash}.db`))
      .not.toBe(path.join(INJECTION_DB_DIR, `${nameUnderscore}.db`));
  });

  it('appends an 8-hex suffix separated by a dash', () => {
    const name = injectionDbName(randomUUID());
    expect(name).toMatch(/-[0-9a-f]{8}$/);
  });
});

describe('memory injection round-trip', () => {
  it('persists and reads back a record at a prompt index', async () => {
    const id = uniqueId();
    const db = await openInjectionDatabase(id);
    expect(db).toBeDefined();
    openHandles.push(db!);

    insertMemoryInjection(db!, 3, makeDisplay('hello'));
    expect(getMemoryInjection(db!, 3)?.ftsQuery).toBe('hello');
    expect(getMemoryInjection(db!, 99)).toBeUndefined();
  });

  it('lets the latest write win at the same prompt index', async () => {
    const id = uniqueId();
    const db = await openInjectionDatabase(id);
    openHandles.push(db!);

    insertMemoryInjection(db!, 1, makeDisplay('first'));
    insertMemoryInjection(db!, 1, makeDisplay('second'));
    expect(getMemoryInjection(db!, 1)?.ftsQuery).toBe('second');
  });
});

describe('legacy-name pickup on open', () => {
  it('renames a pre-hash file to the hashed name and preserves its record', async () => {
    const id = uniqueId();

    // Seed a real DB, then rename its file to the legacy (pre-hash) name to simulate old data.
    const seed = await openInjectionDatabase(id);
    insertMemoryInjection(seed!, 7, makeDisplay('legacy-data'));
    seed!.close();

    for (const ext of SIBLINGS) {
      const from = `${newBasePath(id)}${ext}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${legacyBasePath(id)}${ext}`);
    }
    expect(dbExists(newBasePath(id))).toBe(false);
    expect(dbExists(legacyBasePath(id))).toBe(true);

    const db = await openInjectionDatabase(id);
    openHandles.push(db!);
    expect(getMemoryInjection(db!, 7)?.ftsQuery).toBe('legacy-data');
    expect(dbExists(newBasePath(id))).toBe(true);
    expect(dbExists(legacyBasePath(id))).toBe(false);
  });
});

describe('deleteInjectionDatabaseFile', () => {
  it('removes the full .db + -wal + -shm trio', async () => {
    const id = uniqueId();
    const base = newBasePath(id);
    // Materialize the whole trio on disk (wal/shm are transient while open, so write them directly).
    for (const ext of SIBLINGS) fs.writeFileSync(`${base}${ext}`, '');
    for (const ext of SIBLINGS) expect(fs.existsSync(`${base}${ext}`)).toBe(true);

    await deleteInjectionDatabaseFile(id);
    for (const ext of SIBLINGS) expect(fs.existsSync(`${base}${ext}`)).toBe(false);
  });

  it('is a no-op for a session with no files', async () => {
    await expect(deleteInjectionDatabaseFile(uniqueId())).resolves.toBeUndefined();
  });
});

describe('renameInjectionDatabaseFile', () => {
  it('moves the trio old to new', async () => {
    const oldId = uniqueId();
    const newId = uniqueId();
    const oldBase = newBasePath(oldId);
    for (const ext of SIBLINGS) fs.writeFileSync(`${oldBase}${ext}`, '');

    await renameInjectionDatabaseFile(oldId, newId);

    for (const ext of SIBLINGS) {
      expect(fs.existsSync(`${oldBase}${ext}`)).toBe(false);
      expect(fs.existsSync(`${newBasePath(newId)}${ext}`)).toBe(true);
    }
  });

  it('tolerates an absent -wal / -shm sibling', async () => {
    const oldId = uniqueId();
    const newId = uniqueId();
    fs.writeFileSync(`${newBasePath(oldId)}.db`, '');

    await renameInjectionDatabaseFile(oldId, newId);

    expect(dbExists(newBasePath(oldId))).toBe(false);
    expect(dbExists(newBasePath(newId))).toBe(true);
  });
});

describe('sweepStaleInjectionDatabases', () => {
  it('sweeps DBs older than the cutoff and spares fresh ones', async () => {
    const freshId = uniqueId();
    const staleId = uniqueId();

    const fresh = await openInjectionDatabase(freshId);
    fresh!.close();
    const stale = await openInjectionDatabase(staleId);
    stale!.close();

    // Age the stale DB past the 90-day cutoff so the default sweep collects it.
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    fs.utimesSync(`${newBasePath(staleId)}.db`, old, old);

    const swept = await sweepStaleInjectionDatabases();

    expect(swept).toContain(injectionDbName(staleId));
    expect(swept).not.toContain(injectionDbName(freshId));
    expect(dbExists(newBasePath(staleId))).toBe(false);
    for (const ext of SIBLINGS) {
      expect(fs.existsSync(`${newBasePath(staleId)}${ext}`)).toBe(false);
    }
    expect(dbExists(newBasePath(freshId))).toBe(true);
  });
});

describe('InjectionManager session lifecycle', () => {
  it('deleteSession closes the handle before removing the file', async () => {
    const mgr = makeManager();
    managers.push(mgr);
    const id = uniqueId();

    await mgr.persistInjection(id, 0, makeDisplay('x'));
    expect(dbExists(newBasePath(id))).toBe(true);

    await mgr.deleteSession(id);
    expect(dbExists(newBasePath(id))).toBe(false);
  });

  it('renameSession moves the file and migrates the first-message cache', async () => {
    const mgr = makeManager();
    managers.push(mgr);
    const oldId = uniqueId();
    const newId = uniqueId();

    await mgr.persistInjection(oldId, 0, makeDisplay('x'));
    mgr.markFirstMessageSent(oldId);

    await mgr.renameSession(oldId, newId);

    // First-message state must follow the new id: a fresh session reports true, a sent one false.
    expect(mgr.isFirstMessageOfSession(newId)).toBe(false);
    expect(mgr.isFirstMessageOfSession(oldId)).toBe(true);
    expect(dbExists(newBasePath(oldId))).toBe(false);
    expect(dbExists(newBasePath(newId))).toBe(true);
  });

  it('preserves the prompt-0 record across a session rename', async () => {
    const mgr = makeManager();
    managers.push(mgr);
    const oldId = uniqueId();
    const newId = uniqueId();

    await mgr.persistInjection(oldId, 0, makeDisplay('profile-and-handoff'));
    await mgr.renameSession(oldId, newId);

    expect((await mgr.getPersistedInjection(newId, 0))?.ftsQuery).toBe('profile-and-handoff');
    expect(dbExists(newBasePath(oldId))).toBe(false);
  });
});
