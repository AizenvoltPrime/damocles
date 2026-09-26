import { describe, it, expect } from 'vitest';
import {
  agentCacheHitRate,
  agentUsageUnpriced,
  cacheHitRate,
  countOwnUserPrompts,
  isOwnEntry,
  isUnpriced,
  netCacheSavings,
  subtractUsage,
  sumOwnUsage,
  sumUsage,
  toAgentUsage,
  usageOfEntry,
  type AccountingEntry,
} from '../usage-accounting';

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total: number }) {
  return {
    input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: cost.input ?? 0, output: cost.output ?? 0, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0, total: cost.total },
  };
}

const at = (iso: string) => ({ timestamp: iso });

// A rewound branch: pi still billed the abandoned request, so it stays in the file total.
const entries: AccountingEntry[] = [
  { type: 'message', ...at('2026-01-01T10:00:00.000Z'), message: { role: 'user' } },
  { type: 'message', ...at('2026-01-01T10:00:01.000Z'), message: { role: 'assistant', usage: usage(10, 20, 100, 50, { total: 1 }) } },
  { type: 'message', ...at('2026-01-01T10:00:02.000Z'), message: { role: 'assistant', stopReason: 'aborted', usage: usage(1, 2, 0, 0, { total: 0.5 }) } } as AccountingEntry,
  { type: 'message', ...at('2026-01-01T10:00:03.000Z'), message: { role: 'toolResult', usage: usage(3, 3, 0, 0, { total: 0.25 }) } },
  { type: 'message', ...at('2026-01-01T10:00:03.500Z'), message: { role: 'toolResult' } },
  { type: 'usage', ...at('2026-01-01T10:05:00.000Z'), usage: usage(0, 1, 200, 0, { total: 0.125 }) },
  { type: 'compaction', ...at('2026-01-01T10:06:00.000Z'), usage: usage(5, 5, 0, 0, { total: 2 }) },
  { type: 'compaction', ...at('2026-01-01T10:06:30.000Z') },
  { type: 'branch_summary', ...at('2026-01-01T10:07:00.000Z'), usage: usage(4, 4, 0, 0, { total: 4 }) },
  { type: 'custom', ...at('2026-01-01T10:08:00.000Z'), usage: usage(999, 999, 0, 0, { total: 999 }) } as AccountingEntry,
];

describe('usageOfEntry / sumUsage', () => {
  it('counts every entry pi bills, including aborted, cache_warm, compaction and branch summaries', () => {
    expect(sumUsage(entries)).toEqual({ input: 23, output: 35, cacheRead: 300, cacheWrite: 50, cost: 7.875 });
  });

  it('ignores user messages and custom entries', () => {
    expect(usageOfEntry(entries[0]!)).toBeUndefined();
    expect(usageOfEntry(entries[9]!)).toBeUndefined();
  });

  it('counts nothing for a usage or compaction entry whose usage is null', () => {
    expect(usageOfEntry({ type: 'usage', usage: null })).toBeUndefined();
    expect(usageOfEntry({ type: 'compaction', usage: null })).toBeUndefined();
    expect(sumUsage([{ type: 'usage', usage: null }, { type: 'compaction', usage: null }])).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });

  it('treats malformed numbers as zero', () => {
    const u = usageOfEntry({ type: 'usage', usage: { input: 'x', output: Number.NaN, cost: null } });
    expect(u).toMatchObject({ input: 0, output: 0, cost: { total: 0 } });
  });
});

describe('isOwnEntry', () => {
  const header = '2026-01-01T10:05:30.000Z';
  it('excludes entries a fork copied, which predate its header', () => {
    const own = sumUsage(entries, (e) => isOwnEntry(e, header));
    expect(own.cost).toBe(6);
    const inherited = sumUsage(entries, (e) => !isOwnEntry(e, header));
    expect(inherited.cost + own.cost).toBe(sumUsage(entries).cost);
  });

  it('counts an entry stamped at the header time as own', () => {
    expect(isOwnEntry(at(header), header)).toBe(true);
    expect(isOwnEntry(at('2026-01-01T10:05:29.999Z'), header)).toBe(false);
  });

  it('sums only own entries', () => {
    expect(sumOwnUsage(entries, header)).toEqual(sumUsage(entries, (e) => isOwnEntry(e, header)));
    expect(sumOwnUsage(entries, undefined)).toEqual(sumUsage(entries));
  });

  it('counts an entry with no readable timestamp as own', () => {
    expect(isOwnEntry({ type: 'message' }, header)).toBe(true);
    expect(isOwnEntry(entries[0]!, undefined)).toBe(true);
  });

  it('counts only own user prompts', () => {
    const branch: AccountingEntry[] = [
      { type: 'message', ...at('2026-01-01T09:00:00.000Z'), message: { role: 'user' } },
      { type: 'message', ...at('2026-01-01T11:00:00.000Z'), message: { role: 'user' } },
      { type: 'message', ...at('2026-01-01T11:00:01.000Z'), message: { role: 'assistant' } },
    ];
    expect(countOwnUserPrompts(branch, '2026-01-01T10:00:00.000Z')).toBe(1);
    expect(countOwnUserPrompts(branch, undefined)).toBe(2);
  });
});

describe('derived figures', () => {
  it('computes the cache hit rate, null with no prompt tokens', () => {
    expect(cacheHitRate(10, 30, 60)).toBeCloseTo(0.3);
    expect(cacheHitRate(0, 0, 0)).toBeNull();
    expect(agentCacheHitRate(toAgentUsage(subtractUsage(sumUsage(entries), sumUsage([]))))).toBeCloseTo(300 / 373);
  });

  it('flags unpriced tokens and never counts them as savings', () => {
    const u = usageOfEntry({ type: 'usage', usage: usage(10, 10, 1000, 0, { total: 0 }) })!;
    expect(isUnpriced(u)).toBe(true);
    expect(netCacheSavings(u, 0.001)).toBe(0);
  });

  it('prices the cached tokens at the entry input rate minus what they cost', () => {
    // $4/M input, cache read at $0.20/M, 1M read: saved 4 - 0.2.
    const u = usageOfEntry({ type: 'usage', usage: usage(1_000_000, 0, 1_000_000, 0, { input: 4, cacheRead: 0.2, total: 4.2 }) })!;
    expect(netCacheSavings(u)).toBeCloseTo(3.8);
  });

  it('falls back to the supplied rate when the entry read no uncached input, and can go negative', () => {
    // 1M 1-hour write at $8/M against a $4/M input rate.
    const u = usageOfEntry({ type: 'usage', usage: usage(0, 0, 0, 1_000_000, { cacheWrite: 8, total: 8 }) })!;
    expect(netCacheSavings(u, 4 / 1_000_000)).toBeCloseTo(-4);
    expect(netCacheSavings(u)).toBe(0);
  });

  it('flags a summed total unpriced only when it billed tokens at zero cost', () => {
    const tokens = { totalInputTokens: 0, totalOutputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(agentUsageUnpriced({ ...tokens, costUsd: 0 })).toBe(true);
    expect(agentUsageUnpriced({ ...tokens, costUsd: 0.01 })).toBe(false);
    expect(agentUsageUnpriced({ ...tokens, totalOutputTokens: 0, costUsd: 0 })).toBe(false);
  });

  it('clamps a subtraction at zero', () => {
    expect(subtractUsage({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 1 }, { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }).input).toBe(0);
  });
});
