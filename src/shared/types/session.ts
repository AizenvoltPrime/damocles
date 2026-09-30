import type { ContentBlock, UserContentBlock } from './content';
import type { AgentUsageTotals } from '../usage-accounting';

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

/** What started a compaction. The webview branches its trigger hint on all three. */
export type CompactionTrigger = "manual" | "threshold" | "overflow";

export interface CompactMarker {
  id: string;
  timestamp: number;
  trigger: CompactionTrigger;
  preTokens: number;
  postTokens?: number;
  summary?: string;
  messageCutoffTimestamp?: number;
  entryId?: string;
  billedTokens?: number;
  billedCost?: number;
}

export interface CacheMissNotice {
  id: string;
  missedTokens: number;
  missedCost: number;
  idleMs: number;
  modelChanged: boolean;
  timestamp: number;
}

export interface CompactionAbortedNotice {
  id: string;
  trigger: CompactionTrigger;
  willRetry: boolean;
  errorMessage?: string;
  timestamp: number;
}

export interface ThinkingDroppedNotice {
  id: string;
  count: number;
  reasons: string[];
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
  /** Files this checkpoint left out; a rewind to it never modifies, deletes or restores them. */
  skipped?: SkippedSummary;
  /** Set when the turn has no usable baseline, so it cannot be rewound. */
  notRewindable?: { reason: NotRewindableReason; params: NotRewindableParams };
}

export type SkipReason = "size" | "category" | "lfs";

/**
 * One row of a checkpoint's full skipped list. `path` is relative to the conversation's folder,
 * `/`-separated; a directory skipped as a whole ends in `/` and has `bytes: null`.
 */
export interface SkippedFile {
  path: string;
  bytes: number | null;
  reason: SkipReason;
}

export interface SkippedTally {
  count: number;
  bytes: number;
}

/** What one category or LFS exclude pattern matched; directories count 1 and 0 bytes. */
export interface SkippedPattern {
  pattern: string;
  reason: "category" | "lfs";
  count: number;
  bytes: number;
}

/**
 * What a snapshot left out. `manifest` is the object id of the full list in the folder repo (read with
 * `requestSkippedFiles`), null when nothing was skipped. `patterns` counts what the folder's exclude
 * rules matched; `byReason` and the manifest count every skip.
 */
export interface SkippedSummary {
  totalCount: number;
  totalBytes: number;
  byReason: { size?: SkippedTally; category?: SkippedTally; lfs?: SkippedTally };
  patterns: SkippedPattern[];
  manifest: string | null;
}

export type NotRewindableReason = "baseline-timeout" | "baseline-failed";

/** Rendered by the webview in the user's language; `error` is raw git text. */
export interface NotRewindableParams {
  tool?: string;
  waitSeconds?: number;
  error?: string;
}

/** What a pre-rewind snapshot was taken before: a rewind to a turn, or an undo of another snapshot. */
export type PreRewindTarget = { kind: "turn"; userEntryId: string } | { kind: "undo"; preRewindId: string };

/** A pre-rewind snapshot the rewind view offers as "Undo rewind"; the file fields are the live diff an undo applies. */
export interface RestorePoint {
  id: string;
  createdAt: number;
  target: PreRewindTarget;
  skipped: SkippedSummary;
  filesAffected: number;
  files?: Array<{ path: string; displayName: string }>;
  linesChanged?: { added: number; removed: number };
}

/** Whose full skipped list `requestSkippedFiles` reads: a turn's checkpoint or a restore point. */
export type SkippedFilesTarget = { kind: "turn"; userEntryId: string } | { kind: "restore-point"; id: string };

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
  /** An injected row echoing a slash command that commits no user entry, so it is not a mid-stream delivery. */
  isCommandEcho?: boolean;
  isCombinedQueue?: boolean;
  isBackgroundResult?: boolean;
  backgroundTaskLabel?: string;
  thinkingContent?: string;
  /** The prompt index the extension stamped (`session-store/prompt-index.ts`); never re-derive it in the webview. A row `USER_PROMPT_FILTER` rejects names no prompt of its own: an injected echo carries the latest prompt's index, and a replayed mid-run delivery or steer chip carries none. */
  promptIndex?: number;
  /** Present on amber "You steered <agent>" chips produced by /steer. Chips carry isInjected:true so they stay excluded from prompt counting. */
  steerTarget?: { agentId: string; agentType?: string; description?: string };
}

/**
 * Marks a tool result the user stopped mid-run. Set by the shell cancel wrapper on the result's
 * `details`, which is persisted and re-read on reload, so a reloaded transcript still shows the
 * cancelled state instead of a success. The extension is the only writer.
 */
export const CANCELLED_TOOL_DETAIL_KEY = "damoclesCancelled";

/**
 * The note the user sent with that cancel, on the same `details`, which pi never sends to the model.
 * It is how a run the note itself starts is told apart from a prompt (`session-store/prompt-index.ts`).
 */
export const CANCEL_NOTE_DETAIL_KEY = "damoclesCancelNote";

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
  /** Success results only; the images load on demand. */
  imageCount?: number;
}

/** Where a tool call's result is stored. */
export type ToolResultOwner =
  | { kind: "session" }
  | { kind: "subagent"; agentId: string }
  | { kind: "team"; teamId: string; agentId: string };

/** Cumulative usage of the conversation's own entries, plus the context meter's last-request snapshot. */
export interface SessionStats extends AgentUsageTotals {
  numTurns: number;
  /** Snapshot of the last request, for the context meter only. Never a billing figure. */
  contextInputTokens: number;
  contextCacheReadTokens: number;
  contextCacheWriteTokens: number;
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
  /** The open folder whose session dir holds this session, with that folder's disambiguated label. */
  workspaceFolder?: { key: string; label: string };
}
