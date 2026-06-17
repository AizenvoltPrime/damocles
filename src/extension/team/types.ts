import type { MessageBus } from './message-bus';
import type { Scratchpad } from './scratchpad';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { ModelInfo } from '../../shared/types/settings';

export type AgentRole = 'lead' | 'specialist';

export interface AgentSpec {
  name: string;
  role: AgentRole;
  specialization?: string;
  model?: string;
}

export type TeamPermissionMode = 'default' | 'acceptEdits' | 'plan';

export interface TeamConfig {
  teamId: string;
  toolUseId: string;
  title: string;
  agents: AgentSpec[];
  cwd: string;
  persistenceSessionId: string;
  permissionMode: TeamPermissionMode;
  additionalMcpServers?: Record<string, unknown>;
  systemPromptSuffix?: string;
  /** Resolve lead model value at spawn time; chosen by panel backend (Opus 4.8 / gpt-5.5). */
  resolveLeadModel: () => string;
  /** Specialist whitelist for this team — tier-aligned to the panel backend. */
  allowedSpecialistModels: readonly string[];
  /** Resolve ModelInfo for any agent model. */
  resolveModelInfo: (modelValue: string) => ModelInfo | undefined;
}

export interface TeamAgent {
  agentId: string;
  teamId: string;
  name: string;
  role: AgentRole;
  specialization: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'awaiting-review' | 'standby' | 'monitoring';
  model: string;
  profileId: string | null;
  startTime: number | null;
  endTime: number | null;
  toolCallCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  finalResponse: string | null;
  error: string | null;
  logFilePath: string | null;
}

export interface TeamMessage {
  messageId: string;
  teamId: string;
  timestamp: number;
  from: string;
  to: string | null;
  content: string;
}

export interface ScratchpadEntry {
  section: string;
  content: string;
  author: string;
  version: number;
  timestamp: number;
}

export type TeamStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type TeamPhase = 'initializing' | 'spawning' | 'working' | 'synthesizing' | 'complete';

export interface Team {
  teamId: string;
  toolUseId: string;
  title: string;
  status: TeamStatus;
  phase: TeamPhase;
  agents: Map<string, TeamAgent>;
  messageBus: MessageBus;
  scratchpad: Scratchpad;
  startTime: number;
  endTime: number | null;
  synthesizedResult: string | null;
}

export interface AgentRunConfig {
  agentId: string;
  name: string;
  role: AgentRole;
  specialization: string;
  model: string;
  systemPrompt: string;
  cwd: string;
  mcpServer: unknown;
  additionalMcpServers?: Record<string, unknown>;
  abortSignal: AbortSignal;
  messageBus: MessageBus;
  onMessage: (msg: ExtensionToWebviewMessage) => void;
  teamId: string;
  persistence: TeamPersistenceWriter;
  /** Optional resolver for the per-agent `ModelInfo`. */
  resolveModelInfo?: (modelValue: string) => ModelInfo | undefined;
  keepAlive?: () => boolean;
  keepAliveMessage?: () => string;
  onTurnEnd?: () => void;
  onKeepAliveResume?: () => void;
  keepAliveTimeoutMs?: number;
  shouldDeliverMessage?: (msg: { from: string; to: string | null }) => boolean;
  onToolCall?: (toolName: string, toolCallCount: number) => void;
  onUsageUpdate?: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }) => void;
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string; [key: string]: unknown },
  ) => Promise<ToolPermissionResult>;
}

export interface AgentResult {
  agentId: string;
  status: 'completed' | 'failed' | 'cancelled';
  finalResponse: string | null;
  toolCallCount: number;
  durationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface TeamPersistenceWriter {
  appendAgentEntry(teamId: string, agentId: string, entry: Record<string, unknown>): void;
  appendTeamEntry(entry: Record<string, unknown>): void;
  flush(): Promise<void>;
}

export interface TeamJSONLEntry {
  type: string;
  teamId: string;
  timestamp: string;
  [key: string]: unknown;
}

export type ToolPermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface AgentMcpContext {
  agentId: string;
  agentName: string;
  role: 'lead' | 'specialist';
  /** Tier-aligned specialist whitelist from TeamConfig — used by the spawn tool's validation. */
  allowedSpecialistModels: readonly string[];
  messageBus: MessageBus;
  scratchpad: Scratchpad;
  startSpecialist: (name: string, task: string, model?: string, profileId?: string) => string;
  synthesizeResult: (result: string) => void;
  cancelSpecialist: (name: string) => void;
  getActiveSpecialistNames: () => string[];
  getPendingSpecialistNames: () => string[];
  getTeamStatus: () => Record<string, unknown>;
  getAgentNames: () => string[];
  requestRevision: (specialistName: string, feedback: string) => void;
  approveSpecialist: (name: string) => void;
  getUnreviewedSpecialistNames: () => string[];
  isReviewRoundReady: () => boolean;
  getNonSettledSpecialistDetails: () => Array<{name: string; status: TeamAgent['status']; toolCallCount: number}>;
  getAllAgents: () => TeamAgent[];
  enterStandby: (agentName: string) => void;
  reportComplete: (agentName: string) => void;
  recordCancelAttempt?: (name: string) => void;
  getCancelAttemptTimestamp?: (name: string) => number | undefined;
  getRecentlyCancelledNames?: () => string[];
}

