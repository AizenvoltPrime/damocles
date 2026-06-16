import { log } from '../../logger';
import type { PendingAssistantMessage, StreamingContent } from '../types';
import type { StreamingState } from './state';

/**
 * Calculate thinking duration when transitioning out of thinking phase.
 * Mutates streamingContent to set isThinking=false and thinkingDuration.
 *
 * @returns The calculated duration in seconds, or null if not applicable
 */
export function calculateThinkingDuration(streamingContent: StreamingContent): number | null {
  if (
    streamingContent.isThinking &&
    streamingContent.thinkingStartTime &&
    !streamingContent.thinkingDuration
  ) {
    streamingContent.thinkingDuration = Math.max(
      1,
      Math.round((Date.now() - streamingContent.thinkingStartTime) / 1000)
    );
    streamingContent.isThinking = false;
    return streamingContent.thinkingDuration;
  }
  return null;
}

/**
 * Emit one cache-efficiency telemetry line per model call to the Damocles OutputChannel.
 *
 * Called from both token-usage emission sites (assistant message + stream_event message_delta)
 * so every backend is observable; dedupes on the message id, so a call whose usage is carried by
 * both paths (Anthropic) logs once. The OpenAI/Codex bridge ships usage only on the delta site, so
 * it logs there once per call. Logs counts, derived hit-rate, the turn-origin tag, and the running
 * session cost (summed from per-turn results) when known — never message bodies or secrets.
 *
 * hitRate = cacheRead / (input + cacheCreation + cacheRead): the fraction of the request prefix
 * billed at the ~10% cached rate, under Anthropic's accounting where `input` excludes the cached
 * tokens. Turn 1 of a fresh prefix is creation-heavy (low rate); reused turns trend high.
 */
export function logCacheUsage(
  state: StreamingState,
  params: {
    messageId: string | null | undefined;
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  },
): void {
  if (!state.markCacheLoggedIfNew(params.messageId)) return;

  const { inputTokens, cacheCreationTokens, cacheReadTokens } = params;
  const denom = inputTokens + cacheCreationTokens + cacheReadTokens;
  const hitRate = denom > 0 ? cacheReadTokens / denom : 0;
  const cost = state.cumulativeCostUsd;

  log(
    '[Cache] in=%d cacheCreate=%d cacheRead=%d hitRate=%s %s%s',
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    hitRate.toFixed(2),
    state.queryOrigin,
    cost > 0 ? ` costΣ=$${cost.toFixed(4)}` : '',
  );
}

/**
 * Commit accumulated streaming text to pending assistant content.
 * Mutates both streamingContent (clears text) and pendingAssistant (appends block).
 */
export function commitStreamingText(
  streamingContent: StreamingContent,
  pendingAssistant: PendingAssistantMessage | null
): void {
  if (!streamingContent.text || !pendingAssistant) return;

  pendingAssistant.content.push({
    type: 'text',
    text: streamingContent.text,
  });
  streamingContent.text = '';
}
