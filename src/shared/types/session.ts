import type { ContentBlock, UserContentBlock } from './content';
import type { PluginInfo } from './plugins';

export interface SystemInitData {
  model: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  plugins: PluginInfo[];
  permissionMode: string;
  slashCommands: string[];
  apiKeySource: string;
  cwd: string;
  outputStyle?: string;
}

export interface QueuedMessage {
  id: string;
  content: string | UserContentBlock[];
  timestamp: number;
}

export interface IdeContextDisplayInfo {
  type: "selection" | "opened_file";
  filePath: string;
  fileName: string;
  lineCount?: number;
}

export interface MessageCheckpoint {
  messageId: string;
  userMessageId: string;
  timestamp: number;
  canRewind: boolean;
}

export interface CompactMarker {
  id: string;
  timestamp: number;
  trigger: "manual" | "auto";
  preTokens: number;
  postTokens?: number;
  summary?: string;
  messageCutoffTimestamp?: number;
}

export interface ContextUsageData {
  model: string;
  totalTokens: number;
  maxTokens: number;
  usagePercentage: number;
  breakdown: {
    systemPrompt: number;
    systemTools: number;
    mcpTools: number;
    customAgents: number;
    memoryFiles: number;
    skills: number;
    messages: number;
    compactBuffer: number;
    freeSpace: number;
  };
  details: {
    mcpTools: { name: string; server: string; tokens: number }[];
    memoryFiles: { type: string; path: string; tokens: number }[];
    skills: { name: string; source: string; tokens: number }[];
    customAgents: { type: string; source: string; tokens: number }[];
  };
}

export interface RewindHistoryItem {
  messageId: string;
  content: string;
  timestamp: number;
  filesAffected: number;
  files?: string[];
  linesChanged?: { added: number; removed: number };
}

export type RewindOption = 'code-and-conversation' | 'conversation-only' | 'code-only' | 'cancel';

export interface AssistantMessage {
  type: "assistant";
  message: {
    id: string;
    role: "assistant";
    content: ContentBlock[];
    model: string;
    stop_reason: string | null;
  };
  session_id: string;
}

export interface PartialMessage {
  type: "partial";
  content: ContentBlock[];
  session_id: string;
  messageId: string | null;
  streamingThinking?: string;
  streamingText?: string;
  isThinking?: boolean;
  thinkingDuration?: number;
}

export interface ResultMessage {
  type: "result";
  session_id: string;
  is_done: boolean;
  total_cost_usd?: number;
  total_output_tokens?: number;
  num_turns?: number;
  context_window_size?: number;
  stop_reason?: string | null;
}

export interface ChatMessage {
  id: string;
  sdkMessageId?: string;
  correlationId?: string;
  role: "user" | "assistant" | "error";
  content: string;
  contentBlocks?: ContentBlock[];
  toolCalls?: ToolCall[];
  timestamp: number;
  isPartial?: boolean;
  isThinkingPhase?: boolean;
  isReplay?: boolean;
  checkpointId?: string;
  thinking?: string;
  thinkingDuration?: number;
  parentToolUseId?: string | null;
  isQueued?: boolean;
  isInjected?: boolean;
}

export interface McpToolData {
  name: string;
  input: Record<string, unknown>;
  status: string;
  result?: string;
  errorMessage?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "pending" | "running" | "awaiting_approval" | "approved" | "denied" | "completed" | "failed" | "abandoned";
  result?: string;
  isError?: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  feedback?: string;
  elapsedTimeSeconds?: number;
  summary?: string;
}

export interface SessionStats {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  numTurns: number;
  contextWindowSize: number;
}

export interface FileEntry {
  path: string;
  operation: "read" | "edit" | "write" | "create";
}

export interface StoredSession {
  id: string;
  timestamp: number;
  preview: string;
  slug?: string;
  planPath?: string;
  customTitle?: string;
  messageCount?: number;
  isRecall?: boolean;
}
