/**
 * usage.ts — Token usage: shapes, accumulator operators, session-stats readers.
 *
 * Ported from @tintinweb/pi-subagents (MIT, © 2026 tintinweb; see THIRD-PARTY-NOTICES.md).
 */

/**
 * Lifetime usage components of one run's assistant messages, accumulated via
 * `message_end` events, for the model-facing result. These components are a
 * token total, so cacheRead is excluded: each turn's cacheRead is the
 * cumulative cached prefix re-read on that one call, and summing it across
 * turns counts the same prefix N times. Summing per-request cacheRead is a
 * different quantity, the one the API bills, which the card reads from pi's
 * session totals instead (`runUsageMeter`).
 */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number };

/** Sum of lifetime usage components, or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
}

/** Minimal shape we read from upstream `getSessionStats()`. */
export type SessionStatsLike = {
  tokens: { input: number; output: number; cacheWrite: number };
  contextUsage?: { percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

/**
 * input + output + cacheWrite from upstream `getSessionStats().tokens`, which
 * sums every billed entry in the session file: it never resets at compaction,
 * and a reopened session's figure includes its earlier runs.
 */
export function getSessionTokens(session: SessionLike | undefined): number {
  if (!session) return 0;
  try {
    const t = session.getSessionStats().tokens;
    return t.input + t.output + t.cacheWrite;
  } catch {
    return 0;
  }
}

/**
 * Context-window utilization (0–100), or null when unavailable
 * (no model contextWindow, or post-compaction before the next response).
 */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  if (!session) return null;
  try {
    return session.getSessionStats().contextUsage?.percent ?? null;
  } catch {
    return null;
  }
}
