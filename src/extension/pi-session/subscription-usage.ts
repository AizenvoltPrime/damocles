import type { UsageWindowBar, UsageSpend, SubscriptionUsageData, ProviderUsage } from '../../shared/types/usage';
import type { PiRuntime } from './pi-runtime';

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 10_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clampUtilization(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function parseIsoToMs(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Window keys churn (Sonnet→Fable) so ordering is positional, not an enum: five_hour, seven_day, seven_day_* alpha, rest alpha. */
function claudeWindowRank(id: string): number {
  if (id === 'five_hour') return 0;
  if (id === 'seven_day') return 1;
  if (id.startsWith('seven_day_')) return 2;
  return 3;
}

function compareClaudeWindows(a: string, b: string): number {
  const ra = claudeWindowRank(a);
  const rb = claudeWindowRank(b);
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Model codename from a weekly_scoped limit's scope, lowercased+snake for a `seven_day_<name>` id. */
function scopedModelSlug(scope: unknown): string | undefined {
  if (!isObject(scope)) return undefined;
  const model = scope['model'];
  if (!isObject(model)) return undefined;
  const name = model['display_name'];
  if (typeof name !== 'string' || !name.trim()) return undefined;
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * New API shape: a `limits` array is the source of truth for windows. Model-scoped weeklies
 * (Fable/Opus/…) live only here now — the legacy top-level `seven_day_*` keys are null. Maps
 * kind → the same ids the webview already labels: session→five_hour, weekly_all→seven_day,
 * weekly_scoped→seven_day_<model> (humanized "Weekly Fable").
 */
function parseClaudeLimits(limits: unknown[]): UsageWindowBar[] {
  const ranked: { bar: UsageWindowBar; rank: number }[] = [];
  for (const entry of limits) {
    if (!isObject(entry)) continue;
    const percent = entry['percent'];
    if (typeof percent !== 'number') continue;
    const resetsAt = parseIsoToMs(entry['resets_at']);
    const kind = entry['kind'];
    const group = entry['group'];

    let id: string;
    let rank: number;
    if (kind === 'session' || group === 'session') {
      id = 'five_hour';
      rank = 0;
    } else if (kind === 'weekly_all') {
      id = 'seven_day';
      rank = 1;
    } else if (kind === 'weekly_scoped') {
      const slug = scopedModelSlug(entry['scope']);
      id = slug ? `seven_day_${slug}` : 'seven_day_scoped';
      rank = 2;
    } else {
      id = typeof kind === 'string' && kind ? kind : 'unknown';
      rank = 3;
    }
    ranked.push({ bar: { id, utilization: clampUtilization(percent), resetsAt }, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || compareClaudeWindows(a.bar.id, b.bar.id));

  const seen = new Set<string>();
  const bars: UsageWindowBar[] = [];
  for (const { bar } of ranked) {
    if (seen.has(bar.id)) continue;
    seen.add(bar.id);
    bars.push(bar);
  }
  return bars;
}

/** Legacy top-level `five_hour`/`seven_day`/`seven_day_*` window objects (pre-`limits` payloads). */
function parseClaudeLegacyWindows(json: Record<string, unknown>): UsageWindowBar[] {
  const bars: UsageWindowBar[] = [];
  const keys = Object.keys(json)
    .filter((key) => key !== 'extra_usage')
    .sort(compareClaudeWindows);

  for (const key of keys) {
    const value = json[key];
    if (!isObject(value)) continue;
    const utilization = value['utilization'];
    if (typeof utilization !== 'number') continue;
    bars.push({ id: key, utilization: clampUtilization(utilization), resetsAt: parseIsoToMs(value['resets_at']) });
  }
  return bars;
}

export function parseClaudeUsage(json: unknown): { bars: UsageWindowBar[]; spend?: UsageSpend } {
  if (!isObject(json)) return { bars: [] };

  const limits = json['limits'];
  const bars =
    Array.isArray(limits) && limits.length > 0 ? parseClaudeLimits(limits) : parseClaudeLegacyWindows(json);

  const spend = parseClaudeSpend(json['spend']) ?? parseClaudeLegacySpend(json['extra_usage']);
  return { bars, ...(spend ? { spend } : {}) };
}

/** Major-unit amount from a `{ amount_minor, exponent }` money object (exponent defaults to 2). */
function minorToMajor(money: unknown): number | undefined {
  if (!isObject(money)) return undefined;
  const minor = money['amount_minor'];
  if (typeof minor !== 'number') return undefined;
  const rawExp = money['exponent'];
  // Bound the external exponent to a sane currency range so a hostile/garbage value can't over/underflow.
  const exponent = typeof rawExp === 'number' && rawExp >= 0 && rawExp <= 10 ? rawExp : 2;
  return minor / Math.pow(10, exponent);
}

/** New API `spend` object: `{ enabled, used: {amount_minor,currency,exponent}, limit: {…}|null }`. */
function parseClaudeSpend(spend: unknown): UsageSpend | undefined {
  if (!isObject(spend)) return undefined;
  if (spend['enabled'] !== true) return undefined;
  const amount = minorToMajor(spend['used']);
  if (amount === undefined) return undefined;

  const used = spend['used'];
  const currency = isObject(used) && typeof used['currency'] === 'string' ? used['currency'] : undefined;
  const limit = minorToMajor(spend['limit']);
  return {
    kind: 'used',
    amount,
    ...(limit !== undefined ? { limit } : {}),
    ...(currency !== undefined ? { currency } : {}),
  };
}

/** Legacy `extra_usage` object (cents): `{ is_enabled, used_credits, monthly_limit, currency }`. */
function parseClaudeLegacySpend(extra: unknown): UsageSpend | undefined {
  if (!isObject(extra)) return undefined;
  if (extra['is_enabled'] !== true) return undefined;
  const usedCredits = extra['used_credits'];
  if (typeof usedCredits !== 'number') return undefined;

  const monthlyLimit = extra['monthly_limit'];
  const currencyRaw = extra['currency'];
  const limit = typeof monthlyLimit === 'number' ? monthlyLimit / 100 : undefined;
  const currency = typeof currencyRaw === 'string' ? currencyRaw : undefined;
  return {
    kind: 'used',
    amount: usedCredits / 100,
    ...(limit !== undefined ? { limit } : {}),
    ...(currency !== undefined ? { currency } : {}),
  };
}

function parseCodexWindow(id: string, window: unknown): UsageWindowBar | undefined {
  if (!isObject(window)) return undefined;
  const usedPercent = window['used_percent'];
  if (typeof usedPercent !== 'number') return undefined;

  const windowSecondsRaw = window['limit_window_seconds'];
  const resetAtRaw = window['reset_at'];
  const windowSeconds = typeof windowSecondsRaw === 'number' ? windowSecondsRaw : undefined;
  const resetsAt = typeof resetAtRaw === 'number' ? resetAtRaw * 1000 : null;
  return {
    id,
    utilization: clampUtilization(usedPercent),
    resetsAt,
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
  };
}

export function parseCodexUsage(json: unknown): { bars: UsageWindowBar[]; planType?: string; spend?: UsageSpend } {
  if (!isObject(json)) return { bars: [] };

  const bars: UsageWindowBar[] = [];
  const rateLimit = json['rate_limit'];
  if (isObject(rateLimit)) {
    const primary = parseCodexWindow('codex_primary', rateLimit['primary_window']);
    if (primary) bars.push(primary);
    const secondary = parseCodexWindow('codex_secondary', rateLimit['secondary_window']);
    if (secondary) bars.push(secondary);
  }

  const planTypeRaw = json['plan_type'];
  const planType = typeof planTypeRaw === 'string' ? planTypeRaw : undefined;
  const spend = parseCodexSpend(json['credits']);
  return { bars, ...(planType !== undefined ? { planType } : {}), ...(spend ? { spend } : {}) };
}

function parseCodexSpend(credits: unknown): UsageSpend | undefined {
  if (!isObject(credits)) return undefined;
  if (credits['has_credits'] !== true) return undefined;
  if (credits['unlimited'] === true) return undefined;

  // balance is number|string|null across plans; guard the type so null/false/[] can't coerce to a phantom 0.
  const balance = credits['balance'];
  if (typeof balance !== 'number' && typeof balance !== 'string') return undefined;
  const amount = Number(balance);
  if (!Number.isFinite(amount)) return undefined;
  return { kind: 'balance', amount };
}

async function fetchClaudeUsage(runtime: PiRuntime): Promise<ProviderUsage> {
  const token = await runtime.getClaudeAccessToken();
  if (token === undefined) return { status: 'not-connected', bars: [] };

  try {
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { status: 'error', bars: [], error: `HTTP ${res.status}` };

    const json = await res.json();
    const { bars, spend } = parseClaudeUsage(json);
    return { status: 'ok', bars, ...(spend ? { spend } : {}) };
  } catch {
    return { status: 'error', bars: [], error: 'Network error' };
  }
}

async function fetchCodexUsage(runtime: PiRuntime): Promise<ProviderUsage> {
  const token = await runtime.getCodexAccessToken();
  if (token === undefined) return { status: 'not-connected', bars: [] };

  try {
    // chatgpt.com is Cloudflare-fronted; this exact browser-like header set is required to avoid a challenge.
    const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        accept: '*/*',
        'content-type': 'application/json',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        origin: 'https://chatgpt.com',
        referer: 'https://chatgpt.com/',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { status: 'error', bars: [], error: `HTTP ${res.status}` };

    // A Cloudflare HTML challenge page carries no JSON content-type; bail before res.json() would throw on it.
    if (!res.headers.get('content-type')?.includes('application/json')) {
      return { status: 'error', bars: [], error: 'Unexpected response' };
    }

    const json = await res.json();
    const { bars, planType, spend } = parseCodexUsage(json);
    return { status: 'ok', bars, ...(planType !== undefined ? { planType } : {}), ...(spend ? { spend } : {}) };
  } catch {
    return { status: 'error', bars: [], error: 'Network error' };
  }
}

export async function fetchSubscriptionUsage(runtime: PiRuntime): Promise<SubscriptionUsageData> {
  const [claudeResult, gptResult] = await Promise.allSettled([
    fetchClaudeUsage(runtime),
    fetchCodexUsage(runtime),
  ]);
  const claude = claudeResult.status === 'fulfilled'
    ? claudeResult.value
    : { status: 'error' as const, bars: [], error: 'Network error' };
  const gpt = gptResult.status === 'fulfilled'
    ? gptResult.value
    : { status: 'error' as const, bars: [], error: 'Network error' };
  return { claude, gpt, fetchedAt: Date.now() };
}
