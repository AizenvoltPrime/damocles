import type { MessageCallbacks } from '../types';
import type { ToolManager } from '../tool-manager';
import type { ContextDistillationService } from '../../context-distillation';
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
  contextDistillation?: ContextDistillationService;
  cwd: string;
}

/** Runtime context passed to processors */
export interface ProcessorContext {
  state: StreamingState;
  deps: ProcessorDependencies;
  flushPendingAssistant: () => void;
}

/** Processor function signature */
export type MessageProcessor<TExtra = void> = TExtra extends void
  ? (message: Record<string, unknown>, ctx: ProcessorContext) => void | Promise<void>
  : (message: Record<string, unknown>, ctx: ProcessorContext, extra: TExtra) => void | Promise<void>;

/** Extra args for result processor */
export interface ResultProcessorExtra {
  budgetLimit: number | null;
  queryGeneration?: number;
}

/** Registry of message type to processor function */
export interface ProcessorRegistry {
  assistant: MessageProcessor;
  stream_event: MessageProcessor;
  system: MessageProcessor;
  user: MessageProcessor;
  result: MessageProcessor<ResultProcessorExtra>;
}

/** SDK message types we handle */
export type SDKMessageType = 'assistant' | 'stream_event' | 'system' | 'user' | 'result';

/** Token usage from assistant message */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}
