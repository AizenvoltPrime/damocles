export type TeamPhase = 'initializing' | 'spawning' | 'working' | 'synthesizing' | 'complete';
export type TeamAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TeamAgent {
  agentId: string;
  name: string;
  role: 'lead' | 'specialist';
  specialization: string;
  model: string;
  profileId: string | null;
  status: TeamAgentStatus;
  startTime: number | null;
  endTime: number | null;
  toolCount: number;
  lastToolName: string | null;
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
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

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
