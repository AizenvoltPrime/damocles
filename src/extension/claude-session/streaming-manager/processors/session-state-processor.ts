import { log } from '../../../logger';
import type { ProcessorDependencies, MessageProcessor } from '../types';

export function createSessionStateProcessor(_deps: ProcessorDependencies): Record<string, MessageProcessor> {
  return {
    'system:session_state_changed': (message, ctx) => {
      const msg = message as Record<string, unknown>;
      const state = msg['state'] as string | undefined;
      const sessionId = msg['session_id'] as string | undefined;
      if (!state || !sessionId) return;

      log('[StreamingManager] Session state changed: %s (session=%s)', state, sessionId);

      if (state === 'idle' && ctx.state.isProcessing && !ctx.state.localPromptPending) {
        ctx.state.setProcessing(false);
      }

      ctx.deps.callbacks.onMessage({
        type: 'sessionStateChanged',
        state: state as 'idle' | 'running' | 'requires_action',
        sessionId,
      });
    },
  };
}
