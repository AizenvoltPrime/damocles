import type { ChatMessage, ToolCall } from './session';

export interface SubagentResult {
  content: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  sdkAgentId?: string;
}

export interface SubagentState {
  id: string;
  agentType: string;
  description: string;
  prompt: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startTime: number;
  endTime?: number;
  messages: ChatMessage[];
  toolCalls: ToolCall[];
  result?: SubagentResult;
  model?: string;
  /** Absolute path to the agent's markdown template file, when it ran from one (clickable in the UI). */
  templatePath?: string;
  sdkAgentId?: string;
  messagesSealed: boolean;
  lastAssistantMessage?: string;
  progressSummary?: string;
  isBackground?: boolean;
}

/** A currently running or queued Agent-tool subagent, for the `/steer` second-stage picker. */
export interface RunningSubagentInfo {
  id: string;
  agentType: string;
  description: string;
  status: 'running' | 'queued';
  isBackground: boolean;
}

export interface Task {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  blockedBy?: string[];
  blocks?: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

/** Status values the `TaskUpdate` tool accepts (the live task statuses plus `deleted`). */
export type TaskUpdateStatus = "pending" | "in_progress" | "completed" | "deleted";

/** Input to the `TaskCreate` tool. */
export interface TaskCreateInput {
  subject: string;
  description?: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

/** Output of the `TaskCreate` tool. */
export interface TaskCreateOutput {
  task: { id: string; subject: string };
}

/** Input to the `TaskUpdate` tool. */
export interface TaskUpdateInput {
  taskId: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskUpdateStatus;
  addBlocks?: string[];
  addBlockedBy?: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

/** Output of the `TaskUpdate` tool. */
export interface TaskUpdateOutput {
  success: boolean;
  taskId: string;
  error?: string;
  statusChange?: { from: string; to: string };
}

/** Output of the `TaskList` tool. */
export interface TaskListOutput {
  tasks: Array<{ id: string; subject: string; status: Task["status"]; owner?: string; blockedBy: string[] }>;
}

/** Output of the `TaskGet` tool. */
export interface TaskGetOutput {
  task: { id: string; subject: string; description: string; status: Task["status"]; blocks: string[]; blockedBy: string[] } | null;
}
