import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import type { UsageStatsReport, UsageStatsTotals } from '@shared/types/usage-stats';

import { useUsageStatsStore } from '../useUsageStatsStore';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/useVSCode', () => ({
  useVSCode: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m) }),
}));

type StatsRequest = Extract<WebviewToExtensionMessage, { type: 'requestUsageStats' }>;

function lastRequest(): StatsRequest {
  const msg = posted[posted.length - 1];
  if (msg?.type !== 'requestUsageStats') throw new Error(`expected requestUsageStats, got ${msg?.type}`);
  return msg;
}

function totals(cost: number): UsageStatsTotals {
  return { cost, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, netCacheSavings: 0, requests: 1, sessions: 1, activeDays: 1 };
}

function report(cost: number, indexedAtMs: number | null = 1_000): UsageStatsReport {
  return {
    range: { startMs: 0, endMs: 1 },
    totals: totals(cost),
    previousTotals: null,
    filterOptions: { models: [], projects: [] },
    indexedAtMs,
  };
}

function settle(store: ReturnType<typeof useUsageStatsStore>): void {
  store.handleResult({ type: 'usageStats', requestId: lastRequest().requestId, final: true, report: report(1) });
}

beforeEach(() => {
  posted.length = 0;
  setActivePinia(createPinia());
});

describe('useUsageStatsStore requests', () => {
  it('sends the zone its range and chart keys are computed in', () => {
    useUsageStatsStore().openOverlay();
    expect(lastRequest().query.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('sends UTC when the engine cannot detect the OS zone', () => {
    const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...resolved.call(this), timeZone: 'Etc/Unknown' };
    });
    try {
      useUsageStatsStore().openOverlay();
      expect(lastRequest().query.timeZone).toBe('UTC');
    } finally {
      spy.mockRestore();
    }
  });

  it('scans on open and on Refresh, and answers filter changes from the index only', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    expect(lastRequest().query.scan).toBe(true);
    settle(store);

    store.setModelKeys(['anthropic/claude-opus-4-5']);
    expect(lastRequest().query).toMatchObject({ scan: false, modelKeys: ['anthropic/claude-opus-4-5'] });

    store.setProjectKeys(['']);
    expect(lastRequest().query).toMatchObject({ scan: false, projectKeys: [''] });

    store.refresh();
    expect(lastRequest().query.scan).toBe(true);
  });

  it('sends a valid range with a previous period, and none once compare is off', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    const { query } = lastRequest();
    expect(Number.isFinite(query.startMs) && Number.isFinite(query.endMs)).toBe(true);
    expect(query.startMs).toBeLessThan(query.endMs);
    expect(query.previous).not.toBeNull();

    store.setCompare(false);
    expect(lastRequest().query.previous).toBeNull();
  });

  it('gives every request its own id', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    store.setCompare(false);
    const ids = posted.map((m) => (m as StatsRequest).requestId);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it('joins a scan still in flight when a filter changes, so a half-built index is never final', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    store.setCompare(false);
    expect(lastRequest().query.scan).toBe(true);
    store.setModelKeys(['openai/gpt-5']);
    expect(lastRequest().query.scan).toBe(true);

    settle(store);
    store.setModelKeys([]);
    expect(lastRequest().query.scan).toBe(false);
  });

  it('does not step past the present', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    settle(store);
    const before = posted.length;
    store.step(1);
    expect(posted.length).toBe(before);

    store.step(-1);
    expect(posted.length).toBe(before + 1);
    expect(lastRequest().query.scan).toBe(false);
  });
});

describe('useUsageStatsStore replies', () => {
  it('drops a reply to a request the user has moved past', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    const stale = lastRequest().requestId;
    store.setCompare(false);
    const current = lastRequest().requestId;

    store.handleResult({ type: 'usageStats', requestId: stale, final: true, report: report(99) });
    expect(store.report).toBeNull();
    expect(store.status).toBe('loading');

    store.handleResult({ type: 'usageStats', requestId: current, final: true, report: report(1) });
    expect(store.report?.totals.cost).toBe(1);
    expect(store.status).toBe('ready');
  });

  it('drops progress for a stale request', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    const stale = lastRequest().requestId;
    store.refresh();

    store.handleProgress({ type: 'usageStatsProgress', requestId: stale, filesDone: 1, filesTotal: 10 });
    expect(store.progress).toBeNull();
    expect(store.status).toBe('loading');
  });

  it('goes loading, indexing, ready through an early reply, progress and the final reply', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    const id = lastRequest().requestId;
    expect(store.status).toBe('loading');

    store.handleResult({ type: 'usageStats', requestId: id, final: false, report: report(1, 500) });
    expect(store.status).toBe('loading');
    expect(store.report?.totals.cost).toBe(1);
    expect(store.updatedAtMs).toBe(500);

    store.handleProgress({ type: 'usageStatsProgress', requestId: id, filesDone: 3, filesTotal: 10 });
    expect(store.status).toBe('indexing');
    expect(store.progress).toEqual({ filesDone: 3, filesTotal: 10 });

    store.handleResult({ type: 'usageStats', requestId: id, final: true, report: report(2, 900) });
    expect(store.status).toBe('ready');
    expect(store.progress).toBeNull();
    expect(store.report?.totals.cost).toBe(2);
    expect(store.updatedAtMs).toBe(900);
  });

  it('treats progress with no files as not indexing', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    store.handleProgress({ type: 'usageStatsProgress', requestId: lastRequest().requestId, filesDone: 0, filesTotal: 0 });
    expect(store.status).toBe('loading');
  });

  it('keeps an early report through later progress and only settles on the final reply', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    const id = lastRequest().requestId;
    store.handleResult({ type: 'usageStats', requestId: id, final: false, report: report(1) });
    store.handleResult({ type: 'usageStats', requestId: id, final: false, report: report(3) });
    expect(store.status).toBe('loading');
    expect(store.report?.totals.cost).toBe(3);
  });

  it('shows the error from a final reply, and Retry repeats the request kind with a new id', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    const failed = lastRequest();
    store.handleResult({ type: 'usageStats', requestId: failed.requestId, final: true, report: null, error: 'worker exited' });
    expect(store.status).toBe('error');
    expect(store.error).toBe('worker exited');

    store.retry();
    const retried = lastRequest();
    expect(retried.requestId).not.toBe(failed.requestId);
    expect(retried.query.scan).toBe(true);
    expect(store.status).toBe('loading');
    expect(store.error).toBeNull();

    store.handleResult({ type: 'usageStats', requestId: retried.requestId, final: true, report: report(4) });
    expect(store.status).toBe('ready');
    expect(store.report?.totals.cost).toBe(4);
  });

  it('retries a failed filter change without scanning', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    settle(store);
    store.setCompare(false);
    store.handleResult({ type: 'usageStats', requestId: lastRequest().requestId, final: true, report: null, error: 'bad query' });
    store.retry();
    expect(lastRequest().query.scan).toBe(false);
  });

  it('ignores replies after the overlay closes and keeps its filters for the next open', () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    store.setModelKeys(['openai/gpt-5']);
    const id = lastRequest().requestId;
    store.closeOverlay();

    store.handleResult({ type: 'usageStats', requestId: id, final: true, report: report(7) });
    expect(store.report).toBeNull();

    store.openOverlay();
    expect(lastRequest().query).toMatchObject({ scan: true, modelKeys: ['openai/gpt-5'] });
  });
});
