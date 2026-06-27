import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { MessageBus } from './message-bus';
import type { Scratchpad } from './scratchpad';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';

/** Classifies a specialist for thinking-depth only (set by the lead on spawn). Re-exported from the
 *  resolver as the single source of truth. The resolver does not import this file, so there is no cycle
 *  today; keeping the type declared there (not here) pre-empts one if these modules ever cross-reference. */
export type { SpecialistKind } from '../pi-session/team-model-resolution';
import type { SpecialistKind } from '../pi-session/team-model-resolution';

export type AgentRole = 'lead' | 'specialist';

export interface AgentSpec {
  name: string;
  role: AgentRole;
  specialization?: string;
  model?: string;
}

export type TeamPermissionMode = 'default' | 'acceptEdits' | 'plan';

/** Outcome of resolving an agent's pi model: the resolved `Model` + display label, or a fail-soft error. */
export interface ResolvedTeamModel {
  model?: Model<Api>;
  /** Short display label for the agent card's model line. */
  modelLabel?: string;
  /** Fixed reasoning depth for this agent's session (Anthropic policy only; unset elsewhere). */
  thinkingLevel?: ThinkingLevel;
  /** Set when resolution failed (unavailable / unauthed / out-of-scope) — the caller falls back. */
  error?: string;
}

/** Options for building a nested pi team agent session (model/tools/prompt/gate resolved by TeamRunner). */
export interface TeamSessionOptions {
  cwd: string;
  systemPrompt: string;
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  tools: string[];
  customTools: ToolDefinition[];
  excludeTools?: string[];
  extensionFactory: import('@earendil-works/pi-coding-agent').ExtensionFactory;
}

/**
 * The pi-native engine PiSession supplies the team (US-024d): how to build/dispose a nested agent
 * session, the agent active-set tool names + customTools builder, the gate-routing extension factory
 * (inherit-parent-mode), and the budget cost rollup. Decoupled from PiSession so the runner is testable
 * against a mock engine.
 */
export interface TeamEngine {
  /** Build a nested pi agent session (auto-compaction off, isolated settings). */
  createSession: (opts: TeamSessionOptions) => Promise<AgentSession>;
  /** Dispose and forget a nested team agent session (on completion / abort). */
  forgetSession: (session: AgentSession) => void;
  /** The active-set tool names a team agent may use (built-ins + module tools, no subagent/team-main tools). */
  agentToolNames: () => string[];
  /** Build a team agent's customTools (Edit/PowerShell/Task* + memory/compass/browser + the 12 team_* tools). */
  buildAgentCustomTools: (ctx: AgentMcpContext) => ToolDefinition[];
  /** The gate-routing extension factory for a team agent (inherit-parent-mode central gate). */
  buildExtensionFactory: (agentName: string, agentId: string) => import('@earendil-works/pi-coding-agent').ExtensionFactory;
  /** Roll a team agent session's cost delta (USD) into the panel budget meter. */
  onAgentCost: (deltaUsd: number) => void;
}

export interface TeamConfig {
  teamId: string;
  toolUseId: string;
  title: string;
  agents: AgentSpec[];
  cwd: string;
  persistenceSessionId: string;
  permissionMode: TeamPermissionMode;
  systemPromptSuffix?: string;
  /** Resolve the lead's pi model — the flagship authed model of the active panel backend (US-024c). */
  resolveLeadModel: () => ResolvedTeamModel;
  /**
   * Resolve a specialist's pi model: explicit `value` honored when its provider is authed, else fall
   * soft to the active panel model. `undefined` value → the active model (US-024c). `kind` sets the
   * Anthropic thinking depth (implementor → high, reviewer → xhigh); ignored on other backends.
   */
  resolveSpecialistModel: (value: string | undefined, kind?: SpecialistKind) => ResolvedTeamModel;
  /** Specialist whitelist for this team — the curated model values the spawn tool advertises/validates. */
  allowedSpecialistModels: readonly string[];
  /** Whether specialist models are policy-forced (Anthropic): the spawn tool ignores an explicit `model`
   *  arg instead of rejecting it against the (Opus-only) whitelist. */
  specialistModelForced: boolean;
  /** The pi-native session/tools/gate/cost engine PiSession supplies. */
  engine: TeamEngine;
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
  /** The agent's opening task — sent as the first `session.prompt(...)`. */
  specialization: string;
  /** Build the nested pi agent session (model/tools/prompt/factory already resolved by TeamRunner). */
  createSession: () => Promise<AgentSession>;
  /** Dispose the nested session when the agent finishes (or aborts). */
  forgetSession: (session: AgentSession) => void;
  abortSignal: AbortSignal;
  messageBus: MessageBus;
  onMessage: (msg: ExtensionToWebviewMessage) => void;
  teamId: string;
  persistence: TeamPersistenceWriter;
  /**
   * Whether the agent should stay idle-waiting for more peer messages after a turn ends (no SDK keep-
   * alive timers — a pi idle session waits at zero cost). When false at a turn boundary the agent
   * session ends. Re-checked on every turn boundary and on every delivered message.
   */
  keepAlive?: () => boolean;
  /** Called when a turn ends and the agent enters its wait state (emit monitoring/standby/awaiting-review). */
  onTurnEnd?: () => void;
  /** Called when a delivered message wakes the agent out of its wait state (emit running). */
  onKeepAliveResume?: () => void;
  /** Filter MessageBus deliveries before re-prompting (e.g. suppress broadcasts to a confirmed-complete agent). */
  shouldDeliverMessage?: (msg: { from: string; to: string | null }) => boolean;
  /** Per-tool-call hook (drives the agent's live tool-count). */
  onToolCall?: (toolName: string, toolCallCount: number) => void;
  /** Per-turn usage snapshot (token totals + session cost). */
  onUsageUpdate?: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }) => void;
  /** Roll the agent session's cost delta (USD) into the panel budget meter. */
  onCost?: (deltaUsd: number) => void;
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

export interface AgentMcpContext {
  agentId: string;
  agentName: string;
  role: 'lead' | 'specialist';
  /** Tier-aligned specialist whitelist from TeamConfig — used by the spawn tool's validation. */
  allowedSpecialistModels: readonly string[];
  /** Whether specialist models are policy-forced (Anthropic) — the spawn tool ignores an explicit `model`. */
  specialistModelForced: boolean;
  messageBus: MessageBus;
  scratchpad: Scratchpad;
  startSpecialist: (name: string, task: string, model?: string, profileId?: string, kind?: SpecialistKind) => string;
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

