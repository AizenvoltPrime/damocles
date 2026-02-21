import { log } from '../../../logger';
import type { ProcessorDependencies, MessageProcessor } from '../types';

interface ToolProgressMessage {
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  task_id?: string;
}

interface ToolUseSummaryMessage {
  summary: string;
  preceding_tool_use_ids: string[];
}

export function createToolEventsProcessors(_deps: ProcessorDependencies): Record<string, MessageProcessor> {
  return {
    tool_progress: (message, ctx) => {
      const msg = message as unknown as ToolProgressMessage;
      log('[StreamingManager] Tool progress: tool=%s, id=%s, elapsed=%ds',
        msg.tool_name, msg.tool_use_id, msg.elapsed_time_seconds);

      ctx.deps.callbacks.onMessage({
        type: 'toolProgress',
        toolUseId: msg.tool_use_id,
        toolName: msg.tool_name,
        parentToolUseId: msg.parent_tool_use_id,
        elapsedTimeSeconds: msg.elapsed_time_seconds,
        ...(msg.task_id !== undefined ? { taskId: msg.task_id } : {}),
      });
    },

    tool_use_summary: (message, ctx) => {
      const msg = message as unknown as ToolUseSummaryMessage;
      log('[StreamingManager] Tool use summary for %d tools: %s',
        msg.preceding_tool_use_ids.length, msg.summary?.slice(0, 100));

      ctx.deps.callbacks.onMessage({
        type: 'toolUseSummary',
        summary: msg.summary,
        precedingToolUseIds: msg.preceding_tool_use_ids,
      });
    },
  };
}
