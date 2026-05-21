import { log } from '../../../logger';
import { stripControlChars } from '../../../../shared/utils';
import { isToolResultMessage, extractErrorToolResults } from '../../utils';
import type { SDKMessageOrigin } from '@anthropic-ai/claude-agent-sdk';
import type { ProcessorDependencies, MessageProcessor } from '../types';

interface ParsedTaskNotification {
  taskId: string;
  toolUseId: string;
  result: string;
  summary: string;
}

function parseTaskNotificationBody(content: string): ParsedTaskNotification | null {
  const resultMatch = content.match(/<result>([\s\S]*?)<\/result>/);
  const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/);
  const taskIdMatch = content.match(/<task-id>([\s\S]*?)<\/task-id>/);
  const toolUseIdMatch = content.match(/<tool-use-id>([\s\S]*?)<\/tool-use-id>/);
  if (!resultMatch?.[1] || !taskIdMatch?.[1] || !toolUseIdMatch?.[1]) return null;
  return {
    taskId: taskIdMatch[1].trim(),
    toolUseId: toolUseIdMatch[1].trim(),
    result: resultMatch[1].trim(),
    summary: summaryMatch?.[1]?.trim() ?? '',
  };
}

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

interface UserMessage {
  uuid?: string;
  message?: { content?: unknown };
  isReplay?: boolean;
  isSynthetic?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: SDKMessageOrigin;
}

export function createUserProcessor(deps: ProcessorDependencies): Record<string, MessageProcessor> {
  const handler: MessageProcessor = (message: Record<string, unknown>, ctx): void => {
    const userMsg = message as UserMessage;
    const { state } = ctx;
    const { callbacks, toolManager } = deps;

    if (userMsg.isMeta) {
      return;
    }

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
        const parsed = parseTaskNotificationBody(content);
        if (parsed) {
          callbacks.onMessage({ type: 'backgroundTaskResult', ...parsed });
        } else {
          const monitorEvent = parseMonitorEventBody(content);
          if (monitorEvent) {
            callbacks.onMessage({ type: 'monitorEvent', ...monitorEvent });
          }
        }
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
        const parsed = parseTaskNotificationBody(body);
        if (parsed) {
          log('[StreamingManager] Sending backgroundTaskResult: taskId=%s, toolUseId=%s, resultLen=%d',
            parsed.taskId, parsed.toolUseId, parsed.result.length);
          callbacks.onMessage({ type: 'backgroundTaskResult', ...parsed });
        } else {
          const monitorEvent = parseMonitorEventBody(body);
          if (monitorEvent) {
            log('[StreamingManager] Sending monitorEvent: taskId=%s', monitorEvent.taskId);
            callbacks.onMessage({ type: 'monitorEvent', ...monitorEvent });
          } else {
            log('[StreamingManager] task-notification body missing required fields');
          }
        }
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
