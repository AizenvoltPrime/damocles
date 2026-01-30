import type { StoredSession } from "@shared/types/session";

export const EXTENSION_VERSION = "2.1.25";

export const INTERRUPT_MARKER = "[Request interrupted by user]";

export const SDK_GENERATED_PREFIXES = ["[Request interrupted by user", "This session is being continued from a previous conversation"];

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SubagentCorrelationEntry {
  type: "subagent-correlation";
  toolUseId: string;
  agentId: string;
  timestamp?: string;
}

export function isSubagentCorrelationEntry(entry: ClaudeSessionEntry): entry is ClaudeSessionEntry & SubagentCorrelationEntry {
  return (
    entry.type === "subagent-correlation" &&
    typeof (entry as SubagentCorrelationEntry).toolUseId === "string" &&
    typeof (entry as SubagentCorrelationEntry).agentId === "string"
  );
}

export const TOOL_RESULT_PREVIEW_LENGTH = 500;
export const COMPACT_SUMMARY_SEARCH_DEPTH = 20;
export const MAX_PROMPT_HISTORY = 500;

export type JsonlContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface ClaudeSessionEntry {
  type: string;
  subtype?: string;
  operation?: string;
  content?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  userType?: string;
  cwd?: string;
  sessionId?: string;
  version?: string;
  gitBranch?: string;
  slug?: string;
  customTitle?: string;
  isInterrupt?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  isInjected?: boolean;
  compactMetadata?: {
    trigger: "manual" | "auto";
    preTokens: number;
  };
  message?: {
    role: string;
    content: string | JsonlContentBlock[];
    model?: string;
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  toolUseResult?:
    | {
        type?: string;
        filePath?: string;
        oldString?: string;
        newString?: string;
        originalFile?: string;
        status?: string;
        prompt?: string;
        agentId?: string;
        content?: Array<{ type: string; text?: string }>;
        totalDurationMs?: number;
        totalTokens?: number;
        totalToolUseCount?: number;
        questions?: Array<{
          question: string;
          header?: string;
          options: Array<{ label: string; description?: string }>;
          multiSelect?: boolean;
        }>;
        answers?: Record<string, string>;
        structuredPatch?: Array<{
          oldStart?: number;
          newStart?: number;
          oldLines?: number;
          newLines?: number;
        }>;
      }
    | Array<{ type: string; text?: string }>;
}

export type { StoredSession };

export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
}

export type AgentContentBlock =
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; result?: string; metadata?: Record<string, unknown> };

export interface AgentMessage {
  role: "user" | "assistant";
  contentBlocks: AgentContentBlock[];
}

export interface AgentData {
  toolCalls: AgentToolCall[];
  model?: string;
  messages: AgentMessage[];
  startTimestamp?: number;
  endTimestamp?: number;
  totalToolUseCount: number;
}

export interface ExtractedSessionStats {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  numTurns: number;
  contextWindowSize: number;
}

export interface CompactInfo {
  trigger: "manual" | "auto";
  preTokens: number;
  summary?: string;
  timestamp: number;
}

export interface PaginatedSessionResult {
  entries: ClaudeSessionEntry[];
  totalCount: number;
  hasMore: boolean;
  nextOffset: number;
  compactInfo?: CompactInfo;
  injectedUuids?: Set<string>;
  /** Subagent correlations: toolUseId -> agentId (extracted from subagent-correlation entries) */
  subagentCorrelations?: Map<string, string>;
  /** Pre-computed stats to avoid double file read */
  stats?: ExtractedSessionStats;
}

export interface PersistUserMessageOptions {
  workspacePath: string;
  sessionId: string;
  content: string | Array<{ type: string; text: string }>;
  parentUuid?: string | null;
  gitBranch?: string;
}

export interface PersistPartialAssistantOptions {
  workspacePath: string;
  sessionId: string;
  parentUuid: string;
  thinking?: string;
  text?: string;
  model?: string;
  gitBranch?: string;
}

export interface PersistInterruptOptions {
  workspacePath: string;
  sessionId: string;
  parentUuid: string;
  gitBranch?: string;
}

export function isContentBlockArray(content: unknown): content is JsonlContentBlock[] {
  return Array.isArray(content) && content.every((block) => typeof block === "object" && block !== null && "type" in block);
}
