import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import { TOOL_AGENT } from '@shared/tool-names';
import { TERMINAL_TOOL_STATUSES } from '@/stores/tool-cancelled-status';
import { USER_PROMPT_FILTER } from '@/composables/useEnrichedPrompts';

function newestLiveIn(calls: readonly ToolCall[] | undefined): ToolCall | null {
  if (!calls) return null;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!;
    if (!TERMINAL_TOOL_STATUSES.has(call.status)) return call;
  }
  return null;
}

// Stops at the prompt that opened the turn: a `terminate` batch leaves its other calls pending on the page that watched it.
function currentTurnLiveCall(messages: readonly ChatMessage[]): ToolCall | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!;
    if (USER_PROMPT_FILTER(message)) return null;
    const call = newestLiveIn(message.toolCalls);
    if (call) return call;
  }
  return null;
}

function newestSubagentLiveCall(subagent: SubagentState): ToolCall | null {
  const direct = newestLiveIn(subagent.toolCalls);
  if (direct) return direct;
  for (let m = subagent.messages.length - 1; m >= 0; m--) {
    const call = newestLiveIn(subagent.messages[m]!.toolCalls);
    if (call) return call;
  }
  return null;
}

/**
 * The tool the status bar names: the current turn's newest main-chat call that has not ended, or, while that is an Agent call,
 * its subagent's newest such call when it has one. Read from the cards, so a view that rebuilt them names what a watching view does.
 */
export function runningToolName(messages: readonly ChatMessage[], subagentOf: (toolUseId: string) => SubagentState | undefined): string | null {
  const call = currentTurnLiveCall(messages);
  if (!call) return null;
  if (call.name !== TOOL_AGENT) return call.name;
  const subagent = subagentOf(call.id);
  return (subagent && newestSubagentLiveCall(subagent)?.name) ?? call.name;
}
