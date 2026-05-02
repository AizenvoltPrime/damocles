import { computed, type ComputedRef } from 'vue';
import type { ChatMessage } from '@shared/types/session';
import type { ContentBlock } from '@shared/types/content';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useNodeStore } from '@/stores/useNodeStore';

const MISSING_NODE_TITLE = 'No node';

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export interface EnrichedPrompt {
  messageId: string;
  promptIndex: number;
  nodeId: string | null;
  nodeTitle: string;
  text: string;
  hasNonTextAttachments: boolean;
  time: string;
  tools: string[];
  errored: boolean;
  sdkMessageId: string | null;
}

/**
 * MUST match the extension's promptIndex stamping rule. Diverging breaks
 * parity codebase-wide. This is the SOLE counting filter for prompt indices —
 * never re-derive promptIndex anywhere in the webview.
 */
export const USER_PROMPT_FILTER = (m: ChatMessage): boolean =>
  m.role === 'user' && !m.isInjected && !m.isCombinedQueue && !m.isQueued;

/**
 * Layered on top of USER_PROMPT_FILTER for navigator display only — does NOT
 * alter promptIndex semantics. Subagent-internal prompts and tool-result-as-user
 * records are hidden from the navigator UI but still bound tool windows for the
 * preceding parent prompt.
 */
export const NAVIGATOR_DISPLAY_FILTER = (m: ChatMessage): boolean => {
  if (!USER_PROMPT_FILTER(m)) return false;
  if (m.parentToolUseId != null) return false;
  const firstBlock = m.contentBlocks?.[0];
  if (firstBlock && firstBlock.type === 'tool_result') return false;
  return true;
};

function extractText(blocks: ContentBlock[] | undefined, fallback: string): string {
  if (!blocks || blocks.length === 0) return fallback;
  const textParts = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text);
  if (textParts.length === 0) return '';
  return textParts.join('\n');
}

function hasNonText(blocks: ContentBlock[] | undefined): boolean {
  if (!blocks || blocks.length === 0) return false;
  return blocks.some((b) => b.type !== 'text');
}

function formatTime(timestamp: number): string {
  return timeFormatter.format(new Date(timestamp));
}

export function useEnrichedPrompts(): ComputedRef<EnrichedPrompt[]> {
  const streamingStore = useStreamingStore();
  const nodeStore = useNodeStore();

  return computed<EnrichedPrompt[]>(() => {
    const msgs = streamingStore.messages;
    const nodes = nodeStore.nodes;
    const result: EnrichedPrompt[] = [];

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      if (!msg || !NAVIGATOR_DISPLAY_FILTER(msg)) continue;

      const seenTools = new Set<string>();
      const tools: string[] = [];
      let errored = false;

      for (let j = i + 1; j < msgs.length; j++) {
        const peer = msgs[j];
        if (!peer) continue;
        if (USER_PROMPT_FILTER(peer)) break;

        if (peer.role === 'error') {
          errored = true;
        }

        if (peer.role === 'assistant' && peer.toolCalls) {
          for (const tc of peer.toolCalls) {
            if (!seenTools.has(tc.name)) {
              seenTools.add(tc.name);
              tools.push(tc.name);
            }
            if (tc.status === 'failed') {
              errored = true;
            }
          }
        }
      }

      const blocks = msg.contentBlocks;
      const text = extractText(blocks, msg.content);
      const nonText = hasNonText(blocks);
      const nodeId = msg.nodeId ?? null;
      const nodeTitle = nodeId
        ? nodes.find((n) => n.nodeId === nodeId)?.title ?? MISSING_NODE_TITLE
        : MISSING_NODE_TITLE;

      result.push({
        messageId: msg.id,
        promptIndex: msg.promptIndex ?? 0,
        nodeId,
        nodeTitle,
        text,
        hasNonTextAttachments: nonText,
        time: formatTime(msg.timestamp),
        tools,
        errored,
        sdkMessageId: msg.sdkMessageId ?? null,
      });
    }

    return result;
  });
}
