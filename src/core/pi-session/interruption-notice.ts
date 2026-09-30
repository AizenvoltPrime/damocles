/**
 * interruption-notice.ts — Tell the parent model which agents were interrupted and how to resume them.
 *
 * The notice is computed from what the parent branch and the agent files persist, so ESC, a reload, a
 * reopen from history and a fork all reach it the same way. It is appended as a hidden custom message,
 * which pi persists and the model reads with the user's next prompt.
 */

import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  agentInvocationsOnBranch,
  indexAgentFiles,
  isResumableSubagentStatus,
  readAgentFile,
  subagentBranchIndex,
  subagentLatestState,
  toolCallArgumentsOnBranch,
  type AgentFile,
  type LiveAgentStatus,
} from './agent-records';
import { DAMOCLES_INTERRUPTION_NOTICE } from './session-store/constants';
import { log } from '../logger';

/** One interrupted invocation. A later interruption of the same agent is a new invocation. */
export interface InterruptedAgent {
  kind: 'subagent' | 'team';
  id: string;
  toolCallId: string;
  description: string;
}

export interface InterruptionNoticeDetails {
  agents: Array<Pick<InterruptedAgent, 'kind' | 'id' | 'toolCallId'>>;
}

export interface InterruptionSources {
  /** The parent session's current branch. */
  branch: readonly SessionEntry[];
  /** The parent session's `subagents/` folder. */
  subagentDir: string;
  /** The in-memory status of a subagent, when this panel still tracks it. */
  liveSubagent: (id: string) => LiveAgentStatus | undefined;
  /** Whether a team has a checkpoint that `resume_team` would continue from. */
  teamResumable: (teamId: string) => Promise<boolean>;
}

export interface NoticeMessage {
  customType: string;
  content: string;
  display: false;
  details: InterruptionNoticeDetails;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function noticeKey(agent: Pick<InterruptedAgent, 'id' | 'toolCallId'>): string {
  return `${agent.id}\u0000${agent.toolCallId}`;
}

/** Resumable subagents on the branch: stopped by the user or a shutdown, or killed with no status. */
export async function collectInterruptedSubagents(sources: InterruptionSources): Promise<InterruptedAgent[]> {
  const index = subagentBranchIndex(sources.branch);
  const ids = [...new Set(index.invocations.map((inv) => inv.id))];
  if (ids.length === 0) return [];
  const files = await indexAgentFiles(sources.subagentDir);
  const out: InterruptedAgent[] = [];
  for (const id of ids) {
    const path = files.get(id);
    let file: AgentFile | null = null;
    if (path) {
      try {
        file = await readAgentFile(path);
      } catch (err) {
        // Read as "no file", its status would fall back to the branch and could call a finished agent interrupted.
        log('[interruption-notice] skipping subagent %s: reading %s failed: %O', id, path, err);
        continue;
      }
    }
    const state = subagentLatestState(index, id, file, sources.liveSubagent(id));
    if (!state || !isResumableSubagentStatus(state)) continue;
    const spawnArgs = state.spawn ? toolCallArgumentsOnBranch(sources.branch, state.spawn.toolCallId) : undefined;
    const description = file?.launch.kind === 'subagent' ? file.launch.description : spawnArgs?.['description'];
    out.push({ kind: 'subagent', id, toolCallId: state.latest.toolCallId, description: typeof description === 'string' ? description : '' });
  }
  return out;
}

/** Resumable teams on the branch: those with an unused resume checkpoint, listed under their latest invocation. */
export async function collectInterruptedTeams(sources: InterruptionSources): Promise<InterruptedAgent[]> {
  const invocations = agentInvocationsOnBranch(sources.branch).filter((inv) => inv.kind === 'team');
  const out: InterruptedAgent[] = [];
  for (const id of new Set(invocations.map((inv) => inv.id))) {
    let resumable: boolean;
    try {
      resumable = await sources.teamResumable(id);
    } catch (err) {
      // A resume of it would fail on the same read, so it is not offered.
      log('[interruption-notice] skipping team %s: reading its resume state failed: %O', id, err);
      continue;
    }
    if (!resumable) continue;
    const mine = invocations.filter((inv) => inv.id === id);
    const created = mine.find((inv) => !inv.resume);
    const title = created ? toolCallArgumentsOnBranch(sources.branch, created.toolCallId)?.['title'] : undefined;
    out.push({ kind: 'team', id, toolCallId: mine.at(-1)!.toolCallId, description: typeof title === 'string' ? title : '' });
  }
  return out;
}

/** Every interrupted agent this conversation can resume. */
export async function collectInterrupted(sources: InterruptionSources): Promise<InterruptedAgent[]> {
  return [...(await collectInterruptedSubagents(sources)), ...(await collectInterruptedTeams(sources))];
}

/** Invocations an earlier notice on the branch already listed. */
export function announcedOnBranch(branch: readonly SessionEntry[]): Set<string> {
  const out = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== 'custom_message' || entry.customType !== DAMOCLES_INTERRUPTION_NOTICE) continue;
    const details: unknown = entry.details;
    if (!isRecord(details) || !Array.isArray(details['agents'])) continue;
    for (const agent of details['agents']) {
      if (isRecord(agent) && typeof agent['id'] === 'string' && typeof agent['toolCallId'] === 'string') {
        out.add(noticeKey({ id: agent['id'], toolCallId: agent['toolCallId'] }));
      }
    }
  }
  return out;
}

export function resumeCall(agent: InterruptedAgent): string {
  return agent.kind === 'team' ? `resume_team({team_id:"${agent.id}"})` : `Agent({resume:"${agent.id}"})`;
}

/** Model-facing text. Descriptions are model-written, so each is flattened onto its own line. */
export function formatInterruptionNotice(agents: readonly InterruptedAgent[]): string {
  const lines = agents.map((agent) => {
    const description = agent.description.replace(/\s+/g, ' ').trim();
    return `- ${agent.kind} ${agent.id}${description ? ` ("${description}")` : ''}: resume with ${resumeCall(agent)}`;
  });
  return [
    'These agents were interrupted before they finished and are not running now:',
    ...lines,
    'Do not resume unless the user asks to continue.',
  ].join('\n');
}

/**
 * Append one hidden notice listing every interrupted invocation no earlier notice on the branch listed.
 * Returns what it announced; throws when collecting or sending fails.
 */
export async function reconcileInterruptions(
  sources: InterruptionSources & { send: (message: NoticeMessage) => Promise<void> },
): Promise<InterruptedAgent[]> {
  const announced = announcedOnBranch(sources.branch);
  const fresh = (await collectInterrupted(sources)).filter((agent) => !announced.has(noticeKey(agent)));
  if (fresh.length === 0) return [];
  await sources.send({
    customType: DAMOCLES_INTERRUPTION_NOTICE,
    content: formatInterruptionNotice(fresh),
    display: false,
    details: { agents: fresh.map(({ kind, id, toolCallId }) => ({ kind, id, toolCallId })) },
  });
  return fresh;
}
