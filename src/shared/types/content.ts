export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** Largest base64 payload one image may carry; the webview compresses an attachment until it fits. */
export const MAX_IMAGE_BASE64_LENGTH = 3_932_160;

export const MAX_IMAGES_PER_MESSAGE = 10;

export function isImageMediaType(value: unknown): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly unknown[]).includes(value);
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: ImageMediaType;
    data: string;
  };
}

/** A shape check only, so it also validates persisted entries; size limits belong to the caller. */
export function isImageBlock(block: unknown): block is ImageBlock {
  if (typeof block !== 'object' || block === null) return false;
  const b = block as { type?: unknown; source?: unknown };
  if (b.type !== 'image') return false;
  if (typeof b.source !== 'object' || b.source === null) return false;
  const src = b.source as { type?: unknown; media_type?: unknown; data?: unknown };
  return (
    src.type === 'base64' &&
    isImageMediaType(src.media_type) &&
    typeof src.data === 'string' &&
    src.data.length > 0
  );
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | ImageBlock;

export type UserContentBlock = TextBlock | ImageBlock;

export type HistoryAgentContentBlock =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | ImageBlock
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean; metadata?: Record<string, unknown> };

export interface HistoryAgentMessage {
  role: 'user' | 'assistant';
  contentBlocks: HistoryAgentContentBlock[];
}

export interface HistoryToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  feedback?: string;
  agentToolCalls?: HistoryToolCall[];
  agentModel?: string;
  agentTemplatePath?: string;
  sdkAgentId?: string;
  agentMessages?: HistoryAgentMessage[];
  agentStartTimestamp?: number;
  agentEndTimestamp?: number;
  agentToolCount?: number;
  /** Subagent terminal status from `resolveAgentStatus`, or `interrupted` when none was recorded. */
  agentStatus?: string;
  /** Subagent final result text (raw result + status note) — the authoritative resumed-card content. */
  agentResultText?: string;
  /** The subagent's launch from its file. A resume call's own arguments carry none of it. */
  agentLaunch?: { agentType: string; description: string; prompt: string; background: boolean };
  /** Set on a resume call's card: the id of the agent it continued. */
  agentResumedFrom?: string;
  metadata?: Record<string, unknown>;
}

export interface HistoryMessage {
  type: "user" | "assistant" | "error";
  content: string;
  contentBlocks?: ContentBlock[];
  thinking?: string;
  tools?: HistoryToolCall[];
  sdkMessageId?: string;
  isInjected?: boolean;
  /** Source JSONL entry timestamp (ms) — used to interleave system notices during replay. */
  timestamp?: number;
}

export interface FileEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

export interface FileWriteInput {
  file_path: string;
  content: string;
}
