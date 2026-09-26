import type { ImageBlock } from './content';
import type { AgentUsageTotals } from '../usage-accounting';

export type TeamPhase = 'initializing' | 'spawning' | 'working' | 'synthesizing' | 'complete';
export type TeamAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'awaiting-review' | 'standby' | 'monitoring';

export interface TeamAgent {
  agentId: string;
  name: string;
  role: 'lead' | 'specialist';
  specialization: string;
  model: string;
  profileId: string | null;
  /** Which launch of this agent the work fields below describe. A redispatch reuses the agentId, so an
   *  advance is the only signal that the counters start over while usage keeps every attempt's spend. */
  attempt: number;
  status: TeamAgentStatus;
  startTime: number | null;
  endTime: number | null;
  toolCount: number;
  lastToolName: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** Whether this agent's model bills real dollars. Its role model can differ from the panel model, so
   *  the panel-level billing flag cannot label this agent's cost. */
  dollarBilled: boolean;
  progressSummary: string | null;
  result: string | null;
  logFilePath: string | null;
}

export interface TeamMessage {
  messageId: string;
  senderAgentId: string;
  senderName: string;
  recipientAgentId: string | null;
  recipientName: string | null;
  content: string;
  timestamp: number;
}

export interface ScratchpadEntry {
  section: string;
  content: string;
  agentId: string;
  agentName: string;
  version: number;
  timestamp: number;
}

export type TeamAgentContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | ImageBlock
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  // `metadata` holds the normalized result details, the only place the user-cancelled marker is recorded.
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; metadata?: Record<string, unknown> };

/** One persisted member message. `id` comes from its pi session entry; a live message never carries it. */
export interface TeamAgentHistoryMessage {
  id: string;
  role: 'user' | 'assistant' | 'toolResult';
  content: TeamAgentContentBlock[];
}

/**
 * One invocation of a team: its `create_team` call or one `resume_team` call. The totals count only the
 * work done during this run, so the cards of a team's runs add up to the team.
 */
export interface TeamRunSummary {
  toolUseId: string;
  /** `running` only for the team's current run, and only while it runs. */
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: number;
  endTime: number | null;
  toolCount: number;
  /** The run's tokens by kind and its cost, counted as an agent's usage is. */
  usage: AgentUsageTotals;
  /**
   * Set only for a run read from a log that recorded its tokens as one input-plus-output figure. The token
   * kinds in `usage` are then zero, because the log never recorded them.
   */
  legacyTokens?: number;
}

export interface TeamState {
  teamId: string;
  /** The `create_team` call that started the team. */
  toolUseId: string;
  title: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  phase: TeamPhase;
  agents: TeamAgent[];
  messages: TeamMessage[];
  scratchpad: ScratchpadEntry[];
  result: string | null;
  startTime: number;
  endTime: number | null;
  totalToolCount: number;
  /** Oldest first; the last is the current run. */
  runs: TeamRunSummary[];
}
