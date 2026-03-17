export type { ContextStrategy } from '../../shared/types/settings';
export type { RecallIteration, SubcallRecord, RecallTrajectory } from '../../shared/types/recall';

export const DEFAULT_ROOT_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_SUBCALL_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_MAX_ITERATIONS = 15;
export const BLOCK_TIMEOUT_MS = 10_000;
export const ASYNC_TIMEOUT_MS = 30_000;
export const PER_CALL_TIMEOUT_MS = 60_000;
export const TOTAL_LOOP_TIMEOUT_MS = 120_000;
export const ITERATION_TIMEOUT_MS = 60_000;
export const STDOUT_TRUNCATION_LIMIT = 20_000;
export const DIRECT_CONTEXT_THRESHOLD = 12_000;
export const DEFAULT_MAX_INJECTED_CHARS = 400_000;

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

export type TurnContentBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; index: number };

export interface StructuredTurn {
  promptIndex: number;
  timestamp: string;
  userMessage: string;
  assistantResponse: string;
  toolCalls: ToolCallRecord[];
  contentBlocks: TurnContentBlock[];
  thinkingBlocks: string[];
  filesTouched: string[];
  nodeId: string | null;
}

export interface NodeSummary {
  title: string;
  taskDescription: string;
  outcome: 'resolved' | 'abandoned' | 'partial';
  filesChanged: string[];
  keyDecisions: string[];
  keyEntities: string[];
}

export interface TaskNode {
  nodeId: string;
  title: string;
  status: 'ACTIVE' | 'CLOSED';
  keyEntities: string[];
  turnIndices: number[];
  createdAt: string;
  closedAt: string | null;
  summary: NodeSummary | null;
  relatedClosedNodeIds: string[];
  manuallyDisconnectedNodeIds: string[];
  seedContext: string | null;
  seedContextPrompt: string | null;
  _seedContextPending?: boolean;
}

export interface NodeState {
  nodes: TaskNode[];
  activeNodeId: string | null;
}

export function extractFilesTouched(toolCalls: ToolCallRecord[]): string[] {
  const files = new Set<string>();
  for (const tc of toolCalls) {
    const filePath = tc.input['file_path'];
    if (typeof filePath === 'string') {
      files.add(filePath);
    }
  }
  return [...files];
}
