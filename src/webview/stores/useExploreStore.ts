import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { HistoryAgentMessage, ContentBlock, ToolUseBlock, TextBlock, ThinkingBlock } from '@shared/types/content';
import type { SubagentState, SubagentResult } from '@shared/types/subagents';
import { useSubagentStore } from './useSubagentStore';

export interface ExploreEntry {
  toolUseId: string;
  model: string;
  prompt: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  startTime: number;
  endTime?: number;
  toolCount: number;
  elapsed: number;
  result: string | null;
  lastToolName?: string;
  messages: ChatMessage[];
}

function buildChatMessagesFromExplore(
  agentMessages: HistoryAgentMessage[],
  idPrefix: string,
  startTime: number,
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
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input,
          status: 'completed',
          ...(block.result !== undefined && { result: block.result }),
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

export const useExploreStore = defineStore('explore', () => {
  const explores = ref<Record<string, ExploreEntry>>({});

  function handleExploreStarted(data: {
    toolUseId: string;
    model: string;
    prompt: string;
    description: string;
    startTime: number;
  }): void {
    explores.value = {
      ...explores.value,
      [data.toolUseId]: {
        toolUseId: data.toolUseId,
        model: data.model,
        prompt: data.prompt,
        description: data.description,
        status: 'running',
        startTime: data.startTime,
        toolCount: 0,
        elapsed: 0,
        result: null,
        messages: [],
      },
    };
  }

  function handleExploreToolCall(data: {
    toolUseId: string;
    toolName: string;
  }): void {
    const explore = explores.value[data.toolUseId];
    if (!explore) return;
    explores.value = {
      ...explores.value,
      [data.toolUseId]: {
        ...explore,
        toolCount: explore.toolCount + 1,
        lastToolName: data.toolName,
      },
    };
  }

  function handleExploreCompleted(data: {
    toolUseId: string;
    status: 'completed' | 'failed';
    result: string | null;
    elapsed: number;
    toolCount: number;
    model: string;
  }): void {
    const explore = explores.value[data.toolUseId];
    if (!explore) return;
    const endTime = explore.startTime + data.elapsed;
    explores.value = {
      ...explores.value,
      [data.toolUseId]: {
        ...explore,
        status: data.status,
        result: data.result,
        elapsed: data.elapsed,
        toolCount: data.toolCount,
        endTime,
        model: data.model,
      },
    };

    const subagentStore = useSubagentStore();
    const subagent = subagentStore.subagents[data.toolUseId];
    if (subagent) {
      const resultText = data.result?.trim() ?? '';
      const resultObj: SubagentResult | undefined = resultText.length > 0
        ? { content: resultText, totalToolUseCount: data.toolCount }
        : undefined;
      subagentStore.subagents = {
        ...subagentStore.subagents,
        [data.toolUseId]: {
          ...subagent,
          status: data.status,
          endTime,
          ...(resultObj ? { result: resultObj } : {}),
          messagesSealed: true,
        },
      };
    }
  }

  function handleExploreMessagesUpdate(data: {
    toolUseId: string;
    messages: HistoryAgentMessage[];
  }): void {
    const explore = explores.value[data.toolUseId];
    if (!explore) return;
    const chatMessages = buildChatMessagesFromExplore(data.messages, data.toolUseId, explore.startTime);
    explores.value = {
      ...explores.value,
      [data.toolUseId]: {
        ...explore,
        messages: chatMessages,
      },
    };

    const subagentStore = useSubagentStore();
    const subagent = subagentStore.subagents[data.toolUseId];
    if (subagent) {
      subagentStore.subagents = {
        ...subagentStore.subagents,
        [data.toolUseId]: {
          ...subagent,
          messages: chatMessages,
        },
      };
    }
  }

  function hasExplore(toolUseId: string): boolean {
    return toolUseId in explores.value;
  }

  function expandExplore(toolUseId: string): void {
    const explore = explores.value[toolUseId];
    if (!explore) return;

    const subagentStore = useSubagentStore();
    const existing = subagentStore.subagents[toolUseId];
    const isTerminal = explore.status === 'completed' || explore.status === 'failed';
    const resultText = explore.result?.trim() ?? '';
    const result: SubagentResult | undefined = isTerminal && resultText.length > 0
      ? { content: resultText, totalToolUseCount: explore.toolCount }
      : undefined;

    const next: SubagentState = {
      id: toolUseId,
      agentType: 'Explore',
      description: explore.description,
      prompt: explore.prompt,
      status: explore.status,
      startTime: explore.startTime,
      ...(isTerminal && explore.endTime !== undefined ? { endTime: explore.endTime } : {}),
      messages: explore.messages,
      toolCalls: existing?.toolCalls ?? [],
      ...(result ? { result } : {}),
      ...(explore.model ? { model: explore.model } : {}),
      sdkAgentId: toolUseId,
      messagesSealed: isTerminal,
    };

    subagentStore.subagents = { ...subagentStore.subagents, [toolUseId]: next };
    subagentStore.expandSubagent(toolUseId);
  }

  function $reset(): void {
    explores.value = {};
  }

  return {
    explores,
    handleExploreStarted,
    handleExploreToolCall,
    handleExploreCompleted,
    handleExploreMessagesUpdate,
    hasExplore,
    expandExplore,
    $reset,
  };
});
