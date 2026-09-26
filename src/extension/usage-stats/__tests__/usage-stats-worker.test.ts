import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UsageStatsQuery } from '../../../shared/types/usage-stats';

vi.mock('../indexer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../indexer')>();
  return { ...actual, indexUsage: vi.fn(actual.indexUsage) };
});

import { indexUsage } from '../indexer';
import { createUsageStatsWorkerRuntime, type UsageStatsWorkerRuntimeOptions } from '../usage-stats-worker';
import type { WorkerEvent, WorkerQueryRequest } from '../worker-protocol';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-worker-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const slug = path.join(sessionsDir, '--work--');
  fs.mkdirSync(slug, { recursive: true });
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
  fs.writeFileSync(
    path.join(slug, '2025-03-01T10-00-00-000Z_s1.jsonl'),
    [
      { type: 'session', id: 's1', timestamp: '2025-03-01T10:00:00.000Z', cwd: root },
      { type: 'message', id: 'aa000001', timestamp: '2025-03-01T10:00:01.000Z', message: { role: 'assistant', provider: 'p', model: 'm', stopReason: 'stop', usage } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  const events: WorkerEvent[] = [];
  const runtime = createUsageStatsWorkerRuntime((e) => events.push(e));
  const request = (id: number, query: Partial<UsageStatsQuery>): WorkerQueryRequest => ({
    type: 'query',
    id,
    paths: { sessionsDir, ledgerPath: path.join(root, 'subcalls.jsonl'), dbPath: path.join(root, 'usage.db') },
    models: [{ key: 'p/m', label: 'M', inputRatePerToken: 0.001 }],
    query: { startMs: 0, endMs: Date.parse('2030-01-01'), previous: null, modelKeys: [], projectKeys: [], bucket: 'day', timeZone: 'UTC', scan: true, ...query },
  });
  const finalFor = async (id: number) => {
    await expect.poll(() => events.some((e) => (e.type === 'result' && e.id === id && e.final) || (e.type === 'error' && e.id === id))).toBe(true);
    return events.filter((e) => e.type !== 'log' && e.id === id);
  };
  const restart = (options: UsageStatsWorkerRuntimeOptions) => createUsageStatsWorkerRuntime((e) => events.push(e), options);
  return { runtime, request, events, finalFor, restart, dbPath: path.join(root, 'usage.db') };
}

describe('usage stats worker runtime', () => {
  it('first scan sends progress and one final report, with no early report from the empty index', async () => {
    const { runtime, request, finalFor } = setup();
    runtime.handle(request(1, {}));
    const events = await finalFor(1);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(events.some((e) => e.type === 'progress')).toBe(true);
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: 'result', final: true, report: { totals: { cost: 0.03, requests: 1, sessions: 1 } } });
    runtime.handle({ type: 'close' });
  });

  it('a later scan answers from the index first, then again after the scan', async () => {
    const { runtime, request, finalFor } = setup();
    runtime.handle(request(1, {}));
    await finalFor(1);
    runtime.handle(request(2, {}));
    const results = (await finalFor(2)).filter((e) => e.type === 'result');
    expect(results.map((e) => e.type === 'result' && e.final)).toEqual([false, true]);
    runtime.handle({ type: 'close' });
  });

  it('buckets in the zone each query names', async () => {
    const { runtime, request, finalFor } = setup();
    runtime.handle(request(1, {}));
    await finalFor(1);
    // The one entry is at 2025-03-01T10:00:01Z.
    runtime.handle(request(2, { scan: false, timeZone: 'Pacific/Kiritimati' }));
    runtime.handle(request(3, { scan: false, timeZone: 'America/Los_Angeles' }));
    const [kiritimati, losAngeles] = [(await finalFor(2)).at(-1), (await finalFor(3)).at(-1)];
    expect(kiritimati).toMatchObject({ report: { series: { points: [{ bucket: '2025-03-02' }] }, heatmap: [{ weekday: 6, hour: 0 }] } });
    expect(losAngeles).toMatchObject({ report: { series: { points: [{ bucket: '2025-03-01' }] }, heatmap: [{ weekday: 5, hour: 2 }] } });
    runtime.handle({ type: 'close' });
  });

  it('scan false answers exactly once from the index', async () => {
    const { runtime, request, finalFor } = setup();
    runtime.handle(request(1, { scan: false }));
    const events = await finalFor(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'result', final: true, report: { indexedAtMs: null, totals: { requests: 0 } } });
    runtime.handle({ type: 'close' });
  });

  it('a scan request arriving mid-scan joins it and still gets its own final report', async () => {
    const { runtime, request, finalFor } = setup();
    vi.mocked(indexUsage).mockClear();
    runtime.handle(request(1, {}));
    runtime.handle(request(2, {}));
    const [a, b] = await Promise.all([finalFor(1), finalFor(2)]);
    expect(indexUsage).toHaveBeenCalledTimes(1);
    expect(a.at(-1)).toMatchObject({ type: 'result', final: true });
    expect(b.some((e) => e.type === 'progress')).toBe(true);
    expect(b.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(b.at(-1)).toMatchObject({ type: 'result', final: true, report: { totals: { requests: 1 } } });
    runtime.handle({ type: 'close' });
  });

  it('a corrupt page that a query hits closes the index, and the next open checks it and moves it aside', async () => {
    const { runtime, request, finalFor, restart, dbPath } = setup();
    runtime.handle(request(1, {}));
    await finalFor(1);
    runtime.handle({ type: 'close' });
    // Page 1 (header and schema) stays intact, so an open that skips quick_check succeeds.
    const bytes = fs.readFileSync(dbPath);
    expect(bytes.length).toBeGreaterThan(4096);
    bytes.fill(0xff, 4096);
    fs.writeFileSync(dbPath, bytes);

    const unchecked = restart({ quickCheck: false });
    unchecked.handle(request(2, { scan: false }));
    expect(await finalFor(2)).toEqual([expect.objectContaining({ type: 'error', message: expect.stringMatching(/malformed/) })]);
    unchecked.handle(request(3, { scan: false }));
    expect(await finalFor(3)).toEqual([expect.objectContaining({ type: 'result', report: expect.objectContaining({ indexedAtMs: null }) })]);
    expect(fs.readdirSync(path.dirname(dbPath)).filter((name) => /^usage\.db\.corrupt-\d+$/.test(name))).toHaveLength(1);
    unchecked.handle({ type: 'close' });
  });
});
