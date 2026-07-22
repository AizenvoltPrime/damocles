import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { log } from '../logger';

// Prune when more than HIGH tool-result images exist, in fixed batches of BATCH. Between HIGH − BATCH + 1
// and HIGH of the newest images survive (right after a trigger only HIGH − BATCH + 1 remain).
const HIGH = 6;
const BATCH = 3;

// Constant placeholder — MUST be byte-identical for every pruned image. Because the boundary is
// batched (below), the transformed history stays byte-stable between prune triggers, so Anthropic's
// prompt-cache prefix survives instead of being invalidated on every turn.
const PLACEHOLDER =
  '[Image removed: an older screenshot was pruned to keep the request within provider size limits. Capture a fresh screenshot (BrowserScreenshot) or re-read the file if this content is still needed.]';

/**
 * Pure transform: replace stale tool-result screenshots with a constant text placeholder so the
 * outbound request stays under the provider byte cap. Only `role === 'toolResult'` image blocks are
 * counted and pruned; every other message passes through by reference. Never mutates its input.
 *
 * User-attached images are deliberately exempt — they are intentional content the model may still
 * need, so a paste-heavy session can in principle still hit the byte cap. After compaction the
 * surviving history is re-counted from scratch, so previously pruned images that outlive compaction
 * reappear — benign, since compaction invalidates the prompt-cache prefix anyway.
 */
export function pruneStaleImages(messages: AgentMessage[]): { messages: AgentMessage[]; prunedCount: number } {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'toolResult') {
      for (const block of message.content) if (block.type === 'image') total++;
    }
  }

  // Boundary B: smallest multiple of BATCH such that T − B ≤ HIGH. Batching (vs. "keep newest K")
  // holds B fixed between triggers, so the transformed bytes — and the cache prefix — don't shift
  // every turn. T≤6 → B=0; 7..9 → 3; 10..12 → 6.
  const boundary = Math.max(0, Math.ceil((total - HIGH) / BATCH) * BATCH);
  if (boundary === 0) return { messages, prunedCount: 0 };

  let ordinal = 0;
  const out = messages.map((message) => {
    if (message.role !== 'toolResult') return message;
    let touched = false;
    const content = message.content.map((block) => {
      if (block.type !== 'image') return block;
      const prune = ordinal < boundary;
      ordinal++;
      if (!prune) return block;
      touched = true;
      return { type: 'text' as const, text: PLACEHOLDER };
    });
    return touched ? { ...message, content } : message;
  });

  return { messages: out, prunedCount: boundary };
}

/** Register the outbound-context image pruner on pi's `context` seam. Fail-soft: a pruning bug must
 *  never block a turn, so on error the handler logs and returns `undefined` (turn proceeds unpruned). */
export function registerContextImagePruning(pi: ExtensionAPI): void {
  pi.on('context', (event) => {
    try {
      const { messages, prunedCount } = pruneStaleImages(event.messages);
      if (prunedCount > 0) log('[ContextPrune] excluding %d stale images from outbound context (cumulative)', prunedCount);
      return { messages };
    } catch (err) {
      log('[ContextPrune] pruning failed, proceeding unpruned: %O', err);
      return undefined;
    }
  });
}
