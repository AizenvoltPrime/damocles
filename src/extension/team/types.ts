import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { MessageBus } from './message-bus';
import type { Scratchpad } from './scratchpad';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { NestedMcpToolset } from '../pi-session/tools/mcp-tools';

/** Selects which role slot a spawned specialist runs under — `implementor` or `reviewer` role settings
 *  (model + reasoning effort), set by the lead on spawn. Re-exported from the resolver, which itself
 *  re-exports the shared single source of truth in `shared/types/settings`. */
export type { SpecialistKind, TeamRole } from '../pi-session/team-model-resolution';
import type { SpecialistKind, TeamRole } from '../pi-session/team-model-resolution';

export type AgentRole = 'lead' | 'specialist';

export interface AgentSpec {
  name: string;
  role: AgentRole;
  specialization?: string;
}

export type TeamPermissionMode = 'default' | 'acceptEdits' | 'plan';

/** Outcome of resolving an agent's pi model: the resolved `Model` + display label, or a blocking error. */
export interface ResolvedTeamModel {
  model?: Model<Api>;
  /** Short display label for the agent card's model line. */
  modelLabel?: string;
  /** Reasoning depth for this agent's session, derived from the role's configured effort setting
   *  (coerced against the resolved model's supported levels); unset when no effort applies. */
  thinkingLevel?: ThinkingLevel;
  /** Set when a CONFIGURED slot is unavailable / unauthed — a blocking error the caller throws (team
   *  creation for the lead, spawn-tool error for a specialist). Never set for an unset (fail-soft) slot. */
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
  /**
   * Everything a team agent's session is built from, in ONE call: its active-set tool names (built-ins
   * + module tools, no subagent/team-main tools), its customTools (Edit/PowerShell/Task* +
   * memory/compass/browser + the `team_*` tools, with the MCP definitions already appended), and the
   * frozen MCP snapshot the names/gate/ToolSearch inventory all derive from.
   *
   * One call, not three. The names, the definitions and the gate context used to be read
   * independently inside a single spawn-time object literal, so an `mcp__*` name could reach `tools:`
   * with no matching definition — which pi drops SILENTLY (no error, no warning, no log). A single
   * call makes them structurally incapable of diverging.
   */
  buildAgentToolset: (ctx: AgentMcpContext) => {
    toolNames: string[];
    customTools: ToolDefinition[];
    mcp: NestedMcpToolset;
  };
  /** The gate-routing extension factory for a team agent (inherit-parent-mode central gate). Takes the
   *  spawn's frozen `mcp` snapshot so the gate's read-only classifier and the nested ToolSearch
   *  inventory come from the same read as the agent's `tools:`. */
  buildExtensionFactory: (agentName: string, agentId: string, mcp: NestedMcpToolset) => import('@earendil-works/pi-coding-agent').ExtensionFactory;
  /** Roll a team agent session's cost delta (USD) into the panel budget meter. */
  onAgentCost: (deltaUsd: number) => void;
  /** Dispose a team agent's browser tab scope at its run-settle point. `closeTabs` closes its tabs only
   *  on SUCCESS; a failed/cancelled agent keeps its tab open for inspection. Required: every team agent
   *  binds browser tools to a scope, so failing to wire the matching teardown leaks tabs. An engine
   *  running without a browser service supplies a no-op explicitly. Takes the agent's per-attempt
   *  BROWSER SCOPE id (see {@link AgentMcpContext.browserScopeId}) — not its agentId. */
  disposeBrowserScope: (browserScopeId: string, closeTabs: boolean) => void;
  /** Withdraw this team agent's in-flight MCP elicitation dialogs from the parent panel at its
   *  run-settle point. Takes the AGENT ID, not the browser scope id: a dialog is attributed to the
   *  agent the user sees, and a redispatch reuses the agentId while minting a new scope id. Required
   *  for the same reason as `disposeBrowserScope` — every team agent's MCP tools are handed an
   *  attributed dialog bridge, so a missing teardown strands a modal naming a dead agent and hangs
   *  whatever is awaiting it. An engine running without a UI bridge supplies a no-op explicitly. */
  cancelAgentDialogs: (agentId: string) => void;
}

export interface TeamConfig {
  teamId: string;
  toolUseId: string;
  title: string;
  /** The team's authoritative specification — single source of truth (spec / acceptance criteria /
   *  architecture). Seeded verbatim into the lead prompt and the immutable `mission-brief` scratchpad. */
  brief: string;
  agents: AgentSpec[];
  cwd: string;
  persistenceSessionId: string;
  permissionMode: TeamPermissionMode;
  /** Resolve a team role's pi model + reasoning depth from the user's per-role settings (lead /
   *  implementor / reviewer). A configured-but-unresolvable/unauthed slot returns `{ error }`; an unset
   *  slot fails soft to the active panel model. */
  resolveRoleModel: (role: TeamRole) => ResolvedTeamModel;
  /** The pi-native session/tools/gate/cost engine PiSession supplies. */
  engine: TeamEngine;
}

export interface TeamAgent {
  agentId: string;
  teamId: string;
  name: string;
  role: AgentRole;
  /** 0-based launch counter. `redispatchSpecialist` reuses `agentId` (to preserve the card and the
   *  transcript) but every attempt gets its own browser scope, so this disambiguates them. */
  attempt: number;
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
  /** Structural discriminator for delivery policy. This is the INTERNAL bus type — distinct from the
   *  webview contract type in `shared/types/team.ts`, and both the JSONL writer and the webview mapper
   *  pick fields explicitly, so this field reaches neither. Branching on it (rather than on rendered
   *  text) means a peer message mimicking the notice prefix cannot spoof a delivery decision.
   *
   *  - `scratchpad-notice`: a peer wrote a section. Delivered only to a specialist in standby, whose
   *    entire purpose is to wake on peer content.
   *  - `ledger-notice`: a peer recorded a verification run. Delivered to NOBODY. The ledger is a pull
   *    surface by contract (`team_record_verification` returns it, and the prompts tell agents to read
   *    it before a run), and a peer's test run cannot advance a standby agent waiting on findings — so
   *    pushing it would only re-prompt whole conversations to no effect. It is still broadcast so it
   *    reaches persistence, the webview timeline and `team_read_messages`. */
  kind?: 'scratchpad-notice' | 'ledger-notice';
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
  /**
   * Publishes this run's note sink and returns its teardown. The runner registers on start and tears
   * the registration down beside the bus unsubscribe, so a note arriving after the run is refused
   * rather than resolved against a dead session. Required, not an optional hook: a construction site
   * that forgets it is exactly how a user note goes back to vanishing with no echo.
   */
  bindNoteDelivery: (deliver: (text: string) => boolean) => () => void;
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
  /**
   * Specialist-only hook fired at the keepAlive-false boundary, BEFORE the wait loop breaks. It may arm
   * a grace hold that flips keepAlive back true (parking the agent for one more turn instead of ending).
   * The runner re-checks keepAlive immediately after; if still false, the session genuinely ends.
   */
  onReconcileBeforeEnd?: () => void;
  /** Called when a delivered message wakes the agent out of its wait state (emit running). */
  onKeepAliveResume?: () => void;
  /** Filter MessageBus deliveries before re-prompting (e.g. suppress broadcasts to a confirmed-complete
   *  agent, or a scratchpad notice to an agent that is not waiting for peer content). */
  shouldDeliverMessage?: (msg: { from: string; to: string | null; kind?: TeamMessage['kind'] }) => boolean;
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
  /**
   * The browser tab scope this agent's browser tools bind to: `${agentId}#${attempt}`.
   *
   * NOT `agentId`. A failed specialist keeps its tabs open for inspection while its scope entry is
   * dropped, and `redispatchSpecialist` reuses the agentId — so a retry bound to the bare agentId would
   * inherit the dead attempt's tabs (listed but undrivable) and a later success would close them,
   * destroying the very evidence the keep-open-on-failure policy exists to preserve.
   */
  browserScopeId: string;
  agentName: string;
  /** The owning team, carried into this agent's MCP elicitation attribution alongside agentId/agentName. */
  teamId: string;
  role: 'lead' | 'specialist';
  messageBus: MessageBus;
  scratchpad: Scratchpad;
  /**
   * Delivers a user-authored note straight to this agent's live run, echoing it to the overlay exactly
   * once. Returns false when no live runner consumed it, so the caller can report the failure instead
   * of assuming delivery. Deliberately not the MessageBus: the bus drops a note silently when the run's
   * `unsubscribeBus()` has already fired, and again when the sender token equals this agent's own name.
   */
  deliverUserNote: (text: string) => boolean;
  startSpecialist: (name: string, task: string, profileId?: string, kind?: SpecialistKind) => string;
  /** Re-run a failed/cancelled specialist as a fresh attempt (reuses agentId, preserves transcript). */
  redispatchSpecialist: (name: string, task: string, profileId?: string, kind?: SpecialistKind) => string;
  /** Mechanical read-gate: the lead cannot spawn until it has read the immutable `mission-brief`. */
  checkBriefReadGate: () => { ok: boolean; error?: string };
  /** Whether a message to `name` can be delivered now — false (with guidance) for undeliverable statuses. */
  checkMessageDeliverable: (name: string) => { ok: boolean; error?: string };
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
  /**
   * Append one entry to the shared `verification` ledger. The caller supplies only the rendered entry —
   * the tree fingerprint is computed by the tool from git state, never taken from the agent, because a
   * self-reported fingerprint would make a reused result unsound.
   */
  recordVerification: (entry: string) => { version: number };
  /** The current ledger text (empty when nothing has been recorded yet). */
  readVerificationLedger: () => string;
  /** Specialist raises a hard conflict with the authoritative brief (blocks explicit synthesis). */
  flagBriefConflict: (name: string, detail: string) => void;
  /** Lead dismisses a specialist's brief-conflict flag with a written rationale (accountable record). */
  resolveBriefConflict: (name: string, resolution: string) => void;
  /** Open (unresolved) brief conflicts — drives the synthesis tool gate + fail-loud completion. */
  getOpenBriefConflicts: () => Array<{ name: string; detail: string }>;
  recordCancelAttempt?: (name: string) => void;
  getCancelAttemptTimestamp?: (name: string) => number | undefined;
  getRecentlyCancelledNames?: () => string[];
}

