import { describe, it, expect } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  CACHE_TTL_MS,
  NOISE_FLOOR_TOKENS,
  detectCacheMiss,
  isCacheMissSignificant,
  type CacheMiss,
  type ModelPriceSource,
} from '../cache-stats';

/**
 * Unit tests for the port of pi's `dist/core/cache-stats.js` @0.87.0. They pin the exact
 * detection thresholds and reset semantics: TTL-scale idle gaps, the 1024-token noise floor,
 * compaction/branch_summary/context_edit baseline resets, the sticky `reportedCache` behaviour on providers
 * that never report cache activity, cache-read-only total misses, the missed-cost math (paid rate
 * vs. cache-read rate, with a ModelPriceSource fallback), and the model-change flag.
 */

interface UsageOpts {
  input: number;
  output?: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

function makeMessage(opts: {
  provider?: string;
  model?: string;
  timestamp: number;
  usage: UsageOpts;
}): AssistantMessage {
  const u = opts.usage;
  return {
    role: 'assistant',
    provider: opts.provider ?? 'anthropic',
    model: opts.model ?? 'claude-sonnet',
    timestamp: opts.timestamp,
    usage: {
      input: u.input,
      output: u.output ?? 0,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      cost: {
        input: u.cost?.input ?? 0,
        output: u.cost?.output ?? 0,
        cacheRead: u.cost?.cacheRead ?? 0,
        cacheWrite: u.cost?.cacheWrite ?? 0,
      },
    },
  } as unknown as AssistantMessage;
}

const msgEntry = (message: AssistantMessage): SessionEntry =>
  ({ type: 'message', message }) as unknown as SessionEntry;
const compactionEntry = (): SessionEntry => ({ type: 'compaction' }) as unknown as SessionEntry;
const branchSummaryEntry = (): SessionEntry => ({ type: 'branch_summary' }) as unknown as SessionEntry;
const contextEditEntry = (): SessionEntry =>
  ({ type: 'context_edit', targetId: 't1', replacement: { content: [{ type: 'text', text: '[Image removed]' }] } }) as unknown as SessionEntry;
/** The entry shape pi's cache warmer appends (`dist/core/session-manager.js:864-878`). */
const cacheWarmEntry = (message: AssistantMessage): SessionEntry =>
  ({
    type: 'usage',
    kind: 'cache_warm',
    provider: message.provider,
    model: message.model,
    timestamp: new Date(message.timestamp).toISOString(),
    usage: message.usage,
  }) as unknown as SessionEntry;

// A fake ModelPriceSource with a fixed cacheRead price ($/million tokens), used for the
// fallback-pricing path (when the missing turn reports zero cacheRead so no per-token rate exists).
const priceSource = (cacheReadPerMillion: number): ModelPriceSource => ({
  getModel: () => ({ cost: { cacheRead: cacheReadPerMillion } }),
});
const noPrice: ModelPriceSource = { getModel: () => undefined };

describe('detectCacheMiss', () => {
  it('(1) detects a real TTL-expiry miss with idleMs > CACHE_TTL_MS', () => {
    const prev = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 0, cacheWrite: 50_000 },
    });
    // Next turn, > 5 min later: the whole prompt is re-billed as input (cacheRead ~ 0).
    const message = makeMessage({
      timestamp: CACHE_TTL_MS + 60_000,
      usage: { input: 50_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.15 } },
    });
    const miss = detectCacheMiss([msgEntry(prev)], message, noPrice);
    expect(miss).toBeDefined();
    expect(miss!.idleMs).toBeGreaterThan(CACHE_TTL_MS);
    // prev prompt = 50_100; this prompt = 50_000; min - cacheRead(0) = 50_000
    expect(miss!.missedTokens).toBe(50_000);
    expect(miss!.modelChanged).toBe(false);
  });

  it('(2) ignores a sub-noise-floor miss (missedTokens <= NOISE_FLOOR_TOKENS)', () => {
    const prev = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 0, cacheWrite: 2_000 },
    });
    // Only 1024 tokens missed (== noise floor) → not counted.
    const message = makeMessage({
      timestamp: 1_000,
      usage: { input: NOISE_FLOOR_TOKENS, cacheRead: 0, cacheWrite: 0, cost: { input: 0.01 } },
    });
    const miss = detectCacheMiss([msgEntry(prev)], message, noPrice);
    expect(miss).toBeUndefined();
  });

  it('(3) a compaction entry resets the baseline → straddling miss NOT counted', () => {
    const prev = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 0, cacheWrite: 50_000 },
    });
    const message = makeMessage({
      timestamp: 1_000,
      usage: { input: 50_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.15 } },
    });
    const miss = detectCacheMiss([msgEntry(prev), compactionEntry()], message, noPrice);
    expect(miss).toBeUndefined();
  });

  it('(4) a branch_summary entry resets the baseline likewise', () => {
    const prev = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 0, cacheWrite: 50_000 },
    });
    const message = makeMessage({
      timestamp: 1_000,
      usage: { input: 50_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.15 } },
    });
    const miss = detectCacheMiss([msgEntry(prev), branchSummaryEntry()], message, noPrice);
    expect(miss).toBeUndefined();
  });

  it('(4b) a context_edit entry resets the baseline: the prune explains the miss', () => {
    // Image pruning appends one, which rewrites the prefix from the edited entry onward. Without the
    // reset the request after a prune reads as a large unexplained miss and is priced as waste.
    const prev = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 0, cacheWrite: 50_000 },
    });
    const message = makeMessage({
      timestamp: 1_000,
      usage: { input: 50_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.15 } },
    });
    const miss = detectCacheMiss([msgEntry(prev), contextEditEntry()], message, noPrice);
    expect(miss).toBeUndefined();
  });

  it('(5) provider that never reports cache (cacheRead+cacheWrite always 0) → no detection', () => {
    const prev = makeMessage({
      timestamp: 0,
      usage: { input: 50_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.15 } },
    });
    const message = makeMessage({
      timestamp: 1_000,
      usage: { input: 50_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.15 } },
    });
    // prev.reportedCache is false (no cache ever), so a zero-cache turn is not a miss.
    const miss = detectCacheMiss([msgEntry(prev)], message, noPrice);
    expect(miss).toBeUndefined();
  });

  it('(6) cache-read-only total miss: prev reported cache, this turn reports 0 cacheRead → counted', () => {
    const prev = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 49_900, cacheWrite: 0, cost: { cacheRead: 0.005 } },
    });
    // Same prompt, but this turn fully re-billed: cacheRead 0, all as input.
    const message = makeMessage({
      timestamp: 1_000,
      usage: { input: 50_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.15 } },
    });
    const miss = detectCacheMiss([msgEntry(prev)], message, priceSource(1.5));
    expect(miss).toBeDefined();
    // prev prompt = 50_000, this prompt = 50_000, min - cacheRead(0) = 50_000
    expect(miss!.missedTokens).toBe(50_000);
  });

  it('(7) missed-cost math uses paid rate vs cacheRead rate, with ModelPriceSource fallback when cacheRead is 0', () => {
    const prev = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 40_000, cacheWrite: 0, cost: { cacheRead: 0.004 } },
    });
    // paidTokens = input(50_000) + cacheWrite(0) = 50_000; paid cost = input 0.15 → paidPerToken = 3e-6.
    // cacheRead == 0 → readPerToken = models.getModel().cost.cacheRead / 1e6 = 1.5 / 1e6 = 1.5e-6.
    const message = makeMessage({
      timestamp: 1_000,
      usage: { input: 50_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.15 } },
    });
    const miss = detectCacheMiss([msgEntry(prev)], message, priceSource(1.5));
    expect(miss).toBeDefined();
    // missedTokens = min(40_100, 50_000) - 0 = 40_100
    expect(miss!.missedTokens).toBe(40_100);
    const paidPerToken = 0.15 / 50_000; // 3e-6
    const readPerToken = 1.5 / 1_000_000; // 1.5e-6
    expect(miss!.missedCost).toBeCloseTo(40_100 * (paidPerToken - readPerToken), 10);
  });

  it('(7b) missedCost is 0 when pricing is unknown and no per-token read rate exists', () => {
    const prev = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 40_000, cacheWrite: 0, cost: { cacheRead: 0.004 } },
    });
    // paidTokens = 0 (input 0, cacheWrite 0) → paidPerToken 0; cacheRead 0 + noPrice → readPerToken 0.
    const message = makeMessage({
      timestamp: 1_000,
      usage: { input: 50_000, cacheRead: 0, cacheWrite: 0, cost: {} },
    });
    const miss = detectCacheMiss([msgEntry(prev)], message, noPrice);
    expect(miss).toBeDefined();
    expect(miss!.missedCost).toBe(0);
  });

  it('(8) modelChanged flag set when provider/model differs from prev', () => {
    const prev = makeMessage({
      provider: 'anthropic',
      model: 'claude-sonnet',
      timestamp: 0,
      usage: { input: 100, cacheRead: 0, cacheWrite: 50_000 },
    });
    const message = makeMessage({
      provider: 'openai',
      model: 'gpt-5.6',
      timestamp: 1_000,
      usage: { input: 50_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.15 } },
    });
    const miss = detectCacheMiss([msgEntry(prev)], message, noPrice);
    expect(miss).toBeDefined();
    expect(miss!.modelChanged).toBe(true);
  });

  it('returns undefined on the first turn (no prev)', () => {
    const message = makeMessage({
      timestamp: 1_000,
      usage: { input: 50_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.15 } },
    });
    expect(detectCacheMiss([], message, noPrice)).toBeUndefined();
  });
});

describe('detectCacheMiss — multi-turn baseline behaviour', () => {
  it('(9) sticky reportedCache carries across ≥3 turns: an early cached turn makes a later zero-cache turn a total miss', () => {
    // Turn 1 reports cache activity → reportedCache becomes sticky true.
    const t1 = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 40_000, cacheWrite: 0, cost: { cacheRead: 0.004 } },
    });
    // Turn 2 reports NO cache (input only) — reportedCache stays true from turn 1.
    const t2 = makeMessage({
      timestamp: 1_000,
      usage: { input: 40_100, cacheRead: 0, cacheWrite: 0, cost: { input: 0.12 } },
    });
    // Turn 3 (the just-completed message) also reports zero cache. Because reportedCache is sticky,
    // this counts as a total miss rather than being dismissed as a no-cache provider.
    const t3 = makeMessage({
      timestamp: 2_000,
      usage: { input: 40_100, cacheRead: 0, cacheWrite: 0, cost: { input: 0.12 } },
    });
    const miss = detectCacheMiss([msgEntry(t1), msgEntry(t2)], t3, priceSource(1.5));
    expect(miss).toBeDefined();
    expect(miss!.missedTokens).toBe(40_100);
  });

  it('(9b) sticky reportedCache survives a context_edit reset, so a later total miss is still detected', () => {
    // The edit resets the token baseline, but whether this provider reports caching at all is not a
    // fact about the prefix: dropping it would silence every total miss after the first prune.
    const t1 = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 40_000, cacheWrite: 0, cost: { cacheRead: 0.004 } },
    });
    const t2 = makeMessage({
      timestamp: 1_000,
      usage: { input: 40_100, cacheRead: 0, cacheWrite: 0, cost: { input: 0.12 } },
    });
    const t3 = makeMessage({
      timestamp: 2_000,
      usage: { input: 40_100, cacheRead: 0, cacheWrite: 0, cost: { input: 0.12 } },
    });
    const miss = detectCacheMiss([msgEntry(t1), contextEditEntry(), msgEntry(t2)], t3, priceSource(1.5));
    expect(miss).toBeDefined();
    expect(miss!.missedTokens).toBe(40_100);
  });

  it('(10) a zero-prompt-token turn does not clear the retained baseline (prev is kept)', () => {
    // Baseline: a real cached turn.
    const base = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 40_000, cacheWrite: 0, cost: { cacheRead: 0.004 } },
    });
    // A degenerate turn with zero prompt tokens: asPreviousRequest returns undefined, so scan keeps
    // the previous baseline (`?? prev`) rather than dropping it.
    const empty = makeMessage({
      timestamp: 1_000,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0 },
    });
    // The just-completed turn is a full re-bill; it must still be measured against `base`.
    const message = makeMessage({
      timestamp: 2_000,
      usage: { input: 40_050, cacheRead: 0, cacheWrite: 0, cost: { input: 0.12 } },
    });
    const miss = detectCacheMiss([msgEntry(base), msgEntry(empty)], message, priceSource(1.5));
    expect(miss).toBeDefined();
    expect(miss!.missedTokens).toBe(40_050);
  });

  it("(11) prompt growth is clamped: missedTokens uses min(prev, current) prompt so new content isn't over-counted", () => {
    // Previous prompt is SMALL; the current prompt grew a lot (the user added a big message).
    const prev = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 9_900, cacheWrite: 0, cost: { cacheRead: 0.001 } },
    });
    // Current: prompt is 100_000 but only 10_000 was ever cacheable before; cacheRead 0 (all re-billed).
    const message = makeMessage({
      timestamp: 1_000,
      usage: { input: 100_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.3 } },
    });
    const miss = detectCacheMiss([msgEntry(prev)], message, priceSource(1.5));
    expect(miss).toBeDefined();
    // min(prev 10_000, current 100_000) - cacheRead(0) = 10_000 — the 90_000 tokens of NEW content
    // are not counted as a cache miss.
    expect(miss!.missedTokens).toBe(10_000);
  });
});

describe('cache_warm usage entries', () => {
  // A warm refresh never runs the agent loop: pi calls `models.streamSimple` and records the spend with
  // `sessionManager.appendUsage("cache_warm", ...)`, so it lands as a `usage` entry, never as an
  // assistant message. The scan only inspects `message`, `compaction` and `branch_summary`, which is
  // what keeps a refresh from reading as a turn that paid for a miss.
  it('produce no cache-miss notice of their own', () => {
    const warm = makeMessage({
      timestamp: 0,
      usage: { input: 0, cacheRead: 50_000, cacheWrite: 0, cost: { cacheRead: 0.025 } },
    });
    expect(detectCacheMiss([cacheWarmEntry(warm)], warm, noPrice)).toBeUndefined();
  });

  it('do not disturb the baseline the next real turn is measured against', () => {
    const prev = makeMessage({
      timestamp: 0,
      usage: { input: 100, cacheRead: 0, cacheWrite: 50_000 },
    });
    const warm = makeMessage({
      timestamp: 1_000,
      usage: { input: 0, cacheRead: 50_100, cacheWrite: 0, cost: { cacheRead: 0.025 } },
    });
    const message = makeMessage({
      timestamp: 2_000,
      usage: { input: 50_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.15 } },
    });

    const withWarm = detectCacheMiss([msgEntry(prev), cacheWarmEntry(warm)], message, noPrice);
    const withoutWarm = detectCacheMiss([msgEntry(prev)], message, noPrice);
    expect(withWarm).toEqual(withoutWarm);
    expect(withWarm!.missedTokens).toBe(50_000);
  });
});

describe('isCacheMissSignificant — display gate (mirrors pi 20k tokens / $0.10)', () => {
  const miss = (missedTokens: number, missedCost: number): CacheMiss => ({
    missedTokens,
    missedCost,
    idleMs: 0,
    modelChanged: false,
  });

  it('shows when tokens >= 20k even if cost is tiny', () => {
    expect(isCacheMissSignificant(miss(20_000, 0))).toBe(true);
    expect(isCacheMissSignificant(miss(25_000, 0.001))).toBe(true);
  });

  it('shows when cost >= $0.10 even if tokens are below 20k', () => {
    expect(isCacheMissSignificant(miss(5_000, 0.1))).toBe(true);
    expect(isCacheMissSignificant(miss(1_500, 0.42))).toBe(true);
  });

  it('suppresses a miss under BOTH thresholds (noisy small miss)', () => {
    expect(isCacheMissSignificant(miss(19_999, 0.099))).toBe(false);
    expect(isCacheMissSignificant(miss(2_000, 0.01))).toBe(false);
  });
});
