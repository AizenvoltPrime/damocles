import type { ClaudeAccountProfile, ProviderUsage, SubscriptionUsageData, UsageWindowBar } from '../../shared/types/usage';
import { describeAuthError } from './describe-error';
import { oneLine } from './untrusted-text';
import { log } from '../logger';
import { t } from '../l10n';

/** The process refreshes subscription usage at most this often after settled turns. */
export const USAGE_REFRESH_INTERVAL_MS: number = 10 * 60_000;
/**
 * How long a rate-limit outcome waits for the refresh that names its window. The usage endpoint answers in
 * well under a second; past this the notification would arrive long after the chat went idle.
 */
export const RATE_LIMIT_REFRESH_BOUND_MS: number = 5_000;
// Highest first: an observation raises only the highest threshold it newly reached.
const THRESHOLDS = [95, 80] as const;
type Threshold = (typeof THRESHOLDS)[number];
// Reset times closer than this are one window, so a reported reset time that jitters is still the same window.
const RESET_RESOLUTION_MS = 60_000;
// An unknown window's label is provider text (a limit kind, a model's display name) shown in an always-on-top popup.
const WINDOW_LABEL_MAX_CHARS = 60;
// A weekly window scoped to one model: `seven_day_<model>` (`subscription-usage.ts`).
const SCOPED_WEEKLY_PREFIX = 'seven_day_';

export type SubscriptionProvider = 'anthropic' | 'openai';

/** A subscription usage window crossed a threshold; raised once per threshold per window reset. */
export interface UsageThresholdCrossing {
  readonly provider: SubscriptionProvider;
  /** The window's bar id, stable across refreshes and launches, e.g. "five_hour" or "codex_secondary". */
  readonly windowId: string;
  /** The window's label as Subscription usage shows it, e.g. "Session (5hr)" or "Weekly". */
  readonly windowLabel: string;
  readonly threshold: Threshold;
  /** 0-100. */
  readonly utilization: number;
  /** Epoch ms. */
  readonly resetsAt?: number;
  /** The subscription the provider reports, e.g. "Max 20x". */
  readonly planName?: string;
}

/** The window a rate limit paused on: at 100% and counting against the chat's model. */
export interface FullUsageWindow {
  /** As `UsageThresholdCrossing.windowId`. */
  readonly windowId: string;
  /** As `UsageThresholdCrossing.windowLabel`. */
  readonly windowLabel: string;
  /** Epoch ms. */
  readonly resetsAt?: number;
}

/** The subscription Anthropic's profile names: a Max multiplier from the rate limit tier, else the organization's plan. */
export function claudePlanName(profile: Pick<ClaudeAccountProfile, 'rateLimitTier' | 'organizationType'>): string | undefined {
  const tier = profile.rateLimitTier ?? '';
  switch (profile.organizationType) {
    case 'claude_team':
      return 'Team';
    case 'claude_enterprise':
      return 'Enterprise';
  }
  if (/(?:^|_)max_20x$/.test(tier)) return 'Max 20x';
  if (/(?:^|_)max_5x$/.test(tier)) return 'Max 5x';
  switch (profile.organizationType) {
    case 'claude_max':
      return 'Max';
    case 'claude_pro':
      return 'Pro';
  }
  return undefined;
}

const CHATGPT_PLANS: Readonly<Record<string, string>> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

/** The subscription a ChatGPT `plan_type` names; a value outside the known plans names none. */
export function chatgptPlanName(planType: string): string | undefined {
  return Object.hasOwn(CHATGPT_PLANS, planType) ? CHATGPT_PLANS[planType] : undefined;
}

function capitalize(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/** A window's label as Subscription usage shows it (`SubscriptionUsageOverlay.vue`), flattened and capped; empty when nothing printable is left. */
export function usageWindowLabel(bar: UsageWindowBar): string {
  return oneLine(windowLabelText(bar), WINDOW_LABEL_MAX_CHARS) ?? '';
}

function windowLabelText(bar: UsageWindowBar): string {
  const seconds = bar.windowSeconds;
  if (typeof seconds === 'number') {
    if (seconds <= 6 * 3600) return t('Session (5hr)');
    return seconds <= 8 * 86400 ? t('Weekly') : t('Monthly');
  }
  switch (bar.id) {
    case 'five_hour':
    case 'codex_primary':
      return t('Session (5hr)');
    case 'seven_day':
      return t('Weekly (7 day)');
    case 'codex_secondary':
      return t('Weekly');
  }
  if (bar.id.startsWith(SCOPED_WEEKLY_PREFIX)) return t('Weekly {0}', capitalize(bar.id.slice(SCOPED_WEEKLY_PREFIX.length)));
  return bar.id.split('_').map(capitalize).join(' ');
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Every window counts against every model except a model-scoped weekly, which counts only when each word of its model is a word of `model`. */
function countsAgainst(windowId: string, model: string): boolean {
  if (!windowId.startsWith(SCOPED_WEEKLY_PREFIX)) return true;
  const scope = words(windowId.slice(SCOPED_WEEKLY_PREFIX.length));
  const own = new Set(words(model));
  return scope.length > 0 && scope.every((word) => own.has(word));
}

// A window with no reset time cannot be shown to reset sooner, so it ranks last.
function resetOrder(bar: UsageWindowBar): number {
  return bar.resetsAt ?? Number.POSITIVE_INFINITY;
}

/** The window at 100% that `model` counts against; when several are, the one that resets last, which is when the pause ends. */
function fullUsageWindow(usage: ProviderUsage, model: string): FullUsageWindow | undefined {
  if (usage.status !== 'ok') return undefined;
  let last: UsageWindowBar | undefined;
  for (const bar of usage.bars) {
    if (bar.utilization < 100 || !countsAgainst(bar.id, model)) continue;
    if (!last || resetOrder(bar) > resetOrder(last)) last = bar;
  }
  if (!last) return undefined;
  return { windowId: last.id, windowLabel: usageWindowLabel(last), ...(last.resetsAt !== null ? { resetsAt: last.resetsAt } : {}) };
}

function usageOf(data: SubscriptionUsageData, provider: SubscriptionProvider): ProviderUsage {
  return provider === 'anthropic' ? data.claude : data.gpt;
}

interface WindowState {
  resetsAt: number | null;
  raised: Threshold | 0;
}

function reachedThreshold(utilization: number): Threshold | 0 {
  return THRESHOLDS.find((threshold) => utilization >= threshold) ?? 0;
}

/** Whether two reported reset times (epoch ms, null for none) name the same window reset. */
export function sameReset(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < RESET_RESOLUTION_MS;
}

export interface UsageMonitorDeps {
  fetchUsage(): Promise<SubscriptionUsageData>;
  now(): number;
  onCrossing(crossing: UsageThresholdCrossing): void;
}

/**
 * The process-wide subscription usage refresh (AD10's limit detection), the plan names its crossings carry,
 * and the full window a rate limit names (D55). One instance lives on `PiRuntime`, so every session shares
 * its refresh interval and its threshold state. The usage and profile bodies hold the account email: nothing
 * here logs them.
 */
export class UsageMonitor {
  private readonly deps: UsageMonitorDeps;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<SubscriptionUsageData | undefined> | null = null;
  // Bumped on a credential change, so a fetch made with the previous credentials observes nothing.
  private generation = 0;
  private readonly plans = new Map<SubscriptionProvider, string>();
  private readonly windows = new Map<string, WindowState>();

  constructor(deps: UsageMonitorDeps) {
    this.deps = deps;
  }

  /** The stored credentials changed: the previous account's plans go, and the next settled turn refreshes with the new ones. */
  credentialsChanged(): void {
    this.generation++;
    this.inFlight = null;
    this.lastRefreshAt = Number.NEGATIVE_INFINITY;
    this.plans.clear();
  }

  /** A turn on a subscription account settled; refreshes unless one ran within the interval. */
  refreshAfterTurn(): void {
    if (this.deps.now() - this.lastRefreshAt < USAGE_REFRESH_INTERVAL_MS) return;
    void this.refresh();
  }

  /**
   * A turn on a `provider` subscription stopped on a rate limit: refreshes at once, joining a refresh in flight, and
   * names the full window `model` counts against. Undefined when none is full, or the refresh failed or outlasted the bound.
   */
  async fullWindow(provider: SubscriptionProvider, model: string): Promise<FullUsageWindow | undefined> {
    const data = await this.refreshWithin(RATE_LIMIT_REFRESH_BOUND_MS);
    return data ? fullUsageWindow(usageOf(data, provider), model) : undefined;
  }

  /** The refresh's observation, or undefined once `ms` pass first; the refresh itself runs on and is observed. */
  private refreshWithin(ms: number): Promise<SubscriptionUsageData | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms);
      void this.refresh().then((data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  /** Never rejects: resolves to what it observed, or undefined when the fetch failed or the credentials changed under it. */
  private refresh(): Promise<SubscriptionUsageData | undefined> {
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    this.lastRefreshAt = this.deps.now();
    const run: Promise<SubscriptionUsageData | undefined> = this.deps
      .fetchUsage()
      .then((data) => {
        if (generation !== this.generation) return undefined;
        this.observe(data);
        return data;
      })
      .catch((err: unknown) => {
        log('[UsageMonitor] subscription usage refresh failed: %s', describeAuthError(err));
        return undefined;
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  private observe(data: SubscriptionUsageData): void {
    const claude = data.claude.profile;
    const planType = data.gpt.status === 'ok' ? data.gpt.planType : undefined;
    this.updatePlan('anthropic', data.claude, claude ? claudePlanName(claude) ?? null : undefined);
    this.updatePlan('openai', data.gpt, planType !== undefined ? chatgptPlanName(planType) ?? null : undefined);
    this.observeWindows('anthropic', data.claude);
    this.observeWindows('openai', data.gpt);
  }

  /** `read` is the plan the response names, null for none, or undefined when it names nothing (a refused profile), which keeps the last one. */
  private updatePlan(provider: SubscriptionProvider, usage: ProviderUsage, read: string | null | undefined): void {
    const named = usage.status === 'not-connected' ? null : read;
    if (named === null) this.plans.delete(provider);
    else if (named !== undefined) this.plans.set(provider, named);
  }

  private observeWindows(provider: SubscriptionProvider, usage: ProviderUsage): void {
    if (usage.status !== 'ok') return;
    for (const bar of usage.bars) {
      const key = `${provider}:${bar.id}`;
      const previous = this.windows.get(key);
      const reached = reachedThreshold(bar.utilization);
      let raised: Threshold | 0 = previous && sameReset(previous.resetsAt, bar.resetsAt) ? previous.raised : 0;
      // With no reset time the window cannot say it reset, so falling below a raised threshold re-arms it.
      if (bar.resetsAt === null && reached < raised) raised = reached;
      this.windows.set(key, { resetsAt: bar.resetsAt, raised: Math.max(raised, reached) as Threshold | 0 });
      if (reached === 0 || reached <= raised) continue;
      const planName = this.plans.get(provider);
      this.deps.onCrossing({
        provider,
        windowId: bar.id,
        windowLabel: usageWindowLabel(bar),
        threshold: reached,
        utilization: bar.utilization,
        ...(bar.resetsAt !== null ? { resetsAt: bar.resetsAt } : {}),
        ...(planName !== undefined ? { planName } : {}),
      });
    }
  }
}
