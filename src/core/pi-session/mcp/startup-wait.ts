import type { McpToolSource } from './tool-source';

/** How long the first prompt of a session waits for servers with Always-loaded tools (pi's startup wait). */
export const MCP_STARTUP_WAIT_MS = 10_000;

export type McpStartupWaitOutcome = 'ready' | 'timeout' | 'aborted';

/**
 * Resolve once no server with Always-loaded tools is still connecting, after `timeoutMs`, or when
 * `signal` aborts, whichever comes first. Re-checked on every tools-changed event, which a connect
 * emits once its tools are registered.
 */
export function waitForPendingDirectServers(
  source: Pick<McpToolSource, 'pendingDirectServers' | 'onToolsChanged'>,
  signal: AbortSignal,
  timeoutMs: number = MCP_STARTUP_WAIT_MS,
): Promise<McpStartupWaitOutcome> {
  if (signal.aborted) return Promise.resolve('aborted');
  if (source.pendingDirectServers().length === 0) return Promise.resolve('ready');
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined = undefined;
    const finish = (outcome: McpStartupWaitOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    // A source may call the listener before `onToolsChanged` returns, so the wait can already be over here.
    unsubscribe = source.onToolsChanged(() => {
      if (source.pendingDirectServers().length === 0) finish('ready');
    });
    if (settled) {
      unsubscribe();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
