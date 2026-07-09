export interface UsageWindowBar {
  /** Raw window id: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_fable' | 'codex_primary' | 'codex_secondary' | future keys. */
  id: string;
  /** 0-100, clamped extension-side. */
  utilization: number;
  /** Reset time as epoch MILLISECONDS (Claude ISO8601 and Codex unix-seconds both converted), or null. */
  resetsAt: number | null;
  /** Window length in seconds when known (Codex limit_window_seconds). */
  windowSeconds?: number;
}

export type ProviderUsageStatus = 'ok' | 'not-connected' | 'error';

export type UsageSpend =
  | { kind: 'used'; amount: number; limit?: number; currency?: string }
  | { kind: 'balance'; amount: number; currency?: string };

export interface ProviderUsage {
  status: ProviderUsageStatus;
  bars: UsageWindowBar[];
  planType?: string;
  spend?: UsageSpend;
  /** Human-readable; NEVER contains token text. */
  error?: string;
}

export interface SubscriptionUsageData {
  claude: ProviderUsage;
  gpt: ProviderUsage;
  fetchedAt: number;
}
