import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';

// a folder the scan cannot list, as a permission or I/O error makes one
const unlistable = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  const readdirSync = ((dir: import('node:fs').PathLike, ...rest: unknown[]) => {
    if (unlistable.dir !== undefined && String(dir) === unlistable.dir) throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(dir)}'`), { code: 'EACCES' });
    return (actual.readdirSync as (...args: unknown[]) => unknown)(dir, ...rest);
  }) as typeof actual.readdirSync;
  return { ...actual, default: { ...actual, readdirSync }, readdirSync };
});
import * as os from 'node:os';
import * as path from 'node:path';
import { MIRROR_CLOCK_FILE, MIRROR_SUBCALLS_FILE } from '../../../shared/remote-mirror';
import { hostNoProjectKey, hostProjectKey } from '../../../shared/types/usage-stats';
import { DAMOCLES_CREDENTIAL_SOURCE_ENTRY } from '../../pi-session/session-store/constants';
import { openUsageDatabase, type UsageDatabase } from '../database';
import { indexUsage, projectKeyOf } from '../indexer';
import { buildReport } from '../queries';
import type { UsageStatsModel } from '../worker-protocol';

const MODELS: UsageStatsModel[] = [{ key: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', inputRatePerToken: 3e-6 }];
const T0 = Date.parse('2025-06-10T09:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const TARGET_CWD = '/home/dev/app';
const LOCAL_CWD = path.resolve('/work/repo');

type Line = Record<string, unknown>;

const header = (id: string, cwd: string): Line => ({ type: 'session', version: 3, id, timestamp: at(0), cwd });
const assistant = (id: string, minute: number, cost: number, provider = 'anthropic'): Line => ({
  type: 'message', id, parentId: null, timestamp: at(minute),
  message: {
    role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'anthropic-messages', provider, model: 'claude-sonnet-4-5',
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } },
    stopReason: 'stop', timestamp: Date.parse(at(minute)),
  },
});
const credentialSource = (id: string, clientProviders: string[]): Line => ({
  type: 'custom', customType: DAMOCLES_CREDENTIAL_SOURCE_ENTRY, id, parentId: null, timestamp: at(0), data: { clientProviders },
});

function write(file: string, lines: readonly Line[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

let root: string;
let db: UsageDatabase;
let sessionsDir: string;
let remoteMirrorsDir: string;
const mirrorFile = (hostId: string, name: string): string => path.join(remoteMirrorsDir, hostId, 'mirror', 'a'.repeat(32), name);

beforeEach(() => {
  logged = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-mirror-'));
  sessionsDir = path.join(root, 'sessions');
  remoteMirrorsDir = path.join(root, 'remote');
  db = openUsageDatabase(path.join(root, 'usage.db'), () => undefined);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

let logged: string[] = [];
const scan = () => indexUsage({ db, sessionsDir, ledgerPath: path.join(root, 'subcalls.jsonl'), remoteMirrorsDir, models: MODELS, log: (line) => logged.push(line) });
const report = (startMs = 0, endMs = T0 + 86_400_000) => buildReport(db, {
  startMs, endMs, previous: null, modelKeys: [], projectKeys: [], bucket: 'day', timeZone: 'UTC', scan: false,
}, MODELS);

// a sub-call ledger line as subcall-ledger.ts writes it
const subcall = (id: string, timestamp: string, cost: number, extra: Line = {}): Line => ({
  v: 1, type: 'subcall', id, timestamp, purpose: 'session-title', provider: 'anthropic', model: 'claude-sonnet-4-5', stopReason: 'stop', cwd: null, sessionId: null,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } },
  ...extra,
});
const hostLedger = (hostId: string): string => path.join(remoteMirrorsDir, hostId, 'mirror', MIRROR_SUBCALLS_FILE);
const setClock = (hostId: string, skewMs: number): void => {
  fs.mkdirSync(path.join(remoteMirrorsDir, hostId, 'mirror'), { recursive: true });
  fs.writeFileSync(path.join(remoteMirrorsDir, hostId, 'mirror', MIRROR_CLOCK_FILE), JSON.stringify({ skewMs }));
};
const tsOf = (id: string): number => (db.prepare('SELECT ts_ms FROM entries WHERE entry_key LIKE ?').get(`${id}|%`) as { ts_ms: number }).ts_ms;
const MINUTE = 60_000;

describe('the session mirror in the usage index', () => {
  it('counts a mirrored session under its host-qualified project, its rows carrying the host id', async () => {
    write(path.join(sessionsDir, '--work-repo--', '2025_local-1.jsonl'), [header('local-1', LOCAL_CWD), assistant('l1', 1, 0.5)]);
    write(mirrorFile('prod-1', '2025_remote-1.jsonl'), [header('remote-1', TARGET_CWD), assistant('r1', 2, 1.5)]);
    await scan();
    const result = report();
    expect(result.totals.cost).toBeCloseTo(2);
    expect(result.byProject).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: hostProjectKey('prod-1', TARGET_CWD), cwd: TARGET_CWD, hostId: 'prod-1', cost: 1.5 }),
      expect.objectContaining({ key: projectKeyOf(LOCAL_CWD), cwd: LOCAL_CWD, cost: 0.5 }),
    ]));
    expect(result.byProject!.find((row) => row.cwd === LOCAL_CWD)).not.toHaveProperty('hostId');
    expect(result.filterOptions.projects).toContainEqual({ key: hostProjectKey('prod-1', TARGET_CWD), cwd: TARGET_CWD, hostId: 'prod-1' });
    expect(result.topSessions!.find((row) => row.sessionId === 'remote-1')).toMatchObject({ hostId: 'prod-1', cwd: TARGET_CWD });
  });

  it('keeps one host\'s project apart from another host\'s project at the same path', async () => {
    write(mirrorFile('prod-1', '2025_s1.jsonl'), [header('s1', TARGET_CWD), assistant('a1', 1, 1)]);
    write(mirrorFile('staging', '2025_s2.jsonl'), [header('s2', TARGET_CWD), assistant('a2', 1, 2)]);
    await scan();
    expect(report().byProject!.map((row) => [row.hostId, row.cost])).toEqual([['staging', 2], ['prod-1', 1]]);
  });

  it('keeps the spend of a mirrored session after the mirror drops its file', async () => {
    const file = mirrorFile('prod-1', '2025_remote-1.jsonl');
    write(file, [header('remote-1', TARGET_CWD), assistant('r1', 2, 1.5)]);
    await scan();
    fs.rmSync(file);
    await scan();
    const result = report();
    expect(result.totals.cost).toBeCloseTo(1.5);
    expect(result.byProject).toEqual([expect.objectContaining({ hostId: 'prod-1', cost: 1.5 })]);
    expect(result.topSessions).toEqual([expect.objectContaining({ sessionId: 'remote-1', hostId: 'prod-1', missing: true })]);
  });

  it('attributes a run on the host\'s own credential to that host, one row per host', async () => {
    write(mirrorFile('prod-1', '2025_s1.jsonl'), [header('s1', TARGET_CWD), credentialSource('c1', []), assistant('a1', 1, 3)]);
    write(mirrorFile('staging', '2025_s2.jsonl'), [header('s2', TARGET_CWD), credentialSource('c2', ['anthropic']), assistant('a2', 1, 1)]);
    write(mirrorFile('staging', '2025_s3.jsonl'), [header('s3', '/srv/other'), credentialSource('c3', []), assistant('a3', 1, 2)]);
    await scan();
    expect(report().byCredential).toEqual([
      expect.objectContaining({ credential: 'host', hostId: 'prod-1', cost: 3 }),
      expect.objectContaining({ credential: 'host', hostId: 'staging', cost: 2 }),
      expect.objectContaining({ credential: 'signIn', cost: 1 }),
    ]);
    expect(report().byCredential!.find((row) => row.credential === 'signIn')).not.toHaveProperty('hostId');
  });

  it('indexes this computer and every other host while one host\'s mirror, or the mirrors folder, cannot be listed', async () => {
    write(path.join(sessionsDir, '--work-repo--', '2025_local-1.jsonl'), [header('local-1', LOCAL_CWD), assistant('l1', 1, 0.5)]);
    write(mirrorFile('prod-1', '2025_s1.jsonl'), [header('s1', TARGET_CWD), assistant('a1', 1, 1)]);
    write(mirrorFile('staging', '2025_s2.jsonl'), [header('s2', TARGET_CWD), assistant('a2', 1, 2)]);
    const costs = (): Array<[string | undefined, number]> => report().byProject!.map((row) => [row.hostId, row.cost]);
    try {
      unlistable.dir = remoteMirrorsDir;
      await scan();
      expect(costs()).toEqual([[undefined, 0.5]]);
      unlistable.dir = path.join(remoteMirrorsDir, 'prod-1', 'mirror');
      await scan();
      expect(costs()).toEqual([['staging', 2], [undefined, 0.5]]);
    } finally {
      unlistable.dir = undefined;
    }
    expect(logged).toContainEqual(expect.stringContaining("prod-1's mirror; retrying on the next scan"));
    await scan();
    expect(costs()).toEqual([['staging', 2], ['prod-1', 1], [undefined, 0.5]]);
  });

  it('skips a folder under the mirrors whose name is not a safe host id', async () => {
    write(path.join(remoteMirrorsDir, '..bad', 'mirror', 'a'.repeat(32), '2025_s1.jsonl'), [header('s1', TARGET_CWD), assistant('a1', 1, 1)]);
    await scan();
    expect(report().totals.requests).toBe(0);
  });
});

describe('a host\'s sub-call ledger in the usage index', () => {
  it('counts each sub-call under that host: its project, its own no-project row and its environment, beside this computer\'s ledger', async () => {
    write(hostLedger('prod-1'), [
      subcall('t1', at(1), 1, { cwd: TARGET_CWD, sessionId: 'remote-1', credentialSource: 'host' }),
      subcall('t2', at(2), 2, { purpose: 'memory-extract' }),
    ]);
    write(path.join(root, 'subcalls.jsonl'), [subcall('l1', at(3), 4)]);
    await scan();
    const result = report();
    expect(result.totals.cost).toBeCloseTo(7);
    expect(result.byProject).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: hostProjectKey('prod-1', TARGET_CWD), cwd: TARGET_CWD, hostId: 'prod-1', cost: 1 }),
      expect.objectContaining({ key: hostNoProjectKey('prod-1'), cwd: null, hostId: 'prod-1', cost: 2 }),
      expect.objectContaining({ key: '', cwd: null, cost: 4 }),
    ]));
    expect(result.byProject!.find((row) => row.key === '')).not.toHaveProperty('hostId');
    expect(result.byCredential).toEqual([
      expect.objectContaining({ credential: 'signIn', cost: 6 }),
      expect.objectContaining({ credential: 'host', hostId: 'prod-1', cost: 1 }),
    ]);
    expect(result.bySource).toEqual([
      expect.objectContaining({ source: 'background', detail: 'session-title', cost: 5 }),
      expect.objectContaining({ source: 'background', detail: 'memory-extract', cost: 2 }),
    ]);
  });

  it('keeps the spend of a host\'s sub-calls after the mirror truncates its ledger, and after it drops it', async () => {
    const ledger = hostLedger('prod-1');
    write(ledger, [subcall('t1', at(1), 1), subcall('t2', at(2), 2)]);
    await scan();
    write(ledger, [subcall('t3', at(3), 4)]);
    await scan();
    expect(report().totals.cost).toBeCloseTo(7);
    fs.rmSync(ledger);
    await scan();
    expect(report().totals.cost).toBeCloseTo(7);
    expect(report().byProject).toEqual([expect.objectContaining({ key: hostNoProjectKey('prod-1'), hostId: 'prod-1', cost: 7 })]);
  });
});

// /stats ends its range at the next minute on this computer's clock, so a host's times count only once on that clock.
describe('a host\'s clock in the usage index', () => {
  const NOW = T0 + 30 * MINUTE;
  const nextMinute = NOW + MINUTE;
  const iso = (ms: number): string => new Date(ms).toISOString();

  for (const [label, skewMs] of [['10 minutes ahead', 10 * MINUTE], ['10 minutes behind', -10 * MINUTE]] as const) {
    it(`counts the spend of a host ${label} at this computer's time, sessions and sub-calls alike`, async () => {
      setClock('prod-1', skewMs);
      // written on the host just now, by its own clock
      write(mirrorFile('prod-1', '2025_s1.jsonl'), [{ ...header('s1', TARGET_CWD), timestamp: iso(NOW - 5 * MINUTE + skewMs) }, { ...assistant('a1', 0, 1), timestamp: iso(NOW + skewMs) }]);
      write(hostLedger('prod-1'), [subcall('t1', iso(NOW + skewMs), 2)]);
      write(path.join(root, 'subcalls.jsonl'), [subcall('l1', iso(NOW), 4)]);
      await scan();
      expect(report(NOW - MINUTE, nextMinute).totals.cost).toBeCloseTo(7);
      expect([tsOf('a1'), tsOf('t1'), tsOf('l1')]).toEqual([NOW, NOW, NOW]);
    });
  }

  for (const [before, after] of [[10 * MINUTE, 0], [0, 10 * MINUTE]] as const) {
    it(`keeps the time a row was first indexed with when the skew moves from ${before / MINUTE} to ${after / MINUTE} minutes, and gives rows indexed later the new skew`, async () => {
      const ledger = hostLedger('prod-1');
      setClock('prod-1', before);
      write(ledger, [subcall('t1', iso(NOW + before), 1)]);
      await scan();
      setClock('prod-1', after);
      // a rewrite reads the file again from its start
      write(ledger, [subcall('t0', iso(NOW + after), 4), subcall('t1', iso(NOW + before), 1), subcall('t2', iso(NOW + after), 2)]);
      await scan();
      expect([tsOf('t0'), tsOf('t1'), tsOf('t2')]).toEqual([NOW, NOW, NOW]);
    });
  }

  it('indexes none of a host\'s files while its clock file holds no skew, and indexes them once it does', async () => {
    fs.mkdirSync(path.join(remoteMirrorsDir, 'prod-1', 'mirror'), { recursive: true });
    fs.writeFileSync(path.join(remoteMirrorsDir, 'prod-1', 'mirror', MIRROR_CLOCK_FILE), '{"skewMs":"soon"}');
    write(mirrorFile('prod-1', '2025_s1.jsonl'), [header('s1', TARGET_CWD), assistant('a1', 1, 1)]);
    write(hostLedger('prod-1'), [subcall('t1', at(1), 2)]);
    write(mirrorFile('staging', '2025_s2.jsonl'), [header('s2', TARGET_CWD), assistant('a2', 1, 4)]);
    await scan();
    expect(report().totals.cost).toBeCloseTo(4);
    expect(logged).toEqual([expect.stringContaining('The clock file of prod-1\'s mirror holds no skew')]);
    setClock('prod-1', MINUTE);
    await scan();
    expect(report().totals.cost).toBeCloseTo(7);
    expect(tsOf('t1')).toBe(T0);
  });
});
