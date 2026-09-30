import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseClaudeUsage, parseCodexUsage, fetchSubscriptionUsage } from '../subscription-usage';
import type { PiRuntime } from '../pi-runtime';

describe('parseClaudeUsage (limits array — current API shape)', () => {
  it('maps session / weekly_all / weekly_scoped limits to window bars incl. the scoped model', () => {
    const { bars } = parseClaudeUsage({
      // Legacy keys are null on current accounts; the limits array is the source of truth.
      five_hour: { utilization: 35, resets_at: '2026-07-09T22:59:59.952302+00:00' },
      seven_day: { utilization: 7, resets_at: '2026-07-11T01:59:59.952333+00:00' },
      seven_day_opus: null,
      seven_day_sonnet: null,
      limits: [
        { kind: 'session', group: 'session', percent: 35, resets_at: '2026-07-09T22:59:59.952302+00:00' },
        { kind: 'weekly_all', group: 'weekly', percent: 7, resets_at: '2026-07-11T01:59:59.952333+00:00' },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 11,
          resets_at: '2026-07-11T01:59:59.952739+00:00',
          scope: { model: { id: null, display_name: 'Fable' } },
        },
      ],
    });
    expect(bars).toEqual([
      { id: 'five_hour', utilization: 35, resetsAt: Date.parse('2026-07-09T22:59:59.952302+00:00') },
      { id: 'seven_day', utilization: 7, resetsAt: Date.parse('2026-07-11T01:59:59.952333+00:00') },
      { id: 'seven_day_fable', utilization: 11, resetsAt: Date.parse('2026-07-11T01:59:59.952739+00:00') },
    ]);
  });

  it('multi-word scoped model names become a single snake-cased id', () => {
    const { bars } = parseClaudeUsage({
      limits: [{ kind: 'weekly_scoped', percent: 3, resets_at: null, scope: { model: { display_name: 'Amber Ladder' } } }],
    });
    expect(bars[0]!.id).toBe('seven_day_amber_ladder');
  });

  it('falls back to seven_day_scoped when a scoped limit has no model name', () => {
    const { bars } = parseClaudeUsage({
      limits: [{ kind: 'weekly_scoped', percent: 3, resets_at: null, scope: null }],
    });
    expect(bars[0]!.id).toBe('seven_day_scoped');
  });

  it('clamps limit percents and maps null resets_at to null', () => {
    const { bars } = parseClaudeUsage({
      limits: [
        { kind: 'session', percent: 150, resets_at: null },
        { kind: 'weekly_all', percent: -5, resets_at: 'not-a-date' },
      ],
    });
    expect(bars.find((b) => b.id === 'five_hour')!.utilization).toBe(100);
    expect(bars.find((b) => b.id === 'five_hour')!.resetsAt).toBeNull();
    expect(bars.find((b) => b.id === 'seven_day')!.utilization).toBe(0);
    expect(bars.find((b) => b.id === 'seven_day')!.resetsAt).toBeNull();
  });

  it('emits used spend from the current spend object (minor units → major)', () => {
    const { spend } = parseClaudeUsage({
      limits: [{ kind: 'session', percent: 1, resets_at: null }],
      spend: { enabled: true, used: { amount_minor: 21, currency: 'USD', exponent: 2 }, limit: { amount_minor: 2000, currency: 'USD', exponent: 2 } },
    });
    expect(spend).toEqual({ kind: 'used', amount: 0.21, limit: 20, currency: 'USD' });
  });

  it('honors a valid non-default exponent and falls back to 2 for an out-of-range one', () => {
    expect(
      parseClaudeUsage({
        limits: [{ kind: 'session', percent: 1, resets_at: null }],
        spend: { enabled: true, used: { amount_minor: 5000, currency: 'JPY', exponent: 0 } },
      }).spend
    ).toEqual({ kind: 'used', amount: 5000, currency: 'JPY' });

    // A hostile/garbage exponent must not over/underflow — clamp back to the 2-decimal default.
    expect(
      parseClaudeUsage({
        limits: [{ kind: 'session', percent: 1, resets_at: null }],
        spend: { enabled: true, used: { amount_minor: 100, currency: 'USD', exponent: 999 } },
      }).spend
    ).toEqual({ kind: 'used', amount: 1, currency: 'USD' });
  });

  it('omits limit when the spend limit is null and yields no spend when disabled', () => {
    expect(
      parseClaudeUsage({
        limits: [{ kind: 'session', percent: 1, resets_at: null }],
        spend: { enabled: true, used: { amount_minor: 500, currency: 'EUR', exponent: 2 }, limit: null },
      }).spend
    ).toEqual({ kind: 'used', amount: 5, currency: 'EUR' });

    expect(
      parseClaudeUsage({
        limits: [{ kind: 'session', percent: 1, resets_at: null }],
        spend: { enabled: false, used: { amount_minor: 21, currency: 'USD', exponent: 2 } },
      }).spend
    ).toBeUndefined();
  });
});

describe('parseClaudeUsage (legacy top-level windows)', () => {
  it('parses a full payload into bars with epoch-ms resets and clamped util', () => {
    const { bars } = parseClaudeUsage({
      five_hour: { utilization: 42, resets_at: '2026-07-09T12:00:00.000Z' },
      seven_day: { utilization: 80, resets_at: '2026-07-15T00:00:00.000Z' },
      seven_day_opus: { utilization: 10, resets_at: '2026-07-15T00:00:00.000Z' },
    });
    expect(bars).toEqual([
      { id: 'five_hour', utilization: 42, resetsAt: Date.parse('2026-07-09T12:00:00.000Z') },
      { id: 'seven_day', utilization: 80, resetsAt: Date.parse('2026-07-15T00:00:00.000Z') },
      { id: 'seven_day_opus', utilization: 10, resetsAt: Date.parse('2026-07-15T00:00:00.000Z') },
    ]);
  });

  it('emits a bar for an unknown seven_day_* key', () => {
    const { bars } = parseClaudeUsage({
      seven_day_fable: { utilization: 5, resets_at: '2026-07-15T00:00:00.000Z' },
    });
    expect(bars).toHaveLength(1);
    expect(bars[0]!.id).toBe('seven_day_fable');
  });

  it('maps null resets_at to null', () => {
    const { bars } = parseClaudeUsage({ five_hour: { utilization: 3, resets_at: null } });
    expect(bars[0]!.resetsAt).toBeNull();
  });

  it('maps an invalid ISO string to null', () => {
    const { bars } = parseClaudeUsage({ five_hour: { utilization: 3, resets_at: 'not-a-date' } });
    expect(bars[0]!.resetsAt).toBeNull();
  });

  it('skips null and malformed top-level values', () => {
    const { bars } = parseClaudeUsage({
      five_hour: { utilization: 3, resets_at: null },
      seven_day: null,
      bogus: 42,
      other: 'string',
    });
    expect(bars.map((b) => b.id)).toEqual(['five_hour']);
  });

  it('never treats extra_usage as a bar', () => {
    const { bars } = parseClaudeUsage({
      five_hour: { utilization: 3, resets_at: null },
      extra_usage: { is_enabled: true, used_credits: 21, monthly_limit: 2000, currency: 'USD' },
    });
    expect(bars.map((b) => b.id)).toEqual(['five_hour']);
  });

  it('clamps utilization to 0..100', () => {
    const { bars } = parseClaudeUsage({
      five_hour: { utilization: 150, resets_at: null },
      seven_day: { utilization: -5, resets_at: null },
    });
    expect(bars.find((b) => b.id === 'five_hour')!.utilization).toBe(100);
    expect(bars.find((b) => b.id === 'seven_day')!.utilization).toBe(0);
  });

  it('clamps a NaN utilization to 0 rather than letting it through', () => {
    const { bars } = parseClaudeUsage({ five_hour: { utilization: NaN, resets_at: null } });
    expect(bars).toEqual([{ id: 'five_hour', utilization: 0, resetsAt: null }]);
  });

  it('orders five_hour, seven_day, then seven_day_* alpha, then other keys alpha', () => {
    const { bars } = parseClaudeUsage({
      zeta: { utilization: 1, resets_at: null },
      seven_day_opus: { utilization: 1, resets_at: null },
      seven_day: { utilization: 1, resets_at: null },
      seven_day_fable: { utilization: 1, resets_at: null },
      five_hour: { utilization: 1, resets_at: null },
      alpha: { utilization: 1, resets_at: null },
    });
    expect(bars.map((b) => b.id)).toEqual([
      'five_hour',
      'seven_day',
      'seven_day_fable',
      'seven_day_opus',
      'alpha',
      'zeta',
    ]);
  });

  it('prefers the current spend object over legacy extra_usage', () => {
    const { spend } = parseClaudeUsage({
      five_hour: { utilization: 1, resets_at: null },
      spend: { enabled: true, used: { amount_minor: 100, currency: 'USD', exponent: 2 } },
      extra_usage: { is_enabled: true, used_credits: 900 },
    });
    expect(spend).toEqual({ kind: 'used', amount: 1, currency: 'USD' });
  });

  it('emits used spend from enabled extra_usage with cents converted', () => {
    const { spend } = parseClaudeUsage({
      extra_usage: { is_enabled: true, used_credits: 21, monthly_limit: 2000, currency: 'USD' },
    });
    expect(spend).toEqual({ kind: 'used', amount: 0.21, limit: 20, currency: 'USD' });
  });

  it('omits limit and currency when absent', () => {
    const { spend } = parseClaudeUsage({
      extra_usage: { is_enabled: true, used_credits: 500 },
    });
    expect(spend).toEqual({ kind: 'used', amount: 5 });
  });

  it('yields no spend when extra_usage is disabled', () => {
    const { spend } = parseClaudeUsage({
      extra_usage: { is_enabled: false, used_credits: 21 },
    });
    expect(spend).toBeUndefined();
  });

  it('yields no spend when used_credits is missing', () => {
    const { spend } = parseClaudeUsage({ extra_usage: { is_enabled: true } });
    expect(spend).toBeUndefined();
  });

  it('returns empty bars for non-object input', () => {
    expect(parseClaudeUsage(null)).toEqual({ bars: [] });
    expect(parseClaudeUsage(42)).toEqual({ bars: [] });
    expect(parseClaudeUsage('x')).toEqual({ bars: [] });
  });
});

describe('parseCodexUsage', () => {
  it('parses a full payload into primary and secondary bars', () => {
    const result = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_at: 1_800_100_000 },
      },
      plan_type: 'plus',
    });
    expect(result.bars).toEqual([
      { id: 'codex_primary', utilization: 30, resetsAt: 1_800_000_000_000, windowSeconds: 18000 },
      { id: 'codex_secondary', utilization: 60, resetsAt: 1_800_100_000_000, windowSeconds: 604800 },
    ]);
    expect(result.planType).toBe('plus');
  });

  it('emits only codex_primary when secondary_window is missing', () => {
    const { bars } = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 10, reset_at: 1_800_000_000 } },
    });
    expect(bars.map((b) => b.id)).toEqual(['codex_primary']);
    expect(bars[0]!.resetsAt).toBe(1_800_000_000_000);
  });

  it('parses a free-plan single monthly window (secondary null, 30-day seconds)', () => {
    const result = parseCodexUsage({
      plan_type: 'free',
      rate_limit: {
        primary_window: { used_percent: 6, limit_window_seconds: 2_592_000, reset_at: 1_784_659_794 },
        secondary_window: null,
      },
      credits: { has_credits: false, unlimited: false, balance: null },
    });
    expect(result.planType).toBe('free');
    expect(result.bars).toEqual([
      { id: 'codex_primary', utilization: 6, resetsAt: 1_784_659_794_000, windowSeconds: 2_592_000 },
    ]);
    expect(result.spend).toBeUndefined();
  });

  it('returns empty bars when rate_limit is missing', () => {
    expect(parseCodexUsage({ plan_type: 'pro' }).bars).toEqual([]);
  });

  it('sets resetsAt null when reset_at is not numeric', () => {
    const { bars } = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 10 } },
    });
    expect(bars[0]!.resetsAt).toBeNull();
  });

  it('passes plan_type through', () => {
    expect(parseCodexUsage({ plan_type: 'team' }).planType).toBe('team');
  });

  it('parses balance spend from a string balance', () => {
    const { spend } = parseCodexUsage({
      credits: { has_credits: true, balance: '50.00' },
    });
    expect(spend).toEqual({ kind: 'balance', amount: 50 });
  });

  it('parses balance spend from an int balance', () => {
    const { spend } = parseCodexUsage({ credits: { has_credits: true, balance: 50 } });
    expect(spend).toEqual({ kind: 'balance', amount: 50 });
  });

  it('parses balance spend from a double balance', () => {
    const { spend } = parseCodexUsage({ credits: { has_credits: true, balance: 50.5 } });
    expect(spend).toEqual({ kind: 'balance', amount: 50.5 });
  });

  it('yields no spend when unlimited is true', () => {
    const { spend } = parseCodexUsage({
      credits: { has_credits: true, unlimited: true, balance: 10 },
    });
    expect(spend).toBeUndefined();
  });

  it('yields no spend when balance is unparseable', () => {
    const { spend } = parseCodexUsage({ credits: { has_credits: true, balance: 'abc' } });
    expect(spend).toBeUndefined();
  });

  it('yields no spend for has_credits with a null balance (no phantom $0)', () => {
    const { spend } = parseCodexUsage({ credits: { has_credits: true, unlimited: false, balance: null } });
    expect(spend).toBeUndefined();
  });

  it('yields no spend when balance is a non-string/number type', () => {
    expect(parseCodexUsage({ credits: { has_credits: true, balance: false } }).spend).toBeUndefined();
    expect(parseCodexUsage({ credits: { has_credits: true, balance: [] } }).spend).toBeUndefined();
    expect(parseCodexUsage({ credits: { has_credits: true, balance: {} } }).spend).toBeUndefined();
  });

  it('returns empty bars for garbage input', () => {
    expect(parseCodexUsage(null)).toEqual({ bars: [] });
    expect(parseCodexUsage(42)).toEqual({ bars: [] });
    expect(parseCodexUsage('x')).toEqual({ bars: [] });
  });
});

// The network layer only calls getClaudeAccessToken/getCodexAccessToken on the runtime, so a stub suffices.
function stubRuntime(claudeToken: string | undefined, codexToken: string | undefined): PiRuntime {
  return {
    getClaudeAccessToken: async () => claudeToken,
    getCodexAccessToken: async () => codexToken,
  } as unknown as PiRuntime;
}

const SECRET = 'sk-secret-token-should-never-surface';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response;
}

/** Route by URL so one mock serves both providers in a single fetchSubscriptionUsage call. */
function mockFetch(handler: (url: string) => Response | Promise<Response> | never): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => handler(String(input))));
}

describe('fetchSubscriptionUsage (network layer)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports not-connected for a provider whose token is missing, without fetching it', () => {
    const claudeBody = { limits: [{ kind: 'session', percent: 12, resets_at: null }] };
    mockFetch((url) => {
      if (url.includes('anthropic.com')) return jsonResponse(claudeBody);
      throw new Error('codex should not be fetched when its token is missing');
    });

    return fetchSubscriptionUsage(stubRuntime(SECRET, undefined)).then((data) => {
      expect(data.claude.status).toBe('ok');
      expect(data.claude.bars).toHaveLength(1);
      expect(data.gpt).toEqual({ status: 'not-connected', bars: [] });
    });
  });

  it('maps a non-OK Claude response to an HTTP-status error carrying no token', async () => {
    mockFetch((url) => {
      if (url.includes('anthropic.com')) return jsonResponse({}, false, 429);
      return jsonResponse({ rate_limit: { primary_window: { used_percent: 4, reset_at: 1 } } });
    });

    const data = await fetchSubscriptionUsage(stubRuntime(SECRET, SECRET));
    expect(data.claude).toEqual({ status: 'error', bars: [], error: 'HTTP 429' });
    expect(JSON.stringify(data)).not.toContain(SECRET);
  });

  it('guards the Codex path against a non-JSON (Cloudflare challenge) body', async () => {
    const htmlResponse = {
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      json: async () => {
        throw new Error('should never parse an HTML challenge as JSON');
      },
    } as unknown as Response;
    mockFetch((url) => {
      if (url.includes('chatgpt.com')) return htmlResponse;
      return jsonResponse({ limits: [{ kind: 'session', percent: 1, resets_at: null }] });
    });

    const data = await fetchSubscriptionUsage(stubRuntime(SECRET, SECRET));
    expect(data.gpt).toEqual({ status: 'error', bars: [], error: 'Unexpected response' });
    expect(data.claude.status).toBe('ok');
  });

  it('maps a thrown fetch (network failure) to a generic error, isolated per provider', async () => {
    mockFetch((url) => {
      if (url.includes('anthropic.com')) throw new TypeError('connection refused');
      return jsonResponse({
        plan_type: 'free',
        rate_limit: { primary_window: { used_percent: 6, limit_window_seconds: 2_592_000, reset_at: 1 } },
      });
    });

    const data = await fetchSubscriptionUsage(stubRuntime(SECRET, SECRET));
    expect(data.claude).toEqual({ status: 'error', bars: [], error: 'Network error' });
    expect(data.gpt.status).toBe('ok');
    expect(data.gpt.planType).toBe('free');
  });

  it('parses both providers on the happy path and stamps fetchedAt', async () => {
    mockFetch((url) => {
      if (url.includes('anthropic.com')) {
        return jsonResponse({
          limits: [
            { kind: 'session', group: 'session', percent: 35, resets_at: null },
            { kind: 'weekly_scoped', percent: 11, resets_at: null, scope: { model: { display_name: 'Fable' } } },
          ],
        });
      }
      return jsonResponse({
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
          secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_at: 1_800_100_000 },
        },
      });
    });

    const before = Date.now();
    const data = await fetchSubscriptionUsage(stubRuntime(SECRET, SECRET));
    expect(data.claude.bars.map((b) => b.id)).toEqual(['five_hour', 'seven_day_fable']);
    expect(data.gpt.bars.map((b) => b.id)).toEqual(['codex_primary', 'codex_secondary']);
    expect(data.gpt.planType).toBe('plus');
    expect(data.fetchedAt).toBeGreaterThanOrEqual(before);
  });
});
