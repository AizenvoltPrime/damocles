import { log } from '../../../logger';
import type { ProcessorDependencies, MessageProcessor } from '../types';

interface TaskStartedMessage {
  task_id: string;
  tool_use_id?: string;
  description: string;
  task_type?: string;
}

interface TaskNotificationMessage {
  task_id: string;
  tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string | null;
  summary: string;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
}

export function createTaskLifecycleProcessors(_deps: ProcessorDependencies): Record<string, MessageProcessor> {
  return {
    'system:task_started': (message, ctx) => {
      const msg = message as unknown as TaskStartedMessage;
      log('[StreamingManager] Task started: id=%s, toolUseId=%s, desc=%s',
        msg.task_id, msg.tool_use_id ?? 'none', msg.description);

      ctx.deps.callbacks.onMessage({
        type: 'taskStarted',
        taskId: msg.task_id,
        ...(msg.tool_use_id !== undefined ? { toolUseId: msg.tool_use_id } : {}),
        description: msg.description,
        ...(msg.task_type !== undefined ? { taskType: msg.task_type } : {}),
      });

      ctx.deps.callbacks.onMessage({
        type: 'backgroundTaskStarted',
        task: {
          taskId: msg.task_id,
          toolUseId: msg.tool_use_id ?? null,
          description: msg.description,
          taskType: msg.task_type ?? null,
          status: 'running',
          startTime: Date.now(),
          endTime: null,
          outputFile: null,
          summary: null,
          progressSummary: null,
          usage: null,
          lastToolName: null,
        },
      });
    },

    'system:task_notification': (message, ctx) => {
      const msg = message as unknown as TaskNotificationMessage;
      log('[StreamingManager] Task notification: id=%s, status=%s, toolUseId=%s',
        msg.task_id, msg.status, msg.tool_use_id ?? 'none');

      ctx.deps.callbacks.onMessage({
        type: 'taskNotification',
        taskId: msg.task_id,
        ...(msg.tool_use_id !== undefined ? { toolUseId: msg.tool_use_id } : {}),
        status: msg.status,
        summary: msg.summary,
        outputFile: msg.output_file,
        ...(msg.usage !== undefined ? {
          usage: {
            totalTokens: msg.usage.total_tokens,
            toolUses: msg.usage.tool_uses,
            durationMs: msg.usage.duration_ms,
          },
        } : {}),
      });

      ctx.deps.callbacks.onMessage({
        type: 'backgroundTaskCompleted',
        taskId: msg.task_id,
        status: msg.status,
        summary: msg.summary,
        outputFile: msg.output_file,
        ...(msg.usage ? {
          usage: {
            totalTokens: msg.usage.total_tokens,
            toolUses: msg.usage.tool_uses,
            durationMs: msg.usage.duration_ms,
          },
        } : {}),
      });

      ctx.deps.loopJobTracker?.handleTaskNotification(msg.task_id, msg.status);
    },
  };
}
