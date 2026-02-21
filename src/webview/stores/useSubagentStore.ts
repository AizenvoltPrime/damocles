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
  'abandoned': 0,
  'awaiting_approval': 1,
  'approved': 2,
  'running': 3,
  'denied': 4,
  'failed': 4,
  'completed': 5,
};

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
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input,
          status: existing?.status ?? 'completed',
          result: existing?.result ?? block.result,
          errorMessage: existing?.errorMessage,
          metadata: block.metadata,
        });
      }
    }

    return {
      id: `${idPrefix}-msg-${idx}`,
      role: msg.role,
      content: '',
      contentBlocks,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      timestamp: startTime + idx,
    };
  });
}

export const useSubagentStore = defineStore('subagent', () => {
  const subagents = ref<Record<string, SubagentState>>({});
  const expandedSubagentId = ref<string | null>(null);
  const streamingMessages = ref<Record<string, StreamingSubagentMessage>>({});

  const expandedSubagent = computed((): SubagentState | undefined => {
    if (!expandedSubagentId.value) return undefined;
    return subagents.value[expandedSubagentId.value];
  });

  function registerTaskTool(
    toolId: string,
    input: { description?: string; prompt?: string; subagent_type?: string }
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
      },
    };
  }

  function startSubagent(sdkAgentId: string, _agentType: string, toolUseId?: string): void {
    if (!toolUseId) return;

    const subagent = subagents.value[toolUseId];
    if (subagent && !subagent.sdkAgentId) {
      subagents.value = {
        ...subagents.value,
        [toolUseId]: {
          ...subagent,
          sdkAgentId,
        },
      };
    }
  }

  function stopSubagent(toolUseId: string | undefined, sdkAgentId: string, lastAssistantMessage?: string): void {
    if (!lastAssistantMessage) return;

    const key = toolUseId && subagents.value[toolUseId] ? toolUseId : null;

    const fallbackKey = key ? null : Object.keys(subagents.value).find(
      k => subagents.value[k].sdkAgentId === sdkAgentId
    );

    const targetKey = key || fallbackKey;
    if (!targetKey) return;

    const subagent = subagents.value[targetKey];
    subagents.value = {
      ...subagents.value,
      [targetKey]: { ...subagent, lastAssistantMessage },
    };
  }

  function completeSubagent(taskToolId: string): void {
    const subagent = subagents.value[taskToolId];
    if (subagent && subagent.status === 'running') {
      subagents.value = {
        ...subagents.value,
        [taskToolId]: {
          ...subagent,
          status: 'completed',
          endTime: Date.now(),
        },
      };
    }
  }

  function failSubagent(taskToolId: string): void {
    const subagent = subagents.value[taskToolId];
    if (subagent && subagent.status === 'running') {
      subagents.value = {
        ...subagents.value,
        [taskToolId]: {
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

  function setSubagentResult(taskToolId: string, result: SubagentResult): void {
    const subagent = subagents.value[taskToolId];
    if (subagent) {
      subagents.value = {
        ...subagents.value,
        [taskToolId]: {
          ...subagent,
          result,
          sdkAgentId: result.sdkAgentId || subagent.sdkAgentId,
          status: subagent.status === 'running' ? 'completed' : subagent.status,
          endTime: subagent.status === 'running' ? Date.now() : subagent.endTime,
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
    if (!(parentToolUseId in subagents.value)) return;
    if (subagents.value[parentToolUseId].messagesSealed) return;

    const existing = streamingMessages.value[parentToolUseId];
    if (!existing || existing.sdkMessageId !== sdkMessageId) {
      streamingMessages.value = {
        ...streamingMessages.value,
        [parentToolUseId]: {
          sdkMessageId,
          content: updates.content ?? '',
          thinking: updates.thinking,
          thinkingDuration: updates.thinkingDuration,
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
    errorMessage?: string
  ): boolean {
    const newPriority = STATUS_PRIORITY[status] ?? 0;

    for (const [subagentId, subagent] of Object.entries(subagents.value)) {
      const toolIndex = subagent.toolCalls.findIndex(t => t.id === toolUseId);
      if (toolIndex !== -1) {
        const oldPriority = STATUS_PRIORITY[subagent.toolCalls[toolIndex].status] ?? 0;
        if (newPriority < oldPriority) return true;

        const updatedToolCalls = [...subagent.toolCalls];
        updatedToolCalls[toolIndex] = {
          ...updatedToolCalls[toolIndex],
          status,
          ...(result !== undefined && { result }),
          ...(errorMessage !== undefined && { errorMessage }),
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

      for (let msgIdx = 0; msgIdx < subagent.messages.length; msgIdx++) {
        const msg = subagent.messages[msgIdx];
        if (msg.toolCalls) {
          const msgToolIndex = msg.toolCalls.findIndex(t => t.id === toolUseId);
          if (msgToolIndex !== -1) {
            const oldPriority = STATUS_PRIORITY[msg.toolCalls[msgToolIndex].status] ?? 0;
            if (newPriority < oldPriority) return true;

            const updatedMsgToolCalls = [...msg.toolCalls];
            updatedMsgToolCalls[msgToolIndex] = {
              ...updatedMsgToolCalls[msgToolIndex],
              status,
              ...(result !== undefined && { result }),
              ...(errorMessage !== undefined && { errorMessage }),
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
      if (toolIndex !== -1) {
        const updatedToolCalls = [...subagent.toolCalls];
        updatedToolCalls[toolIndex] = {
          ...updatedToolCalls[toolIndex],
          metadata: { ...updatedToolCalls[toolIndex].metadata, ...metadata },
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

      for (let msgIdx = 0; msgIdx < subagent.messages.length; msgIdx++) {
        const msg = subagent.messages[msgIdx];
        if (msg.toolCalls) {
          const msgToolIndex = msg.toolCalls.findIndex(t => t.id === toolUseId);
          if (msgToolIndex !== -1) {
            const updatedMsgToolCalls = [...msg.toolCalls];
            updatedMsgToolCalls[msgToolIndex] = {
              ...updatedMsgToolCalls[msgToolIndex],
              metadata: { ...updatedMsgToolCalls[msgToolIndex].metadata, ...metadata },
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
      .map(block => {
        const existing = subagent.toolCalls.find(t => t.id === block.id);
        return {
          id: block.id,
          name: block.name,
          input: block.input,
          status: existing?.status ?? 'completed',
          result: existing?.result,
          errorMessage: existing?.errorMessage,
          metadata: existing?.metadata,
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

    let result: SubagentResult | undefined;
    const hasCompleted = Boolean(tool.result);

    if (tool.result) {
      try {
        const parsed = JSON.parse(tool.result);
        const contentItems = parsed.content as Array<{ type: string; text?: string }> | undefined;
        const contentText = contentItems
          ?.filter(item => item.type === 'text' && item.text)
          .map(item => item.text)
          .join('\n') || '';
        result = {
          content: contentText,
          totalDurationMs: parsed.totalDurationMs,
          totalTokens: parsed.totalTokens,
          totalToolUseCount: parsed.totalToolUseCount ?? tool.agentToolCount,
          sdkAgentId: tool.sdkAgentId || parsed.agentId,
        };
      } catch {
        console.warn('[useSubagentStore] Failed to parse Task tool result from history');
      }
    }

    const startTime = tool.agentStartTimestamp ?? Date.now();
    const endTime = tool.agentEndTimestamp ?? Date.now();
    const messages = buildChatMessagesFromHistory(tool.agentMessages || [], tool.id, startTime);

    subagents.value = {
      ...subagents.value,
      [tool.id]: {
        id: tool.id,
        agentType: subagentType,
        description: description || subagentType,
        prompt,
        status: hasCompleted ? 'completed' : 'cancelled',
        startTime,
        endTime,
        messages,
        toolCalls: [],
        result,
        model: tool.agentModel,
        sdkAgentId: tool.sdkAgentId || result?.sdkAgentId,
        messagesSealed: false,
      },
    };
  }

  function updateSubagentModel(taskToolId: string, model: string): void {
    const subagent = subagents.value[taskToolId];
    if (subagent) {
      subagents.value = {
        ...subagents.value,
        [taskToolId]: {
          ...subagent,
          model,
        },
      };
    }
  }

  function replaceSubagentMessages(taskToolId: string, agentMessages: HistoryAgentMessage[]): void {
    const subagent = subagents.value[taskToolId];
    if (!subagent) return;

    const existingToolStatuses = new Map<string, ToolStatus>();
    for (const tc of subagent.toolCalls) {
      existingToolStatuses.set(tc.id, { status: tc.status, result: tc.result, errorMessage: tc.errorMessage });
    }
    for (const msg of subagent.messages) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          existingToolStatuses.set(tc.id, { status: tc.status, result: tc.result, errorMessage: tc.errorMessage });
        }
      }
    }

    const messages = buildChatMessagesFromHistory(agentMessages, taskToolId, subagent.startTime, existingToolStatuses);

    const { [taskToolId]: _, ...restStreaming } = streamingMessages.value;
    streamingMessages.value = restStreaming;

    subagents.value = {
      ...subagents.value,
      [taskToolId]: {
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

    registerTaskTool,
    startSubagent,
    stopSubagent,
    completeSubagent,
    failSubagent,
    cancelRunningSubagents,
    setSubagentResult,
    addMessageToSubagent,
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
    updateSubagentModel,
    replaceSubagentMessages,
    $reset,
  };
});
