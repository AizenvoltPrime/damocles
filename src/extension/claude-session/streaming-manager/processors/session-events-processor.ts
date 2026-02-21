import { log } from '../../../logger';
import type { ProcessorDependencies, MessageProcessor } from '../types';

interface AuthStatusMessage {
  isAuthenticating: boolean;
  output: string[];
  error?: string;
}

interface FilesPersistedMessage {
  files: { filename: string; file_id: string }[];
  failed: { filename: string; error: string }[];
  processed_at: string;
}

interface HookMessage {
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  outcome?: 'success' | 'error' | 'cancelled';
}

export function createSessionEventsProcessors(_deps: ProcessorDependencies): Record<string, MessageProcessor> {
  return {
    auth_status: (message, ctx) => {
      const msg = message as unknown as AuthStatusMessage;
      log('[StreamingManager] Auth status: authenticating=%s, error=%s',
        msg.isAuthenticating, msg.error ?? 'none');

      ctx.deps.callbacks.onMessage({
        type: 'authStatusUpdate',
        isAuthenticating: msg.isAuthenticating,
        ...(msg.error !== undefined ? { error: msg.error } : {}),
      });
    },

    'system:files_persisted': (message, ctx) => {
      const msg = message as unknown as FilesPersistedMessage;
      log('[StreamingManager] Files persisted: %d files, %d failed',
        msg.files.length, msg.failed.length);

      ctx.deps.callbacks.onMessage({
        type: 'filesPersisted',
        files: msg.files.map(f => ({ filename: f.filename, fileId: f.file_id })),
        failed: msg.failed,
      });
    },

    'system:hook_started': (message, ctx) => {
      const msg = message as unknown as HookMessage;
      log('[StreamingManager] Hook started: %s (%s)', msg.hook_name, msg.hook_event);

      ctx.deps.callbacks.onMessage({
        type: 'hookLifecycle',
        hookId: msg.hook_id,
        hookName: msg.hook_name,
        hookEvent: msg.hook_event,
        phase: 'started',
      });
    },

    'system:hook_progress': (message, ctx) => {
      const msg = message as unknown as HookMessage;
      log('[StreamingManager] Hook progress: %s (%s)', msg.hook_name, msg.hook_event);
      const output = msg.output ?? msg.stdout;

      ctx.deps.callbacks.onMessage({
        type: 'hookLifecycle',
        hookId: msg.hook_id,
        hookName: msg.hook_name,
        hookEvent: msg.hook_event,
        phase: 'progress',
        ...(output !== undefined ? { output } : {}),
      });
    },

    'system:hook_response': (message, ctx) => {
      const msg = message as unknown as HookMessage;
      log('[StreamingManager] Hook response: %s (%s) outcome=%s',
        msg.hook_name, msg.hook_event, msg.outcome ?? 'unknown');
      const output = msg.output ?? msg.stdout;

      ctx.deps.callbacks.onMessage({
        type: 'hookLifecycle',
        hookId: msg.hook_id,
        hookName: msg.hook_name,
        hookEvent: msg.hook_event,
        phase: 'response',
        ...(output !== undefined ? { output } : {}),
        ...(msg.exit_code !== undefined ? { exitCode: msg.exit_code } : {}),
        ...(msg.outcome !== undefined ? { outcome: msg.outcome } : {}),
      });
    },
  };
}
