import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DatabaseSync } from 'node:sqlite';
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

// Distinguishing marker rides on exactText so latest-wins / round-trip reads can be told apart.
function makeDisplay(marker: string): MemoryInjectionDisplay {
  return {
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
    expect(getMemoryInjection(db!, 3)?.exactText).toBe('hello');
    expect(getMemoryInjection(db!, 99)).toBeUndefined();
  });

  it('lets the latest write win at the same prompt index', async () => {
    const id = uniqueId();
    const db = await openInjectionDatabase(id);
    openHandles.push(db!);

    insertMemoryInjection(db!, 1, makeDisplay('first'));
    insertMemoryInjection(db!, 1, makeDisplay('second'));
    expect(getMemoryInjection(db!, 1)?.exactText).toBe('second');
  });
});

describe('display record v3', () => {
  it('wipes records written by schema v2 on open', async () => {
    const id = uniqueId();
    fs.mkdirSync(INJECTION_DB_DIR, { recursive: true });
    const raw = new DatabaseSync(`${newBasePath(id)}.db`);
    raw.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL);
      CREATE TABLE memory_injections (prompt_index INTEGER PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (1), (2);`);
    raw.prepare('INSERT INTO memory_injections (prompt_index, data, created_at) VALUES (?, ?, ?)').run(0, JSON.stringify({ groups: [] }), 1);
    raw.close();

    const db = await openInjectionDatabase(id);
    openHandles.push(db!);
    const count = db!.prepare('SELECT COUNT(*) AS n FROM memory_injections').get() as { n: number };
    expect(count.n).toBe(0);
    const version = db!.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(version.v).toBe(3);
  });

  it('reads a blob whose version is not 3 as undefined', async () => {
    const id = uniqueId();
    const db = await openInjectionDatabase(id);
    openHandles.push(db!);
    db!.prepare('INSERT INTO memory_injections (prompt_index, data, created_at) VALUES (?, ?, ?)').run(4, JSON.stringify({ version: 2 }), 1);
    expect(getMemoryInjection(db!, 4)).toBeUndefined();
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
    expect(getMemoryInjection(db!, 7)?.exactText).toBe('legacy-data');
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

  it('leaves the destination and its records alone when the source has no file', async () => {
    const oldId = uniqueId();
    const newId = uniqueId();
    const seed = await openInjectionDatabase(newId);
    insertMemoryInjection(seed!, 0, makeDisplay('kept'));
    seed!.close();

    await renameInjectionDatabaseFile(oldId, newId);

    const db = await openInjectionDatabase(newId);
    openHandles.push(db!);
    expect(getMemoryInjection(db!, 0)?.exactText).toBe('kept');
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

  it('renameSession moves the file', async () => {
    const mgr = makeManager();
    managers.push(mgr);
    const oldId = uniqueId();
    const newId = uniqueId();

    await mgr.persistInjection(oldId, 0, makeDisplay('x'));
    await mgr.renameSession(oldId, newId);

    expect(dbExists(newBasePath(oldId))).toBe(false);
    expect(dbExists(newBasePath(newId))).toBe(true);
  });

  it('preserves the per-prompt records across a session rename', async () => {
    const mgr = makeManager();
    managers.push(mgr);
    const oldId = uniqueId();
    const newId = uniqueId();

    await mgr.persistInjection(oldId, 0, makeDisplay('prompt-0 record'));
    await mgr.renameSession(oldId, newId);

    expect((await mgr.getPersistedInjection(newId, 0))?.exactText).toBe('prompt-0 record');
    expect(dbExists(newBasePath(oldId))).toBe(false);
  });
});

describe('InjectionManager.copySessionInjections', () => {
  type RawRow = { prompt_index: number; data: string; created_at: number };

  function rawRows(id: string): RawRow[] {
    const raw = new DatabaseSync(`${newBasePath(id)}.db`);
    try {
      return raw.prepare('SELECT prompt_index, data, created_at FROM memory_injections ORDER BY prompt_index').all() as RawRow[];
    } finally {
      raw.close();
    }
  }

  /** A source database on disk, closed, holding one record per index with a distinct marker. */
  async function seedSource(id: string, indices: number[]): Promise<void> {
    const db = await openInjectionDatabase(id);
    for (const i of indices) insertMemoryInjection(db!, i, { ...makeDisplay(`prompt ${i} ü "quoted"`), promptIndex: i });
    db!.close();
  }

  it('copies only the records below the cut, byte for byte', async () => {
    const sourceId = uniqueId();
    const forkId = uniqueId();
    await seedSource(sourceId, [0, 1, 2, 3]);
    const mgr = makeManager();
    managers.push(mgr);

    await expect(mgr.copySessionInjections(sourceId, forkId, 2)).resolves.toBe(2);

    expect((await mgr.getPersistedInjection(forkId, 0))?.exactText).toBe('prompt 0 ü "quoted"');
    expect((await mgr.getPersistedInjection(forkId, 1))?.promptIndex).toBe(1);
    expect(await mgr.getPersistedInjection(forkId, 2)).toBeUndefined();
    expect(await mgr.getPersistedInjection(forkId, 3)).toBeUndefined();
    mgr.closeInjectionDatabases();
    expect(rawRows(forkId)).toEqual(rawRows(sourceId).filter((r) => r.prompt_index < 2));
    expect(rawRows(sourceId).map((r) => r.prompt_index)).toEqual([0, 1, 2, 3]);
  });

  it('copies from a source database the manager already holds open', async () => {
    const sourceId = uniqueId();
    const forkId = uniqueId();
    const mgr = makeManager();
    managers.push(mgr);
    await mgr.persistInjection(sourceId, 0, makeDisplay('live'));

    await expect(mgr.copySessionInjections(sourceId, forkId, 1)).resolves.toBe(1);
    expect((await mgr.getPersistedInjection(forkId, 0))?.exactText).toBe('live');
  });

  it('is a no-op that creates no file when the source has no database', async () => {
    const sourceId = uniqueId();
    const forkId = uniqueId();
    const mgr = makeManager();
    managers.push(mgr);

    await expect(mgr.copySessionInjections(sourceId, forkId, 5)).resolves.toBe(0);
    expect(dbExists(newBasePath(sourceId))).toBe(false);
    expect(dbExists(newBasePath(forkId))).toBe(false);
  });

  it('creates no fork database when no record lies below the cut', async () => {
    const sourceId = uniqueId();
    const forkId = uniqueId();
    await seedSource(sourceId, [3]);
    const mgr = makeManager();
    managers.push(mgr);

    await expect(mgr.copySessionInjections(sourceId, forkId, 3)).resolves.toBe(0);
    expect(dbExists(newBasePath(forkId))).toBe(false);
  });

  it('keeps the copied records when the fork later migrates from an id with no database', async () => {
    const sourceId = uniqueId();
    const forkId = uniqueId();
    const panelId = uniqueId();
    await seedSource(sourceId, [0]);
    const mgr = makeManager();
    managers.push(mgr);

    await mgr.copySessionInjections(sourceId, forkId, 1);
    await mgr.renameSession(panelId, forkId);

    expect((await mgr.getPersistedInjection(forkId, 0))?.exactText).toBe('prompt 0 ü "quoted"');
  });
});
