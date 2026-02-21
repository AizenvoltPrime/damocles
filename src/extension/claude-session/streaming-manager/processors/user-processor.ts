import { log } from '../../../logger';
import { stripControlChars } from '../../../../shared/utils';
import { isToolResultMessage, extractErrorToolResults } from '../../utils';
import type { ProcessorDependencies, MessageProcessor } from '../types';

interface UserMessage {
  uuid?: string;
  message?: { content?: unknown };
  isReplay?: boolean;
  isSynthetic?: boolean;
  isCompactSummary?: boolean;
}

export function createUserProcessor(deps: ProcessorDependencies): Record<string, MessageProcessor> {
  const handler: MessageProcessor = (message: Record<string, unknown>, ctx): void => {
    const userMsg = message as UserMessage;
    const { state } = ctx;
    const { callbacks, toolManager } = deps;

    if (userMsg.uuid && !isToolResultMessage(userMsg.message?.content)) {
      state.lastUserMessageId = userMsg.uuid;
    }

    const errorResults = extractErrorToolResults(userMsg.message?.content);
    for (const { toolUseId, error } of errorResults) {
      const toolInfo = toolManager.getStreamedToolInfo(toolUseId);
      if (toolInfo) {
        toolManager.handlePostToolUseFailure(toolInfo.toolName, toolUseId, error, false);
      } else {
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

      if (content) {
        callbacks.onMessage({
          type: 'userReplay',
          content,
          ...(userMsg.isSynthetic !== undefined ? { isSynthetic: userMsg.isSynthetic } : {}),
          ...(userMsg.uuid !== undefined ? { sdkMessageId: userMsg.uuid } : {}),
        });
      }
    }
  };

  return { user: handler };
}
