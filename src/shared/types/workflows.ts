export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface WorkflowUsage {
  agentCount: number;
  subagentTokens: number;
  toolUses: number;
  durationMs: number;
}

export interface WorkflowPhase {
  title: string;
  detail: string | null;
}

export interface WorkflowAgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result: string | null;
}

export type WorkflowAgentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; toolCall: WorkflowAgentToolCall };

export interface WorkflowAgentTranscript {
  agentId: string;
  label: string;
  /** Subagent type from the per-agent meta file (e.g. "Explore"). Used as the label while an agent is still running, before its transcript exists. */
  agentType: string | null;
  /** False while the agent is still running (meta/journal-started present but no completed transcript yet). */
  running: boolean;
  /** The agent's raw structured result (string, object, or array) as recorded in the journal. Rendered by StructuredResult rather than pre-stringified, so objects keep their shape. */
  result: unknown;
  toolUseCount: number;
  model: string | null;
  prompt: string;
  logFile: string;
  blocks: WorkflowAgentBlock[];
}

export interface WorkflowRun {
  toolUseId: string;
  taskId: string | null;
  name: string;
  description: string;
  phases: WorkflowPhase[];
  status: WorkflowStatus;
  summary: string;
  result: string;
  usage: WorkflowUsage | null;
  outputFile: string | null;
  transcriptDir: string | null;
  startTime: number;
}
