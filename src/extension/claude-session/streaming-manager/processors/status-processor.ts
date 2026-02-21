import { log } from '../../../logger';
import type { ProcessorDependencies, MessageProcessor } from '../types';

interface StatusMessage {
  status?: 'compacting' | null;
  permissionMode?: string;
}

export function createStatusProcessor(_deps: ProcessorDependencies): Record<string, MessageProcessor> {
  const handler: MessageProcessor = (message: Record<string, unknown>, ctx): void => {
    const statusMsg = message as unknown as StatusMessage;
    const { callbacks } = ctx.deps;

    const isCompacting = statusMsg.status === 'compacting';
    log('[StreamingManager] Status update: %s', statusMsg.status ?? 'ready');

    callbacks.onMessage({
      type: 'statusUpdate',
      status: isCompacting ? 'compacting' : 'ready',
      ...(statusMsg.permissionMode !== undefined ? { permissionMode: statusMsg.permissionMode } : {}),
    });
  };

  return { 'system:status': handler };
}
