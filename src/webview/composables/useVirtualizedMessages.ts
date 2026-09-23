import { computed, type Ref } from 'vue';
import type { ChatMessage, CompactMarker as CompactMarkerType, CacheMissNotice, CompactionAbortedNotice, ThinkingDroppedNotice, ToolCall } from '@shared/types/session';
import type { ContentBlock, ImageBlock } from '@shared/types/content';
import { TASK_MANAGEMENT_TOOLS, TEAM_MANAGEMENT_TOOLS, TEAM_RESUME_TOOL, TOOL_GET_SUBAGENT_RESULT } from '@shared/tool-names';
import { isImageContentBlock } from '@/utils/imageUtils';

export type VirtualItemType =
  | 'user-message'
  | 'compact-marker'
  | 'cache-miss-notice'
  | 'compaction-aborted-notice'
  | 'thinking-dropped-notice'
  | 'thinking-block'
  | 'text-block'
  | 'tool-call'
  | 'error-message'
  | 'refusal-message'
  | 'streaming-text'
  | 'background-label';

export interface VirtualItem {
  id: string;
  type: VirtualItemType;
  message: ChatMessage;
  originalMessageIndex: number;
  sourceMessageId: string;
  spacingLevel: 0 | 1 | 2;
  text?: string;
  toolCall?: ToolCall;
  marker?: CompactMarkerType;
  notice?: CacheMissNotice;
  compactionAborted?: CompactionAbortedNotice;
  thinkingDropped?: ThinkingDroppedNotice;
  block?: ContentBlock;
  imageBlocks?: ImageBlock[];
  isStreaming?: boolean;
}

function isTextBlock(block: ContentBlock): block is { type: 'text'; text: string } {
  return block.type === 'text';
}

function isToolUseBlock(block: ContentBlock): block is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } {
  return block.type === 'tool_use';
}

function isFilteredTool(toolName: string): boolean {
  // GetSubagentResult is the parent's "collect a background subagent's result" call; its result is
  // already shown on that subagent's own card, so the standalone tool card is redundant noise.
  return (
    TASK_MANAGEMENT_TOOLS.has(toolName) ||
    // resume_team renders the team card it continued, so it is not noise.
    (TEAM_MANAGEMENT_TOOLS.has(toolName) && toolName !== TEAM_RESUME_TOOL) ||
    toolName === TOOL_GET_SUBAGENT_RESULT
  );
}

function getMarkerPositionTimestamp(marker: CompactMarkerType): number {
  return marker.messageCutoffTimestamp ?? marker.timestamp;
}

export interface VirtualizedMessageSources {
  messages: Ref<ChatMessage[]>;
  compactMarkers: Ref<CompactMarkerType[] | undefined>;
  cacheMissNotices: Ref<CacheMissNotice[] | undefined>;
  compactionAbortedNotices: Ref<CompactionAbortedNotice[] | undefined>;
  thinkingDroppedNotices: Ref<ThinkingDroppedNotice[] | undefined>;
  streamingMessageId: Ref<string | null | undefined>;
}

interface TranscriptAnnotations {
  markers: CompactMarkerType[];
  cacheMisses: CacheMissNotice[];
  aborts: CompactionAbortedNotice[];
  drops: ThinkingDroppedNotice[];
}

export function useVirtualizedMessages(sources: VirtualizedMessageSources) {
  const items = computed<VirtualItem[]>(() => {
    const result: VirtualItem[] = [];
    const msgs = sources.messages.value;
    const streamingId = sources.streamingMessageId.value;
    const annotations: TranscriptAnnotations = {
      markers: sources.compactMarkers.value ?? [],
      cacheMisses: sources.cacheMissNotices.value ?? [],
      aborts: sources.compactionAbortedNotices.value ?? [],
      drops: sources.thinkingDroppedNotices.value ?? [],
    };

    // A processed queue bubble keeps its older timestamp at the end of the array, so each cut runs from the highest timestamp seen so far.
    let maxSeenTimestamp = 0;

    for (const [i, msg] of msgs.entries()) {
      const isStreaming = !!streamingId && msg.id === streamingId;

      result.push(...collectAnnotations(annotations, maxSeenTimestamp, msg.timestamp, msg, i));
      maxSeenTimestamp = Math.max(maxSeenTimestamp, msg.timestamp);

      if (msg.role === 'user') {
        const imageBlocks = msg.contentBlocks?.filter(isImageContentBlock);
        result.push({
          id: `user-${msg.id}`,
          type: 'user-message',
          message: msg,
          originalMessageIndex: i,
          sourceMessageId: msg.id,
          spacingLevel: 0,
          text: msg.content,
          ...(imageBlocks?.length ? { imageBlocks } : {}),
        });
        continue;
      }

      if (msg.role === 'error') {
        result.push({
          id: `error-${msg.id}`,
          type: 'error-message',
          message: msg,
          originalMessageIndex: i,
          sourceMessageId: msg.id,
          spacingLevel: 0,
          text: msg.content,
        });
        continue;
      }

      if (msg.role === 'refusal') {
        result.push({
          id: `refusal-${msg.id}`,
          type: 'refusal-message',
          message: msg,
          originalMessageIndex: i,
          sourceMessageId: msg.id,
          spacingLevel: 0,
          text: msg.content,
        });
        continue;
      }

      if (msg.isBackgroundResult) {
        result.push({
          id: `bg-${msg.id}`,
          type: 'background-label',
          message: msg,
          originalMessageIndex: i,
          sourceMessageId: msg.id,
          spacingLevel: 1,
          ...(msg.backgroundTaskLabel !== undefined && { text: msg.backgroundTaskLabel }),
        });
      }

      if (msg.thinking || msg.thinkingContent || msg.isThinkingPhase || msg.thinkingDuration) {
        result.push({
          id: `thinking-${msg.id}`,
          type: 'thinking-block',
          message: msg,
          originalMessageIndex: i,
          sourceMessageId: msg.id,
          spacingLevel: 1,
        });
      }

      const blocks = msg.contentBlocks;
      if (blocks && blocks.length > 0) {
        flattenContentBlocks(result, msg, blocks, i, isStreaming);
      } else {
        flattenFallback(result, msg, i, isStreaming);
      }
    }

    // Trailing annotations outlive the messages they were cut from, so when the list is empty they still
    // need an anchor. The empty id reproduces what consumers already saw and keeps them off undefined.
    const anchor: ChatMessage = msgs[msgs.length - 1] ?? {
      id: '',
      role: 'assistant',
      content: '',
      timestamp: 0,
    };

    result.push(
      ...collectAnnotations(annotations, maxSeenTimestamp, Number.POSITIVE_INFINITY, anchor, msgs.length - 1),
    );

    return result;
  });

  return { items };
}

function flattenContentBlocks(
  result: VirtualItem[],
  msg: ChatMessage,
  blocks: ContentBlock[],
  msgIndex: number,
  isStreaming: boolean,
): void {
  for (const [bi, block] of blocks.entries()) {
    if (isTextBlock(block)) {
      result.push({
        id: `text-${msg.id}-${bi}`,
        type: 'text-block',
        message: msg,
        originalMessageIndex: msgIndex,
        sourceMessageId: msg.id,
        spacingLevel: 1,
        text: block.text,
        block,
      });
    } else if (isToolUseBlock(block)) {
      if (isFilteredTool(block.name)) continue;
      const toolCall = msg.toolCalls?.find(t => t.id === block.id);
      if (!toolCall) continue;
      result.push({
        id: `tool-${block.id}`,
        type: 'tool-call',
        message: msg,
        originalMessageIndex: msgIndex,
        sourceMessageId: msg.id,
        spacingLevel: 1,
        toolCall,
        block,
      });
    }
  }

  if (isStreaming) {
    const trailingText = getTrailingStreamingText(msg);
    if (trailingText) {
      result.push({
        id: `streaming-${msg.id}`,
        type: 'streaming-text',
        message: msg,
        originalMessageIndex: msgIndex,
        sourceMessageId: msg.id,
        spacingLevel: 1,
        text: trailingText,
        isStreaming: true,
      });
    }
  }
}

function flattenFallback(
  result: VirtualItem[],
  msg: ChatMessage,
  msgIndex: number,
  isStreaming: boolean,
): void {
  if (msg.toolCalls?.length) {
    for (const tool of msg.toolCalls) {
      if (isFilteredTool(tool.name)) continue;
      result.push({
        id: `tool-${tool.id}`,
        type: 'tool-call',
        message: msg,
        originalMessageIndex: msgIndex,
        sourceMessageId: msg.id,
        spacingLevel: 2,
        toolCall: tool,
      });
    }
  }

  if (msg.content) {
    result.push({
      id: `text-${msg.id}`,
      type: isStreaming ? 'streaming-text' : 'text-block',
      message: msg,
      originalMessageIndex: msgIndex,
      sourceMessageId: msg.id,
      spacingLevel: 1,
      text: msg.content,
      isStreaming,
    });
  }
}

function getTrailingStreamingText(message: ChatMessage): string {
  if (!message.contentBlocks || message.contentBlocks.length === 0) return '';
  let committedLength = 0;
  for (const block of message.contentBlocks) {
    if (isTextBlock(block)) committedLength += block.text.length;
  }
  if (message.content.length <= committedLength) return '';
  return message.content.slice(committedLength);
}

// One pass owns every timestamp range, so an annotation cannot land in a message gap and in the trailing range both.
function collectAnnotations(
  annotations: TranscriptAnnotations,
  afterTimestamp: number,
  throughTimestamp: number,
  anchor: ChatMessage,
  anchorIndex: number,
): VirtualItem[] {
  const anchoring = {
    message: anchor,
    originalMessageIndex: anchorIndex,
    sourceMessageId: anchor.id,
    spacingLevel: 0 as const,
  };

  const inRange = (timestamp: number): boolean =>
    timestamp > afterTimestamp && timestamp <= throughTimestamp;

  const placed: Array<{ timestamp: number; item: VirtualItem }> = [];

  for (const marker of annotations.markers) {
    const timestamp = getMarkerPositionTimestamp(marker);
    if (!inRange(timestamp)) continue;
    placed.push({
      timestamp,
      item: { id: `marker-${marker.id}`, type: 'compact-marker', ...anchoring, marker },
    });
  }

  for (const notice of annotations.cacheMisses) {
    if (!inRange(notice.timestamp)) continue;
    placed.push({
      timestamp: notice.timestamp,
      item: { id: `cache-miss-${notice.id}`, type: 'cache-miss-notice', ...anchoring, notice },
    });
  }

  for (const abort of annotations.aborts) {
    if (!inRange(abort.timestamp)) continue;
    placed.push({
      timestamp: abort.timestamp,
      item: { id: `compaction-aborted-${abort.id}`, type: 'compaction-aborted-notice', ...anchoring, compactionAborted: abort },
    });
  }

  for (const drop of annotations.drops) {
    if (!inRange(drop.timestamp)) continue;
    placed.push({
      timestamp: drop.timestamp,
      item: { id: `thinking-dropped-${drop.id}`, type: 'thinking-dropped-notice', ...anchoring, thinkingDropped: drop },
    });
  }

  // A gap holds at most a handful of annotations, and the sort is stable, so equal timestamps keep list order.
  placed.sort((a, b) => a.timestamp - b.timestamp);
  return placed.map(entry => entry.item);
}
