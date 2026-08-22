import { computed, type Ref } from 'vue';
import type { ChatMessage, CompactMarker as CompactMarkerType, CacheMissNotice, ToolCall } from '@shared/types/session';
import type { ContentBlock, ImageBlock } from '@shared/types/content';
import type { SubagentState } from '@shared/types/subagents';
import { TASK_MANAGEMENT_TOOLS, TEAM_MANAGEMENT_TOOLS, TOOL_GET_SUBAGENT_RESULT } from '@shared/tool-names';
import { isImageContentBlock } from '@/utils/imageUtils';

export type VirtualItemType =
  | 'user-message'
  | 'compact-marker'
  | 'cache-miss-notice'
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
    TEAM_MANAGEMENT_TOOLS.has(toolName) ||
    toolName === TOOL_GET_SUBAGENT_RESULT
  );
}

function getMarkerPositionTimestamp(marker: CompactMarkerType): number {
  return marker.messageCutoffTimestamp ?? marker.timestamp;
}

export function useVirtualizedMessages(
  messages: Ref<ChatMessage[]>,
  compactMarkers: Ref<CompactMarkerType[] | undefined>,
  cacheMissNotices: Ref<CacheMissNotice[] | undefined>,
  streamingMessageId: Ref<string | null | undefined>,
  _subagents: Ref<Record<string, SubagentState> | undefined>,
) {
  const items = computed<VirtualItem[]>(() => {
    const result: VirtualItem[] = [];
    const msgs = messages.value;
    const markers = compactMarkers.value ?? [];
    const notices = cacheMissNotices.value ?? [];

    for (const [i, msg] of msgs.entries()) {
      const isStreaming = !!streamingMessageId.value && msg.id === streamingMessageId.value;

      const markersBeforeThis = getMarkersBeforeMessage(markers, msgs, msg.timestamp, i);
      for (const marker of markersBeforeThis) {
        result.push({
          id: `marker-${marker.id}`,
          type: 'compact-marker',
          message: msg,
          originalMessageIndex: i,
          sourceMessageId: msg.id,
          spacingLevel: 0,
          marker,
        });
      }

      const noticesBeforeThis = getNoticesBeforeMessage(notices, msgs, msg.timestamp, i);
      for (const notice of noticesBeforeThis) {
        result.push({
          id: `cache-miss-${notice.id}`,
          type: 'cache-miss-notice',
          message: msg,
          originalMessageIndex: i,
          sourceMessageId: msg.id,
          spacingLevel: 0,
          notice,
        });
      }

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

    // Trailing markers outlive the messages they were cut from, so when the list is empty they still
    // need an anchor. The empty id reproduces what consumers already saw and keeps them off undefined.
    const anchor: ChatMessage = msgs[msgs.length - 1] ?? {
      id: '',
      role: 'assistant',
      content: '',
      timestamp: 0,
    };

    const trailingMarkers = getTrailingMarkers(markers, msgs);
    for (const marker of trailingMarkers) {
      result.push({
        id: `marker-${marker.id}`,
        type: 'compact-marker',
        message: anchor,
        originalMessageIndex: msgs.length - 1,
        sourceMessageId: anchor.id,
        spacingLevel: 0,
        marker,
      });
    }

    const trailingNotices = getTrailingNotices(notices, msgs);
    for (const notice of trailingNotices) {
      result.push({
        id: `cache-miss-${notice.id}`,
        type: 'cache-miss-notice',
        message: anchor,
        originalMessageIndex: msgs.length - 1,
        sourceMessageId: anchor.id,
        spacingLevel: 0,
        notice,
      });
    }

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

function getMarkersBeforeMessage(
  markers: CompactMarkerType[],
  messages: ChatMessage[],
  messageTimestamp: number,
  messageIndex: number,
): CompactMarkerType[] {
  if (!markers.length) return [];
  const prevTimestamp = messageIndex > 0 ? messages[messageIndex - 1]?.timestamp ?? 0 : 0;
  return markers.filter(m => {
    const pos = getMarkerPositionTimestamp(m);
    return pos > prevTimestamp && pos <= messageTimestamp;
  });
}

function getTrailingMarkers(markers: CompactMarkerType[], messages: ChatMessage[]): CompactMarkerType[] {
  if (!markers.length) return [];
  const lastMsgTimestamp = messages[messages.length - 1]?.timestamp ?? 0;
  return markers.filter(m => getMarkerPositionTimestamp(m) > lastMsgTimestamp);
}

function getNoticesBeforeMessage(
  notices: CacheMissNotice[],
  messages: ChatMessage[],
  messageTimestamp: number,
  messageIndex: number,
): CacheMissNotice[] {
  if (!notices.length) return [];
  const prevTimestamp = messageIndex > 0 ? messages[messageIndex - 1]?.timestamp ?? 0 : 0;
  return notices.filter(n => n.timestamp > prevTimestamp && n.timestamp <= messageTimestamp);
}

function getTrailingNotices(notices: CacheMissNotice[], messages: ChatMessage[]): CacheMissNotice[] {
  if (!notices.length) return [];
  const lastMsgTimestamp = messages[messages.length - 1]?.timestamp ?? 0;
  return notices.filter(n => n.timestamp > lastMsgTimestamp);
}
