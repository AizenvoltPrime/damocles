/**
 * background-results.ts — Format completed background subagent results for the parent keep-alive hold.
 *
 * When a parent turn ends with background subagents still running, the turn is held until they finish
 * and their results are injected back as a `display:false` custom message — which `convertToLlm` turns
 * into a model-visible user message — so the parent does one more round and synthesizes a final answer.
 */

import type { InjectedAgentResult, SubagentResultsDetails } from '../agent-records';
import { getStatusNote, recordResultText } from './status-note';
import type { AgentRecord } from './types';

/** Custom-message type for the injected results (display:false → seen by the model, not rendered as a bubble). */
export const SUBAGENT_RESULTS_CUSTOM_TYPE = 'damocles-subagent-results';

/** Build the model-visible follow-up content from finished background subagent records. */
export function formatBackgroundResults(records: readonly AgentRecord[]): string {
  const blocks = records.map((r) => `## ${r.type} — ${r.description}\n${recordResultText(r).trim() || '(no output)'}`);
  const plural = records.length === 1 ? '' : 's';
  const verb = records.length === 1 ? 'is' : 'are';
  return (
    `The background subagent${plural} you launched ${verb} no longer running. ` +
    `Use the results below to complete your response to the user now.\n\n${blocks.join('\n\n')}`
  );
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
      result: (r.result ?? r.error ?? '') + getStatusNote(r.status, r.stopReason, r.id),
    });
  }
  return { agents };
}
