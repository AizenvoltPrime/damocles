import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { log } from '../../logger';

/**
 * Resolve to `onAbort()` the instant `signal` fires, instead of waiting for `work`. Some calls (CDP,
 * MCP) cannot be cancelled promptly, so a slow or hung one would otherwise block the agent loop, which
 * `await`s the tool's `execute`, and with it pi's `abort()`/`waitForIdle()`. The orphaned work keeps
 * running in the background, so a tool body must re-check `signal.aborted` before any side effect it
 * performs after an await.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort: () => T, toolName: string): Promise<T> {
  if (!signal) return work;
  // Nobody awaits orphaned work, so its failure is logged here. Only the error name: an MCP or page
  // error message can carry server output or page text.
  const logOrphanFailure = (err: unknown): void =>
    log('[abortableTool] %s failed after its turn was aborted (%s)', toolName, err instanceof Error ? err.name : typeof err);
  if (signal.aborted) {
    work.catch(logOrphanFailure);
    return Promise.resolve(onAbort());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbortEvent = (): void => resolve(onAbort());
    signal.addEventListener('abort', onAbortEvent, { once: true });
    void work.then(
      (value) => { signal.removeEventListener('abort', onAbortEvent); resolve(value); },
      (err) => {
        signal.removeEventListener('abort', onAbortEvent);
        if (signal.aborted) logOrphanFailure(err);
        reject(err);
      },
    );
  });
}

/** Wrap a tool so its `execute` returns the instant the turn is aborted (see `raceAbort`). */
export function abortableTool(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      raceAbort(
        tool.execute(toolCallId, params, signal, onUpdate, ctx),
        signal,
        () => ({ content: [{ type: 'text', text: `${tool.name} aborted` }], details: undefined }) as AgentToolResult<unknown>,
        tool.name,
      ),
  };
}
