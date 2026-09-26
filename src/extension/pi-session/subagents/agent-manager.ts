/**
 * agent-manager.ts — Tracks subagents, background execution with a concurrency cap, steering, abort.
 *
 * Adapted from @tintinweb/pi-subagents `agent-manager.ts` (MIT, © 2026 tintinweb; see
 * THIRD-PARTY-NOTICES.md). Worktree isolation and group-join are dropped. Each subagent runs in its own
 * pi session file under the parent session's `subagents/` folder (see `agent-records.ts`), which is its
 * only message record and what a later resume reopens. The manager is a per-`PiSession` cross-turn
 * singleton, so `run_in_background` agents outlive the spawning turn. The per-spawn run orchestration
 * (prompt build, toolset resolution, session creation, stream bridge) is driven through an injected
 * `SubagentEngine` so model policy + budget rollup stay owned by PiSession.
 */

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { AgentSession, ExtensionFactory, SessionEntry, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PermissionHandler } from '../../permission-handler';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { SteerTargetInfo } from '../../../shared/types/subagents';
import { buildResumePrompt, wrapSteerMessage } from '../../../shared/steer';
import { TEAM_CREATE_TOOL } from '../../../shared/tool-names';
import { log } from '../../logger';
import { PI_EXCLUDED_TOOLS } from '../pi-models';
import type { PiCreateSubagentSessionOptions } from '../folder-runtime';
import type { DispatchDeps } from '../hooks';
import { deferredToolNames } from '../tools/deferred-tools';
import type { NestedMcpToolset } from '../tools/mcp-tools';
import { COMPASS_PI_TOOL_NAMES } from '../tools/compass-tools';
import { COMPASS_AGENT_PROMPT } from '../../compass/system-prompt';
import { AgentRegistry } from './agent-types';
import { buildAgentPrompt, buildPlanMechanismBlock, type PromptExtras } from './prompts';
import { detectEnv } from './env';
import { preloadSkills } from './skill-loader';
import { resolveAgentToolset } from './agent-toolset';
import {
  findAgentFile,
  isResumableSubagentStatus,
  readAgentFile,
  subagentBranchIndex,
  subagentLatestState,
  terminalAgentStatus,
  toolCallArgumentsOnBranch,
  type AgentInvocationData,
  type AgentSegmentData,
  type AgentStatusData,
  type AgentStopReason,
  type LiveAgentStatus,
  type SubagentBranchIndex,
  type SubagentLatestState,
  type SubagentLaunchData,
} from '../agent-records';
import { DAMOCLES_AGENT_LAUNCH_ENTRY, DAMOCLES_AGENT_SEGMENT_ENTRY, DAMOCLES_AGENT_STATUS_ENTRY } from '../session-store/constants';
import { createSubagentExtensionFactory } from './subagent-extension-factory';
import { SubagentStreamBridge, buildAgentResultJson } from './subagent-stream-bridge';
import { runSubagent, getAgentConversation } from './subagent-runner';
import { getStatusNote } from './status-note';
import { addUsage, getLifetimeTotal } from './usage';
import { PLAN_AGENT_NAME, isThinkingOverride, type AgentConfig, type AgentRecord, type PendingSteer, type SubagentType, type ThinkingLevel } from './types';
import { extractImages } from '../branch-text';
import type { ImageBlock } from '../../../shared/types/content';
import { emptyAgentUsage, type AgentUsageTotals } from '../../../shared/usage-accounting';

export const DEFAULT_MAX_CONCURRENT = 4;

/** `randomUUID().slice(0, 17)`: 8 hex, dash, 4 hex, dash, the v4 version nibble and 2 hex. Keep the
 *  pattern in step with `newSubagentId`; ids reach `isSubagentId` from the model. */
const SUBAGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{2}$/;

function newSubagentId(): string {
  return randomUUID().slice(0, 17);
}

export function isSubagentId(id: string): boolean {
  return SUBAGENT_ID.test(id);
}

/** Outcome of resolving a model for a spawn. */
export interface ResolvedSubagentModel {
  model?: Model<Api>;
  /** Short label for the card's model line (e.g. "haiku"), when known. */
  modelLabel?: string;
  thinkingLevel?: ThinkingLevel;
  /** Set only by the Explore-section resolution when the user's effort setting yielded a `thinkingLevel`:
   *  makes that level a hard guarantee that beats a per-spawn `spec.thinking`. */
  enforceThinking?: boolean;
  /** Whether the model bills real dollars. Unset when unknown, so the card falls back to the panel's flag. */
  dollarBilled?: boolean;
  /** Set when resolution failed (out-of-scope / unauthed) — the spawn fails soft with this message. */
  error?: string;
}

/** Everything the manager needs to run one subagent, owned by PiSession (decoupled for testability). */
export interface SubagentEngine {
  cwd: string;
  registry: AgentRegistry;
  createSession: (opts: PiCreateSubagentSessionOptions) => Promise<AgentSession>;
  forgetSession: (session: AgentSession) => void;
  permissionHandler: PermissionHandler;
  isPlanMode: () => boolean;
  postMessage: (message: ExtensionToWebviewMessage) => void;
  /** The parent panel's effective system prompt (for append-mode agents). */
  getParentSystemPrompt: () => string;
  /** The parent panel's session id, which the webview keys streamed subagent events by. */
  getParentSessionId: () => string;
  /** The parent session's `subagents/` folder, where each subagent's pi session file is created. */
  subagentStoreDir: () => string;
  /** Append a `damocles-agent-invocation` entry to the parent session. Called before the agent starts. */
  recordInvocation: (data: AgentInvocationData) => void;
  /** The parent session's current branch: the only index of the agents this conversation invoked. */
  parentBranch: () => readonly SessionEntry[];
  /** Throw the resume error unless the model recorded in the agent session file at `path` is usable. */
  assertResumableModel: (path: string, agentId: string) => void;
  /** The parent panel's full active tool-name set (for `*`/general-purpose agents). */
  parentFullToolNames: () => string[];
  /** Build the subagent's customTools (Edit, PowerShell, Task tools, memory/compass/browser) — NOT the
   *  subagent tools — TOGETHER WITH its frozen MCP snapshot, in ONE call. `agentId` binds this
   *  subagent's browser tools to its OWN isolated tab scope AND owns its MCP elicitation dialogs in the
   *  parent panel; `agentName` is what those dialogs are attributed to (untrusted — sanitized where it
   *  is captured, not here); `mcpDisallowed` is the agent's `disallowed_tools` (exact-case) subtracted
   *  from the MCP grant.
   *
   *  One call, not two: the returned `customTools` already contains `mcp.tools`, so the `tools:` names
   *  and the definitions behind them come from a single read and cannot diverge. Two reads is the bug
   *  this shape exists to prevent — an `mcp__*` name reaching `tools:` with no matching definition is
   *  dropped by pi SILENTLY (no error, no warning, no log). */
  buildAgentToolset: (input: { agentId: string; agentName: string; mcpDisallowed: ReadonlySet<string> }) => {
    customTools: ToolDefinition[];
    mcp: NestedMcpToolset;
  };
  /** Dispose this subagent's browser tab scope on completion. `closeTabs` closes its tabs only on
   *  SUCCESS; errored/stopped subagents keep their tabs open for inspection. Required: every subagent
   *  binds browser tools to a scope, so failing to wire the matching teardown leaks tabs. A manager
   *  running without a browser service supplies a no-op explicitly. */
  disposeBrowserScope: (agentId: string, closeTabs: boolean) => void;
  /** Withdraw this subagent's in-flight MCP elicitation dialogs from the parent panel at its settle
   *  point. Required for the same reason as `disposeBrowserScope`: every subagent's MCP tools are
   *  handed an attributed dialog bridge, so a missing teardown strands a modal naming a dead agent and
   *  hangs whatever is awaiting it. A manager running without a UI bridge supplies a no-op explicitly. */
  cancelAgentDialogs: (agentId: string) => void;
  /** Resolve a spawn's model per §4.9 (config.model > Explore selection > parent session model). */
  resolveModel: (input: { agentConfig: AgentConfig }) => ResolvedSubagentModel;
  /** Whether a pi model bills real dollars, for a reopened session whose model the runtime restored. */
  modelDollarBilled: (model: Model<Api>) => boolean;
  /** Roll a subagent cost delta (USD) into the panel's budget meter. */
  onSubagentCost: (costDeltaUsd: number) => void;
  /** Configured-hooks dispatch deps (US-008) — fires PreToolUse/PostToolUse/subagent_end for this subagent. */
  getHooksDispatch?: () => DispatchDeps | undefined;
}

/** A spawn request. `toolCallId` is the spawning `Agent` tool-call id (the webview subagent-card key). */
export interface SpawnRequest {
  kind: 'spawn';
  type: SubagentType;
  prompt: string;
  description: string;
  toolCallId: string;
  thinking?: ThinkingLevel;
  runInBackground: boolean;
  /** Parent abort signal (foreground synchronous spawn) — aborts this subagent when the parent turn does. */
  signal?: AbortSignal;
}

/** Continue an interrupted subagent under its own id. `toolCallId` is the resuming `Agent` call. */
export interface ResumeRequest {
  kind: 'resume';
  agentId: string;
  message?: string;
  toolCallId: string;
  /** Parent abort signal. Bound only when the resumed agent runs in the foreground. */
  signal?: AbortSignal;
}

/** A validated resume: the agent file to reopen, or null to re-run it fresh from `launch`. */
export interface ResumeTarget {
  agentId: string;
  path: string | null;
  launch: SubagentLaunchData;
}

/** What the queue holds and a start runs: a spawn, or a resume that already passed validation. */
type RunSpec = SpawnRequest | (ResumeRequest & { target: ResumeTarget });

function runType(spec: RunSpec): SubagentType {
  return spec.kind === 'spawn' ? spec.type : spec.target.launch.agentType;
}

function runInBackground(spec: RunSpec): boolean {
  return spec.kind === 'spawn' ? spec.runInBackground : spec.target.launch.background;
}

/** The system prompt, toolset and gate factory for one run, rebuilt from the current template and mode. */
interface PreparedRun {
  systemPrompt: string;
  eligibleToolNames: string[];
  customTools: ToolDefinition[];
  extensionFactory: ExtensionFactory;
}

function deliverSteer(session: AgentSession, steer: PendingSteer): Promise<void> {
  return steer.images ? session.steer(steer.text, extractImages(steer.images)) : session.steer(steer.text);
}

function stillActiveError(id: string, status: string): Error {
  return new Error(`Subagent "${id}" is still ${status}; steer it with SteerSubagent or read it with GetSubagentResult.`);
}

function alreadyResumingError(id: string): Error {
  return new Error(`Subagent "${id}" is already being resumed by another Agent call; wait for that call's result.`);
}

function notResumableError(id: string, state: Pick<SubagentLatestState, 'status' | 'stopReason'>): Error {
  if (state.status === 'stopped' && state.stopReason === 'budget') {
    return new Error(`Subagent "${id}" was stopped by the budget limit and cannot be resumed.`);
  }
  if (state.status === 'stopped' && state.stopReason === 'reset') {
    return new Error(`Subagent "${id}" was stopped when its conversation was cleared and cannot be resumed.`);
  }
  return new Error(`Subagent "${id}" finished with status "${state.status}"; only interrupted agents can be resumed.`);
}

function unknownResumeError(id: string): Error {
  return new Error(`No interrupted subagent "${id}" in this conversation.`);
}

export class AgentManager {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly bridges = new Map<string, SubagentStreamBridge>();
  private readonly engine: SubagentEngine;
  private maxConcurrent: number;
  private readonly queue: { id: string; spec: RunSpec }[] = [];
  /** Ids claimed by a resume between validation and the resumed record being tracked. */
  private readonly resuming = new Set<string>();
  /** Total concurrent subagents (foreground + background) that have started — capped at maxConcurrent. */
  private running = 0;
  /** Resolves each record's lifetime `promise` exactly once at its terminal state. Created at spawn so a
   *  spawn that never reaches `startRecord` (queued, then aborted) still settles its awaiters. */
  private readonly doneResolvers = new Map<string, (text: string) => void>();
  private disposed = false;
  /** Bumped by `abortAll`, so a resume that was validating across an ESC, reset or dispose never starts. */
  private abortEpoch = 0;

  constructor(engine: SubagentEngine, maxConcurrent: number = DEFAULT_MAX_CONCURRENT) {
    this.engine = engine;
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /** The tracked record's status, tied to the invocation it ran for. */
  liveStatus(id: string): LiveAgentStatus | undefined {
    const record = this.agents.get(id);
    if (!record) return undefined;
    return { toolCallId: record.toolCallId, status: record.status, ...(record.stopReason ? { stopReason: record.stopReason } : {}) };
  }

  /** The currently running + queued subagents, for the `/steer` second-stage picker. */
  listActive(): SteerTargetInfo[] {
    return [...this.agents.values()]
      .filter((r) => r.status === 'running' || r.status === 'queued')
      .map((r) => ({
        kind: 'subagent' as const,
        id: r.id,
        agentType: r.type,
        description: r.description,
        status: r.status as 'running' | 'queued',
        isBackground: r.background ?? false,
      }));
  }

  /** The spawnable agent types (name + description) for the `Agent` tool's `subagent_type` advertisement. */
  getSpawnableAgents(): { name: string; description: string }[] {
    return this.engine.registry.getAvailableConfigs().map((c) => ({ name: c.name, description: c.description }));
  }

  /**
   * Effective background flag for a spawn. An explicit `run_in_background` on the `Agent` call always
   * wins; when omitted, the agent template's frontmatter default (`run_in_background:`) applies, else
   * foreground. Resolved here (not in the tool) because the sync-vs-async branch is chosen before spawn.
   */
  resolveRunInBackground(type: SubagentType, paramValue: boolean | undefined): boolean {
    if (paramValue !== undefined) return paramValue;
    return this.engine.registry.getAgentConfig(type)?.runInBackground ?? false;
  }

  /** Spawn a background subagent and return its id immediately. Queues if at the concurrency cap. */
  spawn(spec: SpawnRequest): string {
    const id = newSubagentId();
    this.engine.recordInvocation({ kind: 'subagent', id, toolCallId: spec.toolCallId, resume: false });
    this.enqueueOrStart(id, spec);
    return id;
  }

  /** Spawn a foreground subagent and await completion. Shares the single concurrency cap with background
   *  spawns — queues for a slot when at capacity rather than launching unconditionally. */
  async spawnAndWait(spec: SpawnRequest): Promise<AgentRecord> {
    const id = newSubagentId();
    this.engine.recordInvocation({ kind: 'subagent', id, toolCallId: spec.toolCallId, resume: false });
    const record = this.enqueueOrStart(id, spec);
    await record.promise;
    return record;
  }

  /**
   * Continue an interrupted subagent under its own id, through the same queue and cap as a spawn. Returns
   * once it is running or queued; await `record.promise` for the result. Throws the validation errors
   * verbatim.
   */
  async resume(request: ResumeRequest): Promise<AgentRecord> {
    const epoch = this.abortEpoch;
    const target = await this.resolveResume(request.agentId);
    try {
      if (this.disposed || epoch !== this.abortEpoch) {
        throw new Error(`The resume of subagent "${target.agentId}" was stopped before it started; it can still be resumed.`);
      }
      this.engine.recordInvocation({ kind: 'subagent', id: target.agentId, toolCallId: request.toolCallId, resume: true });
      const { signal, ...rest } = request;
      return this.enqueueOrStart(target.agentId, { ...rest, target, ...(signal && !target.launch.background ? { signal } : {}) });
    } finally {
      this.resuming.delete(target.agentId);
    }
  }

  /**
   * Validate a resume and claim the id. The claim is taken before the first `await`, so of two parallel
   * resumes of one id only the first gets past it. It is released on failure here, or by `resume` once
   * the resumed record is tracked as running or queued.
   */
  private async resolveResume(agentId: string): Promise<ResumeTarget> {
    if (!isSubagentId(agentId)) throw new Error(`"${agentId}" is not a valid subagent id.`);
    const branch = this.engine.parentBranch();
    const index = subagentBranchIndex(branch);
    if (!index.invocations.some((inv) => inv.id === agentId)) throw unknownResumeError(agentId);
    if (this.resuming.has(agentId)) throw alreadyResumingError(agentId);
    const existing = this.agents.get(agentId);
    if (existing && (existing.status === 'running' || existing.status === 'queued')) throw stillActiveError(agentId, existing.status);
    this.resuming.add(agentId);
    try {
      // A stopped run may still be winding down and appending to its file.
      await existing?.promise;
      const path = await findAgentFile(this.engine.subagentStoreDir(), agentId);
      const file = path ? await readAgentFile(path) : null;
      const state = subagentLatestState(index, agentId, file, this.liveStatus(agentId));
      if (!state) throw unknownResumeError(agentId);
      if (state.status === 'running' || state.status === 'queued') throw stillActiveError(agentId, state.status);
      if (!isResumableSubagentStatus(state)) throw notResumableError(agentId, state);
      let launch: SubagentLaunchData;
      if (file) {
        if (file.launch.kind !== 'subagent') throw unknownResumeError(agentId);
        launch = file.launch;
      } else {
        launch = this.launchFromSpawnCall(agentId, branch, index, state, existing?.background);
      }
      if (!this.engine.registry.getAgentConfig(launch.agentType) || !this.engine.registry.isValidType(launch.agentType)) {
        throw new Error(`Subagent "${agentId}" was a "${launch.agentType}" agent, which is no longer available.`);
      }
      if (path) this.engine.assertResumableModel(path, agentId);
      return { agentId, path, launch };
    } catch (err) {
      this.resuming.delete(agentId);
      throw err;
    }
  }

  /** Rebuild the launch of an agent that stopped before its first response, so it has no file, from the
   *  arguments of the `Agent` call that spawned it. */
  private launchFromSpawnCall(
    agentId: string,
    branch: readonly SessionEntry[],
    index: SubagentBranchIndex,
    state: SubagentLatestState,
    liveBackground: boolean | undefined,
  ): SubagentLaunchData {
    const args = state.spawn ? toolCallArgumentsOnBranch(branch, state.spawn.toolCallId) : undefined;
    const description = args?.['description'];
    const prompt = args?.['prompt'];
    const agentType = args?.['subagent_type'];
    if (!state.spawn || typeof description !== 'string' || typeof prompt !== 'string' || typeof agentType !== 'string') {
      throw unknownResumeError(agentId);
    }
    const thinking = args?.['thinking'];
    const requested = args?.['run_in_background'];
    const spawnDetails = index.toolDetails.get(state.spawn.toolCallId);
    const background =
      liveBackground ??
      (spawnDetails ? spawnDetails.status === 'async_launched' : this.resolveRunInBackground(agentType, typeof requested === 'boolean' ? requested : undefined));
    return {
      agentId,
      kind: 'subagent',
      agentType,
      description,
      prompt,
      background,
      ...(isThinkingOverride(thinking) ? { thinkingOverride: thinking } : {}),
    };
  }

  /** Create a record and either start it (slot free) or queue it (at the cap). */
  private enqueueOrStart(id: string, spec: RunSpec): AgentRecord {
    const willQueue = this.running >= this.maxConcurrent;
    const record = this.newRecord(id, spec, willQueue);
    this.agents.set(id, record);
    if (willQueue) {
      this.queue.push({ id, spec });
    } else {
      this.startRecord(id, record, spec);
    }
    return record;
  }

  /**
   * Steer a running subagent. Returns a status the SteerSubagent tool reports back. The message is
   * tagged with the priority marker before injection so the subagent (guided by its system prompt)
   * treats it as an absolute-priority override of its current task, not an optional note. Applies to
   * both user (`/steer`) and model (`SteerSubagent`) steers — the single delivery chokepoint.
   */
  async steer(id: string, message: string, images?: ImageBlock[]): Promise<'steered' | 'queued' | 'not-found' | 'finished' | 'failed'> {
    const record = this.agents.get(id);
    if (!record) return 'not-found';
    const wrapped = { text: wrapSteerMessage(message), ...(images?.length ? { images } : {}) };
    if (record.status === 'queued') {
      (record.pendingSteers ??= []).push(wrapped);
      return 'queued';
    }
    if (record.status !== 'running') return 'finished';
    if (record.session) {
      try {
        await deliverSteer(record.session, wrapped);
      } catch (err) {
        log('[AgentManager] steer failed for %s: %O', id, err);
        return 'failed';
      }
      // The run() completion path can settle this record while steer() is in flight; a message handed to
      // an already-finished turn was never processed, so report 'finished' (no chip/parent-note is owed).
      if (record.status !== 'running') return 'finished';
      return 'steered';
    }
    (record.pendingSteers ??= []).push(wrapped);
    return 'queued';
  }

  /** Get a subagent's conversation transcript (for GetSubagentResult verbose mode). */
  getConversation(id: string): string {
    const session = this.agents.get(id)?.session;
    return session ? getAgentConversation(session) : '';
  }

  /** Whether any background subagent is still running or queued. */
  hasPendingBackground(): boolean {
    for (const r of this.agents.values()) {
      if (r.background && (r.status === 'running' || r.status === 'queued')) return true;
    }
    return false;
  }

  /**
   * Whether any background subagent has a result the parent has not yet incorporated — still
   * running/queued, OR terminal-but-unconsumed (it finished mid-turn but was never fetched via
   * GetSubagentResult). Drives the parent keep-alive hold: gating on this (not hasPendingBackground)
   * is what stops a background result that completes during the turn from being silently dropped.
   */
  hasUnconsumedBackground(): boolean {
    for (const r of this.agents.values()) {
      if (r.background && !r.resultConsumed) return true;
    }
    return false;
  }

  /** Await every running/queued background subagent to a terminal state (re-checks as the queue drains,
   *  so a queued agent that starts mid-wait is also awaited). Settles on abort too (deferreds resolve). */
  async waitForBackground(): Promise<void> {
    while (true) {
      const pending = [...this.agents.values()]
        .filter((r) => r.background && (r.status === 'running' || r.status === 'queued'))
        .map((r) => r.promise)
        .filter((p): p is Promise<string> => p !== undefined);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /** Settles once every tracked run has finished writing its session file, including runs `abortAll`
   *  has marked stopped but that are still winding down. Call before `clearCompleted` drops them. */
  whenRunsSettled(): Promise<void> {
    const runs = [...this.agents.values()].map((r) => r.promise).filter((p): p is Promise<string> => p !== undefined);
    return Promise.allSettled(runs).then(() => undefined);
  }

  /** Take terminal, not-yet-consumed background subagent records (marks them consumed). For the parent
   *  keep-alive: their results are injected back into the parent once, then never re-injected. */
  takeCompletedBackgroundResults(): AgentRecord[] {
    const out: AgentRecord[] = [];
    for (const r of this.agents.values()) {
      const terminal = r.status !== 'running' && r.status !== 'queued';
      if (r.background && terminal && !r.resultConsumed) {
        r.resultConsumed = true;
        out.push(r);
      }
    }
    return out;
  }

  private newRecord(id: string, spec: RunSpec, queued: boolean): AgentRecord {
    const record: AgentRecord = {
      id,
      type: runType(spec),
      description: spec.kind === 'spawn' ? spec.description : spec.target.launch.description,
      status: queued ? 'queued' : 'running',
      toolUses: 0,
      startedAt: Date.now(),
      abortController: new AbortController(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      usage: emptyAgentUsage(),
      compactionCount: 0,
      toolCallId: spec.toolCallId,
      background: runInBackground(spec),
    };
    // The executor runs synchronously, so the resolver is registered before this returns.
    record.promise = new Promise<string>((resolve) => this.doneResolvers.set(id, resolve));
    return record;
  }

  /** Resolve a record's lifetime promise once, with its final result text. No-op if already settled. */
  private settleDone(id: string, text: string): void {
    const resolve = this.doneResolvers.get(id);
    if (!resolve) return;
    this.doneResolvers.delete(id);
    resolve(text);
  }

  /** Begin running a subagent record (immediate spawn or queue drain). */
  private startRecord(id: string, record: AgentRecord, spec: RunSpec): void {
    record.status = 'running';
    record.startedAt = Date.now();
    this.running++;

    const type = runType(spec);
    const background = runInBackground(spec);
    const config = this.engine.registry.getAgentConfig(type);
    const bridge = new SubagentStreamBridge({
      parentToolUseId: spec.toolCallId,
      agentId: id,
      agentType: config?.name ?? type,
      isBackground: background,
      description: record.description,
      ...(spec.kind === 'resume' ? { resumedFrom: id } : {}),
      getSessionId: this.engine.getParentSessionId,
      postMessage: this.engine.postMessage,
      onUsage: (usage) => this.rollCost(record, usage),
    });
    this.bridges.set(id, bridge);

    // A resume validates across awaits and a spawn can wait in the queue, so the parent signal may
    // already have fired. Finish without running: pi ignores a session abort that precedes prompt().
    if (spec.signal?.aborted) {
      this.abort(id, 'user');
      bridge.start();
      this.afterComplete(id, record, bridge);
      return;
    }

    // Forward the parent foreground signal into this record's controller.
    let detachParent: (() => void) | undefined;
    if (spec.signal) {
      // ESC, budget, reset and dispose all call abortAll with their reason before the turn aborts.
      const onParentAbort = () => this.abort(id, 'user');
      spec.signal.addEventListener('abort', onParentAbort, { once: true });
      detachParent = () => spec.signal?.removeEventListener('abort', onParentAbort);
    }

    // Reject an unknown or explicitly-disabled type with a distinct error rather than silently running
    // it as general-purpose (which would hand a disabled/hallucinated agent the full toolset).
    if (!config || !this.engine.registry.isValidType(type)) {
      bridge.start();
      this.finalizeError(id, record, bridge, `Unknown or disabled subagent type "${type}".`, detachParent);
      return;
    }

    // A reopened session runs on the model its file recorded, which the runtime resolves.
    const reopening = spec.kind === 'resume' && spec.target.path !== null;
    const resolved: ResolvedSubagentModel = reopening
      ? {
          ...(spec.target.launch.modelLabel ? { modelLabel: spec.target.launch.modelLabel } : {}),
          ...(spec.target.launch.dollarBilled !== undefined ? { dollarBilled: spec.target.launch.dollarBilled } : {}),
        }
      : this.engine.resolveModel({ agentConfig: config });
    bridge.start(resolved.modelLabel, config.filePath);

    if (resolved.error) {
      this.finalizeError(id, record, bridge, resolved.error, detachParent);
      return;
    }

    if (background) this.emitBackgroundTaskStarted(record);

    void this.run(record, spec, config, resolved, bridge)
      .catch((err) => {
        if (record.status !== 'stopped') record.status = 'error';
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();
      })
      .finally(() => {
        detachParent?.();
        this.afterComplete(id, record, bridge);
      });
  }

  /**
   * The system prompt, toolset and gate factory for one run. Built from the agent template and the
   * panel as they are now, so a resumed agent picks up template edits and the current permission mode.
   */
  private prepareRun(record: AgentRecord, config: AgentConfig, parentToolUseId: string): PreparedRun {
    const env = detectEnv(this.engine.cwd);
    // Resolve the toolset BEFORE building the prompt: the prompt is capability-gated on what the agent
    // actually ends up holding, so the resolved set is an input to the prompt and not the other way
    // round. Nothing between them reads the prompt, so the order is free to be this way.
    const parentNames = this.engine.parentFullToolNames();
    const toolset = resolveAgentToolset(config, parentNames);
    const extras: PromptExtras = {};
    if (Array.isArray(config.skills)) {
      const loaded = preloadSkills(config.skills, this.engine.cwd, {
        includeProjectScope: vscode.workspace.isTrusted,
      });
      if (loaded.length > 0) extras.skillBlocks = loaded;
    }
    // Gate on the agent's own CAPABILITY, never the workspace flag: a `tools: *` agent inherits Compass
    // while Explore/Plan's allowlist excludes it even when enabled, so a flag check would brief two
    // agents on tools they cannot call. Membership also self-maintains — no second list to sync.
    if (toolset.names.some((n) => COMPASS_PI_TOOL_NAMES.includes(n))) extras.compassBlock = COMPASS_AGENT_PROMPT;
    if (!toolset.readOnly) extras.writesFiles = true;
    // The Plan agent assigns mechanisms the PARENT will execute, so the team rung is gated on the
    // parent's capability, not this agent's: no subagent can call `create_team` itself. Matched
    // case-insensitively because `AgentRegistry` resolves a spawn that way, so a user `plan.md` takes
    // the role and must take the block with it.
    if (config.name.toLowerCase() === PLAN_AGENT_NAME.toLowerCase()) {
      extras.planMechanismBlock = buildPlanMechanismBlock(parentNames.includes(TEAM_CREATE_TOOL));
    }
    const systemPrompt = buildAgentPrompt(config, this.engine.cwd, env, this.engine.getParentSystemPrompt(), extras);
    // Bind this subagent's browser tools to its OWN tab scope (keyed by record.id) so concurrent
    // subagents never clobber one another or the primary/main tab.
    //
    // ONE call for customTools AND the MCP snapshot. They used to be derived independently, which let
    // an `mcp__*` name reach `tools:` with no matching definition — pi filters the registry by the
    // frozen `_allowedToolNames` and drops the mismatch with no error, no warning and no log. A single
    // call is what makes the two structurally incapable of disagreeing. Runs AFTER the prompt: nothing
    // in the prompt depends on MCP, while `extras.compassBlock` above is gated on `toolset`.
    const { customTools, mcp } = this.engine.buildAgentToolset({
      agentId: record.id,
      agentName: config.name,
      mcpDisallowed: toolset.mcpDisallowed,
    });
    // The agent's whole ELIGIBLE set, composed once and used for both `tools:` and the deferrable set.
    // `deferredToolNames` INTERSECTS its first argument with the deferrable universe, so an `mcp__*`
    // name reaches the ToolSearch port only if it is in this array — `toolset.names` alone has every
    // `mcp__*` stripped and would yield an empty MCP inventory while the runtime still held those tools
    // inactive (it derives its own baseline from `tools:`). One array for both makes
    // `deferrable ⊆ tools:` true by construction rather than by two call sites agreeing.
    const eligibleToolNames = [...toolset.names, ...mcp.names];
    const hooksDispatch = this.engine.getHooksDispatch?.();
    const extensionFactory = createSubagentExtensionFactory({
      permissionHandler: this.engine.permissionHandler,
      isPlanMode: this.engine.isPlanMode,
      // An agent with no write tool (Explore/Plan, or any read-only user agent) keeps that guarantee in
      // the shell too — otherwise its own description promises a read-only mode the runtime never had.
      readOnlyShell: toolset.readOnly,
      parentToolUseId,
      deferrableToolNames: deferredToolNames(eligibleToolNames, mcp.names),
      // Gate parity with the panel: a CLASSIFIER (auto-allow vs `canUseTool`), never a grant filter.
      // Without it `toolCategory('mcp__*')` is 'other' and every nested MCP call, annotated read
      // included, falls through to full approval.
      isMcpReadOnly: mcp.isReadOnly,
      mcpDescriptions: mcp.descriptions,
      ...(hooksDispatch ? { hooks: hooksDispatch } : {}),
    });
    return { systemPrompt, eligibleToolNames, customTools, extensionFactory };
  }

  private async run(
    record: AgentRecord,
    spec: RunSpec,
    config: AgentConfig,
    resolved: ResolvedSubagentModel,
    bridge: SubagentStreamBridge,
  ): Promise<string> {
    const prepared = this.prepareRun(record, config, spec.toolCallId);
    const reopenPath = spec.kind === 'resume' ? spec.target.path : null;
    // A fresh run: a spawn, or a resume of an agent that stopped before its first response.
    const fresh = spec.kind === 'spawn'
      ? { description: spec.description, prompt: spec.prompt, background: spec.runInBackground, thinking: spec.thinking }
      : { ...spec.target.launch, thinking: spec.target.launch.thinkingOverride };
    const thinkingLevel =
      resolved.enforceThinking && resolved.thinkingLevel
        ? resolved.thinkingLevel
        : (fresh.thinking ?? resolved.thinkingLevel);
    const createSession = () =>
      this.engine.createSession({
        cwd: this.engine.cwd,
        systemPrompt: prepared.systemPrompt,
        ...(reopenPath === null && resolved.model ? { model: resolved.model } : {}),
        ...(reopenPath === null && thinkingLevel ? { thinkingLevel } : {}),
        // `mcp.names` MUST be here: pi freezes `options.tools` into `_allowedToolNames` and filters the
        // registry by it, so an MCP definition whose name is missing is dropped silently. It is also
        // where `createSubagentSession` reads this agent's MCP set back from, for the deferred baseline.
        tools: prepared.eligibleToolNames,
        customTools: prepared.customTools,

        excludeTools: [...PI_EXCLUDED_TOOLS],
        extensionFactory: prepared.extensionFactory,
        store: reopenPath !== null
          ? { kind: 'reopen', path: reopenPath, agentId: record.id }
          : { kind: 'file', dir: this.engine.subagentStoreDir(), id: record.id },
      });
    const launch: SubagentLaunchData | null = reopenPath !== null ? null : {
      agentId: record.id,
      kind: 'subagent',
      agentType: config.name,
      description: fresh.description,
      prompt: fresh.prompt,
      background: fresh.background,
      ...(fresh.thinking ? { thinkingOverride: fresh.thinking } : {}),
      ...(config.filePath ? { templatePath: config.filePath } : {}),
      ...(resolved.modelLabel ? { modelLabel: resolved.modelLabel } : {}),
      ...(resolved.dollarBilled !== undefined ? { dollarBilled: resolved.dollarBilled } : {}),
    };
    const segment = (dollarBilled: boolean | undefined): AgentSegmentData | null => spec.kind === 'spawn' ? null : {
      toolCallId: spec.toolCallId,
      ...(spec.message !== undefined ? { message: spec.message } : {}),
      ...(dollarBilled !== undefined ? { dollarBilled } : {}),
    };
    let prompt = fresh.prompt;
    if (spec.kind === 'resume') {
      prompt = reopenPath !== null
        ? buildResumePrompt(spec.message)
        : spec.message?.trim() ? wrapSteerMessage(`${spec.message.trim()}\n\nYour original task:\n${fresh.prompt}`) : fresh.prompt;
    }

    const result = await runSubagent({
      createSession,
      prompt,
      ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
      signal: record.abortController!.signal,
      onSessionCreated: (session) => {
        record.session = session;
        // A reopened session runs on the model its file recorded, which may bill differently from the launch.
        const dollarBilled = reopenPath !== null && session.model ? this.engine.modelDollarBilled(session.model) : resolved.dollarBilled;
        record.bridgeUnsub = bridge.attach(session, dollarBilled);
        // Appended before prompt(), so each entry precedes this run's messages. A new file is only
        // written once the first assistant message arrives; a reopened file takes the entry at once.
        if (launch) session.sessionManager.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, launch);
        const segmentData = segment(dollarBilled);
        if (segmentData) session.sessionManager.appendCustomEntry(DAMOCLES_AGENT_SEGMENT_ENTRY, segmentData);
        record.outputFile = session.sessionManager.getSessionFile();
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            void deliverSteer(session, msg).catch((err) => log('[AgentManager] queued steer flush failed for %s: %O', record.id, err));
          }
          record.pendingSteers = undefined;
        }
      },
      onToolActivity: (activity) => {
        if (activity.type === 'end') record.toolUses++;
      },
      onAssistantUsage: (usage) => addUsage(record.lifetimeUsage, usage),
    });

    if (record.status !== 'stopped') {
      record.status = result.aborted ? 'aborted' : result.steered ? 'steered' : 'completed';
    }
    record.result = result.responseText;
    record.session = result.session;
    record.completedAt ??= Date.now();
    return result.responseText;
  }

  /** Roll this run's cost delta into the parent budget meter, from the reading its bridge published. */
  private rollCost(record: AgentRecord, usage: AgentUsageTotals): void {
    // A record no longer tracked was cleared by reset/clear or replaced by a resume of its id: its spend
    // is already counted, and a late roll would count it again.
    if (this.agents.get(record.id) !== record) return;
    const delta = Math.max(0, usage.costUsd - record.usage.costUsd);
    record.usage = usage;
    if (delta > 0) this.engine.onSubagentCost(delta);
  }

  /** Emit the card resolution + dispose the session + drain the queue. */
  private afterComplete(id: string, record: AgentRecord, bridge: SubagentStreamBridge): void {
    const browserSuccess = record.status === 'completed' || record.status === 'steered';
    // Settle before the card resolves: spend that raised no event, such as a cache warm, rolls here.
    bridge.settleUsage();
    if (record.bridgeUnsub) {
      try { record.bridgeUnsub(); } catch { /* ignore */ }
      record.bridgeUnsub = undefined;
    }
    const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
    const responseText = (record.result ?? record.error ?? '') + getStatusNote(record.status, record.stopReason, record.id);
    const isError = record.status === 'error';
    this.recordStatus(record, responseText);
    const resultJson = buildAgentResultJson({
      responseText,
      agentId: id,
      agentStatus: terminalAgentStatus(record.status),
      totalDurationMs: durationMs,
      totalTokens: getLifetimeTotal(record.lifetimeUsage),
      totalToolUseCount: record.toolUses,
    });
    if (!this.disposed) {
      bridge.finish({
        ...(record.session ? { session: record.session } : {}),
        responseText,
        resultJson,
        isError,
        durationMs,
      });
    }

    if (record.session) {
      this.engine.forgetSession(record.session);
      record.session = undefined;
    }
    // AFTER the session is torn down, so no tool call can still be in flight. An aborted turn resolves
    // its tool call immediately while the underlying browser work keeps running, and a scope disposed
    // while that work is mid-flight would be resurrected by it. Auto-close this subagent's tab(s) ONLY
    // on success — an errored or manually-stopped subagent keeps its tab open so the failed page can be
    // inspected — but drop the scope registry entry either way.
    this.engine.disposeBrowserScope(id, browserSuccess);
    // Same ordering argument as the browser scope: only AFTER the session is torn down can no tool call
    // still be in flight. Unconditional — a subagent that errored or was stopped is exactly the one
    // most likely to have left a prompt on screen, and there is no "keep it open for inspection" case
    // for a modal nobody can answer.
    this.engine.cancelAgentDialogs(id);
    this.bridges.delete(id);
    if (record.background) this.emitBackgroundTaskCompleted(record);
    this.running = Math.max(0, this.running - 1);
    this.settleDone(id, responseText);
    this.drainQueue();
  }

  /** Append the terminal `damocles-agent-status` entry to the agent's own session, once. A session
   *  that never produced an assistant message keeps it buffered, so such an agent has no file. */
  private recordStatus(record: AgentRecord, resultText: string): void {
    if (record.statusRecorded || !record.session) return;
    if (record.status === 'queued' || record.status === 'running') return;
    record.statusRecorded = true;
    const data: AgentStatusData = {
      status: record.status,
      ...(record.status === 'stopped' && record.stopReason ? { stopReason: record.stopReason } : {}),
      result: resultText,
    };
    try {
      record.session.sessionManager.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, data);
    } catch (err) {
      log('[AgentManager] recording the status of %s failed: %O', record.id, err);
    }
  }

  /** Finalize a spawn that failed before running (e.g. model resolution error). */
  private finalizeError(
    id: string,
    record: AgentRecord,
    bridge: SubagentStreamBridge,
    error: string,
    detachParent?: () => void,
  ): void {
    record.status = 'error';
    record.error = error;
    record.completedAt = Date.now();
    detachParent?.();
    // A spawn that failed before running opened no tab; drop any scope entry, never close (closeTabs=false).
    this.engine.disposeBrowserScope(id, false);
    const durationMs = 0;
    if (!this.disposed) {
      bridge.finish({
        responseText: error,
        resultJson: buildAgentResultJson({ responseText: error, agentId: id, agentStatus: 'error', totalDurationMs: 0, totalTokens: 0, totalToolUseCount: 0 }),
        isError: true,
        durationMs,
      });
    }
    this.bridges.delete(id);
    this.running = Math.max(0, this.running - 1);
    this.settleDone(id, error);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (!this.disposed && this.queue.length > 0 && this.running < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== 'queued') continue;
      this.startRecord(next.id, record, next.spec);
    }
  }

  /** Surface a started background subagent in the Background Tasks panel + the active-task chip. */
  private emitBackgroundTaskStarted(record: AgentRecord): void {
    this.engine.postMessage({
      type: 'backgroundTaskStarted',
      task: {
        taskId: record.id,
        toolUseId: record.toolCallId,
        description: record.description,
        status: 'running',
      },
    });
  }

  /** Resolve the background subagent's Background Tasks panel entry. */
  private emitBackgroundTaskCompleted(record: AgentRecord): void {
    const status = record.status === 'error' ? 'failed'
      : record.status === 'completed' || record.status === 'steered' ? 'completed'
      : 'stopped';
    this.engine.postMessage({ type: 'backgroundTaskCompleted', taskId: record.id, status });
  }

  /** Abort one subagent (queued → dropped; running → session abort). */
  abort(id: string, reason: AgentStopReason): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status === 'queued') {
      const idx = this.queue.findIndex((q) => q.id === id);
      if (idx !== -1) this.queue.splice(idx, 1);
      record.status = 'stopped';
      record.stopReason = reason;
      record.completedAt = Date.now();
      // A queued agent never ran, so any steer it holds was never delivered — drop both the undelivered
      // buffer and the parent-awareness note so a stopped record can't carry a phantom "[User steered…]".
      record.pendingSteers = undefined;
      record.userSteers = undefined;
      this.settleDone(id, '');
      return true;
    }
    if (record.status !== 'running') return false;
    record.status = 'stopped';
    record.stopReason = reason;
    record.abortController?.abort();
    record.completedAt = Date.now();
    return true;
  }

  /**
   * Abort all running + queued subagents (interrupt / reset / budget). Returns the count aborted.
   * A killed agent has no result to incorporate, so its record is marked consumed: otherwise
   * `hasUnconsumedBackground()` keeps returning true and the NEXT turn's keep-alive injects
   * "(no output)" and pays for a synthesis round over agents this abort just killed.
   */
  abortAll(reason: AgentStopReason): number {
    this.abortEpoch++;
    let count = 0;
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = 'stopped';
        record.stopReason = reason;
        record.completedAt = Date.now();
        record.resultConsumed = true;
        // Never-delivered steers on a queued agent must not survive the abort (see abort()).
        record.pendingSteers = undefined;
        record.userSteers = undefined;
        this.settleDone(queued.id, '');
        count++;
      }
    }
    this.queue.length = 0;
    for (const record of this.agents.values()) {
      if (record.status === 'running') {
        record.status = 'stopped';
        record.stopReason = reason;
        record.abortController?.abort();
        record.completedAt = Date.now();
        record.resultConsumed = true;
        count++;
      }
    }
    return count;
  }

  /** Remove completed/stopped/errored records (called on reset/clear). Running/queued are kept. */
  clearCompleted(): void {
    for (const [id, record] of this.agents) {
      if (record.status === 'running' || record.status === 'queued') continue;
      this.agents.delete(id);
      this.bridges.delete(id);
    }
  }

  /** Whether any subagent is still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some((r) => r.status === 'running' || r.status === 'queued');
  }

  dispose(): void {
    this.disposed = true;
    this.abortAll('shutdown');
    // abortAll settles queued records; running ones abort asynchronously and would never reach
    // afterComplete after disposal — settle their awaiters now so no GetSubagentResult/spawnAndWait hangs.
    for (const [, resolve] of this.doneResolvers) resolve('');
    this.doneResolvers.clear();
    for (const record of this.agents.values()) {
      // Written now: a window reload may never run the aborted agents' completion path.
      this.recordStatus(record, (record.result ?? record.error ?? '') + getStatusNote(record.status, record.stopReason, record.id));
      if (record.session) {
        this.engine.forgetSession(record.session);
        record.session = undefined;
      }
    }
    this.agents.clear();
    this.bridges.clear();
  }
}
