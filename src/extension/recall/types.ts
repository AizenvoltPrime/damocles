export type { ContextStrategy } from '../../shared/types/settings';
export type { RecallIteration, SubcallRecord, RecallTrajectory } from '../../shared/types/recall';

export const DEFAULT_ROOT_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_SUBCALL_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_MAX_ITERATIONS = 15;
export const BLOCK_TIMEOUT_MS = 10_000;
export const ASYNC_TIMEOUT_MS = 30_000;
export const PER_CALL_TIMEOUT_MS = 60_000;
export const STDOUT_TRUNCATION_LIMIT = 20_000;
export const DIRECT_CONTEXT_THRESHOLD = 12_000;
export const DEFAULT_MAX_INJECTED_CHARS = 200_000;

export interface RecallConfig {
  enabled: boolean;
  subcallModel: string;
  maxIterations: number;
  maxInjectedChars: number;
}

export interface ToolCallRecord {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  result: string;
}

export interface StructuredTurn {
  promptIndex: number;
  timestamp: string;
  userMessage: string;
  assistantResponse: string;
  toolCalls: ToolCallRecord[];
  thinkingBlocks: string[];
}
