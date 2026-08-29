import type { ToolCall } from '@shared/types/session';
import { CANCELLED_TOOL_DETAIL_KEY } from '@shared/types/session';

/**
 * A per-call cancel returns a normal tool result, so the extension marks it on the result's `details`
 * and it arrives as tool metadata. Metadata and completion arrive as two independent messages in
 * either order, so both the status path and the metadata path run this and neither assumes it is
 * second.
 */
export function resolveCancelledStatus(
  status: ToolCall['status'],
  metadata: Record<string, unknown> | undefined,
): ToolCall['status'] {
  if (status !== 'completed') return status;
  return metadata?.[CANCELLED_TOOL_DETAIL_KEY] === true ? 'cancelled' : status;
}

/**
 * Statuses after which a tool call never runs again, so its live output and its optimistic stopping
 * flag are dropped. Every store that renders a tool call must read this one set, or a status added to
 * one copy leaves a permanent spinner in another with nothing failing.
 */
export const TERMINAL_TOOL_STATUSES: ReadonlySet<ToolCall['status']> = new Set([
  'completed',
  'failed',
  'denied',
  'abandoned',
  'cancelled',
  'unrecorded',
]);
