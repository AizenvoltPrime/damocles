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
