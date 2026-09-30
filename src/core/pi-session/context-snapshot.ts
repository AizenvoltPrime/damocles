/** The last request's prompt tokens: what the context window holds, never a billing figure. */
export interface ContextSnapshot {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What the meter reads after a compaction and before the next response: pi reports the size as unknown. */
export function emptyContextSnapshot(): ContextSnapshot {
  return { input: 0, cacheRead: 0, cacheWrite: 0 };
}

interface SnapshotSource {
  stopReason?: unknown;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } | null;
}

/**
 * The context reading an assistant message gives, or undefined for one pi's `getContextUsage` skips: an
 * aborted or errored request, or one that reports no tokens.
 */
export function contextSnapshotOf(message: SnapshotSource): ContextSnapshot | undefined {
  if (message.stopReason === 'aborted' || message.stopReason === 'error' || !message.usage) return undefined;
  const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, totalTokens = 0 } = message.usage;
  if ((totalTokens || input + output + cacheRead + cacheWrite) <= 0) return undefined;
  return { input, cacheRead, cacheWrite };
}
