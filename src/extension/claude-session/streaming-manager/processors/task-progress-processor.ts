import { log } from '../../../logger';
import type { ProcessorDependencies, MessageProcessor } from '../types';

interface TaskProgressMessage {
  task_id: string;
  tool_use_id?: string;
  description: string;
  summary?: string;
  last_tool_name?: string;
  usage: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
}

export function createTaskProgressProcessor(deps: ProcessorDependencies): Record<string, MessageProcessor> {
  return {
    'system:task_progress': (message, ctx) => {
      const msg = message as unknown as TaskProgressMessage;
      log('[StreamingManager] Task progress: id=%s, summary=%s',
        msg.task_id, msg.summary ?? 'none');

      ctx.deps.callbacks.onMessage({
        type: 'taskProgress',
        taskId: msg.task_id,
        ...(msg.tool_use_id !== undefined ? { toolUseId: msg.tool_use_id } : {}),
        description: msg.description,
        ...(msg.summary !== undefined ? { summary: msg.summary } : {}),
        ...(msg.last_tool_name !== undefined ? { lastToolName: msg.last_tool_name } : {}),
        ...(msg.usage !== undefined ? {
          usage: {
            totalTokens: msg.usage.total_tokens,
            toolUses: msg.usage.tool_uses,
            durationMs: msg.usage.duration_ms,
          },
        } : {}),
      });

      if (deps.toolManager.isBackgroundTask(msg.task_id)) {
        ctx.deps.callbacks.onMessage({
          type: 'backgroundTaskProgress',
          taskId: msg.task_id,
          progressSummary: msg.summary ?? msg.description,
          ...(msg.last_tool_name !== undefined ? { lastToolName: msg.last_tool_name } : {}),
          ...(msg.usage !== undefined ? {
            usage: {
              totalTokens: msg.usage.total_tokens,
              toolUses: msg.usage.tool_uses,
              durationMs: msg.usage.duration_ms,
            },
          } : {}),
        });
      }
    },
  };
}
