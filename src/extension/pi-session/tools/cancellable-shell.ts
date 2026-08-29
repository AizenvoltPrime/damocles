import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { CANCELLED_TOOL_DETAIL_KEY } from '../../../shared/types/session';
import { joinResultText } from '../tool-result-text';
import type { ShellCancellation, ShellCancelRegistry } from './shell-cancel-registry';

/** The two shell tools disagree on how they surface a partial: bash throws it, PowerShell returns it. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A shell tool that returns rather than throws on an abort has to set this on `details`, because the wrapper never parses the body. */
export const SHELL_ABORTED_DETAIL_KEY = 'shellAborted';

/** Whether the tool itself saw the abort, which is what separates an interrupted command from one that had already finished when the Stop click landed. */
function observedAbort(details: unknown): boolean {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return false;
  return (details as Record<string, unknown>)[SHELL_ABORTED_DETAIL_KEY] === true;
}

/**
 * The upstream body is taken verbatim, never parsed: its status string differs per tool and per pi
 * version, and the cause is already known from the registry. The trailer stays bracket-delimited so
 * the model can tell it from command output.
 *
 * The note itself never goes here. A tool result is untrusted by construction, so an instruction found
 * in one is prompt injection; the note is delivered as a real user message and the trailer only says
 * one is coming.
 */
function composeCancelledText(body: string, cancellation: ShellCancellation, elapsedMs: number): string {
  const seconds = (elapsedMs / 1000).toFixed(1);
  const reason = cancellation.note ? " The user's reason follows in their next message." : '';
  return `${body}\n\n[Command cancelled by the user after ${seconds}s. The output above is partial.${reason}]`;
}

/** `details` is `unknown` upstream, so the partial's own fields are carried only from a plain object; an array would spread as index keys, and the marker is set either way. */
function cancelledDetails(lastPartial: AgentToolResult<unknown> | undefined): Record<string, unknown> {
  const details = lastPartial?.details;
  const carried = details !== null && typeof details === 'object' && !Array.isArray(details) ? details : {};
  return { ...carried, [CANCELLED_TOOL_DETAIL_KEY]: true };
}

/**
 * Give a shell tool a per-call cancel that is independent of the run-level abort.
 *
 * Link the two signals with `AbortSignal.any` only, so cancelling a call can never signal the run
 * controller. A user cancel has to land as a non-error result or pi's retry heuristics treat it as
 * worth retrying, which leaves the marker on `details` as the only thing that tells the card apart
 * from a success. A run-level abort rethrows unchanged.
 * Spread the definition rather than rebuilding it through `defineTool`, or `description`,
 * `promptSnippet`, `promptGuidelines`, `parameters` and `constrainedSampling` move with it.
 */
export function withPerCallCancel(definition: ToolDefinition, registry: ShellCancelRegistry): ToolDefinition {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const perCall = new AbortController();
      const linked = signal ? AbortSignal.any([signal, perCall.signal]) : perCall.signal;
      const startedAt = Date.now();
      // The last partial carries the truncation state and `fullOutputPath`, which the thrown/returned
      // abort body does not, so the composed result reuses its `details`.
      let lastPartial: AgentToolResult<unknown> | undefined;
      const captureUpdate = onUpdate
        ? (partial: AgentToolResult<unknown>): void => {
            lastPartial = partial;
            onUpdate(partial);
          }
        : undefined;

      registry.register(toolCallId, perCall);
      try {
        const result = await definition.execute(toolCallId, params, linked, captureUpdate, ctx);
        const cancellation = registry.takeCancellation(toolCallId);
        // A Stop click can land after the command finished but before the tool settles, and that output is complete.
        if (!cancellation || !observedAbort(result.details)) return result;
        return {
          content: [{ type: 'text', text: composeCancelledText(joinResultText(result), cancellation, Date.now() - startedAt) }],
          details: cancelledDetails(lastPartial),
        };
      } catch (error) {
        const cancellation = registry.takeCancellation(toolCallId);
        if (!cancellation) throw error;
        return {
          content: [{ type: 'text', text: composeCancelledText(errorText(error), cancellation, Date.now() - startedAt) }],
          details: cancelledDetails(lastPartial),
        };
      } finally {
        registry.release(toolCallId);
      }
    },
  };
}
