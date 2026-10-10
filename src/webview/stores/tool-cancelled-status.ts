import type { ToolCall } from '@shared/types/session';
import { CANCELLED_TOOL_DETAIL_KEY } from '@shared/types/session';

/**
 * The extension marks a call stopped mid-run on the result's `details`, and it arrives as tool metadata:
 * a per-call cancel's normal result, or the error result of a call its aborted run cut short. Metadata
 * and completion arrive as two independent messages in either order, so both the status path and the
 * metadata path run this and neither assumes it is second.
 */
export function resolveCancelledStatus(
  status: ToolCall['status'],
  metadata: Record<string, unknown> | undefined,
): ToolCall['status'] {
  if (status !== 'completed' && status !== 'failed') return status;
  return metadata?.[CANCELLED_TOOL_DETAIL_KEY] === true ? 'cancelled' : status;
}

/**
 * How final each status is; a status never replaces one that ranks higher. The live statuses share a
 * rank because a prompted call goes running, awaiting_approval, running in the order core sends them.
 * `pending` means nothing is known yet; `unrecorded` gives way to a recorded outcome, and the least
 * informative outcomes to a result.
 */
const TOOL_STATUS_RANK: Readonly<Record<ToolCall['status'], number>> = {
  pending: 0,
  running: 1,
  awaiting_approval: 1,
  approved: 1,
  unrecorded: 2,
  abandoned: 3,
  denied: 3,
  failed: 3,
  completed: 4,
  cancelled: 4,
};

export function replacesToolStatus(current: ToolCall['status'], next: ToolCall['status']): boolean {
  return TOOL_STATUS_RANK[next] >= TOOL_STATUS_RANK[current];
}

/**
 * Statuses after which a tool call never runs again, so its live output and its optimistic stopping
 * flag are dropped. Every store that renders a tool call must read this one set, or a status added to
 * one copy leaves a permanent spinner in another with nothing failing.
 */
export const TERMINAL_TOOL_STATUSES: ReadonlySet<ToolCall['status']> = new Set(
  (Object.keys(TOOL_STATUS_RANK) as Array<ToolCall['status']>).filter((status) => TOOL_STATUS_RANK[status] > TOOL_STATUS_RANK.running),
);
