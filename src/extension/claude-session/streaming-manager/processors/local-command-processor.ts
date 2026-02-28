import { log } from '../../../logger';
import { isContextUsageOutput, parseContextUsageMarkdown } from '../../context-usage-parser';
import type { ProcessorDependencies, MessageProcessor } from '../types';

export function createLocalCommandProcessor(deps: ProcessorDependencies): Record<string, MessageProcessor> {
  return {
    'system:local_command_output': (message: Record<string, unknown>) => {
      const content = message['content'] as string;
      if (!content) return;

      if (isContextUsageOutput(content)) {
        const data = parseContextUsageMarkdown(content);
        log('[LocalCommandProcessor] Context usage parsed: %s', data ? 'success' : 'failed');
        deps.callbacks.onMessage({
          type: 'contextUsage',
          data,
          ...(data ? {} : { reason: 'parseFailed' as const }),
        });
      }
    },
  };
}
