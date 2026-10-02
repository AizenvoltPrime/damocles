/**
 * undelivered-results.ts — Deliver background subagent results that an earlier turn ended before injecting.
 *
 * A background result reaches the model once per branch: through the keep-alive injection, a
 * `GetSubagentResult` fetch, or this prompt-start delivery. The live records cover a turn stopped while
 * the panel stayed open; the agent files cover a panel that closed or reloaded first.
 */

import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  deliveredBackgroundResults,
  indexAgentFiles,
  latestSubagentInvocations,
  readAgentFile,
  segmentForInvocation,
  subagentBranchIndex,
  type AgentFile,
  type AgentStatusData,
  type AgentTerminalStatus,
  type InjectedAgentResult,
  type SubagentLaunchData,
  type SubagentResultsDetails,
} from './agent-records';
import { backgroundResultsDetails, formatUndeliveredResults, SUBAGENT_RESULTS_CUSTOM_TYPE } from './subagents/background-results';
import { recordResultText } from './subagents/status-note';
import type { AgentRecord } from './subagents/types';
import { log } from '../logger';

/** A finished background invocation found in its agent file. */
export interface UndeliveredFileResult {
  agentId: string;
  toolCallId: string;
  launch: SubagentLaunchData;
  status: AgentStatusData;
}

export interface UndeliveredResultsMessage {
  customType: typeof SUBAGENT_RESULTS_CUSTOM_TYPE;
  content: string;
  display: false;
  details: SubagentResultsDetails;
}

export interface DeliveredResult {
  agentId: string;
  toolCallId: string;
}

/** `stopped` is absent: a file cannot tell a card stop from an abort kill, and the notice announces user and shutdown stops. */
const DELIVERABLE_FILE_STATUSES: ReadonlySet<AgentTerminalStatus> = new Set<AgentTerminalStatus>(['completed', 'steered', 'aborted', 'error']);

export interface UndeliveredFileScan {
  results: UndeliveredFileResult[];
  /** A candidate's file could not be read, or might be one of the files that could not be indexed. */
  incomplete: boolean;
}

/**
 * Background invocations the manager does not hold whose agent file records a deliverable status and whose
 * result is not in D(branch). Reads no file when the branch has no such invocation.
 */
export async function collectUndeliveredFromFiles(sources: {
  branch: readonly SessionEntry[];
  subagentDir: string;
  isLive: (agentId: string) => boolean;
}): Promise<UndeliveredFileScan> {
  const index = subagentBranchIndex(sources.branch);
  const delivered = deliveredBackgroundResults(index);
  const candidates = [...latestSubagentInvocations(index).values()].filter(
    (inv) => !sources.isLive(inv.id) && index.toolDetails.get(inv.toolCallId)?.status === 'async_launched' && !delivered.has(inv.toolCallId),
  );
  if (candidates.length === 0) return { results: [], incomplete: false };
  const files = await indexAgentFiles(sources.subagentDir);
  const results: UndeliveredFileResult[] = [];
  let incomplete = false;
  for (const inv of candidates) {
    const path = files.paths.get(inv.id);
    if (!path) {
      if (files.unreadable.length > 0) incomplete = true;
      continue;
    }
    let file: AgentFile | null;
    try {
      file = await readAgentFile(path);
    } catch (err) {
      log('[undelivered-results] skipping subagent %s: reading %s failed: %O', inv.id, path, err);
      incomplete = true;
      continue;
    }
    if (file?.launch.kind !== 'subagent') continue;
    const status = segmentForInvocation(file, inv)?.status;
    if (status && DELIVERABLE_FILE_STATUSES.has(status.status)) {
      results.push({ agentId: inv.id, toolCallId: inv.toolCallId, launch: file.launch, status });
    }
  }
  return { results, incomplete };
}

function fileResultDetails(item: UndeliveredFileResult): InjectedAgentResult {
  return {
    agentId: item.agentId,
    toolCallId: item.toolCallId,
    status: item.status.status,
    ...(item.status.stopReason ? { stopReason: item.status.stopReason } : {}),
    result: item.status.result,
  };
}

/**
 * Send one hidden results message for every result not yet in D(branch), live records first. `send`
 * answers whether it appended the message; the pairs it covered are returned only when it did.
 */
export async function deliverUndeliveredResults(sources: {
  live: readonly AgentRecord[];
  cold: readonly UndeliveredFileResult[];
  /** D(branch) as it is now. No await may separate this read from `send`'s append, so a concurrent
   *  delivery that appended first is seen and not repeated. */
  delivered: () => ReadonlySet<string>;
  send: (message: UndeliveredResultsMessage) => Promise<boolean>;
}): Promise<DeliveredResult[]> {
  const delivered = sources.delivered();
  const live = sources.live.filter((r) => !delivered.has(r.toolCallId));
  const cold = sources.cold.filter((c) => !delivered.has(c.toolCallId));
  if (live.length === 0 && cold.length === 0) return [];
  const agents = [...backgroundResultsDetails(live).agents, ...cold.map(fileResultDetails)];
  const content = formatUndeliveredResults([
    ...live.map((r) => ({ type: r.type, description: r.description, result: recordResultText(r) })),
    ...cold.map((c) => ({ type: c.launch.agentType, description: c.launch.description, result: c.status.result })),
  ]);
  const appended = await sources.send({ customType: SUBAGENT_RESULTS_CUSTOM_TYPE, content, display: false, details: { agents } });
  return appended ? agents.map(({ agentId, toolCallId }) => ({ agentId, toolCallId })) : [];
}
