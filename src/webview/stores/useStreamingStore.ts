import { ref, computed } from "vue";
import { defineStore } from "pinia";
import type { ChatMessage, ToolCall, QueuedMessage } from "@shared/types/session";
import type { ContentBlock, ImageBlock, UserContentBlock } from "@shared/types/content";
import type { TerminalAttachmentInfo } from "@shared/types/terminal-attachment";
import { replacesToolStatus, resolveCancelledStatus, TERMINAL_TOOL_STATUSES } from "./tool-cancelled-status";

export interface ToolStatusEntry {
  status: ToolCall["status"];
  result?: string;
  errorMessage?: string;
  feedback?: string;
  durationMs?: number;
  imageCount?: number;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function extractDisplayContent(content: string | UserContentBlock[]): string {
  if (typeof content === "string") return content;
  const textBlocks = content.filter((b): b is { type: "text"; text: string } => b.type === "text");
  const imageCount = content.filter((b) => b.type === "image").length;
  const textContent = textBlocks.map((b) => b.text).join("\n");
  if (imageCount > 0 && !textContent) {
    return `[${imageCount} image${imageCount > 1 ? "s" : ""}]`;
  }
  return textContent;
}

function contentBlocksFromUserContent(content: string | UserContentBlock[]): ContentBlock[] | undefined {
  if (typeof content === "string") return undefined;
  return content;
}

export function buildUserMessage(
  content: string | UserContentBlock[],
  isReplay = false,
  sdkMessageId?: string,
  isInjected?: boolean,
  correlationId?: string,
  promptIndex?: number,
  isMidStream?: boolean,
  isCommandEcho?: boolean,
  terminalAttachments?: readonly TerminalAttachmentInfo[],
  timestamp: number = Date.now(),
): ChatMessage {
  const blocks = contentBlocksFromUserContent(content);
  return {
    id: generateId(),
    ...(sdkMessageId !== undefined && { sdkMessageId }),
    ...(correlationId !== undefined && { correlationId }),
    role: "user",
    content: extractDisplayContent(content),
    ...(blocks !== undefined && { contentBlocks: blocks }),
    ...(terminalAttachments?.length ? { terminalAttachments: [...terminalAttachments] } : {}),
    timestamp,
    isReplay,
    ...(isInjected !== undefined && { isInjected }),
    ...(isCommandEcho === true && { isCommandEcho }),
    ...(isMidStream === true && { isCombinedQueue: true }),
    ...(promptIndex !== undefined && { promptIndex }),
  };
}

export function buildSteerChip(
  message: string,
  steerTarget: ChatMessage['steerTarget'],
  { promptIndex, isReplay = false, images, timestamp = Date.now() }: { promptIndex?: number | undefined; isReplay?: boolean; images?: ImageBlock[] | undefined; timestamp?: number | undefined } = {},
): ChatMessage {
  return {
    id: generateId(),
    role: "user",
    content: message,
    timestamp,
    isReplay,
    isInjected: true,
    ...(images?.length ? { contentBlocks: images } : {}),
    ...(steerTarget !== undefined && { steerTarget }),
    ...(promptIndex !== undefined && { promptIndex }),
  };
}

export function buildMessage(message: Omit<ChatMessage, "id">): ChatMessage {
  return { id: generateId(), ...message };
}

export const useStreamingStore = defineStore("streaming", () => {
  const messages = ref<ChatMessage[]>([]);
  const streamingMessageId = ref<string | null>(null);
  const toolStatusCache = ref<Map<string, ToolStatusEntry>>(new Map());
  const toolMetadataCache = ref<Map<string, Record<string, unknown>>>(new Map());
  const lastStopReason = ref<string | null>(null);

  const streamingMessage = computed<ChatMessage | null>(() => {
    if (!streamingMessageId.value) return null;
    return messages.value.find((m) => m.id === streamingMessageId.value) ?? null;
  });

  function getStreamingMessageIndex(): number {
    if (!streamingMessageId.value) return -1;
    return messages.value.findIndex((m) => m.id === streamingMessageId.value);
  }

  function mergeMessageUpdate(current: ChatMessage, updates: Partial<ChatMessage>): ChatMessage {
    const result = { ...current };

    if (updates.content !== undefined) {
      result.content = updates.content.length >= current.content.length
        ? updates.content : current.content;
    }

    if (updates.thinking !== undefined) {
      const incoming = updates.thinking;
      const existing = current.thinking;
      result.thinking = existing !== undefined && incoming.length < existing.length ? existing : incoming;
    }

    if (updates.contentBlocks !== undefined) {
      const currentBlocks = current.contentBlocks || [];
      const incomingBlocks = updates.contentBlocks || [];

      const base = incomingBlocks.length >= currentBlocks.length ? incomingBlocks : currentBlocks;
      const other = incomingBlocks.length >= currentBlocks.length ? currentBlocks : incomingBlocks;

      const baseToolIds = new Set(
        base.filter(b => b.type === 'tool_use' && 'id' in b).map(b => (b as { id: string }).id)
      );
      const missingToolBlocks = other.filter(
        b => b.type === 'tool_use' && 'id' in b && !baseToolIds.has((b as { id: string }).id)
      );

      result.contentBlocks = missingToolBlocks.length > 0
        ? [...base, ...missingToolBlocks]
        : base;
    }

    if (updates.toolCalls !== undefined) {
      result.toolCalls = mergeToolCalls(current.toolCalls, updates.toolCalls);
    }

    if (updates.isPartial !== undefined) result.isPartial = updates.isPartial;
    if (updates.isThinkingPhase !== undefined) result.isThinkingPhase = updates.isThinkingPhase;
    if (updates.thinkingDuration !== undefined) result.thinkingDuration = updates.thinkingDuration;
    if (updates.sdkMessageId !== undefined) result.sdkMessageId = updates.sdkMessageId;

    return result;
  }

  function updateStreamingMessage(updates: Partial<ChatMessage>, sdkMessageId?: string): void {
    flushReplayQueue();
    let index = -1;
    if (sdkMessageId) {
      index = messages.value.findIndex(m => m.sdkMessageId === sdkMessageId);
    }
    if (index === -1) {
      index = getStreamingMessageIndex();
    }
    if (index === -1) return;

    const current = messages.value[index];
    if (!current) return;
    const merged = mergeMessageUpdate(current, updates);
    const newMessages = [...messages.value];
    newMessages[index] = merged;
    messages.value = newMessages;
  }

  function finalizeStreamingMessage(): ChatMessage | null {
    const msg = streamingMessage.value;
    if (!msg) return null;

    updateStreamingMessage({
      isPartial: false,
      isThinkingPhase: false,
    });

    const finalized = streamingMessage.value;
    streamingMessageId.value = null;

    return finalized;
  }

  function clearQueuedBadges(): void {
    flushReplayQueue();
    const hasQueued = messages.value.some((m) => m.isQueued);
    if (hasQueued) {
      messages.value = messages.value.map((m) => (m.isQueued ? { ...m, isQueued: false } : m));
    }
  }

  function getOrCreateStreamingMessage(sdkMessageId?: string): ChatMessage {
    flushReplayQueue();
    if (sdkMessageId) {
      const existing = messages.value.find(m => m.sdkMessageId === sdkMessageId);
      if (existing) {
        streamingMessageId.value = existing.id;
        return existing;
      }
    }

    if (streamingMessageId.value) {
      const prevIndex = messages.value.findIndex(m => m.id === streamingMessageId.value);
      const prev = prevIndex === -1 ? undefined : messages.value[prevIndex];
      if (prev) {
        if (!sdkMessageId) {
          return prev;
        }

        if (!prev.sdkMessageId) {
          const promoted: ChatMessage = { ...prev, sdkMessageId };
          const newMessages = [...messages.value];
          newMessages[prevIndex] = promoted;
          messages.value = newMessages;
          return promoted;
        }

        const newMessages = [...messages.value];
        newMessages[prevIndex] = { ...prev, isPartial: false, isThinkingPhase: false };
        messages.value = newMessages;
      }
    }

    const newMsg: ChatMessage = {
      id: generateId(),
      ...(sdkMessageId !== undefined && { sdkMessageId }),
      role: "assistant",
      content: "",
      contentBlocks: [],
      timestamp: Date.now(),
      isPartial: true,
      isThinkingPhase: !sdkMessageId,
    };
    messages.value = [...messages.value, newMsg];
    streamingMessageId.value = newMsg.id;
    return newMsg;
  }

  function updateToolStatus(
    toolUseId: string,
    status: ToolCall["status"],
    options?: { result?: string; errorMessage?: string; feedback?: string; durationMs?: number; imageCount?: number }
  ): void {
    flushReplayQueue();
    for (const [i, msg] of messages.value.entries()) {
      if (!msg.toolCalls) continue;
      const toolIndex = msg.toolCalls.findIndex((t) => t.id === toolUseId);
      const target = toolIndex === -1 ? undefined : msg.toolCalls[toolIndex];
      if (!target) continue;

      // Live output is view state for a running call, so the keys are dropped rather than set to
      // undefined, which exactOptionalPropertyTypes rejects.
      const { liveOutput: _clearedOutput, liveOutputTruncated: _clearedTruncated, cancelRequested: _clearedCancel, ...withoutLiveOutput } = target;
      const resolvedStatus = resolveCancelledStatus(status, target.metadata);
      // Not `replacesToolStatus`: a prompt's answer writes an outcome optimistically, and core's own outcome must replace it.
      if (TERMINAL_TOOL_STATUSES.has(target.status) && !TERMINAL_TOOL_STATUSES.has(resolvedStatus)) return;
      const base = TERMINAL_TOOL_STATUSES.has(resolvedStatus) ? withoutLiveOutput : target;

      const updatedToolCalls = [...msg.toolCalls];
      updatedToolCalls[toolIndex] = {
        ...base,
        status: resolvedStatus,
        ...(options?.result !== undefined && { result: options.result }),
        ...(options?.errorMessage !== undefined && { errorMessage: options.errorMessage }),
        ...(options?.feedback !== undefined && { feedback: options.feedback }),
        ...(options?.durationMs !== undefined && { durationMs: options.durationMs }),
        ...(options?.imageCount !== undefined && { imageCount: options.imageCount }),
      };
      const newMessages = [...messages.value];
      newMessages[i] = { ...msg, toolCalls: updatedToolCalls };
      messages.value = newMessages;
      return;
    }
    // Only a status with no call to write it to is cached, so an entry holding a whole tool result is
    // never left behind once the call exists in the transcript.
    const cachedStatus = toolStatusCache.value.get(toolUseId)?.status;
    const resolvedStatus = resolveCancelledStatus(status, toolMetadataCache.value.get(toolUseId));
    if (cachedStatus && TERMINAL_TOOL_STATUSES.has(cachedStatus) && !TERMINAL_TOOL_STATUSES.has(resolvedStatus)) return;
    toolStatusCache.value.set(toolUseId, { status: resolvedStatus, ...options });
  }

  function updateToolMetadata(toolUseId: string, metadata: Record<string, unknown>): void {
    flushReplayQueue();
    for (const [i, msg] of messages.value.entries()) {
      if (!msg.toolCalls) continue;
      const toolIndex = msg.toolCalls.findIndex((t) => t.id === toolUseId);
      const target = toolIndex === -1 ? undefined : msg.toolCalls[toolIndex];
      if (!target) continue;

      const mergedMetadata = { ...target.metadata, ...metadata };
      const updatedToolCalls = [...msg.toolCalls];
      updatedToolCalls[toolIndex] = {
        ...target,
        metadata: mergedMetadata,
        status: resolveCancelledStatus(target.status, mergedMetadata),
      };
      const newMessages = [...messages.value];
      newMessages[i] = { ...msg, toolCalls: updatedToolCalls };
      messages.value = newMessages;
      return;
    }
    toolMetadataCache.value.set(toolUseId, { ...toolMetadataCache.value.get(toolUseId), ...metadata });
  }

  function addToolCall(
    tool: { id: string; name: string; input: Record<string, unknown>; metadata?: Record<string, unknown> },
    contentBlocks?: ContentBlock[],
    sdkMessageId?: string
  ): void {
    const msg = getOrCreateStreamingMessage(sdkMessageId);
    const existingToolCalls = msg.toolCalls || [];

    const existingTool = existingToolCalls.find((t) => t.id === tool.id);
    if (existingTool) {
      if (tool.metadata) {
        updateToolMetadata(tool.id, tool.metadata);
      }
      return;
    }

    if (tool.metadata) {
      toolMetadataCache.value.set(tool.id, { ...toolMetadataCache.value.get(tool.id), ...tool.metadata });
    }

    const cachedStatus = toolStatusCache.value.get(tool.id);
    const cachedMetadata = toolMetadataCache.value.get(tool.id);
    const newToolCall: ToolCall = {
      id: tool.id,
      name: tool.name,
      input: tool.input,
      status: resolveCancelledStatus(cachedStatus?.status ?? "pending", cachedMetadata),
      ...(cachedStatus?.result !== undefined && { result: cachedStatus.result }),
      ...(cachedStatus?.errorMessage !== undefined && { errorMessage: cachedStatus.errorMessage }),
      ...(cachedStatus?.feedback !== undefined && { feedback: cachedStatus.feedback }),
      ...(cachedMetadata !== undefined && { metadata: cachedMetadata }),
      ...(cachedStatus?.durationMs !== undefined && { durationMs: cachedStatus.durationMs }),
      ...(cachedStatus?.imageCount !== undefined && { imageCount: cachedStatus.imageCount }),
    };

    if (cachedStatus) {
      toolStatusCache.value.delete(tool.id);
    }
    if (cachedMetadata) {
      toolMetadataCache.value.delete(tool.id);
    }

    updateStreamingMessage({
      toolCalls: [...existingToolCalls, newToolCall],
      ...(contentBlocks && { contentBlocks }),
      isThinkingPhase: false,
    }, sdkMessageId ?? msg.sdkMessageId);
  }

  function mergeToolCalls(existing: ToolCall[] | undefined, incoming: ToolCall[]): ToolCall[] {
    const merged = new Map<string, ToolCall>();

    for (const tool of existing || []) {
      merged.set(tool.id, tool);
    }

    for (const tool of incoming) {
      const exists = merged.get(tool.id);
      if (!exists) {
        merged.set(tool.id, tool);
      } else if (replacesToolStatus(exists.status, tool.status)) {
        const mergedMetadata = exists.metadata || tool.metadata
          ? { ...exists.metadata, ...tool.metadata }
          : undefined;
        // Resolved here too: an incoming tool rebuilt from a content block carries no metadata of its
        // own, so taking its status verbatim would drop a cancelled card back to completed.
        merged.set(tool.id, {
          ...exists,
          ...tool,
          ...(mergedMetadata !== undefined && { metadata: mergedMetadata }),
          status: resolveCancelledStatus(tool.status, mergedMetadata),
        });
      }
    }

    return Array.from(merged.values());
  }

  function extractTextFromContent(content: ContentBlock[]): string {
    return content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  function extractToolCalls(content: ContentBlock[]): ToolCall[] {
    return content
      .filter((block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => block.type === "tool_use")
      .map((block): ToolCall => {
        const cached = toolStatusCache.value.get(block.id);
        const cachedMetadata = toolMetadataCache.value.get(block.id);
        // The metadata must ride onto the call, not just into this one derivation: a later status write
        // re-derives from `target.metadata`, and a cancelled card with no metadata flips back to completed.
        toolStatusCache.value.delete(block.id);
        toolMetadataCache.value.delete(block.id);
        return {
          id: block.id,
          name: block.name,
          input: block.input,
          status: resolveCancelledStatus(cached?.status ?? "pending", cachedMetadata),
          ...(cached?.result !== undefined && { result: cached.result }),
          ...(cached?.errorMessage !== undefined && { errorMessage: cached.errorMessage }),
          ...(cached?.feedback !== undefined && { feedback: cached.feedback }),
          ...(cached?.durationMs !== undefined && { durationMs: cached.durationMs }),
          ...(cached?.imageCount !== undefined && { imageCount: cached.imageCount }),
          ...(cachedMetadata !== undefined && { metadata: cachedMetadata }),
        };
      });
  }

  function extractThinkingContent(content: ContentBlock[]): string | undefined {
    const thinkingBlocks = content.filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking");
    if (thinkingBlocks.length === 0) return undefined;
    return thinkingBlocks.map((block) => block.thinking).join("\n\n");
  }

  function addUserMessage(
    content: string | UserContentBlock[],
    isReplay = false,
    sdkMessageId?: string,
    isInjected?: boolean,
    correlationId?: string,
    promptIndex?: number,
    isMidStream?: boolean,
    isCommandEcho?: boolean,
    terminalAttachments?: readonly TerminalAttachmentInfo[],
  ): ChatMessage {
    flushReplayQueue();
    const msg = buildUserMessage(content, isReplay, sdkMessageId, isInjected, correlationId, promptIndex, isMidStream, isCommandEcho, terminalAttachments);
    messages.value = [...messages.value, msg];
    return msg;
  }

  function addErrorMessage(error: string): ChatMessage {
    flushReplayQueue();
    const msg: ChatMessage = {
      id: generateId(),
      role: "error",
      content: error,
      timestamp: Date.now(),
    };
    messages.value = [...messages.value, msg];
    return msg;
  }

  function addSteerChip(
    message: string,
    steerTarget: ChatMessage['steerTarget'],
    options: { promptIndex?: number | undefined; isReplay?: boolean; images?: ImageBlock[] | undefined } = {},
  ): ChatMessage {
    flushReplayQueue();
    const msg = buildSteerChip(message, steerTarget, options);
    messages.value = [...messages.value, msg];
    return msg;
  }

  function addRefusalMessage(
    explanation: string | null,
    category: 'cyber' | 'bio' | null,
  ): ChatMessage {
    flushReplayQueue();
    const msg: ChatMessage = {
      id: generateId(),
      role: "refusal",
      content: explanation ?? '',
      refusalExplanation: explanation,
      refusalCategory: category,
      timestamp: Date.now(),
    };
    messages.value = [...messages.value, msg];
    return msg;
  }

  function prependMessages(olderMessages: ChatMessage[]): void {
    flushReplayQueue();
    messages.value = [...olderMessages, ...messages.value];
  }

  function truncateFromSdkMessageId(sdkMessageId: string): string | null {
    flushReplayQueue();
    const index = messages.value.findIndex((m) => m.sdkMessageId === sdkMessageId);

    if (index === -1) {
      console.warn("[useStreamingStore] Could not find message with SDK ID for truncation:", sdkMessageId);
      return null;
    }
    const removedMessage = messages.value[index];
    if (!removedMessage) return null;
    const content = removedMessage.content;
    messages.value = messages.value.slice(0, index);
    streamingMessageId.value = null;
    return content;
  }

  function removeMessageByCorrelationId(correlationId: string): string | null {
    flushReplayQueue();
    const index = messages.value.findIndex((m) => m.correlationId === correlationId);
    if (index === -1) return null;

    const removedMessage = messages.value[index];
    if (!removedMessage) return null;
    messages.value = messages.value.filter((_, i) => i !== index);
    return removedMessage.content;
  }

  function addMessage(message: Omit<ChatMessage, "id">): ChatMessage {
    flushReplayQueue();
    const msg = buildMessage(message);
    messages.value = [...messages.value, msg];
    return msg;
  }

  // Replay items land in one batch per frame. Every writer of `messages` flushes this queue first.
  let replayQueue: ChatMessage[] = [];
  let replayFrame: number | null = null;

  function queueReplayMessage(msg: ChatMessage): void {
    replayQueue.push(msg);
    replayFrame ??= requestAnimationFrame(() => {
      replayFrame = null;
      flushReplayQueue();
    });
  }

  function flushReplayQueue(): void {
    if (replayFrame !== null) {
      cancelAnimationFrame(replayFrame);
      replayFrame = null;
    }
    if (replayQueue.length === 0) return;
    const queued = replayQueue;
    replayQueue = [];
    messages.value = [...messages.value, ...queued];
  }

  function assignSdkIdByCorrelationId(correlationId: string, sdkMessageId: string): void {
    flushReplayQueue();
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const msg = messages.value[i];
      if (msg && msg.correlationId === correlationId) {
        if (msg.sdkMessageId !== sdkMessageId) {
          const newMessages = [...messages.value];
          newMessages[i] = { ...msg, sdkMessageId };
          messages.value = newMessages;
        }
        return;
      }
    }
  }

  function assignSdkIdToFlushedMessage(queueMessageIds: string[], sdkMessageId: string): void {
    flushReplayQueue();
    if (queueMessageIds.length === 0) return;
    const primaryId = queueMessageIds[0];
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const msg = messages.value[i];
      if (msg && msg.id === primaryId) {
        if (msg.sdkMessageId !== sdkMessageId) {
          const newMessages = [...messages.value];
          newMessages[i] = { ...msg, sdkMessageId };
          messages.value = newMessages;
        }
        return;
      }
    }
  }

  function addQueuedMessage(message: QueuedMessage): void {
    flushReplayQueue();
    const blocks = contentBlocksFromUserContent(message.content);
    const chatMessage: ChatMessage = {
      id: message.id,
      sdkMessageId: message.id,
      role: "user",
      content: extractDisplayContent(message.content),
      ...(blocks !== undefined && { contentBlocks: blocks }),
      timestamp: message.timestamp,
      isQueued: true,
      isInjected: true,
    };
    messages.value = [...messages.value, chatMessage];
  }

  function markQueueProcessed(messageId: string): void {
    flushReplayQueue();
    const index = messages.value.findIndex((m) => m.id === messageId);
    const msg = index === -1 ? undefined : messages.value[index];
    if (msg) {
      const newMessages = messages.value.filter((_, i) => i !== index);
      newMessages.push({ ...msg, isQueued: false });
      messages.value = newMessages;
    }
  }

  /** `messageId` names a queued chip, or by its correlation id the echo of a prompt pi queued into the running run. */
  function removeQueuedMessage(messageId: string): ChatMessage | undefined {
    flushReplayQueue();
    const removed = messages.value.find((m) => m.id === messageId || m.correlationId === messageId);
    messages.value = messages.value.filter((m) => m !== removed);
    return removed;
  }

  function combineQueuedMessages(messageIds: string[], combinedContent: string, contentBlocks?: UserContentBlock[]): void {
    flushReplayQueue();
    const combinedId = messageIds[0];
    if (combinedId === undefined) return;

    const idsSet = new Set(messageIds);
    const firstQueued = messages.value.find((m) => idsSet.has(m.id));

    const combinedMessage: ChatMessage = {
      id: combinedId,
      role: "user",
      content: combinedContent,
      ...(contentBlocks !== undefined && { contentBlocks }),
      timestamp: firstQueued?.timestamp ?? Date.now(),
      isCombinedQueue: true,
    };
    messages.value = [...messages.value.filter((m) => !idsSet.has(m.id)), combinedMessage];
  }

  function truncateMessagesBeforeTimestamp(cutoffTimestamp: number): void {
    flushReplayQueue();
    messages.value = messages.value.filter(msg => msg.timestamp > cutoffTimestamp);
    if (streamingMessageId.value) {
      const stillExists = messages.value.some(m => m.id === streamingMessageId.value);
      if (!stillExists) {
        streamingMessageId.value = null;
      }
    }
  }

  function setLastStopReason(reason: string | null) {
    lastStopReason.value = reason;
  }

  function updateToolElapsedTime(toolUseId: string, elapsedSeconds: number): void {
    patchToolCall(toolUseId, { elapsedTimeSeconds: elapsedSeconds });
  }

  function updateToolLiveOutput(toolUseId: string, output: string, truncated: boolean): void {
    patchToolCall(toolUseId, { liveOutput: output, liveOutputTruncated: truncated });
  }

  function markToolCancelRequested(toolUseId: string): void {
    patchToolCall(toolUseId, { cancelRequested: true });
  }

  function clearToolCancelRequested(toolUseId: string): void {
    flushReplayQueue();
    for (const [i, msg] of messages.value.entries()) {
      if (!msg.toolCalls) continue;
      const toolIndex = msg.toolCalls.findIndex((t) => t.id === toolUseId);
      const target = toolIndex === -1 ? undefined : msg.toolCalls[toolIndex];
      if (!target) continue;

      // The key is dropped rather than set to undefined, which exactOptionalPropertyTypes rejects.
      const { cancelRequested: _clearedCancel, ...withoutCancel } = target;
      const updatedToolCalls = [...msg.toolCalls];
      updatedToolCalls[toolIndex] = withoutCancel;
      const newMessages = [...messages.value];
      newMessages[i] = { ...msg, toolCalls: updatedToolCalls };
      messages.value = newMessages;
      return;
    }
  }

  function updateToolSummary(toolUseIds: string[], summary: string): void {
    const lastId = toolUseIds[toolUseIds.length - 1];
    if (lastId === undefined) return;
    patchToolCall(lastId, { summary });
  }

  /** Replaces the first tool call matching `toolUseId` with a patched copy, rebuilding the owning
   *  message so the ref identity changes and dependent computeds re-evaluate. */
  function patchToolCall(toolUseId: string, patch: Partial<ToolCall>): void {
    flushReplayQueue();
    for (const [i, msg] of messages.value.entries()) {
      if (!msg.toolCalls) continue;
      const toolIndex = msg.toolCalls.findIndex((t) => t.id === toolUseId);
      const target = toolIndex === -1 ? undefined : msg.toolCalls[toolIndex];
      if (!target) continue;

      const updatedToolCalls = [...msg.toolCalls];
      updatedToolCalls[toolIndex] = { ...target, ...patch };
      const newMessages = [...messages.value];
      newMessages[i] = { ...msg, toolCalls: updatedToolCalls };
      messages.value = newMessages;
      return;
    }
  }

  function $reset() {
    if (replayFrame !== null) cancelAnimationFrame(replayFrame);
    replayFrame = null;
    replayQueue = [];
    messages.value = [];
    streamingMessageId.value = null;
    toolStatusCache.value = new Map();
    toolMetadataCache.value = new Map();
    lastStopReason.value = null;
  }

  return {
    messages,
    streamingMessage,
    streamingMessageId,
    toolStatusCache,
    toolMetadataCache,
    generateId,
    getStreamingMessageIndex,
    updateStreamingMessage,
    finalizeStreamingMessage,
    clearQueuedBadges,
    getOrCreateStreamingMessage,
    updateToolStatus,
    updateToolMetadata,
    addToolCall,
    mergeToolCalls,
    extractTextFromContent,
    extractToolCalls,
    extractThinkingContent,
    addUserMessage,
    addErrorMessage,
    addSteerChip,
    addRefusalMessage,
    prependMessages,
    addMessage,
    queueReplayMessage,
    flushReplayQueue,
    truncateFromSdkMessageId,
    removeMessageByCorrelationId,
    assignSdkIdByCorrelationId,
    assignSdkIdToFlushedMessage,
    addQueuedMessage,
    markQueueProcessed,
    removeQueuedMessage,
    combineQueuedMessages,
    truncateMessagesBeforeTimestamp,
    lastStopReason,
    setLastStopReason,
    updateToolElapsedTime,
    updateToolLiveOutput,
    markToolCancelRequested,
    clearToolCancelRequested,
    updateToolSummary,
    $reset,
  };
});
