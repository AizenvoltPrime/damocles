/**
 * background-results.ts — Format completed background subagent results for the parent keep-alive hold.
 *
 * When a parent turn ends with background subagents still running, the turn is held until they finish
 * and their results are injected back as a `display:false` custom message — which `convertToLlm` turns
 * into a model-visible user message — so the parent does one more round and synthesizes a final answer.
 */

import { formatUserSteerPrefix } from '../../../shared/steer';
import type { AgentRecord } from './types';

/** Custom-message type for the injected results (display:false → seen by the model, not rendered as a bubble). */
export const SUBAGENT_RESULTS_CUSTOM_TYPE = 'damocles-subagent-results';

/** Build the model-visible follow-up content from finished background subagent records. */
export function formatBackgroundResults(records: readonly AgentRecord[]): string {
  const blocks = records.map((r) => {
    const body = (r.result ?? r.error ?? '(no output)').trim();
    return `## ${r.type} — ${r.description}\n${formatUserSteerPrefix(r.userSteers)}${body}`;
  });
  const plural = records.length === 1 ? '' : 's';
  const verb = records.length === 1 ? 'has' : 'have';
  return (
    `The background subagent${plural} you launched ${verb} finished. ` +
    `Use the results below to complete your response to the user now.\n\n${blocks.join('\n\n')}`
  );
}
