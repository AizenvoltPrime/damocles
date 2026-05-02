import type { UserContentBlock } from '../../shared/types/content';
import type { RecallService } from '../recall';

export interface UserMessagePayload {
  type: 'userMessage';
  content: string;
  contentBlocks?: UserContentBlock[];
  correlationId: string;
  promptIndex: number;
  nodeId: string | null;
  isInjected?: boolean;
}

export interface UserMessageStampSource {
  recallService?: RecallService;
  memoryPromptIndex?: number;
}

/**
 * Builds a `userMessage` payload with the recall-aware promptIndex and nodeId stamp.
 *
 * `promptIndex` resolves in order, accepting only non-negative values:
 *   1. recallService.currentPromptIndex (when recall is enabled and advanced)
 *   2. memoryPromptIndex (extension's non-recall counter)
 *   3. 0
 *
 * Recall returns -1 when disabled or never advanced; callers that pass `recallService`
 * MUST also pass `memoryPromptIndex` for the non-recall fallback to work.
 *
 * `nodeId` is the active recall node id, or null if recall is disabled / no active node.
 *
 * Stamping must reflect the post-increment value for the turn this broadcast represents.
 * Callers driving a turn through `session.sendMessage` MUST broadcast AFTER the counter has
 * advanced (i.e., from inside `session.sendMessage` after `onPromptSubmit` / `_nonRecallPromptIndex++`).
 * Slash-command interceptors that do not invoke `session.sendMessage` stamp with the current
 * value but MUST set `isInjected: true` so the navigator filter excludes them and the next
 * real prompt's index is preserved.
 */
export function buildUserMessagePayload(
  source: UserMessageStampSource,
  content: string,
  opts: { contentBlocks?: UserContentBlock[]; correlationId: string; isInjected?: boolean },
): UserMessagePayload {
  const recallIdx = source.recallService?.currentPromptIndex;
  const memoryIdx = source.memoryPromptIndex;
  const promptIndex =
    recallIdx !== undefined && recallIdx >= 0
      ? recallIdx
      : memoryIdx !== undefined && memoryIdx >= 0
        ? memoryIdx
        : 0;
  const nodeId = source.recallService?.activeNodeId ?? null;
  const payload: UserMessagePayload = {
    type: 'userMessage',
    content,
    correlationId: opts.correlationId,
    promptIndex,
    nodeId,
  };
  if (opts.contentBlocks !== undefined) payload.contentBlocks = opts.contentBlocks;
  if (opts.isInjected) payload.isInjected = true;
  return payload;
}
