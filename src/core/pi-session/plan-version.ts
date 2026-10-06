import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { TOOL_EXIT_PLAN_MODE } from '../../shared/tool-names';
import { PLAN_VERSION_DETAIL_KEY } from '../../shared/types/session';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether a settled `ExitPlanMode` result is a plan the user was shown: a stamped number is, a null stamp (no plan
 * file, not in plan mode, stopped before the plan was shown) is not, and a result recorded before stamping existed is.
 */
function shownPlan(details: unknown): boolean {
  return !isRecord(details) || typeof details[PLAN_VERSION_DETAIL_KEY] === 'number';
}

/**
 * The plan version of `ExitPlanMode` call `toolCallId` (D51): one more than the plans the user was shown before it on
 * `branch`, which runs from the root, so the plans a compaction summarised count and a fork or a rewind continues
 * from the plans its own branch holds. A call with no result on the branch never counts.
 */
export function planVersionOnBranch(branch: readonly SessionEntry[], toolCallId: string): number {
  const results = new Map<string, unknown>();
  const calls: string[] = [];
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message: unknown = entry.message;
    if (!isRecord(message)) continue;
    if (message['role'] === 'toolResult' && typeof message['toolCallId'] === 'string') {
      results.set(message['toolCallId'], message['details']);
      continue;
    }
    if (message['role'] !== 'assistant' || !Array.isArray(message['content'])) continue;
    for (const block of message['content']) {
      if (isRecord(block) && block['type'] === 'toolCall' && block['name'] === TOOL_EXIT_PLAN_MODE && typeof block['id'] === 'string') calls.push(block['id']);
    }
  }
  let shown = 0;
  for (const id of calls) {
    if (id === toolCallId) break;
    if (results.has(id) && shownPlan(results.get(id))) shown++;
  }
  return shown + 1;
}
