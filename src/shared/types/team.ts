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
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  // `metadata` holds the normalized result details, the only place the user-cancelled marker is recorded.
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; metadata?: Record<string, unknown> };

export interface TeamState {
  teamId: string;
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
}
