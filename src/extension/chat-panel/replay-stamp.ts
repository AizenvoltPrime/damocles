export interface ReplayStampInput {
  sdkMessageId?: string;
  isInjected?: boolean;
}

export interface ReplayStamp {
  promptIndex: number;
  nodeId: string | null;
}

/**
 * Stamps a single replayed user message with `{promptIndex, nodeId}`.
 *
 * Mirrors the live extension's stamping rule:
 * - If the message UUID has a node-turn-ref entry, use those exact values.
 * - Otherwise, fall back to a synthetic counter that advances only for non-injected
 *   messages, exactly matching the webview's `USER_PROMPT_FILTER` semantics.
 *
 * Caller maintains the synthetic counter and increments it via the returned `advance` flag.
 */
export function stampReplayMessage(
  msg: ReplayStampInput,
  syntheticPromptIndex: number,
  nodeTurnRefs: Map<string, { promptIndex: number; nodeId: string }>,
): { stamp: ReplayStamp; advance: boolean } {
  const ref = msg.sdkMessageId ? nodeTurnRefs.get(msg.sdkMessageId) : undefined;
  const isCounted = !msg.isInjected;

  if (ref) {
    return { stamp: { promptIndex: ref.promptIndex, nodeId: ref.nodeId }, advance: isCounted };
  }

  const promptIndex = isCounted ? syntheticPromptIndex : Math.max(0, syntheticPromptIndex - 1);
  return { stamp: { promptIndex, nodeId: null }, advance: isCounted };
}
