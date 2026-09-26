import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { SubagentState, SubagentResult } from '@shared/types/subagents';
import type { AgentUsageTotals } from '@shared/usage-accounting';
import type { HistoryAgentMessage, HistoryToolCall, ContentBlock, ImageBlock, ToolUseBlock, TextBlock, ThinkingBlock } from '@shared/types/content';
import { resolveCancelledStatus, TERMINAL_TOOL_STATUSES } from './tool-cancelled-status';

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
  'awaiting_approval': 1,
  'approved': 2,
  'running': 3,
  // Strictly over every live status and strictly under every recorded outcome: a real result replaces
  // it, a spinner never does.
  'unrecorded': 4,
  // Terminal, so it must outrank every live status; least informative of the terminal ones, so a
  // recorded result may still replace it.
  'abandoned': 5,
  'denied': 5,
  'failed': 5,
  'completed': 6,
  'cancelled': 6,
};

/** The card heading: a resume card names the agent it continues until the agent's own details arrive. */
export function subagentHeading(
  subagent: SubagentState,
  t: (key: string, params: Record<string, unknown>) => string,
): { title: string; resumed: boolean } {
  if (subagent.resume && !subagent.resume.loaded) {
    return { title: t('subagentDisplay.resuming', { id: subagent.resume.agentId.slice(0, 8) }), resumed: false };
  }
  return { title: subagent.description, resumed: subagent.resume !== undefined };
}

export type EndedSubagentStatus = Exclude<SubagentState['status'], 'running'>;

/** The card status for an agent's terminal status; the live completion and the reload both read it. */
export function endedSubagentStatus(agentStatus: string): EndedSubagentStatus {
  if (agentStatus === 'error') return 'failed';
  return agentStatus === 'stopped' || agentStatus === 'interrupted' ? 'cancelled' : 'completed';
}

function restoredSubagentStatus(tool: HistoryToolCall): SubagentState['status'] {
  // A refused call ran no agent, and a refused resume writes no invocation entry to carry a status.
  if (tool.isError) return 'failed';
  // Transcripts that predate the persisted status offer only the presence of a result.
  if (!tool.agentStatus) return tool.result ? 'completed' : 'cancelled';
  return endedSubagentStatus(tool.agentStatus);
}

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
      } else if (block.type === 'image') {
        contentBlocks.push(block);
      } else if (block.type === 'tool_use') {
        contentBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input } as ToolUseBlock);
        const existing = existingToolStatuses?.get(block.id);
        const result = existing?.result ?? block.result;
        const errorMessage = existing?.errorMessage ?? (block.isError ? block.result : undefined);
        // Both callers hand this a transcript whose run is over, so a block with no recorded result
        // never reached an outcome and a tracked pre-terminal status would spin for the session's life.
        const recorded: ToolCall['status'] = block.isError
          ? 'failed'
          : block.result === undefined ? 'unrecorded' : 'completed';
        const tracked = existing?.status;
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input,
          status: resolveCancelledStatus(
            tracked !== undefined && TERMINAL_TOOL_STATUSES.has(tracked) ? tracked : recorded,
            block.metadata,
          ),
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
    input: { description?: string; prompt?: string; subagent_type?: string; run_in_background?: boolean; resume?: string; message?: string }
  ): void {
    if (toolId in subagents.value) return;

    const resumedFrom = typeof input.resume === 'string' ? input.resume : undefined;
    const known = resumedFrom !== undefined ? cardWithDetails(resumedFrom) : undefined;
    const agentType = input.subagent_type || known?.agentType;
    const description = input.description || known?.description || agentType || '';

    subagents.value = {
      ...subagents.value,
      [toolId]: {
        id: toolId,
        ...(agentType !== undefined ? { agentType } : {}),
        description,
        prompt: (resumedFrom !== undefined ? input.message : input.prompt) || '',
        status: 'running',
        startTime: Date.now(),
        messages: [],
        toolCalls: [],
        messagesSealed: false,
        isBackground: input.run_in_background === true,
        ...(resumedFrom !== undefined ? { resume: { agentId: resumedFrom, loaded: known !== undefined } } : {}),
      },
    };
  }

  /** A card already showing this agent's own type and description: its spawn card or a loaded resume card. */
  function cardWithDetails(sdkAgentId: string): SubagentState | undefined {
    return Object.values(subagents.value).find(
      s => s.sdkAgentId === sdkAgentId && s.agentType !== undefined && (!s.resume || s.resume.loaded),
    );
  }

  function startSubagent(
    sdkAgentId: string,
    agentType: string,
    toolUseId?: string,
    isBackground?: boolean,
    details?: { description?: string; resumedFrom?: string },
  ): void {
    if (!toolUseId) return;

    const subagent = subagents.value[toolUseId];
    if (!subagent) return;
    // A resume call's arguments name only the agent, so its type and description arrive here.
    const resumed = details?.resumedFrom !== undefined
      ? {
          agentType,
          description: details.description || subagent.description || agentType,
          resume: { agentId: details.resumedFrom, loaded: true },
        }
      : {};
    // The card's `isBackground` was first derived from the Agent call's params; the extension now sends
    // the resolved flag (which folds in the template's `run_in_background` default), so correct it here.
    subagents.value = {
      ...subagents.value,
      [toolUseId]: {
        ...subagent,
        ...resumed,
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

  function endSubagent(agentToolId: string, status: EndedSubagentStatus): void {
    const subagent = subagents.value[agentToolId];
    if (subagent && subagent.status === 'running') {
      subagents.value = {
        ...subagents.value,
        [agentToolId]: {
          ...subagent,
          status,
          endTime: Date.now(),
        },
      };
    }
  }

  function completeSubagent(agentToolId: string): void {
    endSubagent(agentToolId, 'completed');
  }

  function failSubagent(agentToolId: string): void {
    endSubagent(agentToolId, 'failed');
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

  function addUserMessageToSubagent(toolUseId: string, message: string, images?: ImageBlock[]): void {
    const subagent = subagents.value[toolUseId];
    if (!subagent || subagent.messagesSealed) return;

    const userMessage: ChatMessage = {
      // Random suffix so two steers to the same subagent within one millisecond can't collide as v-for keys.
      id: `${toolUseId}-steer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role: 'user',
      content: message,
      ...(images?.length ? { contentBlocks: images } : {}),
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

    // Live output is view state for a running call, so the keys are dropped rather than set to
    // undefined, which exactOptionalPropertyTypes rejects.
    const applyStatus = (tool: ToolCall): ToolCall => {
      const resolved = resolveCancelledStatus(status, tool.metadata);
      const { liveOutput: _clearedOutput, liveOutputTruncated: _clearedTruncated, cancelRequested: _clearedCancel, ...withoutLiveOutput } = tool;
      const base = TERMINAL_TOOL_STATUSES.has(resolved) ? withoutLiveOutput : tool;
      return {
        ...base,
        status: resolved,
        ...(result !== undefined && { result }),
        ...(errorMessage !== undefined && { errorMessage }),
        ...(durationMs !== undefined && { durationMs }),
      };
    };

    for (const [subagentId, subagent] of Object.entries(subagents.value)) {
      const toolIndex = subagent.toolCalls.findIndex(t => t.id === toolUseId);
      const directTool = toolIndex === -1 ? undefined : subagent.toolCalls[toolIndex];
      if (directTool) {
        if (newPriority < (STATUS_PRIORITY[directTool.status] ?? 0)) return true;

        const updatedToolCalls = [...subagent.toolCalls];
        updatedToolCalls[toolIndex] = applyStatus(directTool);
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
        updatedMsgToolCalls[msgToolIndex] = applyStatus(nestedTool);
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

  /** Replaces the first tool call matching `toolUseId`, in an agent's live list or in one of its
   *  messages, with whatever `replace` returns. Returning a rebuilt call is how a key gets dropped. */
  function replaceSubagentTool(toolUseId: string, replace: (tool: ToolCall) => ToolCall): boolean {
    for (const [subagentId, subagent] of Object.entries(subagents.value)) {
      const toolIndex = subagent.toolCalls.findIndex(t => t.id === toolUseId);
      const directTool = toolIndex === -1 ? undefined : subagent.toolCalls[toolIndex];
      if (directTool) {
        const updatedToolCalls = [...subagent.toolCalls];
        updatedToolCalls[toolIndex] = replace(directTool);
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
        updatedMsgToolCalls[msgToolIndex] = replace(nestedTool);
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

  /** `patch` reads the target because a metadata patch merges onto it. */
  function patchSubagentTool(toolUseId: string, patch: (tool: ToolCall) => Partial<ToolCall>): boolean {
    return replaceSubagentTool(toolUseId, tool => ({ ...tool, ...patch(tool) }));
  }

  function updateSubagentToolMetadata(
    toolUseId: string,
    metadata: Record<string, unknown>
  ): boolean {
    return patchSubagentTool(toolUseId, tool => {
      const merged = { ...tool.metadata, ...metadata };
      return { metadata: merged, status: resolveCancelledStatus(tool.status, merged) };
    });
  }

  function updateSubagentToolLiveOutput(toolUseId: string, output: string, truncated: boolean): boolean {
    return patchSubagentTool(toolUseId, () => ({ liveOutput: output, liveOutputTruncated: truncated }));
  }

  function markSubagentToolCancelRequested(toolUseId: string): boolean {
    return patchSubagentTool(toolUseId, () => ({ cancelRequested: true }));
  }

  function clearSubagentToolCancelRequested(toolUseId: string): boolean {
    return replaceSubagentTool(toolUseId, tool => {
      // The key is dropped rather than set to undefined, which exactOptionalPropertyTypes rejects.
      const { cancelRequested: _clearedCancel, ...withoutCancel } = tool;
      return withoutCancel;
    });
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
        // pi seals the assistant message before it starts the tool, so an untracked block has not run
        // yet and any terminal default here is a green check on a tool that is about to execute.
        return {
          id: block.id,
          name: block.name,
          input: block.input,
          status: resolveCancelledStatus(existing?.status ?? 'pending', existing?.metadata),
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

    const launch = tool.agentLaunch;
    const resumedFrom = tool.agentResumedFrom ?? (typeof tool.input.resume === 'string' ? tool.input.resume : undefined);
    const known = launch === undefined && resumedFrom !== undefined ? cardWithDetails(resumedFrom) : undefined;
    const description = launch?.description ?? known?.description ?? ((tool.input.description as string) || '');
    const prompt = resumedFrom !== undefined ? (tool.input.message as string) || '' : (tool.input.prompt as string) || '';
    const subagentType = launch?.agentType ?? known?.agentType ?? ((tool.input.subagent_type as string) || undefined);

    const isBackground = launch?.background ?? Boolean(tool.input.run_in_background);
    const status = restoredSubagentStatus(tool);

    // The transcript's persisted final text is authoritative; a background spawn's tool.result is only the
    // async-launch ack, so prefer agentResultText, then the parsed sync result, then the last message.
    // An errored call's result is the refusal, which the live card never shows as the agent's result.
    let result: SubagentResult | undefined;
    if (!tool.isError && (tool.agentResultText !== undefined || tool.result)) {
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
        ...(subagentType !== undefined ? { agentType: subagentType } : {}),
        description: description || subagentType || '',
        prompt,
        status,
        startTime,
        endTime,
        messages,
        toolCalls: [],
        ...(result !== undefined && { result }),
        ...(tool.agentModel !== undefined && { model: tool.agentModel }),
        ...(tool.agentTemplatePath !== undefined && { templatePath: tool.agentTemplatePath }),
        ...(tool.agentUsage !== undefined && { usage: tool.agentUsage }),
        ...(tool.agentDollarBilled !== undefined && { dollarBilled: tool.agentDollarBilled }),
        ...(restoredAgentId !== undefined && { sdkAgentId: restoredAgentId }),
        messagesSealed: false,
        ...(isBackground ? { isBackground: true } : {}),
        ...(resumedFrom !== undefined ? { resume: { agentId: resumedFrom, loaded: launch !== undefined || known !== undefined } } : {}),
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

  function updateSubagentUsage(agentToolId: string, usage: AgentUsageTotals, dollarBilled?: boolean): void {
    const subagent = subagents.value[agentToolId];
    if (!subagent) return;
    subagents.value = {
      ...subagents.value,
      [agentToolId]: { ...subagent, usage, ...(dollarBilled !== undefined && { dollarBilled }) },
    };
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
    endSubagent,
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
    updateSubagentToolLiveOutput,
    markSubagentToolCancelRequested,
    clearSubagentToolCancelRequested,
    getSubagent,
    hasSubagent,
    getSubagentDescription,
    cardWithDetails,
    getToolCallWithStatus,
    buildToolCallsWithStatus,
    expandSubagent,
    collapseSubagent,
    restoreSubagentFromHistory,
    updateProgressSummary,
    updateSubagentModel,
    updateSubagentTemplate,
    updateSubagentUsage,
    replaceSubagentMessages,
    $reset,
  };
});
