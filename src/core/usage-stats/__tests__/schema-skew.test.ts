import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UsageStatsQuery } from '@shared/types/usage-stats';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { sqliteContentFingerprint } from '../../../__mocks__/sqlite-content';
import { openUsageDatabase } from '../database';
import { UsageStatsService, type UsageStatsPaths } from '../index';

const QUERY: UsageStatsQuery = {
  startMs: 0,
  endMs: Date.parse('2030-01-01'),
  previous: null,
  modelKeys: [],
  projectKeys: [],
  bucket: 'day',
  timeZone: 'UTC',
  scan: true,
};

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const walSize = (dbPath: string): number => (existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0);
const setUserVersionFromAnotherApp = (dbPath: string, version: number): void => {
  const raw = new DatabaseSync(dbPath, { timeout: 5000 });
  raw.exec(`PRAGMA user_version = ${version}`);
  raw.close();
};
const appendLedgerRecord = (ledgerPath: string, id: string): void => {
  const record = {
    v: 1, type: 'subcall', id, timestamp: '2025-06-10T09:00:00.000Z', purpose: 'title', provider: 'anthropic', model: 'claude-haiku-4-5',
    stopReason: 'stop', cwd: null, sessionId: null,
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
  };
  appendFileSync(ledgerPath, `${JSON.stringify(record)}
`);
};
const notice = { level: 'warn', message: expect.stringContaining('the usage index') as string, actions: [] };
const userVersion = (dbPath: string): number => {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  const { user_version } = raw.prepare('PRAGMA user_version').get() as { user_version: number };
  raw.close();
  return user_version;
};

let root: string;
const services: UsageStatsService[] = [];

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'damocles-usage-skew-'));
  // The real worker bundle runs on a worker thread, resolved through AppPaths as the host resolves it.
  await build({
    entryPoints: [path.resolve(__dirname, '..', 'usage-stats-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: path.join(root, 'dist', 'usage-stats-worker.js'),
    logLevel: 'silent',
  });
});

afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function setup(name: string): { fake: FakePlatform; paths: UsageStatsPaths; service: UsageStatsService } {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const paths: UsageStatsPaths = { sessionsDir: path.join(dir, 'sessions'), ledgerPath: path.join(dir, 'subcalls.jsonl'), dbPath: path.join(dir, 'usage.db') };
  openUsageDatabase(paths.dbPath, () => {}).close();
  const fake = createFakePlatform({ appRoot: root });
  const service = new UsageStatsService({ workerPath: fake.paths.workerEntry('usageStats'), paths, notifications: fake.notifications });
  services.push(service);
  return { fake, paths, service };
}

describe('usage index schema skew', () => {
  it('the current version opens normally and scans without a notice', async () => {
    const { fake, paths, service } = setup('current');
    const version = userVersion(paths.dbPath);
    const report = await service.query(QUERY, [], () => {});
    expect(report.indexedAtMs).not.toBeNull();
    expect(fake.notifications.calls).toEqual([]);
    expect(userVersion(paths.dbPath)).toBe(version);
  });

  it('an index stamped one version ahead opens read only, answers from the index, writes nothing and notifies once', async () => {
    const { fake, paths, service } = setup('ahead');
    const version = userVersion(paths.dbPath);
    setUserVersionFromAnotherApp(paths.dbPath, version + 1);
    const before = sha(paths.dbPath);
    const content = sqliteContentFingerprint(paths.dbPath);

    const first = await service.query(QUERY, [], () => {});
    const second = await service.query(QUERY, [], () => {});
    // A scan would stamp indexedAtMs; the read-only worker never scans.
    expect([first.indexedAtMs, second.indexedAtMs]).toEqual([null, null]);
    expect(fake.notifications.calls).toEqual([notice]);
    expect(sqliteContentFingerprint(paths.dbPath)).toBe(content);
    expect(sha(paths.dbPath)).toBe(before);
    expect(walSize(paths.dbPath)).toBe(0);
    expect(userVersion(paths.dbPath)).toBe(version + 1);
  });

  it('an index migrated past this build while open goes read only at the next scan, writes nothing and notifies once', async () => {
    const { fake, paths, service } = setup('moved');
    appendLedgerRecord(paths.ledgerPath, 'subcall-1');
    const indexed = await service.query(QUERY, [], () => {});
    expect(indexed.indexedAtMs).not.toBeNull();

    const version = userVersion(paths.dbPath);
    setUserVersionFromAnotherApp(paths.dbPath, version + 1);
    appendLedgerRecord(paths.ledgerPath, 'subcall-2');
    const content = sqliteContentFingerprint(paths.dbPath);

    const first = await service.query(QUERY, [], () => {});
    const second = await service.query(QUERY, [], () => {});
    // Each would rescan and restamp indexedAtMs; the read-only worker answers from the index.
    expect([first.indexedAtMs, second.indexedAtMs]).toEqual([indexed.indexedAtMs, indexed.indexedAtMs]);
    expect(fake.notifications.calls).toEqual([notice]);
    expect(sqliteContentFingerprint(paths.dbPath)).toBe(content);
    expect(userVersion(paths.dbPath)).toBe(version + 1);
  });
});
