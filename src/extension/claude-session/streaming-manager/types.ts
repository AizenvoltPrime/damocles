import type { MessageCallbacks } from '../types';
import type { ToolManager } from '../tool-manager';
import type { LoopJobTracker } from '../loop-job-tracker';
import type { RecallService } from '../../recall';
import type { StreamingState } from './state';

/** Callback interface for checkpoint tracking */
export interface CheckpointTracker {
  trackCheckpoint(assistantMessageId: string, userMessageId: string): void;
  updateCost(cost: number): void;
  updateTokenUsage(inputTokens: number, contextWindowSize?: number): void;
  setContextWindowSize(size: number): void;
  onCompactComplete(): void;
}

/** Callback for signaling turn completion */
export type TurnCompleteCallback = () => void;

/** Static dependencies injected at construction */
export interface ProcessorDependencies {
  callbacks: MessageCallbacks;
  toolManager: ToolManager;
  checkpointTracker: CheckpointTracker;
  recallService?: RecallService;
  loopJobTracker?: LoopJobTracker;
  cwd: string;
}

/** Runtime context passed to processors */
export interface ProcessorContext {
  state: StreamingState;
  deps: ProcessorDependencies;
  flushPendingAssistant: () => void;
}

/** Processor function signature — uniform for all message types */
export type MessageProcessor = (message: Record<string, unknown>, ctx: ProcessorContext) => void | Promise<void>;

/** Map-based registry: extensible without interface changes */
export type ProcessorRegistry = Map<string, MessageProcessor>;

/** Top-level SDK message types */
export type SDKMessageType =
  | 'assistant'
  | 'stream_event'
  | 'system'
  | 'user'
  | 'result'
  | 'tool_progress'
  | 'tool_use_summary'
  | 'auth_status';

/** System message subtypes, dispatched as 'system:{subtype}' in the processor registry */
export type SystemSubtype =
  | 'init'
  | 'compact_boundary'
  | 'status'
  | 'task_started'
  | 'task_notification'
  | 'task_progress'
  | 'files_persisted'
  | 'hook_started'
  | 'hook_progress'
  | 'hook_response';

/** Token usage from assistant message */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}
