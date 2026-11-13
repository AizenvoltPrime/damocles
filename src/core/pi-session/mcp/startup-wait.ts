import type { McpToolSource } from './tool-source';

/** How long the first prompt of a session waits for servers with Always-loaded tools (pi's startup wait). */
export const MCP_STARTUP_WAIT_MS = 10_000;

export type McpStartupWaitOutcome = 'ready' | 'timeout' | 'aborted';

/**
 * Resolve once no server with Always-loaded tools is still connecting, after `timeoutMs`, or when
 * `signal` aborts, whichever comes first. Re-checked on every tools-changed event, which a connect
 * emits once its tools are registered. `arriving`, when given, is awaited first, inside the same
 * timeout and abort: servers not known yet whose arrival may add connecting ones; it gets a signal
 * that aborts once the wait ends, and its rejection rejects the wait.
 */
export function waitForPendingDirectServers(
  source: Pick<McpToolSource, 'pendingDirectServers' | 'onToolsChanged'>,
  signal: AbortSignal,
  timeoutMs: number = MCP_STARTUP_WAIT_MS,
  arriving?: (ended: AbortSignal) => Promise<void>,
): Promise<McpStartupWaitOutcome> {
  if (signal.aborted) return Promise.resolve('aborted');
  if (!arriving && source.pendingDirectServers().length === 0) return Promise.resolve('ready');
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined = undefined;
    const ended = new AbortController();
    const end = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      signal.removeEventListener('abort', onAbort);
      ended.abort();
      return true;
    };
    const finish = (outcome: McpStartupWaitOutcome): void => {
      if (end()) resolve(outcome);
    };
    const fail = (err: unknown): void => {
      if (end()) reject(err);
    };
    const onAbort = (): void => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    const watch = (): void => {
      if (settled) return;
      if (source.pendingDirectServers().length === 0) {
        finish('ready');
        return;
      }
      // A source may call the listener before `onToolsChanged` returns, so the wait can already be over here.
      unsubscribe = source.onToolsChanged(() => {
        if (source.pendingDirectServers().length === 0) finish('ready');
      });
      if (settled) {
        unsubscribe();
        return;
      }
      if (!arriving) signal.addEventListener('abort', onAbort, { once: true });
    };
    if (arriving) {
      signal.addEventListener('abort', onAbort, { once: true });
      arriving(ended.signal).then(watch, fail);
    } else {
      watch();
    }
  });
}
