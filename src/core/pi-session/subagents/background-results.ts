/**
 * background-results.ts — Format completed background subagent results for the parent keep-alive hold
 * and for the prompt-start delivery of results an earlier turn never injected.
 *
 * When a parent turn ends with background subagents still running, the turn is held until they finish
 * and their results are injected back as a `display:false` custom message — which `convertToLlm` turns
 * into a model-visible user message — so the parent does one more round and synthesizes a final answer.
 */

import type { InjectedAgentResult, SubagentResultsDetails } from '../agent-records';
import { recordOutcomeText, recordResultText } from './status-note';
import type { AgentRecord } from './types';

/** Custom-message type for the injected results (display:false → seen by the model, not rendered as a bubble). */
export const SUBAGENT_RESULTS_CUSTOM_TYPE = 'damocles-subagent-results';

/** One finished agent's block in a results message. `result` already carries its status note. */
export interface BackgroundResultBlock {
  type: string;
  description: string;
  result: string;
}

function formatResultBlocks(items: readonly BackgroundResultBlock[]): string {
  return items.map((i) => `## ${i.type} — ${i.description}\n${i.result.trim() || '(no output)'}`).join('\n\n');
}

/** Build the model-visible follow-up content from finished background subagent records. */
export function formatBackgroundResults(records: readonly AgentRecord[]): string {
  const blocks = formatResultBlocks(records.map((r) => ({ type: r.type, description: r.description, result: recordResultText(r) })));
  const plural = records.length === 1 ? '' : 's';
  const verb = records.length === 1 ? 'is' : 'are';
  return (
    `The background subagent${plural} you launched ${verb} no longer running. ` +
    `Use the results below to complete your response to the user now.\n\n${blocks}`
  );
}

/** The content of the prompt-start delivery of results an earlier turn ended before injecting. */
export function formatUndeliveredResults(items: readonly BackgroundResultBlock[]): string {
  const lead = items.length === 1
    ? 'This background subagent finished during an earlier turn that ended before its result reached you. Take it'
    : 'These background subagents finished during an earlier turn that ended before their results reached you. Take them';
  return `${lead} into account for the user message that follows.\n\n${formatResultBlocks(items)}`;
}

/** The injection's `details`: per-agent status for history, never sent to the model. */
export function backgroundResultsDetails(records: readonly AgentRecord[]): SubagentResultsDetails {
  const agents: InjectedAgentResult[] = [];
  for (const r of records) {
    if (r.status === 'queued' || r.status === 'running') continue;
    agents.push({
      agentId: r.id,
      toolCallId: r.toolCallId,
      status: r.status,
      ...(r.stopReason ? { stopReason: r.stopReason } : {}),
      result: recordOutcomeText(r),
    });
  }
  return { agents };
}
