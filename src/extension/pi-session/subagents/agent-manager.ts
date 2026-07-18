/**
 * agent-manager.ts — Tracks subagents, background execution with a concurrency cap, steering, abort.
 *
 * Adapted from @tintinweb/pi-subagents `agent-manager.ts` (MIT, © 2026 tintinweb; see
 * THIRD-PARTY-NOTICES.md). Worktree isolation, resume, and group-join are dropped. The manager is a
 * per-`PiSession` cross-turn singleton, so `run_in_background` agents outlive the spawning turn. The
 * per-spawn run orchestration (prompt build, toolset resolution, session creation, stream bridge) is
 * driven through an injected `SubagentEngine` so model policy + budget rollup stay owned by PiSession.
 */

import { randomUUID } from 'node:crypto';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PermissionHandler } from '../../permission-handler';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { RunningSubagentInfo } from '../../../shared/types/subagents';
import { wrapSteerMessage } from '../../../shared/steer';
import { log } from '../../logger';
import { PI_EXCLUDED_TOOLS } from '../pi-models';
import type { PiCreateSubagentSessionOptions } from '../pi-runtime';
import type { DispatchDeps } from '../hooks';
import { AgentRegistry } from './agent-types';
import { buildAgentPrompt, type PromptExtras } from './prompts';
import { detectEnv } from './env';
import { preloadSkills } from './skill-loader';
import { resolveAgentToolset } from './agent-toolset';
import { createOutputFilePath, writeInitialEntry, writeFinalEntry, streamToOutputFile } from './output-file';
import { createSubagentExtensionFactory } from './subagent-extension-factory';
import { SubagentStreamBridge, buildAgentResultJson } from './subagent-stream-bridge';
import { runSubagent, getAgentConversation } from './subagent-runner';
import { getStatusNote } from './status-note';
import { addUsage, getLifetimeTotal } from './usage';
import type { AgentConfig, AgentRecord, SubagentType, ThinkingLevel } from './types';

export const DEFAULT_MAX_CONCURRENT = 4;

/** Outcome of resolving a model for a spawn. */
export interface ResolvedSubagentModel {
  model?: Model<Api>;
  /** Short label for the card's model line (e.g. "haiku"), when known. */
  modelLabel?: string;
  thinkingLevel?: ThinkingLevel;
  /** Set only by the Explore-section resolution when the user's effort setting yielded a `thinkingLevel`:
   *  makes that level a hard guarantee that beats a per-spawn `spec.thinking`. */
  enforceThinking?: boolean;
  /** Set when resolution failed (out-of-scope / unauthed) — the spawn fails soft with this message. */
  error?: string;
}

/** Everything the manager needs to run one subagent, owned by PiSession (decoupled for testability). */
export interface SubagentEngine {
  cwd: string;
  registry: AgentRegistry;
  createSession: (opts: PiCreateSubagentSessionOptions) => Promise<import('@earendil-works/pi-coding-agent').AgentSession>;
  forgetSession: (session: import('@earendil-works/pi-coding-agent').AgentSession) => void;
  permissionHandler: PermissionHandler;
  isPlanMode: () => boolean;
  postMessage: (message: ExtensionToWebviewMessage) => void;
  /** The parent panel's effective system prompt (for append-mode agents). */
  getParentSystemPrompt: () => string;
  /** The parent panel's session id — groups a conversation's subagent transcripts on disk. */
  getParentSessionId: () => string;
  /** The parent panel's full active tool-name set (for `*`/general-purpose agents). */
  parentFullToolNames: () => string[];
  /** Build the subagent's customTools (Edit, PowerShell, Task tools, memory/compass/browser) — NOT the subagent tools. */
  buildSubagentCustomTools: () => ToolDefinition[];
  /** Resolve a spawn's model per §4.9 (explicit param > config.model > cheap-for-provider > parent). */
  resolveModel: (input: { agentConfig: AgentConfig; modelParam?: string | undefined }) => ResolvedSubagentModel;
  /** Roll a subagent cost delta (USD) into the panel's budget meter. */
  onSubagentCost: (costDeltaUsd: number) => void;
  /** Configured-hooks dispatch deps (US-008) — fires PreToolUse/PostToolUse/subagent_end for this subagent. */
  getHooksDispatch?: () => DispatchDeps | undefined;
}

/** A spawn request. `toolCallId` is the spawning `Agent` tool-call id (the webview subagent-card key). */
export interface SpawnSpec {
  type: SubagentType;
  prompt: string;
  description: string;
  toolCallId: string;
  modelParam?: string;
  thinking?: ThinkingLevel;
  runInBackground: boolean;
  /** Parent abort signal (foreground synchronous spawn) — aborts this subagent when the parent turn does. */
  signal?: AbortSignal;
}

export class AgentManager {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly bridges = new Map<string, SubagentStreamBridge>();
  private readonly engine: SubagentEngine;
  private maxConcurrent: number;
  private readonly queue: { id: string; spec: SpawnSpec }[] = [];
  /** Total concurrent subagents (foreground + background) that have started — capped at maxConcurrent. */
  private running = 0;
  /** Resolves each record's lifetime `promise` exactly once at its terminal state. Created at spawn so a
   *  spawn that never reaches `startRecord` (queued, then aborted) still settles its awaiters. */
  private readonly doneResolvers = new Map<string, (text: string) => void>();
  private disposed = false;

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

  /** The currently running + queued subagents, for the `/steer` second-stage picker. */
  listActive(): RunningSubagentInfo[] {
    return [...this.agents.values()]
      .filter((r) => r.status === 'running' || r.status === 'queued')
      .map((r) => ({
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
  spawn(spec: SpawnSpec): string {
    const id = randomUUID().slice(0, 17);
    this.enqueueOrStart(id, spec);
    return id;
  }

  /** Spawn a foreground subagent and await completion. Shares the single concurrency cap with background
   *  spawns — queues for a slot when at capacity rather than launching unconditionally. */
  async spawnAndWait(spec: SpawnSpec): Promise<AgentRecord> {
    const id = randomUUID().slice(0, 17);
    const record = this.enqueueOrStart(id, spec);
    await record.promise;
    return record;
  }

  /** Create a record and either start it (slot free) or queue it (at the cap). */
  private enqueueOrStart(id: string, spec: SpawnSpec): AgentRecord {
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
  async steer(id: string, message: string): Promise<'steered' | 'queued' | 'not-found' | 'finished' | 'failed'> {
    const record = this.agents.get(id);
    if (!record) return 'not-found';
    const wrapped = wrapSteerMessage(message);
    if (record.status === 'queued') {
      (record.pendingSteers ??= []).push(wrapped);
      return 'queued';
    }
    if (record.status !== 'running') return 'finished';
    if (record.session) {
      try {
        await record.session.steer(wrapped);
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

  private newRecord(id: string, spec: SpawnSpec, queued: boolean): AgentRecord {
    const record: AgentRecord = {
      id,
      type: spec.type,
      description: spec.description,
      status: queued ? 'queued' : 'running',
      toolUses: 0,
      startedAt: Date.now(),
      abortController: new AbortController(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      costUsd: 0,
      compactionCount: 0,
      toolCallId: spec.toolCallId,
      background: spec.runInBackground,
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
  private startRecord(id: string, record: AgentRecord, spec: SpawnSpec): void {
    record.status = 'running';
    record.startedAt = Date.now();
    this.running++;

    // Forward the parent foreground signal into this record's controller.
    let detachParent: (() => void) | undefined;
    if (spec.signal) {
      const onParentAbort = () => this.abort(id);
      spec.signal.addEventListener('abort', onParentAbort, { once: true });
      detachParent = () => spec.signal?.removeEventListener('abort', onParentAbort);
    }

    const config = this.engine.registry.getAgentConfig(spec.type);
    const bridge = new SubagentStreamBridge({
      parentToolUseId: spec.toolCallId,
      agentId: id,
      agentType: config?.name ?? spec.type,
      isBackground: spec.runInBackground,
      getSessionId: this.engine.getParentSessionId,
      postMessage: this.engine.postMessage,
    });
    this.bridges.set(id, bridge);

    // Reject an unknown or explicitly-disabled type with a distinct error rather than silently running
    // it as general-purpose (which would hand a disabled/hallucinated agent the full toolset).
    if (!config || !this.engine.registry.isValidType(spec.type)) {
      bridge.start();
      this.finalizeError(id, record, bridge, `Unknown or disabled subagent type "${spec.type}".`, detachParent);
      return;
    }

    const resolved = this.engine.resolveModel({ agentConfig: config, modelParam: spec.modelParam });
    bridge.start(resolved.modelLabel, config.filePath);

    if (resolved.error) {
      this.finalizeError(id, record, bridge, resolved.error, detachParent);
      return;
    }

    if (spec.runInBackground) this.emitBackgroundTaskStarted(record, config.name);

    void this.run(record, spec, config, resolved, bridge)
      .catch((err) => {
        if (record.status !== 'stopped') record.status = 'error';
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();
      })
      .finally(() => {
        detachParent?.();
        this.afterComplete(id, record, spec, bridge);
      });
  }

  private async run(
    record: AgentRecord,
    spec: SpawnSpec,
    config: AgentConfig,
    resolved: ResolvedSubagentModel,
    bridge: SubagentStreamBridge,
  ): Promise<string> {
    const env = detectEnv(this.engine.cwd);
    const extras: PromptExtras = {};
    if (Array.isArray(config.skills)) {
      const loaded = preloadSkills(config.skills, this.engine.cwd);
      if (loaded.length > 0) extras.skillBlocks = loaded;
    }
    const systemPrompt = buildAgentPrompt(config, this.engine.cwd, env, this.engine.getParentSystemPrompt(), extras);
    const toolset = resolveAgentToolset(config, this.engine.parentFullToolNames());
    const customTools = this.engine.buildSubagentCustomTools();
    const hooksDispatch = this.engine.getHooksDispatch?.();
    const extensionFactory = createSubagentExtensionFactory({
      permissionHandler: this.engine.permissionHandler,
      isPlanMode: this.engine.isPlanMode,
      parentToolUseId: spec.toolCallId,
      ...(hooksDispatch ? { hooks: hooksDispatch } : {}),
    });

    const thinkingLevel =
      resolved.enforceThinking && resolved.thinkingLevel
        ? resolved.thinkingLevel
        : (spec.thinking ?? resolved.thinkingLevel);
    const createSession = () =>
      this.engine.createSession({
        cwd: this.engine.cwd,
        systemPrompt,
        ...(resolved.model ? { model: resolved.model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        tools: toolset.names,
        customTools,
        excludeTools: [...PI_EXCLUDED_TOOLS],
        extensionFactory,
      });

    const result = await runSubagent({
      createSession,
      prompt: spec.prompt,
      ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
      signal: record.abortController!.signal,
      onSessionCreated: (session) => {
        record.session = session;
        record.bridgeUnsub = bridge.attach(session);
        // Stream a JSONL transcript to disk (§4.8) — the rehydrate source for the subagent card on resume
        // (read back by the history loader, keyed by the spawning Agent tool-call id).
        try {
          const outputFile = createOutputFilePath(this.engine.cwd, record.id, this.engine.getParentSessionId());
          const headerWritten = writeInitialEntry(outputFile, record.id, spec.prompt, this.engine.cwd, {
            parentToolUseId: spec.toolCallId,
            agentType: config.name,
            ...(resolved.modelLabel ? { model: resolved.modelLabel } : {}),
            ...(config.filePath ? { templatePath: config.filePath } : {}),
          });
          // Without the correlation header, streamed turns can never be rehydrated — don't start the
          // stream (which would build an unparseable header-less file).
          if (headerWritten) {
            record.outputFile = outputFile;
            record.outputCleanup = streamToOutputFile(session, outputFile, record.id, this.engine.cwd);
          } else {
            log('[AgentManager] subagent transcript header write failed; skipping transcript for %s', record.id);
          }
        } catch (err) {
          log('[AgentManager] subagent transcript setup failed (non-fatal): %O', err);
        }
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            void session.steer(msg).catch((err) => log('[AgentManager] queued steer flush failed for %s: %O', record.id, err));
          }
          record.pendingSteers = undefined;
        }
      },
      onToolActivity: (activity) => {
        if (activity.type === 'end') record.toolUses++;
      },
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.rollCost(record);
      },
    });

    if (record.status !== 'stopped') {
      record.status = result.aborted ? 'aborted' : result.steered ? 'steered' : 'completed';
    }
    record.result = result.responseText;
    record.session = result.session;
    record.completedAt ??= Date.now();
    return result.responseText;
  }

  /** Roll the subagent session's cost delta into the parent budget meter. */
  private rollCost(record: AgentRecord): void {
    // A record dropped from tracking was cleared by reset/clear (the only callers of clearCompleted) —
    // its spend belongs to the now-replaced session, so a late post-reset `afterComplete` roll must not
    // re-pollute the fresh meter that resetCostBaseline just zeroed.
    if (!this.agents.has(record.id)) return;
    const cost = record.session?.getSessionStats().cost ?? record.costUsd;
    const delta = Math.max(0, cost - record.costUsd);
    record.costUsd = cost;
    if (delta > 0) this.engine.onSubagentCost(delta);
  }

  /** Emit the card resolution + dispose the session + drain the queue. */
  private afterComplete(id: string, record: AgentRecord, spec: SpawnSpec, bridge: SubagentStreamBridge): void {
    this.rollCost(record);
    // Final transcript flush + unsubscribe (both the disk stream and the webview stream bridge).
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore */ }
      record.outputCleanup = undefined;
    }
    if (record.bridgeUnsub) {
      try { record.bridgeUnsub(); } catch { /* ignore */ }
      record.bridgeUnsub = undefined;
    }
    const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
    const responseText = (record.result ?? record.error ?? '') + getStatusNote(record.status);
    const isError = record.status === 'error';
    // Persist the terminal status + final text to the transcript so a resumed card shows the real
    // outcome (e.g. user-stopped → cancelled) rather than inferring "completed" from the spawn result.
    if (record.outputFile) writeFinalEntry(record.outputFile, record.id, record.status, responseText);
    const resultJson = buildAgentResultJson({
      responseText,
      agentId: id,
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
    this.bridges.delete(id);
    if (spec.runInBackground) this.emitBackgroundTaskCompleted(record);
    this.running = Math.max(0, this.running - 1);
    this.settleDone(id, responseText);
    this.drainQueue();
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
    const durationMs = 0;
    if (!this.disposed) {
      bridge.finish({
        responseText: error,
        resultJson: buildAgentResultJson({ responseText: error, agentId: id, totalDurationMs: 0, totalTokens: 0, totalToolUseCount: 0 }),
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
  private emitBackgroundTaskStarted(record: AgentRecord, agentType: string): void {
    this.engine.postMessage({
      type: 'backgroundTaskStarted',
      task: {
        taskId: record.id,
        toolUseId: record.toolCallId ?? null,
        description: record.description,
        taskType: agentType,
        status: 'running',
        startTime: record.startedAt,
        endTime: null,
        outputFile: record.outputFile ?? null,
        summary: null,
        progressSummary: null,
        usage: null,
        lastToolName: null,
      },
    });
  }

  /** Resolve the background subagent's Background Tasks panel entry with its final usage. */
  private emitBackgroundTaskCompleted(record: AgentRecord): void {
    const status = record.status === 'error' ? 'failed'
      : record.status === 'completed' || record.status === 'steered' ? 'completed'
      : 'stopped';
    this.engine.postMessage({
      type: 'backgroundTaskCompleted',
      taskId: record.id,
      status,
      summary: (record.result ?? record.error ?? '').slice(0, 500),
      outputFile: record.outputFile ?? null,
      usage: {
        totalTokens: getLifetimeTotal(record.lifetimeUsage),
        toolUses: record.toolUses,
        durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
      },
    });
  }

  /** Abort one subagent (queued → dropped; running → session abort). */
  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status === 'queued') {
      const idx = this.queue.findIndex((q) => q.id === id);
      if (idx !== -1) this.queue.splice(idx, 1);
      record.status = 'stopped';
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
    record.abortController?.abort();
    record.completedAt = Date.now();
    return true;
  }

  /** Abort all running + queued subagents (interrupt / reset / budget). Returns the count aborted. */
  abortAll(): number {
    let count = 0;
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = 'stopped';
        record.completedAt = Date.now();
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
        record.abortController?.abort();
        record.completedAt = Date.now();
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
    this.abortAll();
    // abortAll settles queued records; running ones abort asynchronously and would never reach
    // afterComplete after disposal — settle their awaiters now so no GetSubagentResult/spawnAndWait hangs.
    for (const [, resolve] of this.doneResolvers) resolve('');
    this.doneResolvers.clear();
    for (const record of this.agents.values()) {
      if (record.session) {
        this.engine.forgetSession(record.session);
        record.session = undefined;
      }
    }
    this.agents.clear();
    this.bridges.clear();
  }
}
