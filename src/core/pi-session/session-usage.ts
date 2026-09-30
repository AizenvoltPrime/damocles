import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import {
  countOwnUserPrompts,
  subtractUsage,
  sumOwnUsage,
  sumUsage,
  toAgentUsage,
  type AccountingEntry,
  type AgentUsageTotals,
  type UsageTotals,
} from '../../shared/usage-accounting';

/** The part of pi's `SessionManager` a usage figure reads. */
export interface UsageEntrySource {
  getEntries(): readonly AccountingEntry[];
}

/** The part of pi's `SessionManager` a conversation's own totals read. */
export interface ConversationEntrySource extends UsageEntrySource {
  getBranch(): readonly AccountingEntry[];
  getHeader(): { timestamp?: unknown } | null;
}

/** pi's `getSessionStats()` totals, without the context projection that call also builds. */
export function sessionUsageTotals(session: { sessionManager: UsageEntrySource }): UsageTotals {
  return sumUsage(session.sessionManager.getEntries());
}

/** The conversation's own spend, which both the status bar and the budget count. */
export function ownSessionUsage(sm: ConversationEntrySource): UsageTotals {
  return sumOwnUsage(sm.getEntries(), sm.getHeader()?.timestamp);
}

export type SessionUsageMessage = Extract<ExtensionToWebviewMessage, { type: 'sessionUsage' }>;

/** The status bar's billing totals. The live adapter and the history replay both build them here. */
export function sessionUsageMessage(sm: ConversationEntrySource): SessionUsageMessage {
  return {
    type: 'sessionUsage',
    usage: toAgentUsage(ownSessionUsage(sm)),
    numTurns: countOwnUserPrompts(sm.getBranch(), sm.getHeader()?.timestamp),
  };
}

/**
 * The usage of one agent run: pi's session totals now, minus the totals when the run began. pi sums every
 * billed entry in the file, so the figure includes compaction and cache-warm spend and never resets.
 */
export function runUsageMeter(session: { sessionManager: UsageEntrySource }): () => AgentUsageTotals {
  const baseline = sessionUsageTotals(session);
  return () => toAgentUsage(subtractUsage(sessionUsageTotals(session), baseline));
}

export function sameAgentUsage(a: AgentUsageTotals, b: AgentUsageTotals): boolean {
  return (
    a.totalInputTokens === b.totalInputTokens &&
    a.totalOutputTokens === b.totalOutputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens &&
    a.costUsd === b.costUsd
  );
}
