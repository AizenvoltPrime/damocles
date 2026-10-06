import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installFakePlatform } from '../../../__mocks__/fake-platform';
import { chatgptPlanName, claudePlanName, RATE_LIMIT_REFRESH_BOUND_MS, UsageMonitor, USAGE_REFRESH_INTERVAL_MS, type UsageThresholdCrossing } from '../usage-thresholds';
import type { ClaudeAccountProfile, ProviderUsage, SubscriptionUsageData, UsageWindowBar } from '../../../shared/types/usage';

const RESET = Date.parse('2026-03-01T15:00:00Z');
const HOUR = 3_600_000;

const PROFILE: ClaudeAccountProfile = {
  organizationType: 'claude_max',
  rateLimitTier: 'default_claude_max_20x',
  seatTier: null,
  subscriptionStatus: 'active',
  hasExtraUsageEnabled: false,
  email: 'dev@example.com',
  organizationName: null,
};

const NOT_CONNECTED: ProviderUsage = { status: 'not-connected', bars: [] };

function bar(utilization: number, resetsAt: number | null = RESET, id = 'five_hour'): UsageWindowBar {
  return { id, utilization, resetsAt };
}

function claude(bars: UsageWindowBar[], profile: Partial<Pick<ProviderUsage, 'profile' | 'profileError'>> = { profile: PROFILE }): SubscriptionUsageData {
  return { claude: { status: 'ok', bars, ...profile }, gpt: NOT_CONNECTED, fetchedAt: 0 };
}

/** A monitor whose fetches answer the queued responses in order, with a clock the test moves. */
function harness() {
  const responses: SubscriptionUsageData[] = [];
  const crossings: UsageThresholdCrossing[] = [];
  const clock = { now: 1_000_000 };
  const fetchUsage = vi.fn(async () => responses.shift() ?? claude([]));
  const monitor = new UsageMonitor({ fetchUsage, now: () => clock.now, onCrossing: (c) => crossings.push(c) });
  /** Queues `data`, lets the interval pass and runs a refresh to completion. */
  const observe = async (data: SubscriptionUsageData): Promise<void> => {
    responses.push(data);
    clock.now += USAGE_REFRESH_INTERVAL_MS;
    monitor.refreshAfterTurn();
    await vi.waitFor(() => expect(responses).toHaveLength(0));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { monitor, crossings, clock, fetchUsage, observe, responses };
}

beforeAll(() => {
  installFakePlatform();
});

describe('usage threshold crossings', () => {
  it('raises 80 once per window, then 95 once, with the window label, reset time and plan', async () => {
    const h = harness();
    await h.observe(claude([bar(81)]));
    await h.observe(claude([bar(85)]));
    await h.observe(claude([bar(96)]));
    await h.observe(claude([bar(99)]));

    expect(h.crossings).toEqual([
      { provider: 'anthropic', windowId: 'five_hour', windowLabel: 'Session (5hr)', threshold: 80, utilization: 81, resetsAt: RESET, planName: 'Max 20x' },
      { provider: 'anthropic', windowId: 'five_hour', windowLabel: 'Session (5hr)', threshold: 95, utilization: 96, resetsAt: RESET, planName: 'Max 20x' },
    ]);
  });

  it('raises only the highest threshold an observation newly reaches, so a start at 96% raises one 95', async () => {
    const h = harness();
    await h.observe(claude([bar(96)]));
    expect(h.crossings.map((c) => c.threshold)).toEqual([95]);
  });

  it('raises again after the window resets, and treats a reset time that moves by seconds as the same window', async () => {
    const h = harness();
    await h.observe(claude([bar(90)]));
    await h.observe(claude([bar(91, RESET + 20_000)]));
    await h.observe(claude([bar(84, RESET + 5 * HOUR)]));
    expect(h.crossings.map((c) => [c.threshold, c.resetsAt])).toEqual([[80, RESET], [80, RESET + 5 * HOUR]]);
  });

  it('treats reset times seconds apart as one window when they straddle the half minute', async () => {
    const h = harness();
    await h.observe(claude([bar(90, RESET + 29_000)]));
    await h.observe(claude([bar(91, RESET + 31_000)]));
    expect(h.crossings).toHaveLength(1);
  });

  it('flattens, strips and caps an unknown window label, which is provider text', async () => {
    const h = harness();
    const scoped = `seven_day_opus\u202e\u0007${'x'.repeat(80)}`;
    await h.observe(claude([bar(81, RESET, 'weekly\nall'), bar(82, RESET, scoped), bar(83, RESET, '\u202e\u0000')]));
    const [kind, model, empty] = h.crossings.map((c) => c.windowLabel);
    expect(kind).toBe('Weekly all');
    expect(model).toMatch(/^Weekly Opus x+…$/u);
    expect([...model!]).toHaveLength(60);
    expect(empty).toBe('');
    expect(h.crossings.map((c) => c.windowId)).toEqual(['weekly\nall', scoped, '\u202e\u0000']);
  });

  it('keys each window apart, and a window with no reset time re-arms once its use falls below the threshold', async () => {
    const h = harness();
    const weekly = (utilization: number): UsageWindowBar => ({ id: 'codex_secondary', utilization, resetsAt: null, windowSeconds: 7 * 86_400 });
    const gpt = (utilization: number): SubscriptionUsageData => ({ claude: NOT_CONNECTED, gpt: { status: 'ok', bars: [weekly(utilization)], planType: 'plus' }, fetchedAt: 0 });
    await h.observe(gpt(82));
    await h.observe(gpt(88));
    await h.observe(gpt(60));
    await h.observe(gpt(83));
    expect(h.crossings).toEqual([
      { provider: 'openai', windowId: 'codex_secondary', windowLabel: 'Weekly', threshold: 80, utilization: 82, planName: 'Plus' },
      { provider: 'openai', windowId: 'codex_secondary', windowLabel: 'Weekly', threshold: 80, utilization: 83, planName: 'Plus' },
    ]);
  });

  it('labels a model-scoped weekly window by its model', async () => {
    const h = harness();
    await h.observe(claude([bar(81, RESET, 'seven_day'), bar(82, RESET, 'seven_day_opus')]));
    expect(h.crossings.map((c) => c.windowLabel)).toEqual(['Weekly (7 day)', 'Weekly Opus']);
  });
});

describe('usage refresh interval', () => {
  it('refreshes after a settled turn at most once per interval, process-wide', async () => {
    const h = harness();
    h.monitor.refreshAfterTurn();
    h.monitor.refreshAfterTurn();
    await vi.waitFor(() => expect(h.fetchUsage).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    h.clock.now += USAGE_REFRESH_INTERVAL_MS - 1;
    h.monitor.refreshAfterTurn();
    expect(h.fetchUsage).toHaveBeenCalledTimes(1);
    h.clock.now += 1;
    h.monitor.refreshAfterTurn();
    expect(h.fetchUsage).toHaveBeenCalledTimes(2);
  });
});

describe('a credential change', () => {
  it("drops what a fetch made with the previous credentials reports, and the previous account's plan", async () => {
    const h = harness();
    await h.observe(claude([bar(81)]));
    let answer: (data: SubscriptionUsageData) => void = () => {};
    h.fetchUsage.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    h.clock.now += USAGE_REFRESH_INTERVAL_MS;
    h.monitor.refreshAfterTurn();
    h.monitor.credentialsChanged();

    // The change also reset the interval, so the next settled turn fetches with the new credentials at once, never joining the old fetch.
    h.responses.push(claude([bar(96, RESET + 5 * HOUR)], { profileError: 'HTTP 403' }));
    h.monitor.refreshAfterTurn();
    expect(h.fetchUsage).toHaveBeenCalledTimes(3);
    answer(claude([bar(96)]));
    await vi.waitFor(() => expect(h.crossings).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.crossings.map((c) => [c.threshold, c.resetsAt])).toEqual([[80, RESET], [95, RESET + 5 * HOUR]]);
    expect(h.crossings[1]).not.toHaveProperty('planName');
  });
});

describe('plan names', () => {
  it('a crossing carries the last plan when the profile is refused, and none once the account is gone', async () => {
    const h = harness();
    await h.observe(claude([bar(81)]));
    await h.observe(claude([bar(81, RESET + 5 * HOUR)], { profileError: 'HTTP 403' }));
    await h.observe({ claude: NOT_CONNECTED, gpt: NOT_CONNECTED, fetchedAt: 0 });
    await h.observe(claude([bar(81, RESET + 10 * HOUR)], { profileError: 'HTTP 403' }));
    expect(h.crossings.map((c) => c.planName)).toEqual(['Max 20x', 'Max 20x', undefined]);
  });

  it.each([
    [{ rateLimitTier: 'default_claude_max_20x', organizationType: 'claude_max' }, 'Max 20x'],
    [{ rateLimitTier: 'default_claude_max_5x', organizationType: 'claude_max' }, 'Max 5x'],
    [{ rateLimitTier: null, organizationType: 'claude_max' }, 'Max'],
    [{ rateLimitTier: 'default_claude_ai', organizationType: 'claude_pro' }, 'Pro'],
    [{ rateLimitTier: 'default_claude_max_5x', organizationType: 'claude_team' }, 'Team'],
    [{ rateLimitTier: null, organizationType: 'claude_enterprise' }, 'Enterprise'],
    [{ rateLimitTier: 'default_raven', organizationType: 'claude_nova' }, undefined],
  ])('maps the Anthropic profile %o to %s, never a raw tier', (profile, name) => {
    expect(claudePlanName(profile)).toBe(name);
  });

  it.each([['plus', 'Plus'], ['pro', 'Pro'], ['team', 'Team'], ['business', 'Business'], ['enterprise', 'Enterprise'], ['free', 'Free'], ['constructor', undefined], ['ultra', undefined]])(
    'maps the ChatGPT plan type %s to %s',
    (planType, name) => {
      expect(chatgptPlanName(planType)).toBe(name);
    },
  );
});

describe('the full window a rate limit names (D55)', () => {
  const WEEK = RESET + 4 * 24 * HOUR;
  const gptOk = (bars: UsageWindowBar[]): ProviderUsage => ({ status: 'ok', bars, planType: 'plus' });

  async function fullWindowOf(data: SubscriptionUsageData, provider: 'anthropic' | 'openai' = 'anthropic', model = 'claude-opus-5-5') {
    const h = harness();
    h.responses.push(data);
    return h.monitor.fullWindow(provider, model);
  }

  it('names a full session window with its label and reset', async () => {
    expect(await fullWindowOf(claude([bar(100), bar(40, WEEK, 'seven_day')]))).toEqual({ windowId: 'five_hour', windowLabel: 'Session (5hr)', resetsAt: RESET });
  });

  it('names a full weekly window', async () => {
    expect(await fullWindowOf(claude([bar(70), bar(100, WEEK, 'seven_day')]))).toEqual({ windowId: 'seven_day', windowLabel: 'Weekly (7 day)', resetsAt: WEEK });
  });

  it('names the window that resets last when several are full, one with no reset time last of all', async () => {
    expect(await fullWindowOf(claude([bar(100), bar(100, WEEK, 'seven_day')]))).toMatchObject({ windowId: 'seven_day', resetsAt: WEEK });
    expect(await fullWindowOf(claude([bar(100, WEEK, 'seven_day'), bar(100, null)]))).toEqual({ windowId: 'five_hour', windowLabel: 'Session (5hr)' });
  });

  it("counts a model-scoped weekly window only for that model", async () => {
    const opus = claude([bar(100, WEEK, 'seven_day_opus')]);
    expect(await fullWindowOf(opus, 'anthropic', 'claude-sonnet-5-5')).toBeUndefined();
    expect(await fullWindowOf(opus, 'anthropic', 'claude-opus-5-5')).toEqual({ windowId: 'seven_day_opus', windowLabel: 'Weekly Opus', resetsAt: WEEK });
  });

  it("reads the chat model's provider", async () => {
    const data: SubscriptionUsageData = { claude: { status: 'ok', bars: [bar(100)], profile: PROFILE }, gpt: gptOk([{ id: 'codex_primary', utilization: 100, resetsAt: WEEK, windowSeconds: 5 * 3600 }]), fetchedAt: 0 };
    expect(await fullWindowOf(data, 'openai', 'gpt-6.1-sol')).toEqual({ windowId: 'codex_primary', windowLabel: 'Session (5hr)', resetsAt: WEEK });
  });

  it('names none when no window is full', async () => {
    expect(await fullWindowOf(claude([bar(99), bar(99.5, WEEK, 'seven_day')]))).toBeUndefined();
  });

  it('names none when the refresh fails', async () => {
    const h = harness();
    h.fetchUsage.mockRejectedValueOnce(new Error('offline'));
    expect(await h.monitor.fullWindow('anthropic', 'claude-opus-5-5')).toBeUndefined();
  });

  it('refreshes at once inside the interval, joining a refresh in flight', async () => {
    const h = harness();
    let answer: (data: SubscriptionUsageData) => void = () => {};
    h.fetchUsage.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    h.monitor.refreshAfterTurn();
    const named = h.monitor.fullWindow('anthropic', 'claude-opus-5-5');
    answer(claude([bar(100)]));
    expect(await named).toMatchObject({ windowId: 'five_hour' });
    expect(h.fetchUsage).toHaveBeenCalledTimes(1);

    h.responses.push(claude([bar(100)]));
    await h.monitor.fullWindow('anthropic', 'claude-opus-5-5');
    expect(h.fetchUsage).toHaveBeenCalledTimes(2);
  });

  it('names none once the bound passes, and still observes the late refresh', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      let answer: (data: SubscriptionUsageData) => void = () => {};
      h.fetchUsage.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
      const named = h.monitor.fullWindow('anthropic', 'claude-opus-5-5');
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_REFRESH_BOUND_MS);
      expect(await named).toBeUndefined();
      answer(claude([bar(100)]));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.crossings.map((c) => c.threshold)).toEqual([95]);
    } finally {
      vi.useRealTimers();
    }
  });
});
