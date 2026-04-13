import { computed, type Ref } from 'vue';
import type { ChatMessage, CompactMarker as CompactMarkerType, ToolCall } from '@shared/types/session';
import type { ContentBlock, ImageBlock } from '@shared/types/content';
import type { SubagentState } from '@shared/types/subagents';
import { TOOL_AGENT, TASK_MANAGEMENT_TOOLS, TEAM_MANAGEMENT_TOOLS, TEAM_CREATE_TOOL } from '@shared/tool-names';

export type VirtualItemType =
  | 'user-message'
  | 'compact-marker'
  | 'thinking-block'
  | 'text-block'
  | 'tool-call'
  | 'error-message'
  | 'streaming-text'
  | 'background-label';

export interface VirtualItem {
  id: string;
  type: VirtualItemType;
  message: ChatMessage;
  originalMessageIndex: number;
  sourceMessageId: string;
  text?: string;
  toolCall?: ToolCall;
  marker?: CompactMarkerType;
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

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === 'image';
}

function isFilteredTool(toolName: string): boolean {
  return TASK_MANAGEMENT_TOOLS.has(toolName) || TEAM_MANAGEMENT_TOOLS.has(toolName) || toolName === TEAM_CREATE_TOOL;
}

function getMarkerPositionTimestamp(marker: CompactMarkerType): number {
  return marker.messageCutoffTimestamp ?? marker.timestamp;
}

export function useVirtualizedMessages(
  messages: Ref<ChatMessage[]>,
  compactMarkers: Ref<CompactMarkerType[] | undefined>,
  streamingMessageId: Ref<string | null | undefined>,
  subagents: Ref<Record<string, SubagentState> | undefined>,
) {
  const items = computed<VirtualItem[]>(() => {
    const result: VirtualItem[] = [];
    const msgs = messages.value;
    const markers = compactMarkers.value ?? [];

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      const isStreaming = !!streamingMessageId.value && msg.id === streamingMessageId.value;

      const markersBeforeThis = getMarkersBeforeMessage(markers, msgs, msg.timestamp, i);
      for (const marker of markersBeforeThis) {
        result.push({
          id: `marker-${marker.id}`,
          type: 'compact-marker',
          message: msg,
          originalMessageIndex: i,
          sourceMessageId: msg.id,
          marker,
        });
      }

      if (msg.role === 'user') {
        const imageBlocks = msg.contentBlocks?.filter(isImageBlock) as ImageBlock[] | undefined;
        result.push({
          id: `user-${msg.id}`,
          type: 'user-message',
          message: msg,
          originalMessageIndex: i,
          sourceMessageId: msg.id,
          text: msg.content,
          imageBlocks: imageBlocks?.length ? imageBlocks : undefined,
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
          text: msg.backgroundTaskLabel,
        });
      }

      if (msg.thinking || msg.thinkingContent || msg.isPartial || msg.thinkingDuration) {
        result.push({
          id: `thinking-${msg.id}`,
          type: 'thinking-block',
          message: msg,
          originalMessageIndex: i,
          sourceMessageId: msg.id,
        });
      }

      if (msg.contentBlocks && msg.contentBlocks.length > 0) {
        flattenContentBlocks(result, msg, i, isStreaming);
      } else {
        flattenFallback(result, msg, i, isStreaming);
      }
    }

    const trailingMarkers = getTrailingMarkers(markers, msgs);
    const dummyMsg = msgs.length > 0 ? msgs[msgs.length - 1] : ({} as ChatMessage);
    for (const marker of trailingMarkers) {
      result.push({
        id: `marker-${marker.id}`,
        type: 'compact-marker',
        message: dummyMsg,
        originalMessageIndex: msgs.length - 1,
        sourceMessageId: dummyMsg.id ?? '',
        marker,
      });
    }

    return result;
  });

  return { items };
}

function flattenContentBlocks(
  result: VirtualItem[],
  msg: ChatMessage,
  msgIndex: number,
  isStreaming: boolean,
): void {
  const blocks = msg.contentBlocks!;

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (isTextBlock(block)) {
      result.push({
        id: `text-${msg.id}-${bi}`,
        type: 'text-block',
        message: msg,
        originalMessageIndex: msgIndex,
        sourceMessageId: msg.id,
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
  const lastMsgTimestamp = messages.length > 0 ? messages[messages.length - 1].timestamp : 0;
  return markers.filter(m => getMarkerPositionTimestamp(m) > lastMsgTimestamp);
}
