import * as crypto from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createDatabaseWrapper, openMemoryDatabaseAt, runMigrations } from '../database';
import { MemoryService } from '../index';
import { createMemoryIntegrity } from '../integrity';
import { repairMarkerPath, type IntegrityVerdict } from '../integrity-protocol';
import { runIntegrityRequest } from '../integrity-worker';
import type { DatabaseInstance } from '../types';
import { MemoryReadOnlyError } from '../write-queue';

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

// Records each request the service sends to the real worker; a test may answer `check` itself or shorten the write hold.
const requests = vi.hoisted(() => [] as string[]);
const service$ = vi.hoisted(() => ({ check: null as null | (() => Promise<IntegrityVerdict>), holdMs: 5_000 }));
vi.mock('../integrity', async (importActual) => {
  const actual = await importActual<typeof import('../integrity')>();
  return {
    ...actual,
    get MEMORY_WRITE_HOLD_MS() {
      return service$.holdMs;
    },
    createMemoryIntegrity: (...args: Parameters<typeof actual.createMemoryIntegrity>) => {
      const real = actual.createMemoryIntegrity(...args);
      return {
        check: (dbPath: string) => (requests.push('check'), service$.check ? service$.check() : real.check(dbPath)),
        rebuildFts: (dbPath: string) => (requests.push('rebuildFts'), real.rebuildFts(dbPath)),
        repair: (dbPath: string) => (requests.push('repair'), real.repair(dbPath)),
        dispose: () => real.dispose(),
      };
    },
  };
});

// Stops an in-process repair at one step: a hook throws before the file call or the copy it names runs.
const stops = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => void),
  rm: null as null | ((file: string) => void),
  copy: null as null | 'rows' | 'index',
}));
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      stops.rename?.(String(from), String(to));
      actual.renameSync(from, to);
    },
    rmSync: (file: string, options?: Parameters<typeof actual.rmSync>[1]) => {
      stops.rm?.(String(file));
      actual.rmSync(file, options);
    },
  };
});
vi.mock('../database', async (importActual) => {
  const actual = await importActual<typeof import('../database')>();
  return {
    ...actual,
    openAndMigrate: (...args: Parameters<typeof actual.openAndMigrate>) => {
      const opened = actual.openAndMigrate(...args);
      const at = stops.copy;
      if (at === null || !args[0].endsWith('.salvage')) return opened;
      const db: DatabaseInstance = {
        ...opened.db,
        transaction: (fn) => (at === 'rows' ? stop() : opened.db.transaction(fn)),
        exec: (sql) => (at === 'index' && sql.includes("'rebuild'") ? stop() : opened.db.exec(sql)),
      };
      return { ...opened, db };
    },
  };
});

class Stopped extends Error {}
const stop = (): never => {
  throw new Stopped('stopped');
};

const dbPath = path.join(os.homedir(), '.damocles', 'memory.v3.db');
const legacyPath = path.join(os.homedir(), '.damocles', 'memory.v2.db');
let root: string;
const services: MemoryService[] = [];

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'damocles-memory-integrity-'));
  // The real worker bundle runs on a worker thread, resolved through AppPaths as the host resolves it.
  await build({
    entryPoints: [path.resolve(__dirname, '..', 'integrity-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['node:sqlite'],
    outfile: path.join(root, 'dist', 'memory-integrity-worker.js'),
    logLevel: 'silent',
  });
});

afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
  requests.length = 0;
  service$.check = null;
  service$.holdMs = 5_000;
  stops.rename = null;
  stops.rm = null;
  stops.copy = null;
  const dir = path.dirname(dbPath);
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(path.basename(dbPath)) || entry === path.basename(legacyPath)) rmSync(path.join(dir, entry), { force: true });
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function service(appRoot = root): { service: MemoryService; fake: ReturnType<typeof createFakePlatform> } {
  const fake = createFakePlatform({ appRoot });
  const s = new MemoryService(fake);
  services.push(s);
  return { service: s, fake };
}

/** A migrated store in rollback-journal mode, so every page lives in the main file. */
function seedStore(seed: (raw: InstanceType<typeof DatabaseSync>) => void, file = dbPath): number {
  mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file, { timeout: 5000 });
  runMigrations(createDatabaseWrapper(raw));
  seed(raw);
  const pageSize = (raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  raw.close();
  return pageSize;
}

function insertMemories(raw: InstanceType<typeof DatabaseSync>, count: number, text: (i: number) => string, first = 0): void {
  const insert = raw.prepare(
    "INSERT INTO memories (id, kind, scope, content, content_hash, root_id, workspace, created_at, updated_at) VALUES (?, 'fact', 'project', ?, '', ?, '/ws', ?, ?)",
  );
  for (let i = first; i < first + count; i++) insert.run(`mem-${i}`, text(i), `mem-${i}`, Date.now(), Date.now());
}

function overwritePages(pages: number[], pageSize: number, byte: number): void {
  const fd = openSync(dbPath, 'r+');
  for (const page of pages) writeSync(fd, Buffer.alloc(pageSize - 50, byte), 0, pageSize - 50, (page - 1) * pageSize + 40);
  closeSync(fd);
}

function pagesOf(raw: InstanceType<typeof DatabaseSync>, table: string): number[] {
  return (raw.prepare('SELECT pageno FROM dbstat WHERE name = ? ORDER BY pageno').all(table) as Array<{ pageno: number }>).map((r) => r.pageno);
}

/** 40 memories beside torn `memory_candidates` pages: damage outside the index, which only a salvage repairs. */
function seedTornStore(): void {
  let candidatePages: number[] = [];
  const pageSize = seedStore((raw) => {
    insertMemories(raw, 40, (i) => `durable fact number ${i}`);
    const insert = raw.prepare("INSERT INTO memory_candidates (id, session_id, prompt_index, user_text, assistant_text, created_at) VALUES (?, 's', 0, ?, 'a', ?)");
    for (let i = 0; i < 200; i++) insert.run(`cand-${i}`, `user turn ${i} ${'pad '.repeat(40)}`, Date.now());
    candidatePages = pagesOf(raw, 'memory_candidates');
  });
  overwritePages(candidatePages, pageSize, 0xee);
}

/** 150 memories over a freelist the header miscounts (offset 36), which no table's own check reads. */
function seedDamagedFreelist(): void {
  seedStore((raw) => {
    insertMemories(raw, 300, (i) => `fact ${i} ${'pad '.repeat(30)}`);
    raw.exec('DELETE FROM memories WHERE rowid % 2 = 0');
  });
  const header = Buffer.alloc(4);
  header.writeUInt32BE(readFileSync(dbPath).readUInt32BE(36) + 7);
  const fd = openSync(dbPath, 'r+');
  writeSync(fd, header, 0, 4, 36);
  closeSync(fd);
}

function markForRepair(): void {
  writeFileSync(repairMarkerPath(dbPath), JSON.stringify({ foundAt: new Date().toISOString() }));
}

function count(sql: string, file = dbPath): number {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return (raw.prepare(sql).get() as { n: number }).n;
  } finally {
    raw.close();
  }
}

function quarantined(): string[] {
  return readdirSync(path.dirname(dbPath)).filter((entry) => /^memory\.v3\.db\.corrupt-\d+$/.test(entry));
}

function recoveredNotice(memories: number): unknown {
  return { level: 'warn', message: expect.stringContaining(`${memories} memories were recovered`) as string, actions: [] };
}

const damagedNotice = { level: 'warn', message: 'Damocles found damage in the memory database. It is repaired the next time Damocles starts.', actions: [] };

describe('memory integrity check on a worker', () => {
  it('rebuilds a damaged full-text index online; the write queued meanwhile then succeeds', async () => {
    // Zeroed leaf pages of the index's data table break every FTS write trigger while `memories` stays intact.
    let leaves: number[] = [];
    const pageSize = seedStore((raw) => {
      insertMemories(raw, 400, (i) => `searchable term unique${i} ${'filler '.repeat(20)}`);
      const rootPage = (raw.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'memories_fts_data'").get() as { rootpage: number }).rootpage;
      leaves = pagesOf(raw, 'memories_fts_data').filter((page) => page !== rootPage);
    });
    overwritePages(leaves, pageSize, 0x00);

    const { service: s, fake } = service();
    const note = await s.addNote('delta searchable needle');

    expect(note).not.toBeNull();
    expect(requests).toEqual(['check', 'rebuildFts']);
    expect(count("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'needle'")).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM memories')).toBe(401);
    expect(fake.notifications.calls).toEqual([]);
    expect(existsSync(repairMarkerPath(dbPath))).toBe(false);
    expect(quarantined()).toEqual([]);
  }, 30_000);

  it('a torn page outside the index makes the run read only with one notice and a marker, and the next start salvages the store', async () => {
    seedTornStore();

    const first = service();
    await expect(first.service.addNote('refused')).rejects.toBeInstanceOf(MemoryReadOnlyError);
    await vi.waitFor(() => expect(first.fake.notifications.calls).toEqual([damagedNotice]));
    expect(existsSync(repairMarkerPath(dbPath))).toBe(true);
    expect(await first.service.addNote('refused again')).toBeNull();
    expect(first.service.listNotes()).toEqual([]);
    expect((first.service.database!.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(40);
    await first.service.dispose();

    requests.length = 0;
    const second = service();
    await second.service.ensureInitialized();
    expect(existsSync(repairMarkerPath(dbPath))).toBe(false);
    expect(quarantined()).toHaveLength(1);
    expect(second.fake.notifications.calls).toEqual([recoveredNotice(40)]);
    expect(await second.service.addNote('writes again')).not.toBeNull();
    expect(requests).toEqual(['repair', 'check']);
    expect(count('SELECT COUNT(*) AS n FROM memories')).toBe(41);
    expect(count('SELECT COUNT(*) AS n FROM memory_candidates')).toBe(0);
  }, 30_000);

  it('a damaged freelist is database-level damage, never the index: the run goes read only and the next start salvages', async () => {
    seedDamagedFreelist();

    const first = service();
    await expect(first.service.addNote('refused')).rejects.toBeInstanceOf(MemoryReadOnlyError);
    await vi.waitFor(() => expect(first.fake.notifications.calls).toEqual([damagedNotice]));
    expect(requests).toEqual(['check']);
    expect(existsSync(repairMarkerPath(dbPath))).toBe(true);
    await first.service.dispose();

    const second = service();
    await second.service.ensureInitialized();
    expect(second.fake.notifications.calls).toEqual([recoveredNotice(150)]);
    expect(await second.service.addNote('writes again')).not.toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM memories')).toBe(151);
    expect(runIntegrityRequest({ type: 'check', dbPath })).toBe('ok');
  }, 30_000);

  it('a rebuild that leaves a finding answers corrupt', () => {
    seedDamagedFreelist();
    expect(runIntegrityRequest({ type: 'rebuildFts', dbPath })).toBe('corrupt');
  });

  it('never checks a store whose schema is newer than this build', async () => {
    let candidatePages: number[] = [];
    const pageSize = seedStore((raw) => {
      insertMemories(raw, 5, (i) => `fact ${i}`);
      const insert = raw.prepare("INSERT INTO memory_candidates (id, user_text, assistant_text, created_at) VALUES (?, ?, 'a', 1)");
      for (let i = 0; i < 200; i++) insert.run(`cand-${i}`, 'pad '.repeat(40));
      candidatePages = pagesOf(raw, 'memory_candidates');
      const { v } = raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
      raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v + 1);
    });
    overwritePages(candidatePages, pageSize, 0xee);

    const { service: s, fake } = service();
    await s.ensureInitialized();
    await s.dispose();

    expect(requests).toEqual([]);
    expect(existsSync(repairMarkerPath(dbPath))).toBe(false);
    expect(fake.notifications.calls).toEqual([
      { level: 'warn', message: expect.stringContaining('newer version') as string, actions: [] },
    ]);
  });

  it('lets writes through when the worker cannot answer', async () => {
    const { service: s, fake } = service(mkdtempSync(path.join(os.tmpdir(), 'damocles-no-worker-')));
    expect(await s.addNote('written without a check')).not.toBeNull();
    expect(requests).toEqual(['check']);
    expect(fake.notifications.calls).toEqual([]);
  });

  it('holds writes only for the hold; a slower check still makes the run read only when it finds damage', async () => {
    seedStore((raw) => insertMemories(raw, 3, (i) => `fact ${i}`));
    let answer!: (verdict: IntegrityVerdict) => void;
    service$.check = () => new Promise((resolve) => (answer = resolve));
    service$.holdMs = 50;

    const { service: s, fake } = service();
    expect(await s.addNote('written while the check runs')).not.toBeNull();
    expect(requests).toEqual(['check']);

    answer('corrupt');
    await vi.waitFor(() => expect(fake.notifications.calls).toEqual([damagedNotice]));
    expect(existsSync(repairMarkerPath(dbPath))).toBe(true);
    expect(await s.addNote('refused')).toBeNull();
  });

  it('a store the open finds damaged is salvaged on the worker, then opened', async () => {
    seedStore((raw) => insertMemories(raw, 12, (i) => `fact ${i}`));
    // A torn root page of `schema_version` fails the open's first read, as a damaged header page would.
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const root = (raw.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'schema_version'").get() as { rootpage: number }).rootpage;
    const pageSize = (raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    raw.close();
    const fd = openSync(dbPath, 'r+');
    writeSync(fd, Buffer.alloc(pageSize, 0xee), 0, pageSize, (root - 1) * pageSize);
    closeSync(fd);
    expect(await openMemoryDatabaseAt(dbPath)).toBe('corrupt');

    const { service: s, fake } = service();
    expect(await s.addNote('after the salvage')).not.toBeNull();
    expect(requests).toEqual(['repair', 'check']);
    expect(quarantined()).toHaveLength(1);
    expect(existsSync(repairMarkerPath(dbPath))).toBe(false);
    expect(fake.notifications.calls).toEqual([recoveredNotice(12)]);
    expect(count('SELECT COUNT(*) AS n FROM memories')).toBe(13);
  }, 30_000);
});

describe('a repair stopped midway', () => {
  /** Runs the repair on this thread until a stop throws. */
  function stopRepair(): void {
    expect(() => runIntegrityRequest({ type: 'repair', dbPath })).toThrow();
    stops.rename = null;
    stops.rm = null;
    stops.copy = null;
    expect(existsSync(repairMarkerPath(dbPath))).toBe(true);
  }

  /** Runs the repair until a stop, then starts the app with the real worker, which salvages every memory. */
  async function stopThenRestart(expected: number): Promise<void> {
    stopRepair();
    await restartSalvages(expected);
  }

  async function restartSalvages(expected: number): Promise<void> {
    const next = service();
    await next.service.ensureInitialized();
    expect(existsSync(repairMarkerPath(dbPath))).toBe(false);
    expect(quarantined()).toHaveLength(1);
    expect(next.fake.notifications.calls).toEqual([recoveredNotice(expected)]);
    expect(count('SELECT COUNT(*) AS n FROM memories')).toBe(expected);
    expect(await next.service.addNote('writes again')).not.toBeNull();
    expect(runIntegrityRequest({ type: 'check', dbPath })).toBe('ok');
  }

  it('after the marker names the quarantined file, before the store moves', async () => {
    seedTornStore();
    markForRepair();
    // The move's own failure path catches the stop, which leaves the files as a stop there would.
    stops.rename = (from) => (from === dbPath ? stop() : undefined);
    expect(runIntegrityRequest({ type: 'repair', dbPath })).toEqual({ kind: 'failed' });
    stops.rename = null;
    expect(JSON.parse(readFileSync(repairMarkerPath(dbPath), 'utf8'))).toEqual({ salvageFrom: expect.stringMatching(/^memory\.v3\.db\.corrupt-\d+$/) as string });
    expect(quarantined()).toEqual([]);
    await restartSalvages(40);
  }, 30_000);

  it('after the store moved, before the copy', async () => {
    seedTornStore();
    markForRepair();
    stops.rm = (file) => (file.endsWith('.salvage') ? stop() : undefined);
    await stopThenRestart(40);
  }, 30_000);

  it('mid-copy, before any row', async () => {
    seedTornStore();
    markForRepair();
    stops.copy = 'rows';
    await stopThenRestart(40);
  }, 30_000);

  it('mid-copy, with the rows copied and the search index not built', async () => {
    seedTornStore();
    markForRepair();
    stops.copy = 'index';
    await stopThenRestart(40);
  }, 30_000);

  it('before the complete copy moves into place', async () => {
    seedTornStore();
    markForRepair();
    stops.rename = (from, to) => (from.endsWith('.salvage') && to === dbPath ? stop() : undefined);
    await stopThenRestart(40);
  }, 30_000);

  it('after the copy moved into place, before the marker was removed', async () => {
    seedTornStore();
    markForRepair();
    stops.rm = (file) => (file === repairMarkerPath(dbPath) ? stop() : undefined);
    await stopThenRestart(40);
  }, 30_000);

  it('between the main file and its WAL, keeping the rows only the WAL holds', async () => {
    seedTornStore();
    // Five more memories live only in the WAL: copies taken while a connection holds it unflushed.
    const raw = new DatabaseSync(dbPath, { timeout: 5000 });
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA wal_autocheckpoint = 0');
    insertMemories(raw, 5, (i) => `wal fact ${i}`, 40);
    const main = readFileSync(dbPath);
    const wal = readFileSync(`${dbPath}-wal`);
    raw.close();
    rmSync(`${dbPath}-shm`, { force: true });
    writeFileSync(dbPath, main);
    writeFileSync(`${dbPath}-wal`, wal);
    markForRepair();
    stops.rename = (from) => (from === `${dbPath}-wal` ? stop() : undefined);
    await stopThenRestart(45);
  }, 30_000);

  it('a pending salvage never reads as intact and never imports the legacy store', async () => {
    seedTornStore();
    seedStore((legacy) => insertMemories(legacy, 1, () => 'legacy fact', 900), legacyPath);
    markForRepair();
    stops.rm = (file) => (file.endsWith('.salvage') ? stop() : undefined);
    stopRepair();
    expect(existsSync(dbPath)).toBe(false);

    // A start whose repair cannot run stays read only on an empty store and imports nothing.
    const stalled = service(mkdtempSync(path.join(os.tmpdir(), 'damocles-no-worker-')));
    await stalled.service.ensureInitialized();
    expect(await stalled.service.addNote('refused')).toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM memories')).toBe(0);
    expect(stalled.fake.notifications.calls).toEqual([damagedNotice]);
    await stalled.service.dispose();

    await restartSalvages(40);
    expect(count("SELECT COUNT(*) AS n FROM memories WHERE id = 'mem-900'")).toBe(0);
  }, 30_000);
});

describe('repair coordination', () => {
  it('dispose lets a running repair finish', async () => {
    seedTornStore();
    markForRepair();
    const { service: s } = service();
    const init = s.ensureInitialized();
    await vi.waitFor(() => expect(requests).toContain('repair'));
    await s.dispose();
    await init;

    expect(existsSync(repairMarkerPath(dbPath))).toBe(false);
    expect(quarantined()).toHaveLength(1);
    expect(count('SELECT COUNT(*) AS n FROM memories')).toBe(40);
  }, 30_000);

  it('two apps starting together repair the store once', async () => {
    seedTornStore();
    markForRepair();
    const a = service();
    const b = service();
    await Promise.all([a.service.ensureInitialized(), b.service.ensureInitialized()]);

    expect(quarantined()).toHaveLength(1);
    expect([...a.fake.notifications.calls, ...b.fake.notifications.calls]).toEqual([recoveredNotice(40)]);
    expect(count('SELECT COUNT(*) AS n FROM memories')).toBe(40);
  }, 30_000);

  it.runIf(process.platform === 'win32')('a store another app holds open stays damaged and marked until a later start', async () => {
    seedTornStore();
    markForRepair();
    const holder = new DatabaseSync(dbPath, { readOnly: true });
    holder.prepare('PRAGMA user_version').get();
    try {
      const first = service();
      await first.service.ensureInitialized();
      expect(await first.service.addNote('refused')).toBeNull();
      expect(existsSync(repairMarkerPath(dbPath))).toBe(true);
      expect(quarantined()).toEqual([]);
      expect(first.fake.notifications.calls).toEqual([damagedNotice]);
      await first.service.dispose();
    } finally {
      holder.close();
    }

    const second = service();
    await second.service.ensureInitialized();
    expect(second.fake.notifications.calls).toEqual([recoveredNotice(40)]);
    expect(existsSync(repairMarkerPath(dbPath))).toBe(false);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('a store moved aside while open makes the next write refuse, so nothing lands in the moved file', async () => {
    seedStore((raw) => insertMemories(raw, 3, (i) => `fact ${i}`));
    const { service: s, fake } = service();
    expect(await s.addNote('before the move')).not.toBeNull();

    // Another app's repair: the store moves aside and a new one takes its path.
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${dbPath}${suffix}`)) renameSync(`${dbPath}${suffix}`, `${dbPath}.corrupt-1${suffix}`);
    seedStore(() => undefined);

    await expect(s.addNote('after the move')).rejects.toThrow(/moved or replaced/);
    expect(fake.notifications.calls).toEqual([
      { level: 'warn', message: expect.stringContaining('moved or replaced') as string, actions: [] },
    ]);
    expect(count('SELECT COUNT(*) AS n FROM memories')).toBe(0);
  });

  it('a request after dispose starts no worker', async () => {
    const integrity = createMemoryIntegrity(path.join(root, 'dist', 'memory-integrity-worker.js'));
    await integrity.dispose();
    await expect(integrity.check(dbPath)).rejects.toThrow('memory integrity was disposed');
    await expect(integrity.repair(dbPath)).rejects.toThrow('memory integrity was disposed');
  });
});

describe('openAndMigrate', () => {
  it('runs no integrity check on the calling thread', async () => {
    const file = path.join(os.tmpdir(), `damocles-open-${crypto.randomUUID()}.db`);
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
    try {
      const opened = await openMemoryDatabaseAt(file);
      if (opened === null || opened === 'corrupt') throw new Error(`open failed: ${opened}`);
      opened.db.close();
      const statements = [...prepare.mock.calls, ...exec.mock.calls].map(([sql]) => sql);
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.filter((sql) => /quick_check|integrity_check|integrity-check/i.test(sql))).toEqual([]);
    } finally {
      prepare.mockRestore();
      exec.mockRestore();
    }
  });
});
