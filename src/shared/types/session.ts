import type { ContentBlock, UserContentBlock } from './content';

export interface SystemInitData {
  model: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  permissionMode: string;
  slashCommands: string[];
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

export interface CompactMarker {
  id: string;
  timestamp: number;
  trigger: "manual" | "auto";
  preTokens: number;
  postTokens?: number;
  summary?: string;
  messageCutoffTimestamp?: number;
  entryId?: string;
}

export interface CacheMissNotice {
  id: string;
  missedTokens: number;
  missedCost: number;
  idleMs: number;
  modelChanged: boolean;
  timestamp: number;
}

export interface ContextUsageData {
  model: string;
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  categories: { name: string; tokens: number; color: string; isDeferred?: boolean }[];
  memoryFiles: { path: string; type: string; tokens: number }[];
  mcpTools: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[];
  agents: { agentType: string; source: string; tokens: number; filePath?: string }[];
  deferredBuiltinTools?: { name: string; tokens: number; isLoaded: boolean }[];
  systemTools?: { name: string; tokens: number }[];
  systemPromptSections?: { name: string; tokens: number }[];
  skills?: { totalSkills: number; includedSkills: number; tokens: number; skillFrontmatter: { name: string; source: string; tokens: number; filePath?: string }[] };
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number; commands?: { name: string; source: string; filePath: string; tokens: number }[] };
  autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
  messageBreakdown?: {
    toolCallTokens: number; toolResultTokens: number; attachmentTokens: number;
    assistantMessageTokens: number; userMessageTokens: number;
    toolCallsByType: { name: string; callTokens: number; resultTokens: number }[];
    attachmentsByType: { name: string; tokens: number }[];
  };
  apiUsage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } | null;
}

export interface RewindHistoryItem {
  /** Discriminates a normal turn anchor (`prompt`, default) from a compaction-point anchor. A
   *  compaction item branches the tree at the compaction entry's parent (conversation-only, no file
   *  restore); `messageId` carries the pi compaction entry id, `content` the summary. */
  kind?: "prompt" | "compaction";
  messageId: string;
  content: string;
  timestamp: number;
  filesAffected: number;
  files?: Array<{ path: string; displayName: string }>;
  linesChanged?: { added: number; removed: number };
}

export type RewindOption =
  | 'fork-conversation'
  | 'code-only'
  | 'fork-and-rewind-code'
  | 'cancel';

/** Arguments passed when spawning a forked panel from a rewind action */
export interface ForkSpawnArgs {
  sourceSdkSessionId: string;
  /** Parent UUID of the user message — used as the SDK `resumeSessionAt` anchor. May be null when forking from the very first message. */
  forkAtUuid: string | null;
  /** UUID of the user message that was rewound TO — used to slice the source-session history (always present in displayable entries). */
  userMessageId: string;
  promptContent?: string;
  sourcePanelId: string;
  /** pi path: header id of the already-truncated branched session file the forked panel resumes (US-013c). */
  piBranchedSessionId?: string;
}

/** Per-panel fork lineage carried by the forked panel until its first SDK call */
export interface ForkContext {
  sourceSdkSessionId: string;
  forkAtUuid: string | null;
  consumed: boolean;
  /** pi path: header id of the branched session file the forked panel resumes on start (US-013c). */
  piBranchedSessionId?: string;
}

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

export interface RefusalStopDetails {
  category: 'cyber' | 'bio' | null;
  explanation: string | null;
  type: 'refusal';
}

export interface ResultMessage {
  type: "result";
  session_id: string;
  is_done: boolean;
  total_cost_usd?: number;
  total_output_tokens?: number;
  num_turns?: number;
  stop_reason?: string | null;
  stop_details?: RefusalStopDetails | null;
}

export interface ChatMessage {
  id: string;
  sdkMessageId?: string;
  correlationId?: string;
  role: "user" | "assistant" | "error" | "refusal";
  content: string;
  refusalExplanation?: string | null;
  refusalCategory?: 'cyber' | 'bio' | null;
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
  isCombinedQueue?: boolean;
  isBackgroundResult?: boolean;
  backgroundTaskLabel?: string;
  thinkingContent?: string;
  /** Sequential index of this real user prompt within the session. Counted across messages where role === 'user' && !isInjected && !isCombinedQueue && !isQueued — the single source for prompt counting; never re-derive in the webview. */
  promptIndex?: number;
  /** Present on amber "You steered <agent>" chips produced by /steer. Chips carry isInjected:true so they stay excluded from prompt counting. */
  steerTarget?: { agentId: string; agentType?: string; description?: string };
}

export interface McpToolData {
  name: string;
  input: Record<string, unknown>;
  status: string;
  result?: string;
  errorMessage?: string;
}

/**
 * Marks a tool result the user stopped mid-run. Set by the shell cancel wrapper on the result's
 * `details`, which is persisted and re-read on reload, so a reloaded transcript still shows the
 * cancelled state instead of a success. The extension is the only writer.
 */
export const CANCELLED_TOOL_DETAIL_KEY = "damoclesCancelled";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * `unrecorded` is terminal: the call ran and no outcome survived, so nothing may render it as live.
   * `cancelled` is derived in the webview from `metadata[CANCELLED_TOOL_DETAIL_KEY]`, never sent as a status.
   */
  status: "pending" | "running" | "awaiting_approval" | "approved" | "denied" | "completed" | "failed" | "abandoned" | "cancelled" | "unrecorded";
  result?: string;
  isError?: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  feedback?: string;
  elapsedTimeSeconds?: number;
  summary?: string;
  durationMs?: number;
  /** Live shell output while a Bash/PowerShell call runs. Cleared at terminal status. */
  liveOutput?: string;
  /** Whether pi's accumulator dropped earlier output from the snapshot above. */
  liveOutputTruncated?: boolean;
  /** Optimistic webview-owned flag, cleared at terminal status alongside liveOutput. */
  cancelRequested?: boolean;
}

export interface SessionStats {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** OpenAI-only: tokens served from prompt cache (separate billing tier from input). */
  cachedInputTokens?: number;
  /** OpenAI-only: subset of output_tokens that the model spent on hidden reasoning. */
  reasoningTokens?: number;
  numTurns: number;
  contextWindowSize: number;
  contextTotalTokens?: number;
  contextMaxTokens?: number;
  contextPercentage?: number;
}

export interface FileEntry {
  path: string;
  operation: "read" | "edit" | "write" | "create";
}

export interface StoredSession {
  id: string;
  timestamp: number;
  preview: string;
  customTitle?: string;
  aiTitle?: string;
  messageCount?: number;
  tag?: string;
  createdAt?: number;
}
