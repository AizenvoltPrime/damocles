import { log } from '../../../logger';
import { pushWorkflowTranscripts } from './workflow-transcript-push';
import { readWorkflowOutput } from '../../workflow-output';
import { unwrapToolUseError } from '../../../../shared/utils';
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

interface TaskUpdatedMessage {
  task_id: string;
  patch: {
    status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused';
    description?: string;
    error?: string;
  };
}

export function createTaskLifecycleProcessors(deps: ProcessorDependencies): Record<string, MessageProcessor> {
  return {
    'system:task_started': (message, ctx) => {
      const msg = message as unknown as TaskStartedMessage;
      const isWorkflow = msg.task_type === 'local_workflow' || msg.task_type === 'workflow';
      const isBackground = Boolean(
        msg.tool_use_id && deps.toolManager.isBackgroundToolUse(msg.tool_use_id)
      );
      log('[StreamingManager] Task started: id=%s, toolUseId=%s, desc=%s, isBackground=%s, isWorkflow=%s',
        msg.task_id, msg.tool_use_id ?? 'none', msg.description, isBackground, isWorkflow);

      if (isWorkflow) {
        // Workflow runs surface through the WorkflowCard + workflow store (keyed by
        // tool_use_id), not the generic background-task panel. Bind task_id → tool_use_id
        // here: the completion notification reliably carries task_id but only optionally
        // carries tool_use_id, so this mapping lets the lean live notification resolve back
        // to the workflow store. Skip the generic `taskStarted` emit — it would register the
        // workflow's tool-use-id as an orphan subagent in the subagent store.
        if (msg.tool_use_id) {
          ctx.state.workflowToolUseIds.add(msg.tool_use_id);
          ctx.state.workflowTaskToToolUse.set(msg.task_id, msg.tool_use_id);
        }
        log('[StreamingManager] Workflow task_started: taskId=%s, toolUseId=%s (bound=%s)',
          msg.task_id, msg.tool_use_id ?? 'none', String(Boolean(msg.tool_use_id)));
        return;
      }

      ctx.deps.callbacks.onMessage({
        type: 'taskStarted',
        taskId: msg.task_id,
        ...(msg.tool_use_id !== undefined ? { toolUseId: msg.tool_use_id } : {}),
        description: msg.description,
        ...(msg.task_type !== undefined ? { taskType: msg.task_type } : {}),
        ...(isBackground ? { isBackground: true } : {}),
      });

      if (isBackground) {
        deps.toolManager.registerBackgroundTask(msg.task_id);
        ctx.deps.callbacks.onMessage({
          type: 'backgroundTaskStarted',
          task: {
            taskId: msg.task_id,
            toolUseId: msg.tool_use_id ?? null,
            description: msg.description,
            taskType: msg.task_type ?? null,
            workflowName: null,
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
      }
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

      // Resolve the workflow this notification belongs to. The live notification carries
      // task_id reliably but tool_use_id only optionally, so fall back to the task_id →
      // tool_use_id binding captured at task_started.
      const workflowToolUseId = msg.tool_use_id && ctx.state.workflowToolUseIds.has(msg.tool_use_id)
        ? msg.tool_use_id
        : ctx.state.workflowTaskToToolUse.get(msg.task_id) ?? null;

      if (workflowToolUseId) {
        // Live workflow completion. The notification is lean (no result body, no
        // agent_count); the structured result + accurate counts arrive on history
        // load via the persisted user-message notification.
        const transcriptDir = ctx.state.workflowTranscriptDirs.get(workflowToolUseId);
        log('[StreamingManager] Workflow completion → workflowResult: taskId=%s, resolvedToolUseId=%s, status=%s, viaTaskMap=%s',
          msg.task_id, workflowToolUseId, msg.status, String(workflowToolUseId !== msg.tool_use_id));
        ctx.deps.callbacks.onMessage({
          type: 'workflowResult',
          toolUseId: workflowToolUseId,
          taskId: msg.task_id,
          status: msg.status,
          summary: msg.summary,
          result: '',
          outputFile: msg.output_file,
          ...(transcriptDir ? { transcriptDir } : {}),
          ...(msg.usage ? {
            usage: {
              agentCount: 0,
              subagentTokens: msg.usage.total_tokens,
              toolUses: msg.usage.tool_uses,
              durationMs: msg.usage.duration_ms,
            },
          } : {}),
        });

        // The lean live notification has no result body; the task output file does. Read it
        // and enrich (merge-friendly applyResult) so the Result section and accurate agent
        // count render live, not only after a history reload.
        if (msg.status === 'completed' && msg.output_file) {
          const { task_id, status, summary, output_file, usage } = msg;
          void readWorkflowOutput(output_file).then(out => {
            if (!out) return;
            ctx.deps.callbacks.onMessage({
              type: 'workflowResult',
              toolUseId: workflowToolUseId,
              taskId: task_id,
              status,
              summary: out.summary || summary,
              result: out.result,
              outputFile: output_file,
              ...(transcriptDir ? { transcriptDir } : {}),
              usage: {
                agentCount: out.agentCount,
                subagentTokens: usage?.total_tokens ?? 0,
                toolUses: usage?.tool_uses ?? 0,
                durationMs: usage?.duration_ms ?? 0,
              },
            });
          }).catch(err => {
            log('[StreamingManager] Failed to enrich workflow result from output file: %s',
              err instanceof Error ? err.message : String(err));
          });
        }

        pushWorkflowTranscripts(ctx, workflowToolUseId, true);
        ctx.deps.loopJobTracker?.handleTaskNotification(msg.task_id, msg.status);
        return;
      }

      if (deps.toolManager.isBackgroundTask(msg.task_id)) {
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
        deps.toolManager.unregisterBackgroundTask(msg.task_id);
      }

      ctx.deps.loopJobTracker?.handleTaskNotification(msg.task_id, msg.status);
    },

    // A workflow that settles fast/synchronously (e.g. a script that throws in its body)
    // reports its terminal state through `task_updated`'s status patch and emits NO
    // `task_notification` — so without this the card would spin on "running" forever. The
    // patch carries the authoritative status (and `error` for failures). Resolve via the
    // task_id → tool_use_id binding and forward terminal transitions to the workflow store;
    // interim states (pending/running/paused) and non-workflow tasks are ignored, and a later
    // `task_notification` (success path) still enriches result/usage via merge-friendly applyResult.
    'system:task_updated': (message, ctx) => {
      const msg = message as unknown as TaskUpdatedMessage;
      const status = msg.patch?.status;
      if (status !== 'completed' && status !== 'failed' && status !== 'killed') return;

      const workflowToolUseId = ctx.state.workflowTaskToToolUse.get(msg.task_id) ?? null;
      if (!workflowToolUseId) return;

      const mappedStatus = status === 'killed' ? 'stopped' : status;
      log('[StreamingManager] Workflow task_updated terminal → workflowResult: taskId=%s, toolUseId=%s, status=%s',
        msg.task_id, workflowToolUseId, mappedStatus);
      const transcriptDir = ctx.state.workflowTranscriptDirs.get(workflowToolUseId);
      ctx.deps.callbacks.onMessage({
        type: 'workflowResult',
        toolUseId: workflowToolUseId,
        taskId: msg.task_id,
        status: mappedStatus,
        summary: msg.patch.error ? unwrapToolUseError(msg.patch.error) : '',
        result: '',
        outputFile: null,
        ...(transcriptDir ? { transcriptDir } : {}),
      });

      pushWorkflowTranscripts(ctx, workflowToolUseId, true);
    },
  };
}
