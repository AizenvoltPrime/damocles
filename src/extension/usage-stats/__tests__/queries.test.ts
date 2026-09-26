import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NO_PROJECT_KEY, type UsageStatsAggregate, type UsageStatsQuery, type UsageStatsTotals } from '../../../shared/types/usage-stats';
import { cacheHitRate, netCacheSavings, type NormalizedUsage } from '../../../shared/usage-accounting';
import { openUsageDatabase, type UsageDatabase } from '../database';
import { buildReport, loadRates, localParts, queryByModel, queryByProject, queryBySource, queryFilterOptions, queryHeatmap, querySeries, queryTopSessions, queryTotals } from '../queries';
import type { UsageStatsModel } from '../worker-protocol';

const SONNET = 'anthropic/claude-sonnet-4-5';
const MODELS: UsageStatsModel[] = [
  { key: SONNET, label: 'Claude Sonnet 4.5', inputRatePerToken: 3e-6 },
  { key: 'openai/gpt-5', label: 'GPT-5', inputRatePerToken: 1.25e-6 },
];

const P1 = 'c:\\work\\alpha';
const P2 = 'c:\\work\\beta';

/** The zone `noon` and `localAt` are read in; each query below buckets in it unless it names another. */
const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Local noon keeps every row on its calendar date whatever the machine's zone. */
const noon = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12).getTime();
const localAt = (y: number, m: number, d: number, h: number, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

interface Seed {
  key: string;
  tsMs: number;
  sessionId?: string | null;
  projectKey?: string;
  origin?: string;
  kind?: string;
  detail?: string | null;
  modelKey?: string | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total: number };
}

let root: string;
let db: UsageDatabase;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-usage-queries-')));
  db = openUsageDatabase(path.join(root, 'usage.db'), () => undefined);
  db.prepare('INSERT INTO projects (project_key, cwd) VALUES (?, ?), (?, ?), (?, NULL)').run(P1, 'C:\\Work\\alpha', P2, 'C:\\Work\\beta', NO_PROJECT_KEY);
  db.prepare("INSERT INTO files (file_id, path, kind) VALUES (1, 'fixture', 'main')").run();
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function seed(rows: readonly Seed[]): void {
  const insert = db.prepare(`INSERT INTO entries (entry_key, ts_ms, session_id, agent_session_id, session_started_ms, project_key, origin, kind,
    detail, provider, model, model_key, input, output, cache_read, cache_write, cache_write_1h, reasoning, cost_input, cost_output,
    cost_cache_read, cost_cache_write, cost_total, stop_reason, file_id)
    VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'stop', 1)`);
  for (const r of rows) {
    const c = r.cost ?? { total: 0 };
    insert.run(
      r.key, r.tsMs, r.sessionId === undefined ? 'S1' : r.sessionId, r.projectKey ?? P1, r.origin ?? 'main', r.kind ?? 'assistant', r.detail ?? null,
      r.modelKey === undefined ? SONNET : r.modelKey,
      r.input ?? 0, r.output ?? 0, r.cacheRead ?? 0, r.cacheWrite ?? 0,
      c.input ?? 0, c.output ?? 0, c.cacheRead ?? 0, c.cacheWrite ?? 0, c.total,
    );
  }
}

const normalized = (r: Seed): NormalizedUsage => ({
  input: r.input ?? 0, output: r.output ?? 0, cacheRead: r.cacheRead ?? 0, cacheWrite: r.cacheWrite ?? 0, cacheWrite1h: 0, reasoning: 0,
  cost: { input: r.cost?.input ?? 0, output: r.cost?.output ?? 0, cacheRead: r.cost?.cacheRead ?? 0, cacheWrite: r.cost?.cacheWrite ?? 0, total: r.cost?.total ?? 0 },
});

const ALL = { startMs: 0, endMs: Number.MAX_SAFE_INTEGER };
const NO_FILTER = { modelKeys: [], projectKeys: [] };

function totals(range = ALL, filters: { modelKeys: string[]; projectKeys: string[] } = NO_FILTER) {
  loadRates(db, MODELS);
  return queryTotals(db, range, filters, HOST_ZONE);
}

// Priced with its own input rate (3e-6): saves 12000 * 3e-6 - 0.0105 = 0.0255.
const OWN_RATE: Seed = {
  key: 'e1', tsMs: noon(2025, 1, 10), input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000,
  cost: { input: 0.003, output: 0.0075, cacheRead: 0.003, cacheWrite: 0.0075, total: 0.021 },
};
// No uncached input, so the registry rate for Sonnet (3e-6) applies: 20000 * 3e-6 - 0.006 = 0.054. A nested row of S1.
const REGISTRY_RATE: Seed = {
  key: 'e2', tsMs: noon(2025, 1, 10) + 1000, origin: 'subagent', output: 100, cacheRead: 20_000,
  cost: { output: 0.0015, cacheRead: 0.006, total: 0.0075 },
};
// No uncached input and a model the registry does not know: no rate, no saving.
const NO_RATE: Seed = {
  key: 'e3', tsMs: noon(2025, 1, 11), sessionId: 'S2', projectKey: P2, modelKey: 'custom/unknown', output: 10, cacheRead: 5000,
  cost: { output: 0.001, cacheRead: 0.001, total: 0.002 },
};
// Tokens with zero recorded cost: unpriced, reported apart, saves nothing.
const UNPRICED: Seed = {
  key: 'e4', tsMs: localAt(2025, 1, 11, 18), sessionId: null, projectKey: NO_PROJECT_KEY, modelKey: 'local/llama', input: 300, output: 200, cacheRead: 1000,
  cost: { total: 0 },
};
// Cache writes outweigh the reads: 10000 * 3e-6 - 0.0375 = -0.0075.
const NEGATIVE: Seed = {
  key: 'e5', tsMs: noon(2025, 1, 13), sessionId: 'S3', input: 100, cacheWrite: 10_000,
  cost: { input: 0.0003, cacheWrite: 0.0375, total: 0.0378 },
};
const D5_ROWS = [OWN_RATE, REGISTRY_RATE, NO_RATE, UNPRICED, NEGATIVE];

describe('queryTotals D5 math', () => {
  beforeEach(() => seed(D5_ROWS));

  it('sums recorded cost and keeps unpriced tokens apart', () => {
    const t = totals();
    expect(t.cost).toBeCloseTo(0.021 + 0.0075 + 0.002 + 0.0378, 12);
    expect(t.unpricedTokens).toBe(300 + 200 + 1000);
    expect({ input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }).toEqual({
      input: 1400, output: 810, cacheRead: 36_000, cacheWrite: 12_000,
    });
    // Total tokens and cache hit rate are derived from these four with the shared helpers.
    expect(t.input + t.output + t.cacheRead + t.cacheWrite).toBe(50_210);
    expect(cacheHitRate(t.input, t.cacheRead, t.cacheWrite)).toBeCloseTo(36_000 / 49_400, 12);
  });

  it('never reports unpriced usage as spend', () => {
    const t = totals({ startMs: localAt(2025, 1, 11, 17), endMs: localAt(2025, 1, 11, 19) });
    expect(t).toMatchObject({ cost: 0, unpricedTokens: 1500, netCacheSavings: 0, requests: 1 });
  });

  it('nets cache savings per entry: own input rate, registry fallback, no rate, unpriced excluded, negative allowed', () => {
    const t = totals();
    expect(t.netCacheSavings).toBeCloseTo(0.0255 + 0.054 + 0 + 0 - 0.0075, 12);
    const rates = new Map(MODELS.map((m) => [m.key, m.inputRatePerToken]));
    const shared = D5_ROWS.reduce((acc, r) => acc + netCacheSavings(normalized(r), rates.get(r.modelKey === undefined ? SONNET : r.modelKey ?? '')), 0);
    expect(t.netCacheSavings).toBeCloseTo(shared, 12);
    expect(totals({ startMs: noon(2025, 1, 13), endMs: noon(2025, 1, 14) }).netCacheSavings).toBeCloseTo(-0.0075, 12);
  });

  it('counts requests, distinct top-level sessions and distinct local days', () => {
    // S1 has a main and a nested row; the unpriced ledger row has no session.
    expect(totals()).toMatchObject({ requests: 5, sessions: 3, activeDays: 3 });
  });

  it('takes the start as inclusive and the end as exclusive', () => {
    const t = totals({ startMs: OWN_RATE.tsMs, endMs: NO_RATE.tsMs });
    expect(t).toMatchObject({ requests: 2, sessions: 1, activeDays: 1 });
  });

  it('answers an empty range with zeros', () => {
    expect(totals({ startMs: noon(2030, 1, 1), endMs: noon(2030, 1, 2) })).toEqual({
      cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, netCacheSavings: 0, requests: 0, sessions: 0, activeDays: 0,
    });
  });
});

describe('filters', () => {
  beforeEach(() => seed(D5_ROWS));

  it('filters by model keys', () => {
    expect(totals(ALL, { modelKeys: [SONNET], projectKeys: [] })).toMatchObject({ requests: 3, sessions: 2 });
    expect(totals(ALL, { modelKeys: [SONNET, 'local/llama'], projectKeys: [] })).toMatchObject({ requests: 4, unpricedTokens: 1500 });
  });

  it('filters by project keys, including no project', () => {
    expect(totals(ALL, { modelKeys: [], projectKeys: [P2] })).toMatchObject({ requests: 1, sessions: 1 });
    expect(totals(ALL, { modelKeys: [], projectKeys: [NO_PROJECT_KEY] })).toMatchObject({ requests: 1, sessions: 0, unpricedTokens: 1500 });
    expect(totals(ALL, { modelKeys: [SONNET], projectKeys: [P1] })).toMatchObject({ requests: 3 });
  });

  it('binds filter values as data, never as SQL', () => {
    const hostile = ["x' OR '1'='1", '") OR 1=1 --', '%', '*'];
    expect(totals(ALL, { modelKeys: hostile, projectKeys: [] })).toMatchObject({ requests: 0, cost: 0 });
    expect(totals(ALL, { modelKeys: [], projectKeys: hostile })).toMatchObject({ requests: 0, cost: 0 });
  });
});

describe('buildReport', () => {
  beforeEach(() => seed(D5_ROWS));

  const query = (over: Partial<UsageStatsQuery>): UsageStatsQuery => ({
    startMs: noon(2025, 1, 11) - 12 * 3_600_000, endMs: noon(2025, 1, 14), previous: null, modelKeys: [], projectKeys: [], bucket: 'day', timeZone: HOST_ZONE, scan: false, ...over,
  });

  it('answers the previous period with the same filters, or null when there is none', () => {
    const report = buildReport(db, query({ previous: { startMs: noon(2025, 1, 9), endMs: noon(2025, 1, 11) - 12 * 3_600_000 }, modelKeys: [SONNET] }), MODELS);
    expect(report.range).toEqual({ startMs: noon(2025, 1, 11) - 12 * 3_600_000, endMs: noon(2025, 1, 14) });
    expect(report.totals).toMatchObject({ requests: 1, sessions: 1, activeDays: 1 });
    expect(report.totals.cost).toBeCloseTo(0.0378, 12);
    expect(report.previousTotals).toMatchObject({ requests: 2, sessions: 1, activeDays: 1 });
    expect(report.previousTotals!.cost).toBeCloseTo(0.021 + 0.0075, 12);
    expect(buildReport(db, query({}), MODELS).previousTotals).toBeNull();
    expect(report.indexedAtMs).toBeNull();
  });

  it('lists every indexed model with its registry label and every project with usage', () => {
    const options = queryFilterOptions(db, MODELS);
    expect(options.models).toEqual([
      { key: SONNET, label: 'Claude Sonnet 4.5' },
      { key: 'custom/unknown', label: 'custom/unknown' },
      { key: 'local/llama', label: 'local/llama' },
    ]);
    expect(options.projects).toEqual([
      { key: NO_PROJECT_KEY, cwd: null },
      { key: P1, cwd: 'C:\\Work\\alpha' },
      { key: P2, cwd: 'C:\\Work\\beta' },
    ]);
  });
});

const priced = (total: number): NonNullable<Seed['cost']> => ({ input: total / 4, output: total / 4, cacheRead: total / 4, cacheWrite: total / 4, total });

// One row per source shape the indexer writes, including compactions and cache warms inside nested files.
const SOURCE_ROWS: Seed[] = [
  { key: 's-main', tsMs: noon(2025, 1, 14), input: 100, output: 50, cost: priced(0.1) },
  { key: 's-main-compaction', tsMs: noon(2025, 1, 14) + 1, kind: 'compaction', input: 400, output: 80, cost: priced(0.2) },
  { key: 's-main-branch', tsMs: noon(2025, 1, 15), kind: 'branch_summary', input: 300, output: 60, cost: priced(0.05) },
  { key: 's-main-warm', tsMs: noon(2025, 1, 15) + 1, kind: 'usage:cache_warm', cacheRead: 900, cost: priced(0.01) },
  { key: 's-sub', tsMs: noon(2025, 1, 15) + 2, origin: 'subagent', detail: 'Explore', modelKey: 'openai/gpt-5', input: 200, output: 40, cost: priced(0.3) },
  { key: 's-sub-plan', tsMs: noon(2025, 1, 16), origin: 'subagent', detail: 'Plan', input: 20, output: 4, cost: priced(0.03) },
  { key: 's-sub-untyped', tsMs: noon(2025, 1, 16) + 1, origin: 'subagent', detail: null, input: 10, output: 2, cost: priced(0.02) },
  { key: 's-sub-compaction', tsMs: noon(2025, 1, 16) + 2, origin: 'subagent', detail: 'Explore', kind: 'compaction', modelKey: null, input: 500, output: 90, cost: priced(0.4) },
  { key: 's-sub-warm', tsMs: noon(2025, 1, 17), origin: 'subagent', detail: 'Explore', kind: 'usage:cache_warm', cacheRead: 700, cost: priced(0.007) },
  { key: 's-team', tsMs: noon(2025, 1, 17) + 1, origin: 'team', detail: 'Backend Architect', projectKey: P2, sessionId: 'S4', input: 60, output: 30, cost: priced(0.6) },
  { key: 's-team-warm', tsMs: noon(2025, 1, 17) + 2, origin: 'team', detail: 'Backend Architect', kind: 'usage:cache_warm', projectKey: P2, sessionId: 'S4', cacheWrite: 300, cost: priced(0.003) },
  { key: 's-bg-title', tsMs: noon(2025, 1, 18), origin: 'background', kind: 'subcall', detail: 'session-title', sessionId: null, projectKey: NO_PROJECT_KEY, modelKey: 'openai/gpt-5', input: 30, output: 5, cost: priced(0.001) },
  { key: 's-bg-title-2', tsMs: noon(2025, 1, 18) + 1, origin: 'background', kind: 'subcall', detail: 'session-title', sessionId: 'S1', input: 40, output: 6, cost: priced(0.002) },
  { key: 's-bg-rerank', tsMs: noon(2025, 1, 18) + 2, origin: 'background', kind: 'subcall', detail: 'memory-rerank', sessionId: null, projectKey: P2, modelKey: 'local/llama', input: 70, output: 7, cost: { total: 0 } },
];

const tokensOf = (a: { input: number; output: number; cacheRead: number; cacheWrite: number }): number => a.input + a.output + a.cacheRead + a.cacheWrite;

function sumAggregates(rows: readonly UsageStatsAggregate[]): UsageStatsAggregate {
  return rows.reduce<UsageStatsAggregate>(
    (acc, r) => ({
      cost: acc.cost + r.cost, input: acc.input + r.input, output: acc.output + r.output, cacheRead: acc.cacheRead + r.cacheRead,
      cacheWrite: acc.cacheWrite + r.cacheWrite, unpricedTokens: acc.unpricedTokens + r.unpricedTokens, requests: acc.requests + r.requests,
    }),
    { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, requests: 0 },
  );
}

function expectSumsTo(label: string, sum: UsageStatsAggregate, total: UsageStatsTotals): void {
  expect(sum.cost, `${label} cost`).toBeCloseTo(total.cost, 12);
  expect({ input: sum.input, output: sum.output, cacheRead: sum.cacheRead, cacheWrite: sum.cacheWrite, unpricedTokens: sum.unpricedTokens, requests: sum.requests }, label)
    .toEqual({ input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite, unpricedTokens: total.unpricedTokens, requests: total.requests });
}

describe('breakdowns', () => {
  beforeEach(() => seed([...D5_ROWS, ...SOURCE_ROWS]));

  const JAN = { startMs: noon(2025, 1, 1), endMs: noon(2025, 2, 1) };

  function sourcesOf(range = ALL, filters: { modelKeys: string[]; projectKeys: string[] } = NO_FILTER) {
    loadRates(db, MODELS);
    return queryBySource(db, range, filters);
  }

  it('gives every entry exactly one source; compaction and cache warming win over the file they sit in', () => {
    const rows = sourcesOf({ startMs: noon(2025, 1, 14), endMs: noon(2025, 1, 19) });
    const byKey = new Map(rows.map((r) => [`${r.source}:${r.detail ?? '-'}`, r]));
    expect([...byKey.keys()].sort()).toEqual([
      'background:memory-rerank',
      'background:session-title',
      'cacheWarm:main',
      'cacheWarm:subagent',
      'cacheWarm:team',
      'compaction:branch_summary',
      'compaction:compaction',
      'main:-',
      'subagent:-',
      'subagent:Explore',
      'subagent:Plan',
      'team:Backend Architect',
    ]);
    // The subagent's own compaction and cache warm are not counted as subagent spend; only its assistant turn is.
    expect(byKey.get('subagent:Explore')).toMatchObject({ requests: 1, input: 200 });
    expect(byKey.get('compaction:compaction')).toMatchObject({ requests: 2, input: 900 });
    expect(byKey.get('cacheWarm:subagent')).toMatchObject({ requests: 1, cacheRead: 700 });
    expect(byKey.get('team:Backend Architect')).toMatchObject({ requests: 1, input: 60 });
  });

  it('lists background tasks as ledger rows by purpose, keeping unpriced ones apart', () => {
    const background = sourcesOf().filter((r) => r.source === 'background');
    expect(background.map((r) => [r.detail, r.requests])).toEqual([['session-title', 2], ['memory-rerank', 1]]);
    expect(background[0]!.cost).toBeCloseTo(0.003, 12);
    expect(background[1]).toMatchObject({ cost: 0, unpricedTokens: 77 });
  });

  it('orders models by cost, labels them from the registry and keeps an unrecorded model as null', () => {
    loadRates(db, MODELS);
    const rows = queryByModel(db, JAN, NO_FILTER, MODELS);
    expect(rows.map((r) => [r.key, r.label])).toEqual([
      [SONNET, 'Claude Sonnet 4.5'],
      [null, null],
      ['openai/gpt-5', 'GPT-5'],
      ['custom/unknown', null],
      ['local/llama', null],
    ]);
    expect(rows.find((r) => r.key === 'local/llama')).toMatchObject({ cost: 0, unpricedTokens: 1500 + 77, requests: 2 });
  });

  it('lists projects with their folder, including no project', () => {
    loadRates(db, MODELS);
    const rows = queryByProject(db, JAN, NO_FILTER);
    expect(rows.map((r) => [r.key, r.cwd])).toEqual([[P1, 'C:\\Work\\alpha'], [P2, 'C:\\Work\\beta'], [NO_PROJECT_KEY, null]]);
  });

  it('splits each local bucket by model with the four token counts and four cost fields', () => {
    loadRates(db, MODELS);
    const day = querySeries(db, { startMs: noon(2025, 1, 10) - 12 * 3_600_000, endMs: noon(2025, 1, 12) }, NO_FILTER, 'day', HOST_ZONE);
    expect(day.bucket).toBe('day');
    expect(day.points.map((p) => [p.bucket, p.modelKey])).toEqual([
      ['2025-01-10', SONNET],
      ['2025-01-11', 'custom/unknown'],
      ['2025-01-11', 'local/llama'],
    ]);
    // OWN_RATE and REGISTRY_RATE share the day and the model.
    expect(day.points[0]).toMatchObject({ input: 1000, output: 600, cacheRead: 30_000, cacheWrite: 2000 });
    expect(day.points[0]!.costInput).toBeCloseTo(0.003, 12);
    expect(day.points[0]!.costOutput).toBeCloseTo(0.009, 12);
    expect(day.points[0]!.costCacheRead).toBeCloseTo(0.009, 12);
    expect(day.points[0]!.costCacheWrite).toBeCloseTo(0.0075, 12);
    expect(day.points[0]!.cost).toBeCloseTo(0.0285, 12);

    const week = querySeries(db, JAN, NO_FILTER, 'week', HOST_ZONE);
    expect([...new Set(week.points.map((p) => p.bucket))]).toEqual(['2025-01-06', '2025-01-13']);
    const month = querySeries(db, ALL, NO_FILTER, 'month', HOST_ZONE);
    expect([...new Set(month.points.map((p) => p.bucket))]).toEqual(['2025-01']);
  });

  const cases: Array<[string, UsageStatsQuery['bucket'], { startMs: number; endMs: number }, { modelKeys: string[]; projectKeys: string[] }]> = [
    ['everything', 'month', ALL, NO_FILTER],
    ['a day range', 'day', { startMs: noon(2025, 1, 11), endMs: noon(2025, 1, 17) }, NO_FILTER],
    ['one model', 'week', JAN, { modelKeys: [SONNET], projectKeys: [] }],
    ['two models', 'day', JAN, { modelKeys: ['openai/gpt-5', 'local/llama'], projectKeys: [] }],
    ['one project', 'day', JAN, { modelKeys: [], projectKeys: [P2] }],
    ['no project', 'day', JAN, { modelKeys: [], projectKeys: [NO_PROJECT_KEY] }],
    ['a model and a project', 'week', JAN, { modelKeys: [SONNET], projectKeys: [P1] }],
    ['an empty range', 'day', { startMs: noon(2030, 1, 1), endMs: noon(2030, 1, 2) }, NO_FILTER],
  ];

  it.each(cases)('sums every breakdown and the series to the totals: %s', (_label, bucket, range, filters) => {
    const report = buildReport(db, { ...range, previous: null, ...filters, bucket, timeZone: HOST_ZONE, scan: false }, MODELS);
    const total = report.totals;
    expectSumsTo('byModel', sumAggregates(report.byModel!), total);
    expectSumsTo('byProject', sumAggregates(report.byProject!), total);
    expectSumsTo('bySource', sumAggregates(report.bySource!), total);

    const points = report.series!.points;
    expect(points.reduce((acc, p) => acc + p.cost, 0), 'series cost').toBeCloseTo(total.cost, 12);
    expect(points.reduce((acc, p) => acc + tokensOf(p), 0), 'series tokens').toBe(tokensOf(total));
    expect(report.series!.bucket).toBe(bucket);

    const cells = report.heatmap!;
    expect(cells.reduce((acc, c) => acc + c.cost, 0), 'heatmap cost').toBeCloseTo(total.cost, 12);
    expect(cells.reduce((acc, c) => acc + c.tokens, 0), 'heatmap tokens').toBe(tokensOf(total));
    expect(cells.reduce((acc, c) => acc + c.requests, 0), 'heatmap requests').toBe(total.requests);
  });

  it('keeps the source rows mutually exclusive: no entry is counted twice', () => {
    const rows = sourcesOf();
    expect(rows.reduce((acc, r) => acc + r.requests, 0)).toBe(D5_ROWS.length + SOURCE_ROWS.length);
    expect(new Set(rows.map((r) => `${r.source}:${r.detail}`)).size).toBe(rows.length);
  });
});

describe('localParts', () => {
  const localDate = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it.each([
    // [label, date, week Monday, weekday 0=Mon]
    ['Monday', [2025, 1, 13], '2025-01-13', 0],
    ['Wednesday', [2025, 1, 15], '2025-01-13', 2],
    ['Sunday', [2025, 1, 19], '2025-01-13', 6],
    ['a week spanning the new year', [2025, 1, 1], '2024-12-30', 2],
    ['the Sunday before it', [2024, 12, 29], '2024-12-23', 6],
    ['a leap day', [2024, 2, 29], '2024-02-26', 3],
  ] as const)('buckets %s at noon by day, ISO week, month and weekday', (_label, [y, m, d], monday, weekday) => {
    const day = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const expected = { day, week: monday, month: day.slice(0, 7), weekday, hour: 12 };
    expect(localParts('UTC', Date.UTC(y, m - 1, d, 12))).toEqual(expected);
    // Auckland is UTC+13 in these months, so the same wall clock is 13 hours earlier.
    expect(localParts('Pacific/Auckland', Date.UTC(y, m - 1, d, 12) - 13 * 3_600_000)).toEqual(expected);
  });

  it('keeps zones apart for the same instant', () => {
    const ts = Date.UTC(2025, 0, 31, 18, 15);
    expect(localParts('UTC', ts)).toMatchObject({ day: '2025-01-31', hour: 18 });
    expect(localParts('Asia/Kathmandu', ts)).toMatchObject({ day: '2025-02-01', month: '2025-02', hour: 0 });
    expect(localParts('America/Los_Angeles', ts)).toMatchObject({ day: '2025-01-31', hour: 10 });
  });

  it('rejects an unknown zone', () => {
    expect(() => localParts('Mars/Olympus_Mons', 0)).toThrow(RangeError);
  });

  /** The first instant of each 2025 UTC offset change in this machine's zone. */
  function offsetChanges(year: number): number[] {
    const changes: number[] = [];
    let prev = new Date(year, 0, 1).getTimezoneOffset();
    for (let ms = new Date(year, 0, 1).getTime(); ms < new Date(year + 1, 0, 1).getTime(); ms += 15 * 60_000) {
      const offset = new Date(ms).getTimezoneOffset();
      if (offset !== prev) changes.push(ms);
      prev = offset;
    }
    return changes;
  }

  // The webview keys buckets with `Date`, so both must agree in its zone; a zone without DST has no change to cross.
  const changes = offsetChanges(2025);
  it.skipIf(changes.length === 0)('agrees with the JavaScript local clock on both sides of each DST change in the machine zone', () => {
    for (const change of changes) {
      for (const ts of [change - 30 * 60_000, change + 30 * 60_000]) {
        const parts = localParts(HOST_ZONE, ts);
        expect({ ts, hour: parts.hour, day: parts.day }).toEqual({ ts, hour: new Date(ts).getHours(), day: localDate(ts) });
      }
    }
  });
});

describe('buckets in the query zone', () => {
  function reportIn(timeZone: string, bucket: UsageStatsQuery['bucket']) {
    return buildReport(db, { ...ALL, previous: null, ...NO_FILTER, bucket, timeZone, scan: false }, MODELS);
  }

  function keys(timeZone: string, bucket: UsageStatsQuery['bucket']): string[] {
    return [...new Set(reportIn(timeZone, bucket).series!.points.map((p) => p.bucket))];
  }

  function cells(timeZone: string): Array<[number, number, number]> {
    return reportIn(timeZone, 'day').heatmap!.map((c) => [c.weekday, c.hour, c.requests]);
  }

  const rowsAt = (instants: readonly string[]): Seed[] =>
    instants.map((iso, i) => ({ key: `z${i}`, tsMs: Date.parse(iso), output: 10, cost: { output: 0.01, total: 0.01 } }));

  it('cuts days, weeks, months, the heatmap and active days in Auckland across the April 2025 DST end', () => {
    seed(rowsAt([
      '2025-03-31T10:30:00Z', // Mon 31 Mar 23:30 NZDT (+13)
      '2025-04-05T13:30:00Z', // Sun 6 Apr 02:30 NZDT, before the change
      '2025-04-05T14:30:00Z', // Sun 6 Apr 02:30 NZST (+12), the repeated hour
      '2025-04-06T11:30:00Z', // Sun 6 Apr 23:30 NZST; the pre-change offset would give Monday
      '2025-04-06T12:30:00Z', // Mon 7 Apr 00:30 NZST
    ]));
    const zone = 'Pacific/Auckland';
    expect(keys(zone, 'day')).toEqual(['2025-03-31', '2025-04-06', '2025-04-07']);
    expect(keys(zone, 'week')).toEqual(['2025-03-31', '2025-04-07']);
    expect(keys(zone, 'month')).toEqual(['2025-03', '2025-04']);
    expect(cells(zone)).toEqual([[0, 0, 1], [0, 23, 1], [6, 2, 2], [6, 23, 1]]);
    expect(reportIn(zone, 'day').totals.activeDays).toBe(3);
  });

  it('cuts days, weeks, months, the heatmap and active days in Los Angeles across the March 2025 DST start', () => {
    seed(rowsAt([
      '2025-03-09T09:30:00Z', // Sun 9 Mar 01:30 PST (-8)
      '2025-03-09T10:30:00Z', // Sun 9 Mar 03:30 PDT (-7); 02:xx does not exist
      '2025-03-10T07:30:00Z', // Mon 10 Mar 00:30 PDT; the pre-change offset would give Sunday
      '2025-04-01T07:30:00Z', // Tue 1 Apr 00:30 PDT; the pre-change offset would give March
    ]));
    const zone = 'America/Los_Angeles';
    expect(keys(zone, 'day')).toEqual(['2025-03-09', '2025-03-10', '2025-04-01']);
    expect(keys(zone, 'week')).toEqual(['2025-03-03', '2025-03-10', '2025-03-31']);
    expect(keys(zone, 'month')).toEqual(['2025-03', '2025-04']);
    expect(cells(zone)).toEqual([[0, 0, 1], [1, 0, 1], [6, 1, 1], [6, 3, 1]]);
    expect(reportIn(zone, 'day').totals.activeDays).toBe(3);
  });

  it('cuts at the quarter hour in Kathmandu (UTC+05:45)', () => {
    seed(rowsAt([
      '2025-01-31T18:14:59.999Z', // Fri 31 Jan 23:59
      '2025-01-31T18:15:00Z', // Sat 1 Feb 00:00
    ]));
    const zone = 'Asia/Kathmandu';
    expect(keys(zone, 'day')).toEqual(['2025-01-31', '2025-02-01']);
    expect(keys(zone, 'week')).toEqual(['2025-01-27']);
    expect(keys(zone, 'month')).toEqual(['2025-01', '2025-02']);
    expect(cells(zone)).toEqual([[4, 23, 1], [5, 0, 1]]);
    // One UTC date, two Kathmandu dates.
    expect(reportIn(zone, 'day').totals.activeDays).toBe(2);
    expect(reportIn('UTC', 'day').totals.activeDays).toBe(1);
  });

  it('keeps the series and the heatmap summing to the totals in every zone', () => {
    seed([...D5_ROWS, ...SOURCE_ROWS]);
    for (const zone of ['Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kathmandu']) {
      const report = reportIn(zone, 'day');
      expect(report.series!.points.reduce((acc, p) => acc + tokensOf(p), 0), zone).toBe(tokensOf(report.totals));
      expect(report.heatmap!.reduce((acc, c) => acc + c.requests, 0), zone).toBe(report.totals.requests);
    }
  });

  it('fails the report for an unknown zone and leaves no transaction open', () => {
    seed(D5_ROWS);
    expect(() => reportIn('Mars/Olympus_Mons', 'day')).toThrow();
    expect(db.isTransaction).toBe(false);
  });
});

describe('queryHeatmap', () => {
  beforeEach(() => seed(D5_ROWS));

  it('places each request in its local weekday (Monday first) and hour', () => {
    loadRates(db, MODELS);
    const cells = queryHeatmap(db, ALL, NO_FILTER, HOST_ZONE);
    // 2025-01-10 is a Friday and 2025-01-11 a Saturday.
    expect(cells.find((c) => c.weekday === 4 && c.hour === 12)).toMatchObject({ requests: 2, tokens: 13_500 + 20_100 });
    expect(cells.find((c) => c.weekday === 5 && c.hour === 18)).toEqual({ weekday: 5, hour: 18, cost: 0, tokens: 1500, requests: 1 });
    expect(cells.every((c) => c.weekday >= 0 && c.weekday <= 6 && c.hour >= 0 && c.hour <= 23)).toBe(true);
  });
});

describe('queryTopSessions', () => {
  beforeEach(() => {
    seed([...D5_ROWS, ...SOURCE_ROWS]);
    db.prepare(`INSERT INTO sessions (session_id, project_key, title, started_ms, file_id, missing) VALUES
      ('S1', ?, 'Alpha work', 1, 1, 0), ('S2', ?, NULL, 1, 1, 1), ('S4', ?, 'Team run', 1, 1, 0)`).run(P1, P2, P2);
    loadRates(db, MODELS);
  });

  it('rolls subagent, team and attributed sub-call spend into the parent and ranks by cost', () => {
    const top = queryTopSessions(db, ALL, NO_FILTER, 10);
    expect(top.map((s) => s.sessionId)).toEqual(['S1', 'S4', 'S3', 'S2']);
    const s1 = top[0]!;
    expect(s1.cost).toBeCloseTo(1.1475, 12);
    expect(s1).toMatchObject({ title: 'Alpha work', projectKey: P1, cwd: 'C:\\Work\\alpha', missing: false, openable: false, requests: 12 });
    expect(s1.lastActiveMs).toBe(noon(2025, 1, 18) + 1);
  });

  it('keeps a deleted conversation with no title, and one never indexed as a session under its entries project', () => {
    const top = queryTopSessions(db, ALL, NO_FILTER, 10);
    expect(top.find((s) => s.sessionId === 'S2')).toMatchObject({ title: null, missing: true, projectKey: P2 });
    expect(top.find((s) => s.sessionId === 'S3')).toMatchObject({ title: null, missing: false, projectKey: P1, cwd: 'C:\\Work\\alpha' });
  });

  it('never lists spend with no conversation, honours the limit and applies the filters', () => {
    expect(queryTopSessions(db, ALL, NO_FILTER, 10).every((s) => s.sessionId !== null)).toBe(true);
    expect(queryTopSessions(db, ALL, NO_FILTER, 2).map((s) => s.sessionId)).toEqual(['S1', 'S4']);
    expect(queryTopSessions(db, ALL, { modelKeys: [], projectKeys: [P2] }, 10).map((s) => s.sessionId)).toEqual(['S4', 'S2']);
  });
});
