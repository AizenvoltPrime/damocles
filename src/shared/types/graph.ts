export type GraphNodeStatus = 'pending' | 'running' | 'completed' | 'error' | 'skipped';

export interface GraphNodeState {
  name: string;
  status: GraphNodeStatus;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  inputState?: Record<string, unknown>;
  outputState?: Record<string, unknown>;
  error?: string;
}

export interface GraphTopology {
  nodes: { name: string; type: 'start' | 'end' | 'node' }[];
  edges: { from: string; to: string; type: 'static' | 'conditional'; label?: string }[];
}

export interface GraphExecutionSnapshot {
  topology: GraphTopology;
  nodeStates: GraphNodeState[];
  currentNode: string | null;
  graphState: Record<string, unknown>;
  totalDurationMs: number;
  promptIndex: number;
}
