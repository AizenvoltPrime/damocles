import type {
  UsageStatsAggregate,
  UsageStatsHeatmapCell,
  UsageStatsQuery,
  UsageStatsReport,
  UsageStatsSeriesPoint,
  UsageStatsSource,
  UsageStatsTotals,
} from '../../../src/shared/types/usage-stats.ts';

/** Per-million-token USD rates: input, output, cache read, cache write. */
const MODELS = [
  { key: 'anthropic/claude-opus-5-5', label: 'Opus 5.5', share: 0.58, rates: [5, 25, 0.5, 6.25] },
  { key: 'anthropic/claude-sonnet-5', label: 'Sonnet 5', share: 0.27, rates: [3, 15, 0.3, 3.75] },
  { key: 'openai-codex/gpt-6-sol', label: 'GPT-6 Sol', share: 0.15, rates: [2.5, 15, 0.25, 0] },
] as const;

const PROJECTS = [
  { key: 'c:/dev/acme-api', cwd: 'c:\\dev\\acme-api', share: 0.52 },
  { key: 'c:/dev/acme-web', cwd: 'c:\\dev\\acme-web', share: 0.31 },
  { key: 'c:/dev/infra', cwd: 'c:\\dev\\infra', share: 0.13 },
  { key: '', cwd: null, share: 0.04 },
];

const SOURCES: { source: UsageStatsSource; detail: string | null; share: number }[] = [
  { source: 'main', detail: null, share: 0.56 },
  { source: 'subagent', detail: 'Explore', share: 0.14 },
  { source: 'subagent', detail: 'general-purpose', share: 0.07 },
  { source: 'team', detail: 'lead', share: 0.08 },
  { source: 'team', detail: 'implementor', share: 0.06 },
  { source: 'team', detail: 'reviewer', share: 0.03 },
  { source: 'compaction', detail: 'compaction', share: 0.03 },
  { source: 'cacheWarm', detail: 'main', share: 0.02 },
  { source: 'background', detail: 'session-title', share: 0.01 },
];

const TOP_TITLES = [
  'Move sessions to Redis', 'Rate limit /login', 'Audit session cookie validation', 'Migrate billing webhooks to queues',
  'Fix flaky websocket reconnect test', 'Terraform: split staging and prod state', 'Add OpenTelemetry tracing', 'Dark mode for the dashboard',
  'Paginate the admin audit log', 'Upgrade to Express 5',
];

/** Deterministic, so every render shows the same dashboard. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const zero = (): UsageStatsAggregate => ({ cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, requests: 0 });

const scale = (a: UsageStatsAggregate, f: number): UsageStatsAggregate => ({
  cost: a.cost * f, input: Math.round(a.input * f), output: Math.round(a.output * f), cacheRead: Math.round(a.cacheRead * f),
  cacheWrite: Math.round(a.cacheWrite * f), unpricedTokens: 0, requests: Math.round(a.requests * f),
});

const add = (a: UsageStatsAggregate, b: UsageStatsAggregate): UsageStatsAggregate => ({
  cost: a.cost + b.cost, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite, unpricedTokens: 0, requests: a.requests + b.requests,
});

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A report for `query` whose every breakdown sums to its totals, as the real index guarantees. */
export function usageReport(query: UsageStatsQuery): UsageStatsReport {
  const rand = rng(20260928);
  const points: UsageStatsSeriesPoint[] = [];
  let total = zero();
  let activeDays = 0;
  const start = new Date(query.startMs);
  for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d.getTime() < query.endMs; d.setDate(d.getDate() + 1)) {
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    if (weekend && rand() < 0.6) continue;
    activeDays += 1;
    const trend = 0.75 + (d.getTime() - query.startMs) / (query.endMs - query.startMs) * 0.6;
    const volume = (weekend ? 0.35 : 1) * trend * (0.6 + rand() * 0.8);
    for (const m of MODELS) {
      const v = volume * m.share * (0.7 + rand() * 0.6);
      const input = Math.round(260_000 * v);
      const output = Math.round(95_000 * v);
      const cacheRead = Math.round(6_400_000 * v);
      const cacheWrite = m.rates[3] ? Math.round(420_000 * v) : 0;
      const [ri, ro, rr, rw] = m.rates;
      const costInput = (input * ri) / 1e6;
      const costOutput = (output * ro) / 1e6;
      const costCacheRead = (cacheRead * rr) / 1e6;
      const costCacheWrite = (cacheWrite * rw) / 1e6;
      const cost = costInput + costOutput + costCacheRead + costCacheWrite;
      points.push({ bucket: dayKey(d), modelKey: m.key, input, output, cacheRead, cacheWrite, costInput, costOutput, costCacheRead, costCacheWrite, cost });
      total = add(total, { cost, input, output, cacheRead, cacheWrite, unpricedTokens: 0, requests: Math.round(160 * v) });
    }
  }

  const byModel = MODELS.map((m) => points.filter((p) => p.modelKey === m.key).reduce<UsageStatsAggregate>((a, p) => add(a, {
    cost: p.cost, input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite, unpricedTokens: 0, requests: 0,
  }), zero())).map((agg, i) => ({ key: MODELS[i]!.key, label: MODELS[i]!.label, ...agg, requests: Math.round(total.requests * MODELS[i]!.share) }))
    .sort((a, b) => b.cost - a.cost);

  const heatmap: UsageStatsHeatmapCell[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const work = weekday < 5 && hour >= 9 && hour <= 19 ? 1 : 0;
      const evening = weekday < 5 && hour >= 20 && hour <= 23 ? 0.25 : 0;
      const weekend = weekday >= 5 && hour >= 11 && hour <= 18 ? 0.18 : 0;
      const lunchDip = hour === 13 ? 0.55 : 1;
      const w = (work + evening + weekend) * lunchDip * (0.5 + rand());
      if (w < 0.05) continue;
      heatmap.push({ weekday, hour, cost: total.cost / 70 * w, tokens: Math.round((total.input + total.output + total.cacheRead) / 70 * w), requests: Math.round(total.requests / 70 * w) });
    }
  }

  const topWeights = TOP_TITLES.map((_, i) => 0.09 / (1 + i * 0.35));
  const topSessions = TOP_TITLES.map((title, i) => ({
    sessionId: `0197a3c2-${String(1000 + i)}-7b2a-9c44-2f1d8e6b0a1${i}`,
    title, projectKey: PROJECTS[i % 3]!.key, cwd: PROJECTS[i % 3]!.cwd,
    lastActiveMs: query.endMs - (i * 2.3 + 0.2) * 86_400_000, missing: false, openable: false,
    ...scale(total, topWeights[i]!),
  }));

  const totals: UsageStatsTotals = { ...total, netCacheSavings: total.cost * 0.78, sessions: 64, activeDays };
  const previousTotals: UsageStatsTotals = { ...scale(total, 0.74), netCacheSavings: total.cost * 0.55, sessions: 49, activeDays: Math.max(1, activeDays - 3) };

  return {
    range: { startMs: query.startMs, endMs: query.endMs },
    totals,
    previousTotals: query.previous ? previousTotals : null,
    filterOptions: { models: MODELS.map((m) => ({ key: m.key, label: m.label })), projects: PROJECTS.map((p) => ({ key: p.key, cwd: p.cwd })) },
    indexedAtMs: Date.now(),
    series: { bucket: 'day', points },
    byModel,
    byProject: PROJECTS.map((p) => ({ key: p.key, cwd: p.cwd, ...scale(total, p.share) })),
    bySource: SOURCES.map((s) => ({ source: s.source, detail: s.detail, ...scale(total, s.share) })),
    heatmap,
    topSessions,
  };
}
