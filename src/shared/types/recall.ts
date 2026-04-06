export interface SubcallRecord {
  prompt: string;
  model: string;
  response: string;
  durationMs: number;
}

export interface RecallIteration {
  index: number;
  modelResponse: string;
  codeBlock: string | null;
  replOutput: string | null;
  subcalls: SubcallRecord[];
  durationMs: number;
}

export interface OrientationBM25Result {
  turnIndex: number;
  promptIndex: number;
  score: number;
  preview: string;
}

export type OrientationPhase = 'expanding' | 'searching' | 'investigating' | 'complete';

export interface OrientationData {
  expandedTerms: string[];
  graphTerms?: string[];
  bm25Results: OrientationBM25Result[];
  investigationReport: string | null;
  durationMs: number;
}

export interface NodeRecallAttempt {
  promptIndex: number;
  userPrompt: string;
  orientation: OrientationData | null;
  iterationCount: number;
  totalDurationMs: number;
  shortCircuited: boolean;
}

export interface RecallTrajectory {
  promptIndex: number;
  userPrompt: string;
  iterations: RecallIteration[];
  finalContext: string | null;
  totalDurationMs: number;
  shortCircuited: boolean;
  forcedAnswer: boolean;
  timedOut: boolean;
  turnCount: number;
  historyChars: number;
  nodeId: string | null;
  nodeTitle: string | null;
  contextTurns: NodeTurnDisplay[];
  seedContext: string | null;
  relatedSummaries: RelatedNodeSummaryCard[];
  orientation: OrientationData | null;
}

export interface RelatedNodeSummaryCard {
  nodeId: string;
  title: string;
  outcome: 'resolved' | 'abandoned' | 'partial';
  taskDescription: string;
  filesChanged: string[];
  keyDecisions: string[];
}

export type DisplayContentBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; input: Record<string, unknown>; result: string };

export interface NodeTurnDisplay {
  promptIndex: number;
  timestamp: string;
  userMessage: string;
  assistantResponse: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  contentBlocks: DisplayContentBlock[];
  thinkingBlocks: string[];
  filesTouched: string[];
}

export interface NodeSummaryDisplay {
  title: string;
  taskDescription: string;
  outcome: 'resolved' | 'abandoned' | 'partial';
  filesChanged: string[];
  keyDecisions: string[];
}

export interface TaskNodeDisplay {
  nodeId: string;
  title: string;
  status: 'ACTIVE' | 'CLOSED';
  keyEntities: string[];
  turnCount: number;
  createdAt: string;
  closedAt: string | null;
  summary: NodeSummaryDisplay | null;
  relatedClosedNodeIds: string[];
  firstPrompt: string | null;
  filesTouched: string[];
  lastActivity: string | null;
}
