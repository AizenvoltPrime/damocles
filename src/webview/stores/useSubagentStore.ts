import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { SubagentState, SubagentResult } from '@shared/types/subagents';
import type { HistoryAgentMessage, HistoryToolCall, ContentBlock, ToolUseBlock, TextBlock, ThinkingBlock } from '@shared/types/content';

export interface StreamingSubagentMessage {
  sdkMessageId: string;
  content: string;
  thinking?: string;
  thinkingDuration?: number;
  isThinkingPhase: boolean;
}

type ToolStatus = { status: ToolCall['status']; result?: string; errorMessage?: string };

// Status priority for preventing downgrades (higher = more final)
const STATUS_PRIORITY: Record<ToolCall['status'], number> = {
  'pending': 0,
  'abandoned': 0,
  'awaiting_approval': 1,
  'approved': 2,
  'running': 3,
  'denied': 4,
  'failed': 4,
  'completed': 5,
};

function extractLastTextFromMessages(agentMessages?: HistoryAgentMessage[]): string {
  if (!agentMessages || agentMessages.length === 0) return '';
  for (const msg of [...agentMessages].reverse()) {
    const texts = msg.contentBlocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && 'text' in b)
      .map(b => b.text);
    if (texts.length > 0) return texts.join('\n');
  }
  return '';
}

function buildChatMessagesFromHistory(
  agentMessages: HistoryAgentMessage[],
  idPrefix: string,
  startTime: number,
  existingToolStatuses?: Map<string, ToolStatus>
): ChatMessage[] {
  return agentMessages.map((msg, idx) => {
    const contentBlocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of msg.contentBlocks) {
      if (block.type === 'thinking') {
        contentBlocks.push({ type: 'thinking', thinking: block.thinking } as ThinkingBlock);
      } else if (block.type === 'text') {
        contentBlocks.push({ type: 'text', text: block.text } as TextBlock);
      } else if (block.type === 'tool_use') {
        contentBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input } as ToolUseBlock);
        const existing = existingToolStatuses?.get(block.id);
        const result = existing?.result ?? block.result;
        const errorMessage = existing?.errorMessage ?? (block.isError ? block.result : undefined);
        // On resume-from-disk there is no live status, so derive failed/completed from the persisted
        // isError flag, otherwise a failed nested tool would rehydrate as succeeded.
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input,
          status: existing?.status ?? (block.isError ? 'failed' : 'completed'),
          ...(result !== undefined && { result }),
          ...(errorMessage !== undefined && { errorMessage }),
          ...(block.metadata !== undefined && { metadata: block.metadata }),
        });
      }
    }

    return {
      id: `${idPrefix}-msg-${idx}`,
      role: msg.role,
      content: '',
      contentBlocks,
      ...(toolCalls.length > 0 && { toolCalls }),
      timestamp: startTime + idx,
    };
  });
}

/**
 * A subagent's transcript leads with its own prompt as a user message (the mapper keeps it because it
 * also feeds the on-disk transcript). The overlay already surfaces the prompt in its "View prompt"
 * collapsible, so drop the duplicated leading user message here. Drop by role, not text-equality —
 * robust to any IDE-context prefix the mapper merges into the leading user text.
 */
function stripLeadingUserMessage(messages: ChatMessage[]): ChatMessage[] {
  return messages[0]?.role === 'user' ? messages.slice(1) : messages;
}

export const useSubagentStore = defineStore('subagent', () => {
  const subagents = ref<Record<string, SubagentState>>({});
  const expandedSubagentId = ref<string | null>(null);
  const streamingMessages = ref<Record<string, StreamingSubagentMessage>>({});

  const expandedSubagent = computed((): SubagentState | undefined => {
    if (!expandedSubagentId.value) return undefined;
    return subagents.value[expandedSubagentId.value];
  });

  function registerAgentTool(
    toolId: string,
    input: { description?: string; prompt?: string; subagent_type?: string; run_in_background?: boolean }
  ): void {
    if (toolId in subagents.value) return;

    const subagentType = (input.subagent_type as string) || 'general-purpose';
    const description = (input.description as string) || subagentType;

    subagents.value = {
      ...subagents.value,
      [toolId]: {
        id: toolId,
        agentType: subagentType,
        description,
        prompt: (input.prompt as string) || '',
        status: 'running',
        startTime: Date.now(),
        messages: [],
        toolCalls: [],
        messagesSealed: false,
        isBackground: input.run_in_background === true,
      },
    };
  }

  function startSubagent(sdkAgentId: string, _agentType: string, toolUseId?: string, isBackground?: boolean): void {
    if (!toolUseId) return;

    const subagent = subagents.value[toolUseId];
    if (!subagent) return;
    // The card's `isBackground` was first derived from the Agent call's params; the extension now sends
    // the resolved flag (which folds in the template's `run_in_background` default), so correct it here.
    subagents.value = {
      ...subagents.value,
      [toolUseId]: {
        ...subagent,
        sdkAgentId: subagent.sdkAgentId ?? sdkAgentId,
        ...(isBackground !== undefined ? { isBackground } : {}),
      },
    };
  }

  function stopSubagent(toolUseId: string | undefined, sdkAgentId: string, lastAssistantMessage?: string): void {
    if (!lastAssistantMessage) return;

    const key = toolUseId && subagents.value[toolUseId] ? toolUseId : null;

    const fallbackKey = key ? null : Object.keys(subagents.value).find(
      k => subagents.value[k]?.sdkAgentId === sdkAgentId
    );

    const targetKey = key || fallbackKey;
    if (!targetKey) return;

    const subagent = subagents.value[targetKey];
    if (!subagent) return;
    subagents.value = {
      ...subagents.value,
      [targetKey]: { ...subagent, lastAssistantMessage },
    };
  }

  function resetToRunning(toolId: string, description?: string, isBackground?: boolean): void {
    const subagent = subagents.value[toolId];
    if (!subagent) return;
    // The stale end time is dropped, not set to undefined, so a later spread cannot resurrect it.
    const { endTime: _clearedEndTime, ...withoutEndTime } = subagent;
    subagents.value = {
      ...subagents.value,
      [toolId]: {
        ...withoutEndTime,
        status: 'running',
        isBackground: !!isBackground,
        ...(description ? { description } : {}),
      },
    };
  }

  function completeSubagent(agentToolId: string): void {
    const subagent = subagents.value[agentToolId];
    if (subagent && subagent.status === 'running') {
      subagents.value = {
        ...subagents.value,
        [agentToolId]: {
          ...subagent,
          status: 'completed',
          endTime: Date.now(),
        },
      };
    }
  }

  function failSubagent(agentToolId: string): void {
    const subagent = subagents.value[agentToolId];
    if (subagent && subagent.status === 'running') {
      subagents.value = {
        ...subagents.value,
        [agentToolId]: {
          ...subagent,
          status: 'failed',
          endTime: Date.now(),
        },
      };
    }
  }

  function cancelRunningSubagents(): void {
    const entries = Object.entries(subagents.value);
    if (entries.length === 0) return;

    const now = Date.now();
    const updated: Record<string, SubagentState> = {};
    let hasChanges = false;

    for (const [id, subagent] of entries) {
      if (subagent.status === 'running') {
        updated[id] = { ...subagent, status: 'cancelled', endTime: now };
        hasChanges = true;
      } else {
        updated[id] = subagent;
      }
    }

    if (hasChanges) {
      subagents.value = updated;
      streamingMessages.value = {};
    }
  }

  function setSubagentResult(agentToolId: string, result: SubagentResult): void {
    const subagent = subagents.value[agentToolId];
    if (subagent) {
      subagents.value = {
        ...subagents.value,
        [agentToolId]: {
          ...subagent,
          result,
          ...(result.sdkAgentId ? { sdkAgentId: result.sdkAgentId } : {}),
          ...(subagent.status === 'running' ? { status: 'completed' as const, endTime: Date.now() } : {}),
        },
      };
    }
  }

  function addMessageToSubagent(parentToolUseId: string, message: ChatMessage): void {
    const subagent = subagents.value[parentToolUseId];
    if (subagent) {
      if (subagent.messagesSealed) return;
      const { [parentToolUseId]: _, ...restStreaming } = streamingMessages.value;
      streamingMessages.value = restStreaming;

      const finalizedToolIds = new Set(
        (message.contentBlocks || [])
          .filter((b): b is ToolUseBlock => b.type === 'tool_use')
          .map(b => b.id)
      );
      const remainingToolCalls = finalizedToolIds.size > 0
        ? subagent.toolCalls.filter(t => !finalizedToolIds.has(t.id))
        : subagent.toolCalls;

      subagents.value = {
        ...subagents.value,
        [parentToolUseId]: {
          ...subagent,
          messages: [...subagent.messages, message],
          toolCalls: remainingToolCalls,
        },
      };
    }
  }

  function addUserMessageToSubagent(toolUseId: string, message: string): void {
    const subagent = subagents.value[toolUseId];
    if (!subagent || subagent.messagesSealed) return;

    const userMessage: ChatMessage = {
      // Random suffix so two steers to the same subagent within one millisecond can't collide as v-for keys.
      id: `${toolUseId}-steer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };

    subagents.value = {
      ...subagents.value,
      [toolUseId]: {
        ...subagent,
        messages: [...subagent.messages, userMessage],
      },
    };
  }

  function updateSubagentStreaming(
    parentToolUseId: string,
    sdkMessageId: string,
    updates: {
      content?: string;
      thinking?: string;
      thinkingDuration?: number;
      isThinkingPhase?: boolean;
    }
  ): void {
    const target = subagents.value[parentToolUseId];
    if (!target || target.messagesSealed) return;

    const existing = streamingMessages.value[parentToolUseId];
    if (!existing || existing.sdkMessageId !== sdkMessageId) {
      streamingMessages.value = {
        ...streamingMessages.value,
        [parentToolUseId]: {
          sdkMessageId,
          content: updates.content ?? '',
          ...(updates.thinking !== undefined && { thinking: updates.thinking }),
          ...(updates.thinkingDuration !== undefined && { thinkingDuration: updates.thinkingDuration }),
          isThinkingPhase: updates.isThinkingPhase ?? true,
        },
      };
    } else {
      streamingMessages.value = {
        ...streamingMessages.value,
        [parentToolUseId]: {
          ...existing,
          ...(updates.content !== undefined && { content: updates.content }),
          ...(updates.thinking !== undefined && { thinking: updates.thinking }),
          ...(updates.thinkingDuration !== undefined && { thinkingDuration: updates.thinkingDuration }),
          ...(updates.isThinkingPhase !== undefined && { isThinkingPhase: updates.isThinkingPhase }),
        },
      };
    }
  }

  function getSubagentStreaming(parentToolUseId: string): StreamingSubagentMessage | undefined {
    return streamingMessages.value[parentToolUseId];
  }

  function addToolCallToSubagent(parentToolUseId: string, tool: ToolCall): void {
    const subagent = subagents.value[parentToolUseId];
    if (!subagent) return;
    if (subagent.messagesSealed) return;

    const existsInToolCalls = subagent.toolCalls.some(t => t.id === tool.id);
    if (existsInToolCalls) return;

    const existsInMessages = subagent.messages.some(msg => msg.toolCalls?.some(t => t.id === tool.id));
    if (existsInMessages) return;

    subagents.value = {
      ...subagents.value,
      [parentToolUseId]: {
        ...subagent,
        toolCalls: [...subagent.toolCalls, tool],
      },
    };
  }

  function updateSubagentToolStatus(
    toolUseId: string,
    status: ToolCall['status'],
    result?: string,
    errorMessage?: string,
    durationMs?: number
  ): boolean {
    const newPriority = STATUS_PRIORITY[status] ?? 0;

    const patch: Partial<ToolCall> = {
      status,
      ...(result !== undefined && { result }),
      ...(errorMessage !== undefined && { errorMessage }),
      ...(durationMs !== undefined && { durationMs }),
    };

    for (const [subagentId, subagent] of Object.entries(subagents.value)) {
      const toolIndex = subagent.toolCalls.findIndex(t => t.id === toolUseId);
      const directTool = toolIndex === -1 ? undefined : subagent.toolCalls[toolIndex];
      if (directTool) {
        if (newPriority < (STATUS_PRIORITY[directTool.status] ?? 0)) return true;

        const updatedToolCalls = [...subagent.toolCalls];
        updatedToolCalls[toolIndex] = { ...directTool, ...patch };
        subagents.value = {
          ...subagents.value,
          [subagentId]: {
            ...subagent,
            toolCalls: updatedToolCalls,
          },
        };
        return true;
      }

      for (const [msgIdx, msg] of subagent.messages.entries()) {
        if (!msg.toolCalls) continue;
        const msgToolIndex = msg.toolCalls.findIndex(t => t.id === toolUseId);
        const nestedTool = msgToolIndex === -1 ? undefined : msg.toolCalls[msgToolIndex];
        if (!nestedTool) continue;

        if (newPriority < (STATUS_PRIORITY[nestedTool.status] ?? 0)) return true;

        const updatedMsgToolCalls = [...msg.toolCalls];
        updatedMsgToolCalls[msgToolIndex] = { ...nestedTool, ...patch };
        const updatedMessages = [...subagent.messages];
        updatedMessages[msgIdx] = { ...msg, toolCalls: updatedMsgToolCalls };
        subagents.value = {
          ...subagents.value,
          [subagentId]: {
            ...subagent,
            messages: updatedMessages,
          },
        };
        return true;
      }
    }
    return false;
  }

  function updateSubagentToolMetadata(
    toolUseId: string,
    metadata: Record<string, unknown>
  ): boolean {
    for (const [subagentId, subagent] of Object.entries(subagents.value)) {
      const toolIndex = subagent.toolCalls.findIndex(t => t.id === toolUseId);
      const directTool = toolIndex === -1 ? undefined : subagent.toolCalls[toolIndex];
      if (directTool) {
        const updatedToolCalls = [...subagent.toolCalls];
        updatedToolCalls[toolIndex] = {
          ...directTool,
          metadata: { ...directTool.metadata, ...metadata },
        };
        subagents.value = {
          ...subagents.value,
          [subagentId]: {
            ...subagent,
            toolCalls: updatedToolCalls,
          },
        };
        return true;
      }

      for (const [msgIdx, msg] of subagent.messages.entries()) {
        if (!msg.toolCalls) continue;
        const msgToolIndex = msg.toolCalls.findIndex(t => t.id === toolUseId);
        const nestedTool = msgToolIndex === -1 ? undefined : msg.toolCalls[msgToolIndex];
        if (!nestedTool) continue;

        const updatedMsgToolCalls = [...msg.toolCalls];
        updatedMsgToolCalls[msgToolIndex] = {
          ...nestedTool,
          metadata: { ...nestedTool.metadata, ...metadata },
        };
        const updatedMessages = [...subagent.messages];
        updatedMessages[msgIdx] = { ...msg, toolCalls: updatedMsgToolCalls };
        subagents.value = {
          ...subagents.value,
          [subagentId]: {
            ...subagent,
            messages: updatedMessages,
          },
        };
        return true;
      }
    }
    return false;
  }

  function getSubagent(id: string): SubagentState | undefined {
    return subagents.value[id];
  }

  function hasSubagent(id: string): boolean {
    return id in subagents.value;
  }

  function getSubagentDescription(id: string): string | undefined {
    return subagents.value[id]?.description;
  }

  function getToolCallWithStatus(parentToolUseId: string, toolId: string): ToolCall | undefined {
    return subagents.value[parentToolUseId]?.toolCalls.find(t => t.id === toolId);
  }

  function buildToolCallsWithStatus(parentToolUseId: string, contentBlocks: ContentBlock[]): ToolCall[] {
    const subagent = subagents.value[parentToolUseId];
    if (!subagent) return [];

    return contentBlocks
      .filter((b): b is ToolUseBlock => b.type === 'tool_use')
      .map((block): ToolCall => {
        const existing = subagent.toolCalls.find(t => t.id === block.id);
        return {
          id: block.id,
          name: block.name,
          input: block.input,
          status: existing?.status ?? 'completed',
          ...(existing?.result !== undefined && { result: existing.result }),
          ...(existing?.errorMessage !== undefined && { errorMessage: existing.errorMessage }),
          ...(existing?.metadata !== undefined && { metadata: existing.metadata }),
        };
      });
  }

  function expandSubagent(id: string): void {
    expandedSubagentId.value = id;
  }

  function collapseSubagent(): void {
    expandedSubagentId.value = null;
  }

  function restoreSubagentFromHistory(tool: HistoryToolCall): void {
    if (tool.id in subagents.value) return;

    const description = (tool.input.description as string) || '';
    const prompt = (tool.input.prompt as string) || '';
    const subagentType = (tool.input.subagent_type as string) || 'general-purpose';

    const isBackground = Boolean(tool.input.run_in_background);
    // Prefer the transcript's persisted terminal status (e.g. user-stopped → cancelled). Fall back to the
    // old presence heuristic only for legacy transcripts that predate the status entry.
    const status: SubagentState['status'] = tool.agentStatus
      ? tool.agentStatus === 'error'
        ? 'failed'
        : tool.agentStatus === 'stopped'
          ? 'cancelled'
          : 'completed'
      : tool.result
        ? 'completed'
        : 'cancelled';

    // The transcript's persisted final text is authoritative; a background spawn's tool.result is only the
    // async-launch ack, so prefer agentResultText, then the parsed sync result, then the last message.
    let result: SubagentResult | undefined;
    if (tool.agentResultText !== undefined || tool.result) {
      let parsed: { content?: Array<{ type: string; text?: string }>; totalDurationMs?: number; totalTokens?: number; totalToolUseCount?: number; agentId?: string } = {};
      if (tool.result) {
        try {
          parsed = JSON.parse(tool.result);
        } catch {
          console.warn('[useSubagentStore] Failed to parse Task tool result from history');
        }
      }
      let contentText = tool.agentResultText?.trim() ? tool.agentResultText : '';
      if (!contentText) {
        contentText = parsed.content
          ?.filter(item => item.type === 'text' && item.text)
          .map(item => item.text)
          .join('\n') || '';
      }
      if (!contentText) contentText = extractLastTextFromMessages(tool.agentMessages);
      const totalToolUseCount = parsed.totalToolUseCount ?? tool.agentToolCount;
      const resultAgentId = tool.sdkAgentId || parsed.agentId;
      result = {
        content: contentText,
        ...(parsed.totalDurationMs !== undefined && { totalDurationMs: parsed.totalDurationMs }),
        ...(parsed.totalTokens !== undefined && { totalTokens: parsed.totalTokens }),
        ...(totalToolUseCount !== undefined && { totalToolUseCount }),
        ...(resultAgentId !== undefined && { sdkAgentId: resultAgentId }),
      };
    }

    const restoredAgentId = tool.sdkAgentId || result?.sdkAgentId;
    const startTime = tool.agentStartTimestamp ?? Date.now();
    const endTime = tool.agentEndTimestamp ?? Date.now();
    const messages = stripLeadingUserMessage(buildChatMessagesFromHistory(tool.agentMessages || [], tool.id, startTime));

    subagents.value = {
      ...subagents.value,
      [tool.id]: {
        id: tool.id,
        agentType: subagentType,
        description: description || subagentType,
        prompt,
        status,
        startTime,
        endTime,
        messages,
        toolCalls: [],
        ...(result !== undefined && { result }),
        ...(tool.agentModel !== undefined && { model: tool.agentModel }),
        ...(tool.agentTemplatePath !== undefined && { templatePath: tool.agentTemplatePath }),
        ...(restoredAgentId !== undefined && { sdkAgentId: restoredAgentId }),
        messagesSealed: false,
        ...(isBackground ? { isBackground: true } : {}),
      },
    };
  }

  function updateProgressSummary(agentToolId: string, summary: string): void {
    const subagent = subagents.value[agentToolId];
    if (subagent && subagent.status === 'running') {
      subagents.value = {
        ...subagents.value,
        [agentToolId]: {
          ...subagent,
          progressSummary: summary,
        },
      };
    }
  }

  function updateSubagentModel(agentToolId: string, model: string): void {
    const subagent = subagents.value[agentToolId];
    if (subagent) {
      subagents.value = {
        ...subagents.value,
        [agentToolId]: {
          ...subagent,
          model,
        },
      };
    }
  }

  function updateSubagentTemplate(agentToolId: string, templatePath: string): void {
    const subagent = subagents.value[agentToolId];
    if (subagent) {
      subagents.value = {
        ...subagents.value,
        [agentToolId]: {
          ...subagent,
          templatePath,
        },
      };
    }
  }

  function replaceSubagentMessages(agentToolId: string, agentMessages: HistoryAgentMessage[]): void {
    const subagent = subagents.value[agentToolId];
    if (!subagent) return;

    const existingToolStatuses = new Map<string, ToolStatus>();
    const rememberStatus = (tc: ToolCall): void => {
      existingToolStatuses.set(tc.id, {
        status: tc.status,
        ...(tc.result !== undefined && { result: tc.result }),
        ...(tc.errorMessage !== undefined && { errorMessage: tc.errorMessage }),
      });
    };
    for (const tc of subagent.toolCalls) rememberStatus(tc);
    for (const msg of subagent.messages) {
      for (const tc of msg.toolCalls ?? []) rememberStatus(tc);
    }

    const messages = stripLeadingUserMessage(
      buildChatMessagesFromHistory(agentMessages, agentToolId, subagent.startTime, existingToolStatuses),
    );

    const { [agentToolId]: _, ...restStreaming } = streamingMessages.value;
    streamingMessages.value = restStreaming;

    subagents.value = {
      ...subagents.value,
      [agentToolId]: {
        ...subagent,
        messages,
        toolCalls: [],
        messagesSealed: true,
      },
    };
  }

  function $reset() {
    subagents.value = {};
    streamingMessages.value = {};
    expandedSubagentId.value = null;
  }

  return {
    subagents,
    expandedSubagentId,
    expandedSubagent,
    streamingMessages,

    registerAgentTool,
    resetToRunning,
    startSubagent,
    stopSubagent,
    completeSubagent,
    failSubagent,
    cancelRunningSubagents,
    setSubagentResult,
    addMessageToSubagent,
    addUserMessageToSubagent,
    updateSubagentStreaming,
    getSubagentStreaming,
    addToolCallToSubagent,
    updateSubagentToolStatus,
    updateSubagentToolMetadata,
    getSubagent,
    hasSubagent,
    getSubagentDescription,
    getToolCallWithStatus,
    buildToolCallsWithStatus,
    expandSubagent,
    collapseSubagent,
    restoreSubagentFromHistory,
    updateProgressSummary,
    updateSubagentModel,
    updateSubagentTemplate,
    replaceSubagentMessages,
    $reset,
  };
});
