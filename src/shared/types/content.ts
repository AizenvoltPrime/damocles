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

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
  };
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | ImageBlock;

export type UserContentBlock = TextBlock | ImageBlock;

export type HistoryAgentContentBlock =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; result?: string; metadata?: Record<string, unknown> };

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
  sdkAgentId?: string;
  agentMessages?: HistoryAgentMessage[];
  agentStartTimestamp?: number;
  agentEndTimestamp?: number;
  agentToolCount?: number;
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
