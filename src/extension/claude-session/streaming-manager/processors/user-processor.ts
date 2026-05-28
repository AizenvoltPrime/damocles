import { log } from '../../../logger';
import { stripControlChars } from '../../../../shared/utils';
import { parseWorkflowLaunch } from '../../../../shared/workflow-launch';
import { isToolResultMessage, extractErrorToolResults } from '../../utils';
import { parseTaskNotification } from '../../task-notification-parser';
import type { SDKMessageOrigin } from '@anthropic-ai/claude-agent-sdk';
import type { ProcessorDependencies, MessageProcessor, ProcessorContext } from '../types';

interface ParsedMonitorEvent {
  taskId: string;
  summary: string;
  event: string;
}

function parseMonitorEventBody(content: string): ParsedMonitorEvent | null {
  const eventMatch = content.match(/<event>([\s\S]*?)<\/event>/);
  if (!eventMatch?.[1]) return null;
  const taskIdMatch = content.match(/<task-id>([\s\S]*?)<\/task-id>/);
  if (!taskIdMatch?.[1]) return null;
  const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/);
  return {
    taskId: taskIdMatch[1].trim(),
    summary: summaryMatch?.[1]?.trim() ?? '',
    event: eventMatch[1].trim(),
  };
}

function extractTaskNotificationBodies(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return (content as Array<Record<string, unknown>>)
    .filter((b): b is { type: string; content: string } =>
      b['type'] === 'tool_result' && typeof b['content'] === 'string'
    )
    .map(b => b.content);
}

/**
 * Bind a workflow's task id to its launching tool-use id from the `Workflow` tool's
 * launch result ("Workflow launched in background. Task ID: <id> …"). This is the most
 * reliable source: the live `system:task_notification` carries `task_id` but only
 * optionally carries `tool_use_id`, and `task_started` may omit it too, whereas the
 * launch result text always contains the task id and is paired with the tool-use id.
 */
function captureWorkflowLaunchBinding(content: unknown, ctx: ProcessorContext): void {
  if (!Array.isArray(content)) return;
  for (const block of content as Array<Record<string, unknown>>) {
    if (block['type'] !== 'tool_result' || typeof block['tool_use_id'] !== 'string') continue;
    const toolUseId = block['tool_use_id'];
    if (!ctx.state.workflowToolUseIds.has(toolUseId)) continue;
    const text = typeof block['content'] === 'string' ? block['content'] : '';
    const { taskId, transcriptDir } = parseWorkflowLaunch(text);
    if (taskId) {
      ctx.state.workflowTaskToToolUse.set(taskId, toolUseId);
      log('[StreamingManager] Bound workflow task→toolUse from launch result: taskId=%s, toolUseId=%s',
        taskId, toolUseId);
    }
    if (transcriptDir) {
      ctx.state.workflowTranscriptDirs.set(toolUseId, transcriptDir);
    } else {
      log('[StreamingManager] Workflow launch result for toolUseId=%s yielded no transcript dir — live agent transcripts will not stream (launch-result format may have changed)',
        toolUseId);
    }
  }
}

interface UserMessage {
  uuid?: string;
  message?: { content?: unknown };
  isReplay?: boolean;
  isSynthetic?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: SDKMessageOrigin;
}

/**
 * Route a `<task-notification>` body to the right webview message: a `Workflow`
 * tool's completion becomes a `workflowResult` (panel/overlay), a generic
 * background task becomes a `backgroundTaskResult` (chat bubble), and a monitor
 * event becomes a `monitorEvent`.
 */
function routeTaskNotificationBody(body: string, deps: ProcessorDependencies, ctx: ProcessorContext): void {
  const parsed = parseTaskNotification(body);
  if (parsed) {
    if (ctx.state.workflowToolUseIds.has(parsed.toolUseId)) {
      log('[StreamingManager] Sending workflowResult: toolUseId=%s, status=%s', parsed.toolUseId, parsed.status);
      const transcriptDir = ctx.state.workflowTranscriptDirs.get(parsed.toolUseId);
      deps.callbacks.onMessage({
        type: 'workflowResult',
        toolUseId: parsed.toolUseId,
        taskId: parsed.taskId,
        status: parsed.status,
        summary: parsed.summary,
        result: parsed.result,
        outputFile: parsed.outputFile,
        ...(transcriptDir ? { transcriptDir } : {}),
        ...(parsed.usage ? { usage: parsed.usage } : {}),
      });
      return;
    }
    if (parsed.result) {
      log('[StreamingManager] Sending backgroundTaskResult: taskId=%s, toolUseId=%s, resultLen=%d',
        parsed.taskId, parsed.toolUseId, parsed.result.length);
      deps.callbacks.onMessage({
        type: 'backgroundTaskResult',
        taskId: parsed.taskId,
        toolUseId: parsed.toolUseId,
        result: parsed.result,
        summary: parsed.summary,
      });
      return;
    }
  }
  const monitorEvent = parseMonitorEventBody(body);
  if (monitorEvent) {
    log('[StreamingManager] Sending monitorEvent: taskId=%s', monitorEvent.taskId);
    deps.callbacks.onMessage({ type: 'monitorEvent', ...monitorEvent });
  } else {
    log('[StreamingManager] task-notification body missing required fields');
  }
}

export function createUserProcessor(deps: ProcessorDependencies): Record<string, MessageProcessor> {
  const handler: MessageProcessor = (message: Record<string, unknown>, ctx): void => {
    const userMsg = message as UserMessage;
    const { state } = ctx;
    const { callbacks, toolManager } = deps;

    if (userMsg.isMeta) {
      return;
    }

    captureWorkflowLaunchBinding(userMsg.message?.content, ctx);

    const isTaskNotification = userMsg.origin?.kind === 'task-notification';

    if (userMsg.uuid && !isToolResultMessage(userMsg.message?.content) && !isTaskNotification) {
      state.lastUserMessageId = userMsg.uuid;
    }

    const errorResults = extractErrorToolResults(userMsg.message?.content);
    for (const { toolUseId, error } of errorResults) {
      const toolInfo = toolManager.getStreamedToolInfo(toolUseId);
      if (toolInfo) {
        toolManager.handlePostToolUseFailure(toolInfo.toolName, toolUseId, error, false);
      } else if (!toolManager.wasFinalized(toolUseId)) {
        log('[StreamingManager] Error tool_result for unknown tool: %s', toolUseId);
      }
    }

    if (userMsg.isCompactSummary && userMsg.message?.content) {
      log('[StreamingManager] Received isCompactSummary message');
      const rawContent =
        typeof userMsg.message.content === 'string' ? userMsg.message.content : '';
      const summary = stripControlChars(rawContent);
      log('[StreamingManager] Compact summary length: %d', summary.length);
      if (summary) {
        log('[StreamingManager] Sending compactSummary to webview');
        callbacks.onMessage({
          type: 'compactSummary',
          summary,
        });
      }
      return;
    }

    if (userMsg.isReplay && userMsg.message?.content) {
      const rawContent = Array.isArray(userMsg.message.content)
        ? userMsg.message.content
            .filter(
              (c): c is { type: 'text'; text: string } =>
                typeof c === 'object' && c !== null && 'type' in c && c.type === 'text'
            )
            .map((c) => c.text)
            .join('')
        : typeof userMsg.message.content === 'string'
          ? userMsg.message.content
          : '';
      const content = stripControlChars(rawContent);

      if (content.startsWith('<local-command-')) {
        log(
          '[StreamingManager] Skipping local command wrapper in userReplay: %s',
          content.substring(0, 50)
        );
        return;
      }

      if (isTaskNotification) {
        log('[StreamingManager] Routing task-notification origin from userReplay');
        routeTaskNotificationBody(content, deps, ctx);
        return;
      }

      if (content) {
        callbacks.onMessage({
          type: 'userReplay',
          content,
          ...(userMsg.isSynthetic !== undefined ? { isSynthetic: userMsg.isSynthetic } : {}),
          ...(userMsg.uuid !== undefined ? { sdkMessageId: userMsg.uuid } : {}),
          promptIndex: deps.getCurrentPromptIndex(),
          nodeId: deps.getActiveNodeId(),
        });
      }
      return;
    }

    if (isTaskNotification) {
      const bodies = extractTaskNotificationBodies(userMsg.message?.content);
      log('[StreamingManager] Routing %d task-notification body(ies) from live content', bodies.length);
      for (const body of bodies) {
        routeTaskNotificationBody(body, deps, ctx);
      }
      return;
    }

    if (state.localPromptPending) {
      state.localPromptPending = false;
      return;
    }
  };

  return { user: handler };
}
