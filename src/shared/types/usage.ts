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

/** Claude account behind the subscription OAuth token; a field the endpoint omits or mistypes is null. */
export interface ClaudeAccountProfile {
  organizationType: string | null;
  rateLimitTier: string | null;
  seatTier: string | null;
  subscriptionStatus: string | null;
  hasExtraUsageEnabled: boolean | null;
  /** Identifying: the webview masks it until the user reveals it, and the host never logs it. */
  email: string | null;
  /** Identifying: a personal organization is named after the account email. */
  organizationName: string | null;
}

export interface ProviderUsage {
  status: ProviderUsageStatus;
  bars: UsageWindowBar[];
  planType?: string;
  spend?: UsageSpend;
  /** Human-readable; NEVER contains token text. */
  error?: string;
  profile?: ClaudeAccountProfile;
  /** Human-readable; NEVER contains token or profile text. */
  profileError?: string;
  /** Set when the endpoint rejects the credential's token; the overlay links here instead of showing bars. */
  usageUrl?: string;
}

export interface SubscriptionUsageData {
  claude: ProviderUsage;
  gpt: ProviderUsage;
  fetchedAt: number;
}
