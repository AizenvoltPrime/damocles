import { randomUUID } from "crypto";
import { existsSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import type { AgentSession, AgentSessionRuntime, BuildSystemPromptOptions, CreateAgentSessionRuntimeFactory, ToolDefinition, AgentBeforeSettleEvent, CustomMessageEntryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model, Api, ImageContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ChatSession } from "../chat-session";
import type { SessionOptions, ContentInput, McpScope, RewindOption } from "../session-types";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { ModelInfo, AccountInfo, PermissionMode, AutoCompactConfig, EffortLevel } from "../../shared/types/settings";
import type { SlashCommandInfo } from "../../shared/types/commands";
import type { McpServerStatusInfo } from "../../shared/types/mcp";
import type { MemoryInjectionDisplay } from "../../shared/types/context-injection";
import type { SteerTargetInfo } from "../../shared/types/subagents";
import type { TeamService } from "../team";
import type { UserContentBlock } from "../../shared/types/content";
import { DEFAULT_CONTEXT_WINDOW, MODEL_SUBSTITUTES, migrateLegacyModelValue, migrateLegacyEffortValue, parseEffortLevel } from "../../shared/types/constants";
import { PLAN_MODE_TOOLS } from "../../shared/tool-names";
import { log } from "../logger";
import { PiRuntime } from "./pi-runtime";
import type { FolderRuntime } from "./folder-runtime";
import { getPiCodingAgent, type PiCodingAgentModule } from "./pi-loader";
import { cacheWarmingSetting, PI_AGENT_DIR } from "./agent-dir";
import { installTurnDecider, BUDGET_STOP_HOOK } from "./finish-turn";
import { dispatchObserveOnly } from "./hooks/dispatch";
import { buildPermissionRequiredPayload, buildForkPayload } from "./hooks/payload";
import { PiStreamAdapter, isNothingToCompact } from "./pi-stream-adapter";
import { deriveSessionState, type SessionState, type TurnState } from "./session-state";
import {
  piSupportedModels,
  resolvePiModel,
  providerDisplayName,
  piModelToModelInfo,
  effortToThinkingLevel,
  PI_EXCLUDED_TOOLS,
  PLAN_MODE_EXCLUDED_TOOLS,
} from "./pi-models";
import { buildCustomTools } from "./tools";
import { ShellCancelStore } from "./tools/shell-cancel-registry";
import { createShellSessionJob } from "./tools/process-tree";
import { sessionNoteDelivery, subagentNoteDelivery, teamAgentNoteDelivery } from "./note-delivery";
import type { ShellOptions } from "./tools/bash-tool";
import { buildTeamAgentPiTools, TEAM_MAIN_PI_TOOL_NAMES, teamAgentPiToolNamesForRole } from "./tools/team-tools";
import { createSubagentExtensionFactory } from "./subagents/subagent-extension-factory";
import {
  resolveRoleModel,
  type TeamModelDeps,
  type TeamRole,
  type TeamRoleSetting,
} from "./team-model-resolution";
import type { TeamEngine, ResolvedTeamModel, AgentMcpContext } from "../team/types";
import {
  AgentManager,
  resolveEnabledModels,
  readEnabledModels,
  isModelInScope,
  type SubagentEngine,
  type ResolvedSubagentModel,
  type AgentConfig,
} from "./subagents";
import type { AgentRegistry } from "./subagents/agent-types";
import { AGENT_SCOPE_BY_SOURCE } from "./subagents/types";
import { resolveCheapModelFor } from "./subagents/cheap-model";
import { backgroundResultsDetails, formatBackgroundResults, SUBAGENT_RESULTS_CUSTOM_TYPE } from "./subagents/background-results";
import { reconcileInterruptions } from "./interruption-notice";
import { copyForkAgentData } from "./fork-agent-data";
import { subagentsDir, type AgentInvocationData } from "./agent-records";
import { TeamPersistence } from "../team/persistence";
import { resolveExploreSectionModel } from "./custom-providers";
import type { CustomAgentInfo } from "../../shared/types/commands";
import {
  ensurePiSessionDir,
  resolvePiSessionFile,
  piSessionIdFromFile,
  extractFirstUserMessage,
  DAMOCLES_USER_RENAMED_ENTRY,
  DAMOCLES_TAG_ENTRY,
  DAMOCLES_ORIGINAL_INPUT_ENTRY,
  DAMOCLES_MID_STREAM_ENTRY,
  DAMOCLES_STEER_ENTRY,
  DAMOCLES_AGENT_INVOCATION_ENTRY,
  stripIdeContext,
} from "./session-store";
import { computePlanFilePath, findSessionPlanFiles } from "../paths";
import { CheckpointService } from "./checkpoint-service";
import { getCheckpointEntries, getRepoDir, getGitDir, RepoManager } from "./checkpoints";
import { SUBAGENT_PI_TOOL_NAMES } from "./tools/tool-catalog";
import { assembleDamoclesSystemPrompt, renderSections, resolveSkillFileReadTool, type DamoclesPromptSections } from "./agent-start";
import type { McpToolSource } from "./mcp/tool-source";
import { isMcpToolName } from "./mcp/naming";
import { buildNestedMcpToolset, type NestedMcpToolset } from "./tools/mcp-tools";
import { isWebSearchEnabled } from "./web-access";
import { WebviewExtensionUIContext, type AgentUiAttribution } from "./extension-ui-context";
import type { PanelGateContext, SystemPromptEnv } from "./permission-gate";
import type { ToolsSnapshot } from "../../shared/types/tools";
import {
  extractText,
  extractImages,
  piMessageText,
  lastUserEntry,
  turnExchangeAfter,
  firstExchangeForTitle,
} from "./branch-text";
import {
  PLAN_MODE_NUDGE_CUSTOM_TYPE,
  selectPlanModeNudgeText,
  lastAssistant,
  turnHasNonErrorExitPlanModeResult,
} from "./plan-mode-hold";
import { BTW_SYSTEM_PROMPT, buildBtwContextBlock } from "./btw-context";
import { registerTurnEndImagePruning, registerAgentStartImageReconcile } from "./context-image-pruning";
import { buildContextUsage } from "./context-usage";
import { resolveCompactionBudget } from "./compaction-budget";
import { generateSessionTitle } from "./session-title";
import {
  buildAccountInfo as buildAccountInfoFrom,
  dollarBilled as dollarBilledFrom,
  type AccountBillingDeps,
} from "./account-billing";
import {
  fullActiveToolNames as fullActiveToolNamesFrom,
  activeToolNamesWithDeferral,
  buildToolStatus as buildToolStatusFrom,
  type ToolStatusDeps,
} from "./tool-status";
import { deferredToolNames } from "./tools/deferred-tools";
import { mcpGroupName, type DeferrableSnapshot } from "./tools/tool-search-tool";

/** Runtimes whose provider-fallback warning has already been shown (see `warnCustomProviderFallback`).
 *  Module scope because the dedupe spans PiSession instances; weak so a disposed runtime is collectable. */
const fallbackWarnedRuntimes = new WeakSet<PiRuntime>();

/** How long a session delete waits for the agents it aborted to stop writing. Aborted runs settle in
 *  milliseconds; this only caps a run whose tool ignores the abort signal. */
const ABORTED_AGENTS_SETTLE_TIMEOUT_MS = 10_000;

/**
 * `ChatSession` implementation backed by the pi harness (US-P1-4). Owns one `AgentSessionRuntime`
 * whose factory reuses its folder's `FolderRuntime.services` and a `PiStreamAdapter` that
 * reproduces the existing webview message contract. Deferred subsystems degrade gracefully — no
 * method reachable from a live handler throws (FR-10).
 */
export class PiSession implements ChatSession {
  private readonly options: SessionOptions;
  private readonly cwd: string;
  private readonly adapter: PiStreamAdapter;
  /** Per-PiSession webview-bridged extension UI context (US-026), re-bound on each (re)bind. */
  private readonly uiContext: WebviewExtensionUIContext;

  private runtime: AgentSessionRuntime | null = null;
  /** This panel folder's pi services, resolved by `start()`; null until then. */
  private folder: FolderRuntime | null = null;
  private unsubscribe: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  /** In-flight session replacement (reset/clear → newSession); a following sendMessage awaits it. */
  private resetPromise: Promise<void> | null = null;
  /** In-flight abort (interrupt/cancel → session.abort() → waitForIdle); a following sendMessage awaits
   * it so a new turn never races a still-winding-down one ("Agent is already processing"). */
  private abortPromise: Promise<void> | null = null;
  /** In-flight MCP-driven `session.reload()` (orphan recovery); serialized with reset/newSession. */
  private mcpReloadPromise: Promise<void> | null = null;
  /** A tools-changed arrived mid-reload: single-flight coalescing (one trailing reload, not N). */
  private mcpReloadRerunRequested = false;
  /** A tools-changed arrived while busy: reload deferred, flushed at the next turn (`sendMessage`). */
  private mcpReloadPendingAfterTurn = false;
  /** The pi sessionId currently registered in the folder runtime's panel registry (cleared/replaced on rebind). */
  private registeredSessionId: string | null = null;
  /** The exact gate context and tool refresher registered under `registeredSessionId`; unregistering
   *  hands them back so a late release cannot evict another panel's entry for the same id. */
  private registeredGate: PanelGateContext | null = null;
  private registeredToolRefresher: (() => void) | null = null;
  /** Debounce key for `permission_required` (US-009): one notification per (sessionId, turn). */
  private _lastPermissionNotifyKey: string | null = null;
  /** The latest MCP scope fed to this panel; applied once the folder runtime exists. */
  private mcpScope: McpScope | undefined;
  /** Pushes fresh MCP runtime status to this panel's webview on every connect/disconnect (no manual refresh). */
  private _mcpStatusListener: (() => void) | null = null;
  /** Per-session checkpoint engine driver, registered alongside the panel gate context (US-013b). */
  private checkpointService: CheckpointService | null = null;
  /** User entry ids that have a checkpoint — the rewindable set pushed via `checkpointInfo`. */
  private readonly checkpointUserIds = new Set<string>();
  /** Size of the last `checkpointInfo` broadcast, to suppress no-op re-emits. */
  private lastCheckpointBroadcast = -1;
  /** The last `sessionStateChanged` sent, as `state:sessionId`, so a re-derivation that changed
   *  nothing sends nothing. Only an identical message is ever dropped. */
  private lastSessionState: string | null = null;
  /** The turn's own lifecycle, the single value `publishSessionState` derives from. Written only by
   *  `setTurnState`, never inferred from another flag: `processingFlag` is cleared a tick later than the
   *  adapter reports idle, so reading it here republishes `running` after `idle` and latches the bar. */
  private turnState: TurnState = "idle";

  private desiredModel: Model<Api> | undefined;
  private modelValue: string;
  // The catalog is static, so it is populated before start(): a resumed panel defers start() and still
  // has to resolve its model's billing.
  private supportedModelsCache: ModelInfo[] = piSupportedModels();
  private permissionMode: PermissionMode;
  private processingFlag = false;
  /** Set while a manual compaction runs. Distinct from `processingFlag` so it gates a concurrent
   * sendMessage without arming the budget-abort / context-busy behavior keyed off processingFlag. */
  private compacting = false;
  /** Set while interrupt()/cancel() tears down the in-flight turn, so the prompt() rejection it
   * triggers doesn't surface an error card on top of the sessionCancelled already emitted. */
  private _aborting = false;
  /** Bumped by every ESC, so a send still waiting to start its turn can tell it was cancelled. */
  private abortEpoch = 0;
  /** Set when the hard budget limit is crossed mid-turn, so the turn finishes gracefully at the next
   * model round-trip boundary (the `finishTurn` decider) instead of being torn mid-stream by an abort. */
  private _budgetStopRequested = false;
  /** Set once dispose() begins, so a late hook callback draining during teardown emits nothing. */
  private _disposed = false;
  /** Set whenever an agent may have stopped unfinished since the last check, so the next prompt first
   *  tells the model which agents were interrupted (`reconcileInterruptions`). */
  private interruptionCheckPending = false;
  private promptIndexCounter = -1;
  /** A stored session id to resume on next start(), or to switch the live runtime to (US-010b). */
  private resumeSessionId: string | null = null;
  /** Guards the one-shot AI title generation after the first assistant turn (US-012). */
  private titleGenerationAttempted = false;
  /** The first real (non-internal, non-`<…>`) user message of this session, captured in `sendMessage`.
   *  Used by `getPlanFilePath` as a fallback before the message is committed to the branch — on the first
   *  turn `before_agent_start` builds the plan-mode prompt before the user message lands in the branch,
   *  so reading the branch alone would slug to `plan`. Matches `StoredSession.preview`. Reset on clear. */
  private _firstUserMessage: string | null = null;
  private thinkingDisabledNextQuery = false;
  /** Messages the user queued during the current turn, held until they are injected as ONE combined
   * steer at the next agent boundary. Each carries its webview chip id so the chips collapse into the
   * single combined message on delivery. Cleared on delivery, abort, and session replacement. */
  private queuedInputs: { id: string; text: string; images: ImageContent[]; content: ContentInput }[] = [];
  /** Cancel notes pi has accepted but not yet delivered. Their delivery event is not a queued batch. */
  private injectedNotes: string[] = [];
  /** The native subagent engine (Phase 5): the shared workspace registry + a per-PiSession manager. */
  private agentRegistry: AgentRegistry | null = null;
  private subagentManager: AgentManager | null = null;
  /** Unsubscribe from the shared workspace registry's change notifications (re-emits availability). */
  private _agentsUnsub: (() => void) | null = null;
  /** VS Code config listener that re-applies the subagent concurrency cap when it changes mid-session. */
  private _configUnsub: vscode.Disposable | null = null;
  /** Live `/btw` aside sessions keyed by btwId, so `cancelBtw` can abort one mid-stream (US-025). */
  private readonly btwSessions = new Map<string, { session: AgentSession; ac: AbortController }>();
  /** Browser tab scopes this session handed to its subagents / team agents. The BrowserService is shared
   *  by every panel, so the session that minted a scope is the only thing that may reclaim its tabs: an
   *  agent that failed keeps its tab for inspection and drops its scope entry, leaving nobody else able
   *  to close it once the conversation ends. */
  private readonly ownedBrowserScopes = new Set<string>();
  /** Deferred tools `ToolSearch` has loaded, durable for the life of the session. Every recompute path
   *  funnels through `applyActiveToolsForMode`, so re-applying this union there is what stops a settings
   *  toggle / MCP change / permission-mode change from silently deactivating a mid-conversation load. */
  private readonly toolSearchActivated = new Set<string>();
  /** A field, not a per-session local, so a live call's entry survives session replacement. Each entry
   *  carries the delivery of the context that registered it, so a note still reaches the conversation
   *  that ran the command and not the one that replaced it. */
  private readonly shellCancel = new ShellCancelStore();
  // Panel-scoped, not conversation-scoped: reset() and clear() swap the pi session but keep this instance, so a
  // process the user deliberately backgrounded survives a /clear and dies only when the panel is disposed.
  private readonly shellJob = createShellSessionJob();

  /** True when the turn must not be EXTENDED — ESC (`_aborting`) or the budget limit. For the
   * turn-holding paths only; those meaning "the user aborted" (the slash-command release and the
   * `prompt()` catch) deliberately keep testing `_aborting` alone. */
  private stopRequested(): boolean {
    return this._aborting || this._budgetStopRequested;
  }

  constructor(options: SessionOptions) {
    this.options = options;
    this.cwd = options.cwd;
    this.mcpScope = options.mcpScope;
    this.modelValue = options.model ?? "";
    this.permissionMode = "default";
    this.adapter = new PiStreamAdapter({
      onMessage: options.onMessage,
      cwd: options.cwd,
      sessionId: () => this.runtime?.session.sessionId ?? "",
      modelValue: () => this.modelValue,
      defaultModelValue: () => options.getDefaultModel?.() ?? this.modelValue,
      contextWindow: () => this.contextWindowForCurrentModel(),
      supportedModels: () => this.supportedModelsCache,
      permissionMode: () => this.permissionMode,
      budgetLimit: () => this.budgetLimitForEnforcement(),
      showCacheMissNotices: () =>
        vscode.workspace.getConfiguration('damocles').get<boolean>('showCacheMissNotices', false),
      showThinkingDroppedNotices: () =>
        vscode.workspace.getConfiguration('damocles').get<boolean>('showThinkingDroppedNotices', true),
      sessionCost: () => this.runtime?.session.getSessionStats().cost ?? 0,
      onBudgetStop: () => this.stopForBudget(),
      onUserMessageDelivered: (deliveredText) => this.onQueuedInputsDelivered(deliveredText),
      onMidStreamBatchCommitted: (userEntryId) => this.recordMidStreamMarker(userEntryId),
      onTurnStateChanged: (state) => this.setTurnState(state),
      ...(options.onAssistantTextFinal ? { onAssistantTextFinal: options.onAssistantTextFinal } : {}),
    });
    this.uiContext = new WebviewExtensionUIContext(options.onMessage, () => this.runtime?.session.sessionId ?? "");
    // Wired here and not at bind time: a prompt outranks the turn lifecycle even before start().
    this.uiContext.setPendingChangedListener(() => this.publishSessionState());
    options.permissionHandler.setPendingPromptsListener(() => this.publishSessionState());
  }

  // ---- lifecycle ----------------------------------------------------------

  private ensureStarted(): Promise<void> {
    // A panel replaces a disposed session rather than reviving it, so a stale caller must fail here.
    if (this._disposed) return Promise.reject(new Error("PiSession: session was disposed"));
    if (!this.startPromise)
      this.startPromise = this.start().catch((err) => {
        this.startPromise = null;
        throw err;
      });
    return this.startPromise;
  }

  /** The folder runtime, for paths that only run once `start()` has resolved it. */
  private requireFolder(): FolderRuntime {
    if (this.folder === null) throw new Error("PiSession: folder runtime used before start()");
    return this.folder;
  }

  /** A folder switch disposes a session while its webview stays live, so a start that outlived its
   *  session must not bind, register or announce anything. */
  private throwIfDisposedDuringStart(): void {
    if (this._disposed) throw new Error("PiSession: session was disposed during start");
  }

  private async start(): Promise<void> {
    const piRuntime = PiRuntime.get();
    const folder = await piRuntime.folder(this.cwd);
    this.throwIfDisposedDuringStart();
    this.folder = folder;
    const pi = getPiCodingAgent();
    if (!pi) throw new Error("PiSession.start: pi runtime not initialized");

    // Wire native custom providers (StepFun/DeepSeek/OpenRouter/Gemini) from secrets so subagents AND a
    // saved StepFun/DeepSeek default model can resolve (Phase 5, US-018.8). Deliberately still AWAITED
    // before resolveInitialModel: fire-and-forget would race the user's first prompt and route turn 1 to
    // the wrong provider. Safe to await because the sync is bounded, cancellable and fail-soft — and if
    // it does give up, the resulting model downgrade is surfaced below rather than applied silently.
    let syncTimedOut = false;
    let notWiredProviders: string[] = [];
    if (this.options.secrets) {
      const secrets = this.options.secrets;
      ({ notWired: notWiredProviders, timedOut: syncTimedOut } = await piRuntime.syncCustomProviders((key) => secrets.get(key)));
      this.throwIfDisposedDuringStart();
    }

    const requestedModel = this.modelValue;
    this.resolveInitialModel(piRuntime);
    if (syncTimedOut) this.warnCustomProviderFallback(piRuntime, requestedModel, notWiredProviders);

    // Native subagent engine (Phase 5): a cross-turn per-PiSession registry + manager, created before the
    // factory so the primary session's customTools include the three subagent tools.
    this.ensureSubagentEngine(pi, folder);

    const factory: CreateAgentSessionRuntimeFactory = async (opts) => {
      // Refresh the folder's extension runtime so each session binds to its own fresh runtime — a
      // disposed session marks its runtime stale, and reload() (verified) only swaps the loader's
      // current runtime without invalidating other panels' already-bound live sessions, so this also
      // isolates concurrent panels. Skipped only for the folder's first session (which uses the
      // pristine creation runtime); every later session on the same folder reloads.
      await folder.prepareSessionExtensions();
      const shared = folder.services;
      // Filled in below, once this factory call's session exists. The tools are built before it does, so
      // the note delivery reads it through a thunk; binding it here and not to `this.runtime` is what
      // keeps a leftover shell call's note in the conversation that ran the command.
      const bound: { session?: AgentSession } = {};
      // Built per session so per-session tool state (the task list) resets on reset/newSession.
      const customTools = buildCustomTools({
        pi,
        cwd: this.cwd,
        permissionHandler: this.options.permissionHandler,
        ...(this.options.memoryService ? { memoryService: this.options.memoryService } : {}),
        ...(this.options.compassService ? { compassService: this.options.compassService } : {}),
        ...(this.options.browserService ? { browserService: this.options.browserService } : {}),
        getSessionId: () => this.memorySessionId,
        getPlanFilePath: () => this.getPlanFilePath(),
        ...(this.subagentManager ? { subagentManager: this.subagentManager } : {}),
        ...(this.options.teamService ? { teamService: this.options.teamService } : {}),
        isTeamEnabled: () => !!this.options.teamService && this.isTeamEnabled(),
        getShellOptions: () => this.shellOptions(),
        shellCancel: this.shellCancel,
        deliverUserNote: this.noteDeliveryForMain(() => bound.session),
        shellJob: this.shellJob,
      });
      // No `tools:` on purpose. pi freezes `options.tools` into an `_allowedToolNames` filter; since the
      // factory runs before `setMcpServers`, a frozen list would permanently exclude later-registered
      // mcp__ tools (the first-connect bug). Omitting it admits every non-excluded tool into the registry;
      // the active set is governed by `applyActiveToolsForMode`. `excludeTools` still drops pi's `edit`.
      const result = await pi.createAgentSessionFromServices({
        services: shared,
        sessionManager: opts.sessionManager,
        ...(this.desiredModel ? { model: this.desiredModel } : {}),
        excludeTools: [...PI_EXCLUDED_TOOLS],
        customTools,
        thinkingLevel: this.resolveThinkingLevel(),
      });
      bound.session = result.session;
      return { ...result, services: shared, diagnostics: shared.diagnostics ?? [] };
    };

    // Pin sessions to the Damocles-owned pi tree dir (~/.damocles/pi/agent/sessions/<cwd>/), isolated
    // from the user's ~/.pi store (FR-1). `create(cwd)` alone would default to ~/.pi/agent.
    const sessionDir = ensurePiSessionDir(this.cwd);
    // Resume target set before first start (e.g. ready-with-savedSessionId): open the stored session
    // file instead of creating fresh, so the live conversation continues it (US-010b). A forked panel
    // resumes its branched session file (US-013c).
    const fork = this.options.forkContext;
    const forkResumeId = fork && !fork.consumed ? fork.piBranchedSessionId : undefined;
    const resumeTargetId = this.resumeSessionId ?? forkResumeId ?? null;
    const resumePath = resumeTargetId ? await resolvePiSessionFile(this.cwd, resumeTargetId) : null;
    this.throwIfDisposedDuringStart();
    if (resumePath && forkResumeId && fork) fork.consumed = true;
    const sessionManager = resumePath ? pi.SessionManager.open(resumePath, sessionDir) : pi.SessionManager.create(this.cwd, sessionDir);
    const runtime = await pi.createAgentSessionRuntime(factory, { cwd: this.cwd, agentDir: PI_AGENT_DIR, sessionManager });
    if (this._disposed) {
      // dispose() already ran with no runtime to tear down, so this one is ours to release.
      await runtime.dispose();
      this.throwIfDisposedDuringStart();
    }
    this.runtime = runtime;

    this.bindSession(this.runtime.session);
    // Continue the token/budget meter from the resumed session's loaded total rather than zero.
    if (resumePath) {
      this.seedResumedUsage();
      this.interruptionCheckPending = true;
    }
    // Sync the active tool set to the panel's current permission mode (a forked panel may already be
    // in plan mode at session-creation time; the factory `tools` only sets the full default set).
    this.permissionMode = this.options.permissionHandler.getPermissionMode();
    this.applyActiveToolsForMode(this.permissionMode);

    this.runtime.setBeforeSessionInvalidate(() => {
      this.unsubscribe?.();
      this.unsubscribe = null;
    });
    this.runtime.setRebindSession(async (session) => {
      this.bindSession(session);
      // No factory `tools:` means a replacement session starts with pi's bare default set — re-apply the
      // panel's real active set (mirrors start()), else reset/clear would strip every non-default tool.
      this.applyActiveToolsForMode(this.permissionMode);
      // A replacement session (reset/clear → newSession) carries a fresh sessionId; the consumer
      // re-arms the watcher and re-registers the session off this callback, so it must fire here too.
      this.options.onSessionIdChange?.(session.sessionId);
      // Both paths that reach here, a reset/clear and a resume switch, make the webview reset its own
      // store, so the cached key describes a state nothing on screen is showing any more.
      this.lastSessionState = null;
      this.publishSessionState();
    });

    const sid = this.runtime.session.sessionId;
    this.options.onSessionIdChange?.(sid);
    // resolveInitialModel may have moved the model off the requested one, and the panel has had no
    // account state before this point.
    this.publishAccountInfo();
  }

  /**
   * Subscribe the adapter, re-apply the B3 compaction-off invariant, register this panel in the
   * shared gate registry (keyed by the session's id), and bind the webview extension-UI context.
   * Called on initial start and on every session replacement (reset/clear → newSession).
   */
  private bindSession(session: AgentSession): void {
    this.unsubscribe = this.adapter.subscribe(session);
    // Graceful budget stop (US-008): pi consults this once per model round-trip, so `end` finishes the
    // turn at the next boundary with the in-flight message and its tool results intact, unlike an
    // abort. Installed here because start() and setRebindSession both funnel through bindSession, and a
    // REPLACEMENT session brings a new Agent needing it re-installed (as `applyActiveToolsForMode` does).
    // Must read the field at call time — pi snapshots the function reference at run start, so a captured
    // boolean would freeze at that run's starting value.
    installTurnDecider(session.agent, BUDGET_STOP_HOOK, () =>
      this._budgetStopRequested ? { action: 'end' } : undefined,
    );
    // The main panel session honors `damocles.autoCompact` (US-030); pi's compaction flag lives on the
    // shared settings manager, so subagent/team/btw sessions isolate it via their own in-memory manager
    // (see FolderRuntime.createSubagentSession) — they never auto-compact regardless of this toggle.
    this.applyCompactionConfig();
    this.applyCacheWarmingConfig();

    const folder = this.requireFolder();
    const sessionId = session.sessionId;
    if (this.registeredSessionId && this.registeredSessionId !== sessionId) {
      // Gate on the id ACTUALLY changing: a rebind onto the same session (refresh, mode change) must
      // keep whatever ToolSearch loaded, while a replacement session starts from the deferred baseline.
      this.toolSearchActivated.clear();
      this.unregisterFromRuntime(folder, this.registeredSessionId);
      // A replacement session gets a fresh checkpoint driver + rewindable set.
      this.checkpointService?.dispose();
      this.checkpointService = null;
      this.checkpointUserIds.clear();
      this.lastCheckpointBroadcast = -1;
    }
    const gate: PanelGateContext = {
      permissionHandler: this.options.permissionHandler,
      isPlanMode: () => this.options.permissionHandler.getPermissionMode() === "plan",
      ...(this.options.memoryService ? { memoryService: this.options.memoryService } : {}),
      ...(this.options.compassService ? { compassService: this.options.compassService } : {}),
      getSessionModel: () => this.modelValue,
      getSystemPromptEnv: () => this.systemPromptEnv(),
      getPlanFilePath: () => this.getPlanFilePath(),
      isTeamEnabled: () => !!this.options.teamService && this.isTeamEnabled(),
      postMessage: (message) => this.emit(message),
      currentPromptIndex: () => this.currentPromptIndex,
      budgetStopRequested: () => this._budgetStopRequested,
      onBeforeSettle: (event) => this.onBeforeSettle(event),
      isMcpReadOnly: (name) => this.mcpClientManager()?.isMcpReadOnly(name) ?? false,
      deferrableTools: () => this.deferrableToolsSnapshot(),
      activateDeferredTools: (names) => this.activateDeferredTools(names),
    };
    folder.registerPanel(sessionId, gate);
    this.registeredGate = gate;
    // Register the live rename/tag surface so a mutation from any panel routes here, not to a
    // second file-writer that would fork this session's branch (US-012, cross-panel).
    PiRuntime.get().registerSessionMutator(sessionId, this);
    // On MCP tools-changed, re-apply this session's active set and push fresh MCP status (no manual
    // refresh). `reloadForMcpToolChange` also rebuilds an orphaned-runtime session whose registry never
    // got the new tools (multi-panel); it's a plain refresh when not orphaned.
    const refreshTools = (): void => {
      this.reloadForMcpToolChange();
      this._mcpStatusListener?.();
    };
    folder.registerActiveToolRefresher(sessionId, refreshTools);
    this.registeredToolRefresher = refreshTools;
    this.registeredSessionId = sessionId;

    // permission_required notifier (US-009): lazy + debounced-per-turn. Fires only when a hook is
    // configured and only at the two genuine approval waits (file/shell), mapping onto the synthetic
    // `permission_required` hook. Re-set per rebind so the captured session's transcript stays current.
    // For a SUBAGENT approval, `info.parentToolUseId` is set but `session_id`/`transcript_path` (and the
    // debounce key) are the primary panel's — the approval surfaces on the primary, and the parent tool-use
    // id identifies the subagent. This is an observe-only notification, so the primary identity is benign.
    this.options.permissionHandler.setPermissionRequiredNotifier((info) => {
      const deps = folder.getHooksDispatchDeps();
      if (!deps.config.hasEntries("permission_required")) return;
      const turnKey = `${sessionId}:${this.currentPromptIndex}`;
      if (this._lastPermissionNotifyKey === turnKey) return;
      this._lastPermissionNotifyKey = turnKey;
      const payload = buildPermissionRequiredPayload(
        { session_id: sessionId, transcript_path: session.sessionManager.getSessionFile() ?? "", cwd: this.cwd },
        {
          message: info.message,
          tool_name: info.toolName,
          input: info.toolInput,
          ...(info.filePath !== undefined ? { file_path: info.filePath } : {}),
          ...(info.command !== undefined ? { command: info.command } : {}),
          ...(info.parentToolUseId !== undefined ? { parentToolUseId: info.parentToolUseId } : {}),
        },
      );
      void dispatchObserveOnly(deps, "permission_required", this.cwd, payload).catch((err) =>
        log("[PiSession] permission_required hook failed: %O", err),
      );
    });

    // Canonical plan reader for the permission layer (ExitPlanMode approval reads the file, not a summary).
    this.options.permissionHandler.setPlanContentResolver(() => this.getPlanContent());

    // Per-session checkpoint driver (US-013b): created here so it's registered before the first turn's
    // message_start. `hydrate` re-surfaces any checkpoints already in a resumed/forked session tree so
    // it is immediately rewindable; for a fresh session it is a no-op.
    this.checkpointService = new CheckpointService({ cwd: this.cwd, onCheckpointReady: (id) => this.addCheckpoint(id) });
    folder.registerCheckpointService(sessionId, this.checkpointService);
    this.checkpointService.hydrate(session.sessionManager);

    // Cancel any dialogs left pending by the previous session, then bind the UI context (US-026).
    this.uiContext.cancelAll();
    void session.bindExtensions({ uiContext: this.uiContext, mode: "rpc" }).catch((err) => log("[PiSession] bindExtensions failed: %O", err));

    // The latest scope, never the creation-time one: a live feed may have arrived before the folder existed.
    if (this.mcpScope) this.applyMcpScope(this.mcpScope);
  }

  /** Release every runtime registry entry this panel registered under `sessionId`. */
  private unregisterFromRuntime(folder: FolderRuntime, sessionId: string): void {
    if (this.registeredGate) folder.unregisterPanel(sessionId, this.registeredGate);
    if (this.checkpointService) folder.unregisterCheckpointService(sessionId, this.checkpointService);
    PiRuntime.get().unregisterSessionMutator(sessionId, this);
    if (this.registeredToolRefresher) folder.unregisterActiveToolRefresher(sessionId, this.registeredToolRefresher);
    this.registeredGate = null;
    this.registeredToolRefresher = null;
  }

  /**
   * Pick the starting model: the saved value if its canonical provider is authed, otherwise the
   * first curated model the user is actually signed in for (so a codex-only user defaults to a GPT
   * model rather than an unusable Claude/gateway one). Leaves the model unset if nothing is authed.
   */
  private resolveInitialModel(piRuntime: PiRuntime): void {
    const registry = piRuntime.modelRuntime;
    if (!registry) return;
    const openai = piRuntime.getOpenAIAuthStatus();

    const preferApiKey = this.preferOpenAIApiKey();
    const isCurated = (value: string): boolean => this.supportedModelsCache.some((m) => m.value === value);
    const trySet = (value: string): boolean => {
      const res = resolvePiModel(value, registry, openai, preferApiKey);
      if (res.model && res.authed) {
        this.desiredModel = res.model;
        this.modelValue = value;
        return true;
      }
      return false;
    };

    // Honor the saved model only if it's a curated value AND authed; else fall back to the first
    // curated model the user is signed in for (keeps the active model in sync with the dropdown).
    if (this.modelValue && isCurated(this.modelValue) && trySet(this.modelValue)) return;
    // Before that generic walk, try the requested model's declared substitutes. `supportedModelsCache`
    // is ordered by capability rather than price, so a model missing from pi's catalog (a fresh install
    // that is offline or has not refreshed it yet) would otherwise land on the top entry — costlier than
    // what the user actually asked for.
    for (const substitute of MODEL_SUBSTITUTES[this.modelValue] ?? []) {
      if (isCurated(substitute) && trySet(substitute)) return;
    }
    for (const m of this.supportedModelsCache) {
      if (trySet(m.value)) return;
    }
  }

  /**
   * Surface the model downgrade a timed-out provider sync causes: with the saved default not live,
   * `resolveInitialModel` falls back to a curated Claude/GPT model — a different provider with different
   * cost and capabilities than the user picked, which must not happen quietly. Fire-and-forget, so the
   * notification never gates startup on an answer.
   *
   * Keyed off `notWired` (configured but not live), never off the absence from `wired`: a provider whose
   * secret the user deleted is deauthenticated and appears in NEITHER list, and telling that user we
   * "could not reach" their provider — then offering a reload that cannot help — is a wrong diagnosis.
   */
  private warnCustomProviderFallback(piRuntime: PiRuntime, requested: string, notWired: string[]): void {
    const info = this.supportedModelsCache.find((m) => m.value === requested);
    if (!info?.piProvider || !notWired.includes(info.piProvider)) return;
    // A resolved substitute means a downgrade; no `desiredModel` at all means nothing was authed, which
    // leaves `modelValue` equal to `requested` and is the MORE broken case, not a reason to stay silent.
    const fallback = this.modelValue === requested ? null : this.modelValue;
    if (fallback === null && this.desiredModel) return;
    // One modal per runtime: every open panel starts its own PiSession against the same PiRuntime, and
    // persistent lock contention would otherwise stack one identical modal per panel.
    if (fallbackWarnedRuntimes.has(piRuntime)) return;
    fallbackWarnedRuntimes.add(piRuntime);

    const providerName = providerDisplayName(info);
    const requestedName = info.displayName;
    const fallbackName = fallback === null ? null : (this.supportedModelsCache.find((m) => m.value === fallback)?.displayName ?? fallback);
    const message =
      fallbackName === null
        ? vscode.l10n.t(
            "Damocles could not reach {0} in time, so \"{1}\" is unavailable and no signed-in model could be selected.",
            providerName,
            requestedName,
          )
        : vscode.l10n.t(
            "Damocles could not reach {0} in time, so \"{1}\" is unavailable and \"{2}\" is being used instead.",
            providerName,
            requestedName,
            fallbackName,
          );
    const reload = vscode.l10n.t("Reload Window");
    void (async () => {
      // VS Code's Thenable is not a Promise, so `void thenable.then(...)` attaches no rejection handler
      // and a failing executeCommand would vanish.
      const choice = await vscode.window.showWarningMessage(message, reload);
      if (choice === reload) await vscode.commands.executeCommand("workbench.action.reloadWindow");
    })().catch((err) => log("[PiSession] provider fallback notification failed: %O", err));
  }

  // ---- messaging ----------------------------------------------------------

  async sendMessage(
    prompt: ContentInput,
    _agentId?: string,
    correlationId?: string,
    userBroadcast?: { content: string; contentBlocks?: UserContentBlock[] },
    options?: { isInternal?: boolean },
  ): Promise<void> {
    if (this.processingFlag || this.compacting) {
      this.adapter.emitAlreadyInProgress();
      return;
    }
    const abortEpoch = this.abortEpoch;
    try {
      await this.ensureStarted();
    } catch (err) {
      this.emit({ type: "error", message: `pi failed to start: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    // Wait for any in-flight session replacement so we prompt the FRESH session, not the old one that
    // is still tearing down (else pi throws "Agent is already processing"). Drives the plan
    // "clear context & start fresh" flow, which calls clear() then sendMessage() synchronously.
    if (this.resetPromise) {
      const pending = this.resetPromise;
      await pending;
      if (this.resetPromise === pending) this.resetPromise = null;
    }
    // Likewise wait for an in-flight abort (interrupt/cancel) to fully wind the prior turn down before
    // starting a new one. ESC during a long tool (e.g. browser open) keeps pi streaming until the tool
    // returns; a sendMessage that arrived in that window would otherwise hit "Agent is already
    // processing". Tools honor the abort signal, so this resolves promptly rather than blocking.
    if (this.abortPromise) {
      await this.abortPromise;
    }
    // Flush a deferred MCP reload (a connect that arrived mid-turn on an orphaned session): the prior
    // turn has settled, so rebuild now — awaited so this turn prompts against the rebuilt session.
    if (this.mcpReloadPendingAfterTurn) {
      await this.runMcpReload();
    }
    const session = this.runtime?.session;
    if (!session) {
      this.emit({ type: "error", message: "Failed to initialize pi session" });
      return;
    }
    // Before `beginTurn`: the notice's own message_start must not be read as this turn's user entry.
    await this.reconcileInterruptionsIfPending(session);
    // No await may follow this check before `prompt()`: an ESC or a session replacement that lands in
    // one would be lost, and the message would run anyway.
    if (this.abortEpoch !== abortEpoch || this.runtime?.session !== session) {
      this.returnUnsentMessage(correlationId, userBroadcast);
      return;
    }
    // Capture the session's first real user message for the deterministic plan path (FR-3/FR-4). The
    // branch doesn't yet hold this prompt when `before_agent_start` builds the plan-mode system prompt on
    // the first turn, so `getPlanFilePath` falls back to this. Prefer the user's ORIGINAL typed text
    // (`userBroadcast.content`) over the expanded `prompt` so the slug matches the branch-derived value
    // `extractFirstUserMessage` later returns (which resolves the same original via the sidecar). Otherwise
    // a slash-command/skill first message would slug the expansion now and the original later, splitting
    // the session across two plan files. Drops `<…>`-prefixed synthetic prompts and internal sends; being a
    // pre-branch fallback, it self-heals to the branch-derived value once a qualifying message lands.
    if (!options?.isInternal && this._firstUserMessage === null) {
      const text = userBroadcast?.content ?? piMessageText(prompt);
      if (text && !text.trimStart().startsWith("<")) this._firstUserMessage = text;
    }

    // Pre-prompt budget block (US-008): if the session already crossed the hard limit, refuse the next
    // turn rather than starting one that would immediately abort.
    const budgetLimit = this.budgetLimitForEnforcement();
    if (budgetLimit !== null && this.cumulativeCostUsd() >= budgetLimit) {
      this.emit({ type: "budgetExceeded", finalSpend: this.cumulativeCostUsd(), limit: budgetLimit });
      this.emit({ type: "processing", isProcessing: false });
      return;
    }

    const isInternal = options?.isInternal === true;
    if (!isInternal) this.promptIndexCounter += 1;

    if (userBroadcast && correlationId) {
      this.emit({
        type: "userMessage",
        content: userBroadcast.content,
        ...(userBroadcast.contentBlocks ? { contentBlocks: userBroadcast.contentBlocks } : {}),
        correlationId,
        promptIndex: Math.max(0, this.promptIndexCounter),
        ...(isInternal ? { isInjected: true } : {}),
      });
    }

    this.processingFlag = true;
    this._aborting = false;
    this._budgetStopRequested = false;
    session.setThinkingLevel(this.resolveThinkingLevel());
    // Refresh the auto-compaction reserve against the current model's window before the turn, so the
    // configured trigger percent holds even after a model switch or a settings save() (US-030).
    this.refreshCompactionReserve();
    this.adapter.beginTurn(correlationId);

    const text = extractText(prompt);
    const images = extractImages(prompt);
    // The user entry id BEFORE this turn, so we only record an original-input sidecar when prompt()
    // actually committed a NEW user message (a pi extension command like `/todos` commits none).
    const priorUserEntryId = lastUserEntry(session)?.id ?? null;
    try {
      // Defense in depth: under 0.80.5 `isStreaming` stays true for the whole agent run, including
      // retry/auto-compaction windows. A prompt landing in one of those windows now queues as a
      // follow-up instead of hitting pi's "Agent is already processing" rejection — the message runs
      // as a continuation rather than being lost. Strictly better desync defense than before.
      const promptOpts = {
        ...(images.length > 0 ? { images } : {}),
        ...(session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
      };
      await session.prompt(text, Object.keys(promptOpts).length > 0 ? promptOpts : undefined);
      // An extension slash command (e.g. `/todos`) is handled synchronously inside prompt() and starts
      // no agent run, so no terminal event settles the turn — the spinner would hang. Under 0.80.5
      // prompt() resolves only when the run is fully settled, so `isStreaming` is reliably false here
      // for a slash command that started no run. When prompt() resolved without an observed run and the
      // agent isn't streaming, release the turn ourselves.
      if (!this._aborting && !session.isStreaming && !this.adapter.observedAgentRun()) {
        this.adapter.endTurnWithoutAgentRun();
      }
      // A slash command was expanded to its body before persisting — pi expands prompt templates inside
      // prompt(), chat-handlers rewrites skills/`/init` before sendMessage — so the on-disk user message
      // no longer matches what the user typed. Record the original typed text as an inert sidecar keyed
      // to the pi user entry so reload/up-arrow/preview can restore it.
      if (!isInternal && userBroadcast) this.recordOriginalInputIfDiverged(session, userBroadcast.content, priorUserEntryId);
      // The turn completed (prompt resolves once the run has settled). After the first real turn, auto-title the
      // session (US-012). Fire-and-forget so it never blocks the next interaction.
      if (!isInternal) void this.maybeGenerateTitle();
      // Record the completed exchange as a memory extraction candidate so the consolidation passes have
      // something to extract from (and the idle timer arms). Symmetric with the harvesters above.
      if (!isInternal && userBroadcast) this.enqueueMemoryCandidate(session, priorUserEntryId);
    } catch (err) {
      // A user abort rejects prompt(); interrupt()/cancel() already emitted sessionCancelled + idle,
      // so swallow the rejection here rather than stacking a spurious error card on top of it.
      if (this._aborting) {
        log("[PiSession] prompt aborted by user");
      } else {
        log("[PiSession] prompt failed: %O", err);
        this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
        this.emit({ type: "processing", isProcessing: false });
      }
    } finally {
      this.processingFlag = false;
      // The turn is over however it ended. A rejection that never reached an agent run emits no pi
      // event, so without this the lifecycle would stay `running` with nothing left to move it.
      this.setTurnState("idle");
      this._aborting = false;
      this._budgetStopRequested = false;
    }
  }

  /** A message cancelled or orphaned before its turn started never reached the model, so it goes back
   *  to the composer. */
  private returnUnsentMessage(correlationId: string | undefined, userBroadcast: { content: string } | undefined): void {
    log("[PiSession] message not sent: cancelled or session replaced before its turn started");
    this.emit({ type: "processing", isProcessing: false });
    if (correlationId && userBroadcast) this.emit({ type: "interruptRecovery", correlationId, promptContent: userBroadcast.content });
  }

  /** Append the hidden interruption notice when one is pending. Never throws. */
  private async reconcileInterruptionsIfPending(session: AgentSession): Promise<void> {
    if (!this.interruptionCheckPending) return;
    this.interruptionCheckPending = false;
    try {
      await reconcileInterruptions({
        branch: session.sessionManager.getBranch(),
        subagentDir: subagentsDir(ensurePiSessionDir(this.cwd), session.sessionId),
        liveSubagent: (id) => this.subagentManager?.liveStatus(id),
        teamResumable: (teamId) => new TeamPersistence(this.cwd, session.sessionId).isResumable(teamId),
        // A replaced session's file may already be deleted, and an append would recreate it header-less.
        send: async (message) => {
          if (this.runtime?.session !== session) return;
          await session.sendCustomMessage(message, { triggerTurn: false });
        },
      });
    } catch (err) {
      log("[PiSession] interruption notice failed: %O", err);
      this.emit({
        type: "notification",
        message: "Could not record which agents were interrupted; the model will not be told it can resume them.",
        notificationType: "warning",
      });
    }
  }

  /**
   * Queue a mid-turn message. All messages queued before the next agent boundary are combined into ONE
   * steer (US): held in `queuedInputs`, re-steered as a single combined prompt each time one arrives
   * (clearing the prior steer so pi holds exactly one). pi injects the combined prompt at its next turn
   * boundary, redirecting the agent mid-task. Returns 'queued' so the webview shows a pending chip per
   * message; the chips collapse into the combined message once the adapter sees pi deliver it.
   */
  queueInput(content: ContentInput, messageId?: string): "queued" | "flushed" | false {
    const session = this.runtime?.session;
    // Gate on pi's own streaming state, not `processingFlag`: the two can momentarily disagree. Under
    // 0.80.5 `isStreaming` also stays true across retry/compaction windows, so input is now accepted
    // during those (desirable — pi steers at the next boundary); the disagreement window is narrower.
    // A queue routed to a non-streaming session must still be refused so the caller can fall back.
    // Refused after a budget stop too, even though the run is still streaming: pi's settle boundary
    // continues on a non-empty queue whatever the decider answers, so accepting one bills a round trip
    // past a hard limit (the same hazard `stopForBudget` flushes the existing queue for).
    if (!session || !session.isStreaming || this._budgetStopRequested) return false;
    this.queuedInputs.push({
      id: messageId ?? `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text: extractText(content),
      images: extractImages(content),
      content,
    });
    this.resteerQueuedInputs(session);
    return "queued";
  }

  /**
   * Re-steer the whole queued buffer as one combined message. `clearQueue()` drops the previously
   * steered (not-yet-delivered) combination so pi never holds stale copies; follow-ups are preserved.
   * Routed through prompt() (not raw steer()) so slash-command/skill handling and images survive — the
   * raw queue methods throw on `/`-prefixed input and would drop it silently.
   */
  private resteerQueuedInputs(session: AgentSession): void {
    if (this.queuedInputs.length === 0) return;
    const { followUp } = session.clearQueue();
    const combinedText = this.queuedInputs.map((q) => q.text).join("\n\n");
    const images = this.queuedInputs.flatMap((q) => q.images);
    void session
      .prompt(combinedText, { streamingBehavior: "steer", ...(images.length > 0 ? { images } : {}) })
      .catch((err) => log("[PiSession] steered prompt failed: %O", err));
    // Re-queued the way they were queued, not through `followUp()`: that one runs the extension-command
    // check and the skill and template expansion, which would execute or rewrite a cancel note that was
    // deliberately queued as literal text.
    for (const text of followUp) {
      void session
        .sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false })
        .catch((err) => log("[PiSession] re-queueing a preserved follow-up failed: %O", err));
    }
  }

  /**
   * Called by the adapter when pi delivers a user message mid-run (a steer/follow-up delivery — the
   * initial prompt lives in the run's initial context and emits no such event). The held buffer has now
   * been injected, so collapse its chips into the single combined message and clear the buffer; further
   * queueing starts a fresh combination.
   */
  onQueuedInputsDelivered(deliveredText: string): boolean {
    // A cancel note is queued straight onto the pi session, so its delivery raises the same event a
    // steered batch does. Matching on the text is exact because the note is sent with template
    // expansion off, and it is order-independent: pi drains steers before follow-ups, so a counter
    // would let a batch delivered first consume the note's signal.
    const injected = this.injectedNotes.indexOf(deliveredText);
    if (injected !== -1) {
      this.injectedNotes.splice(injected, 1);
      return false;
    }
    if (this.queuedInputs.length === 0) return false;
    const messageIds = this.queuedInputs.map((q) => q.id);
    const combinedContent = this.queuedInputs.map((q) => q.text).join("\n\n");
    const blocks = this.queuedInputs.flatMap((q) => (typeof q.content === "string" ? [] : q.content));
    this.queuedInputs = [];
    this.emit({
      type: "queueBatchProcessed",
      messageIds,
      combinedContent,
      ...(blocks.length > 0 ? { contentBlocks: blocks } : {}),
    });
    // A real batch was delivered; its mid-stream marker is owed once pi commits the steered user entry.
    // The adapter resolves the committed entry id at the next assistant message_start (the delivery
    // event fires before pi persists the entry) and calls back into recordMidStreamMarker.
    return true;
  }

  /**
   * Persist a mid-stream marker keyed to a delivered queued batch's committed pi user entry id, so a
   * reloaded session re-applies the amber "sent mid-stream" styling. Called by the adapter at the next
   * assistant message_start — the first point the steered entry is committed to the tree (keying it at
   * delivery time mis-keys to the previous turn's entry). Fail-soft: a write error never breaks the turn.
   */
  recordMidStreamMarker(userEntryId: string): void {
    const session = this.runtime?.session;
    if (!session) return;
    try {
      session.sessionManager.appendCustomEntry(DAMOCLES_MID_STREAM_ENTRY, { userEntryId });
    } catch (err) {
      log("[PiSession] recordMidStream failed: %O", err);
    }
  }

  /** Drop any queued-but-undelivered messages and remove their chips (turn aborted / session reset). */
  private clearQueuedInputs(): void {
    if (this.queuedInputs.length === 0) return;
    const ids = this.queuedInputs.map((q) => q.id);
    this.queuedInputs = [];
    for (const messageId of ids) this.emit({ type: "queueCancelled", messageId });
  }

  async interrupt(): Promise<void> {
    await this.beginAbort("interrupt");
  }

  cancel(): void {
    void this.beginAbort("cancel");
  }

  /** Stops one running shell call. The turn continues, so this must never reach `beginAbort`. */
  cancelToolCall(toolUseId: string, note?: string): boolean {
    const cancelled = this.shellCancel.cancel(toolUseId, note);
    if (!cancelled) log("[PiSession] cancelToolCall: no live shell call for %s", toolUseId);
    return cancelled;
  }

  /**
   * The panel session's cancel-note delivery, bound at the main `buildCustomTools` call site to the
   * session that call created, which is why a cancel arriving after `reset()` still reaches the
   * conversation that ran the command rather than the one that replaced it.
   *
   * The echo waits for pi to accept the note into its queue, because a `sendUserMessage` that rejects
   * outright, which is what a session being replaced or torn down under a leftover call does, would
   * otherwise have already told the user the agent was told. Acceptance is also where the subagent and
   * team contexts echo, so all three mean the same thing by an echo, and it is the last point that is
   * still synchronous enough to keep the note next to the tool card it belongs to. Returning before the
   * echo keeps the cancel path synchronous for its caller. `isInjected` is what keeps a note the user
   * never typed into the composer out of prompt counting, which is also why `promptIndexCounter` is not
   * advanced. Subagents and team agents echo through `subagentSteered` and `teamAgentUserMessage`, so
   * only this context emits `userMessage`.
   */
  private noteDeliveryForMain(session: () => AgentSession | undefined): (text: string) => void {
    const deliver = sessionNoteDelivery(session);
    return (text) => {
      const promptIndex = Math.max(0, this.promptIndexCounter);
      void deliver(text).then(
        () => {
          // pi delivers this back as a user message_end of its own; record it so that delivery is not
          // mistaken for the queued chip batch being injected.
          this.injectedNotes.push(text);
          this.emit({ type: "userMessage", content: text, correlationId: randomUUID(), promptIndex, isInjected: true });
        },
        (err) => log("[PiSession] cancel note delivery to the panel session failed: %O", err),
      );
    };
  }

  /** One subagent's cancel-note delivery, bound at the subagent `buildCustomTools` call site. */
  private noteDeliveryForSubagent(agentId: string): (text: string) => void {
    return subagentNoteDelivery((id, message) => this.steerSubagent(id, message), agentId);
  }

  /** One team agent's cancel-note delivery, bound at the team `buildCustomTools` call site. */
  private noteDeliveryForTeamAgent(ctx: AgentMcpContext): (text: string) => void {
    return teamAgentNoteDelivery(ctx.deliverUserNote, ctx.agentName);
  }

  /**
   * Tear down the in-flight turn. Emits `sessionCancelled` + idle immediately, then drives
   * `session.abort()` (which aborts the agent and waits for it to go idle). The abort promise is
   * tracked so the next `sendMessage` awaits it — a turn started before pi finished winding down would
   * otherwise hit pi's "Agent is already processing" rejection.
   */
  private beginAbort(origin: "interrupt" | "cancel"): Promise<void> {
    this.abortEpoch++;
    this._aborting = true;
    this.processingFlag = false;
    // An abort during a long tool with no model stream open produces no aborted assistant event, so
    // this is the only thing that tells the webview the turn is over.
    this.setTurnState("idle");
    this._budgetStopRequested = false;
    this.adapter.markAborted();
    // Abort-everything: ESC kills foreground AND background subagents (Phase 5, FR-12).
    this.subagentManager?.abortAll("user");
    this.interruptionCheckPending = true;
    // ESC during a team aborts it; its `create_team` tool then returns the partial synthesis (US-024d).
    this.options.teamService?.cancelActiveTeam();
    this.clearQueuedInputs();
    // The adapter stops reporting user deliveries once aborted, so an accepted note will never be
    // matched off this list; leaving it would let a later chip batch with the same text match it.
    this.injectedNotes = [];
    this.emit({ type: "sessionCancelled" });
    this.emit({ type: "processing", isProcessing: false });
    const pending = (async () => {
      try {
        await this.runtime?.session.abort();
      } catch (err) {
        log("[PiSession] %s abort failed: %O", origin, err);
      }
    })();
    this.abortPromise = pending;
    void pending.finally(() => {
      if (this.abortPromise === pending) this.abortPromise = null;
    });
    return pending;
  }

  async cancelAutoCompact(): Promise<void> {
    this.runtime?.session.abortCompaction();
  }

  /**
   * Manually compact the conversation (US-030). Gated to idle: if a turn is in flight we refuse rather
   * than abort it mid-stream (pi's `compact()` would abort the current op first). The adapter translates
   * pi's `compaction_start`/`compaction_end` events into the existing webview compaction messages.
   */
  async compact(instructions?: string): Promise<void> {
    if (this.processingFlag || this.compacting) {
      this.emit({ type: "notification", message: "Finish or stop the current turn before compacting.", notificationType: "warning" });
      return;
    }
    // Hold `compacting` across the whole operation so a sendMessage arriving mid-compaction is rejected
    // with the normal "already in progress" notice instead of racing into pi's raw "Agent is already
    // processing" error on the shared session.
    this.compacting = true;
    try {
      try {
        await this.ensureStarted();
      } catch (err) {
        this.emit({ type: "error", message: `pi failed to start: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      if (this.resetPromise) await this.resetPromise;
      if (this.abortPromise) await this.abortPromise;
      const session = this.runtime?.session;
      if (!session) {
        this.emit({ type: "error", message: "Failed to initialize pi session" });
        return;
      }
      const trimmed = instructions?.trim();
      try {
        await session.compact(trimmed && trimmed.length > 0 ? trimmed : undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // pi emits `compaction_end` and then rethrows the same failure, so the adapter has usually
        // already put a card on screen for it. Only what the adapter left unreported belongs here.
        if (this.adapter.takeCompactionReported()) {
          log("[PiSession] compact outcome already reported by the adapter: %s", message);
        } else if (isNothingToCompact(message)) {
          log("[PiSession] compact skipped: nothing to compact (session too small)");
          this.emit({ type: "notification", message: "Nothing to compact yet — the conversation is too small.", notificationType: "info" });
        } else {
          log("[PiSession] compact failed: %O", err);
          this.emit({ type: "error", message });
        }
      }
    } finally {
      this.compacting = false;
    }
  }

  /** The `damocles.autoCompact` config, read live so a mid-session change applies on the next call. */
  private autoCompactConfig(): AutoCompactConfig {
    return vscode.workspace
      .getConfiguration("damocles")
      .get<AutoCompactConfig>("autoCompact", { enabled: false, triggerPercent: 80 });
  }

  /**
   * Apply the panel's auto-compaction preference to the shared pi settings manager (US-030). `enabled`
   * is written durably via `setCompactionEnabled` (it survives the settings manager's frequent `save()`
   * rebuilds and defeats pi's default-on), and the model-dependent `reserveTokens` is refreshed from the
   * configured trigger percent. Called on bind and on the config-change handler.
   */
  private applyCompactionConfig(): void {
    if (this.folder === null) return;
    const sm = this.folder.services.settingsManager;
    const cfg = this.autoCompactConfig();
    sm.setCompactionEnabled(cfg.enabled);
    if (cfg.enabled) this.refreshCompactionReserve(cfg);
  }

  /**
   * Apply `damocles.cacheWarming` to the shared pi settings manager. pi's `CacheWarmer` reads the mode
   * through `getCacheWarmingMode()`, which reads `globalSettings.cacheWarming`. That is a different
   * field from the one `applyOverrides` writes, so only `setCacheWarmingMode` has any effect here.
   */
  private applyCacheWarmingConfig(): void {
    if (this.folder === null) return;
    const sm = this.folder.services.settingsManager;
    sm.setCacheWarmingMode(cacheWarmingSetting());
  }

  /**
   * Refresh pi's compaction `reserveTokens` for the current model. pi auto-compacts when
   * `contextTokens > contextWindow − reserveTokens`, so a trigger at N% means reserving the remaining
   * (100−N)% of the window. Applied via `applyOverrides` (effective-only); re-applied at each turn start
   * because the model — and thus the window — can change, and a settings `save()` can drop the override.
   * The settingsManager is process-wide, so panels on different models last-writer-win on this override;
   * that is intentional and harmless precisely because each panel re-asserts its own value at turn start.
   */
  private refreshCompactionReserve(cfg = this.autoCompactConfig()): void {
    if (!cfg.enabled || this.folder === null) return;
    const sm = this.folder.services.settingsManager;
    const budget = resolveCompactionBudget(cfg, this.modelValue, this.contextWindowForCurrentModel());
    sm.applyOverrides({
      compaction: {
        enabled: true,
        reserveTokens: budget.reserveTokens,
        // Omitted when unset so pi's own keepRecentTokens default stands.
        ...(budget.keepRecentTokens !== undefined ? { keepRecentTokens: budget.keepRecentTokens } : {}),
      },
    });
  }

  /** Read per call, never cached, so a settings edit lands without a reload. The shared manager is right
   *  in every context: the per-subagent one is seeded from the same settings and overrides `compaction`. */
  private shellOptions(): ShellOptions {
    const sm = this.folder?.services.settingsManager;
    const commandPrefix = sm?.getShellCommandPrefix();
    const shellPath = sm?.getShellPath();
    return {
      ...(commandPrefix !== undefined ? { commandPrefix } : {}),
      ...(shellPath !== undefined ? { shellPath } : {}),
    };
  }

  reset(): void {
    this.processingFlag = false;
    // The replacement session disposes the old one, which aborts whatever turn it was running.
    this.setTurnState("idle");
    this._budgetStopRequested = false;
    this.queuedInputs = [];
    // The replaced session takes its undelivered notes with it, so nothing here can shadow a later batch.
    this.injectedNotes = [];
    // Kill any in-flight subagents and drop their completed records so a fresh session starts clean.
    this.subagentManager?.abortAll("reset");
    this.subagentManager?.clearCompleted();
    // A context clear with a team running aborts it (its create_team tool returns the partial synthesis).
    this.options.teamService?.cancelActiveTeam("reset");
    // The aborted agents above never close their own tabs (only success does), and their scopes are
    // dropped as they settle — so reclaim every tab this conversation opened before starting the next.
    this.releaseBrowserScopes();
    // newSession() zeroes the parent session's cost; reset the adapter baselines to match so the budget
    // meter doesn't carry stale subagent/parent dollars across the context clear.
    this.adapter.resetCostBaseline();
    // A fresh session must not re-open a prior resume target, and is eligible for a new AI title. The
    // fork target is retired the same way — otherwise `pendingSessionId` keeps naming a branch this
    // panel has let go of, and after a detach that means reporting a session id whose file is gone.
    this.resumeSessionId = null;
    if (this.options.forkContext) this.options.forkContext.consumed = true;
    this.titleGenerationAttempted = false;
    // The continuation session computes its own plan path from its own first message (clear-context).
    this._firstUserMessage = null;
    // A fresh session reads the now-current tool set on build, so any deferred MCP reload is moot.
    this.mcpReloadPendingAfterTurn = false;
    const runtime = this.runtime;
    if (!runtime) return;
    // newSession() disposes the old AgentSession (which aborts any in-flight turn) and installs a
    // fresh idle one via setRebindSession. Track the promise so a sendMessage that follows
    // synchronously (plan "clear context & start fresh") waits for the fresh session.
    //
    // Chain off any in-flight replacement so two rapid reset()/clear() calls run newSession()
    // serially, not concurrently — concurrent replacements interleave the rebind callbacks and can
    // leave registeredSessionId on an intermediate session / double-register panels. Also chain off any
    // in-flight MCP reload so newSession() can't dispose the session under a live session.reload().
    const priorReload = this.mcpReloadPromise;
    // Destructive work is sequenced off `whenReplaced()`, so this promise must report reality: a
    // replacement that threw, or that a `session_before_switch` handler cancelled, leaves the OLD
    // session installed and still able to write. Swallowing that here would let a caller delete the
    // file out from under a live writer. The prior attempt is chained off for serialization only —
    // `.catch` before it so one failure doesn't poison every later reset.
    const replacement = (this.resetPromise ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => (priorReload ? priorReload.catch(() => undefined) : undefined))
      .then(() => runtime.newSession())
      .then(({ cancelled }) => {
        if (cancelled) throw new Error("session replacement was cancelled");
      });
    // Logging hangs off a SEPARATE handle, so the rejection stays observable to `whenReplaced()`
    // callers while never surfacing as an unhandled rejection when nobody awaits it.
    replacement.catch((err) => log("[PiSession] reset newSession failed: %O", err));
    this.resetPromise = replacement;
  }

  clear(): void {
    this.reset();
  }

  /** Resolve once any in-flight session replacement (reset/clear → newSession) has finished, so the
   *  old AgentSession is disposed and can no longer append. Resolved immediately when none is pending. */
  whenReplaced(): Promise<void> {
    return this.resetPromise ?? Promise.resolve();
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    // Closing the handle is what kills whatever this panel's shells left running: the job object's
    // kill-on-close on Windows, the EOF the sentinel is waiting for on POSIX.
    this.shellJob?.dispose();
    // After the job, so a still-registered call has already had its process killed; a tool whose promise
    // never settles would otherwise leave this session reachable through the entry's delivery closure.
    this.shellCancel.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    // The adapter outlives every session replacement, so its timers are released here and not in
    // bindSession's unsubscribe, which fires on a mere rebind.
    this.adapter.dispose();
    // Both listeners close over this session, so a prompt map outliving the panel (the handler is
    // supplied by the caller) would keep publishing into a webview that is gone.
    this.options.permissionHandler.setPendingPromptsListener(null);
    this.uiContext.setPendingChangedListener(null);
    this.uiContext.cancelAll();
    // Tear down any active team (aborts its agents + resolves the create_team tool) — the service is
    // owned by the panel, so the panel disposes it.
    this.options.teamService?.dispose();
    // Tear down the subagent engine: abort + dispose all nested sessions; unsubscribe from the shared
    // folder registry (which is owned by FolderRuntime and shared across panels — never disposed here).
    this.subagentManager?.dispose();
    this.subagentManager = null;
    this.agentRegistry = null;
    this._agentsUnsub?.();
    this._agentsUnsub = null;
    this._configUnsub?.dispose();
    this._configUnsub = null;
    // Abort any in-flight `/btw` asides. They run as direct `createSubagentSession`s on the folder
    // runtime (not this.runtime, not the AgentManager), so nothing above reaches
    // them — without this they keep streaming their model call until full extension shutdown.
    if (this.btwSessions.size > 0) {
      const folder = this.requireFolder();
      for (const { session, ac } of this.btwSessions.values()) {
        ac.abort();
        void session.abort().catch(() => {});
        folder.forgetSubagentSession(session);
      }
      this.btwSessions.clear();
    }
    // Unregister FIRST so no new hook can look the checkpoint service up, then dispose the runtime: it
    // emits `session_shutdown` to the extension runner, and a handler on that still needs a live
    // checkpoint service, so the service is only torn down after.
    if (this.registeredSessionId) {
      this.unregisterFromRuntime(this.requireFolder(), this.registeredSessionId);
      this.registeredSessionId = null;
    }
    try {
      // The runtime owns the AgentSession it created via the factory and disposes it here; the
      // session was never registered with the folder runtime (createSession), so there is nothing to forget.
      await this.runtime?.dispose();
    } catch (err) {
      log("[PiSession] dispose failed: %O", err);
    }
    this.runtime = null;
    this.checkpointService?.dispose();
    this.checkpointService = null;
    this.releaseBrowserScopes();
  }

  /** Reclaim every browser tab scope this session handed out, closing the tabs failed agents left open
   *  for inspection. Runs when the conversation ends (dispose) or is replaced (reset/clear). */
  private releaseBrowserScopes(): void {
    const browser = this.options.browserService;
    for (const scopeId of this.ownedBrowserScopes) browser?.discardScope(scopeId);
    this.ownedBrowserScopes.clear();
  }

  /** Stop a running background subagent (the Background Tasks panel "stop" button). Aborting the
   *  record drives `AgentManager.emitBackgroundTaskCompleted` (status `stopped`) — the authoritative
   *  completion — so the handler must not also post one. No-op if the task already finished. It requests
   *  no interruption notice: the keep-alive injection already gives the model the stop note and resume call. */
  async stopTask(taskId: string): Promise<void> {
    this.subagentManager?.abort(taskId, "user");
  }

  /** Running + queued subagents, then live team members, for the `/steer` second-stage picker. */
  listSteerTargets(): SteerTargetInfo[] {
    return [...(this.subagentManager?.listActive() ?? []), ...(this.options.teamService?.listSteerTargets() ?? [])];
  }

  /**
   * The user's `/steer` path: a subagent first, then a live team member. `steerSubagent` stays
   * subagent-only because the shell-cancel note path and the `SteerSubagent` tool rely on that.
   */
  async steerTarget(agentId: string, message: string): Promise<void> {
    if (!message.trim()) return;
    const outcome = this.subagentManager?.getRecord(agentId) ? null : this.options.teamService?.steerMember(agentId, message);
    if (!outcome) {
      await this.steerSubagent(agentId, message);
      return;
    }
    const description = `${outcome.teamTitle} · ${outcome.memberName}`;
    this.emit({
      type: "subagentSteered",
      agentId,
      toolUseId: null,
      description,
      message,
      status: outcome.status,
      team: { teamId: outcome.teamId, teamTitle: outcome.teamTitle, memberName: outcome.memberName, role: outcome.role },
    });
    if (outcome.status !== 'steered') return;
    const session = this.runtime?.session;
    if (!session) return;
    try {
      session.sessionManager.appendCustomEntry(DAMOCLES_STEER_ENTRY, { agentId, description, message });
    } catch (err) {
      log("[PiSession] recordSteer failed: %O", err);
    }
  }

  /** Deliver a user-typed `/steer <id> <message>` directly to a running/queued subagent (no model turn).
   *  Emits `subagentSteered` so the webview can echo the amber chip + overlay user message. The emission
   *  lives here (not in AgentManager) because the chip is a USER-action echo — the model's SteerSubagent
   *  tool must never produce chips. On a delivered/queued steer, records it on the subagent's `userSteers`
   *  so the parent becomes aware when it consumes the result. */
  async steerSubagent(agentId: string, message: string): Promise<void> {
    // An empty steer carries no instruction and would persist a marker `isSteerData` rejects on reload;
    // the webview already blocks it, so this is a boundary guard, not a user-facing error path.
    if (!message.trim()) return;
    const status = (await this.subagentManager?.steer(agentId, message)) ?? 'not-found';
    const record = this.subagentManager?.getRecord(agentId);
    this.emit({
      type: "subagentSteered",
      agentId,
      toolUseId: record?.toolCallId ?? null,
      ...(record?.type ? { agentType: record.type } : {}),
      ...(record?.description ? { description: record.description } : {}),
      message,
      status,
    });
    if ((status === 'steered' || status === 'queued') && record) {
      (record.userSteers ??= []).push(message);
      // Persist a standalone marker so a reloaded session replays the amber "You steered" chip in place.
      // Fail-soft, mirroring recordMidStreamMarker: a write error must never break the steer.
      const session = this.runtime?.session;
      if (session) {
        try {
          session.sessionManager.appendCustomEntry(DAMOCLES_STEER_ENTRY, {
            agentId,
            ...(record.type ? { agentType: record.type } : {}),
            ...(record.description ? { description: record.description } : {}),
            message,
          });
        } catch (err) {
          log("[PiSession] recordSteer failed: %O", err);
        }
      }
    }
  }

  // ---- model --------------------------------------------------------------

  setModel(model?: string): void {
    if (!model) return;
    const piRuntime = PiRuntime.get();
    const modelRuntime = piRuntime.modelRuntime;
    if (!modelRuntime || !this.runtime) return;
    const resolution = resolvePiModel(model, modelRuntime, piRuntime.getOpenAIAuthStatus(), this.preferOpenAIApiKey());
    if (resolution.authRequired) {
      this.emit({ type: "openaiAuthRequired", modelValue: model });
      return;
    }
    if (!resolution.model) {
      const info = this.getModelInfo(model);
      if (info?.piProvider) {  // catalog-known custom provider, just not keyed (StepFun pre-key)
        this.emit({ type: "notification", message: `Sign in to ${providerDisplayName(info)} to use ${model}`, notificationType: "warning" });
        return;
      }
      this.emit({ type: "notification", message: `Model ${model} is unavailable on the pi harness`, notificationType: "error" });
      return;
    }
    if (resolution.authed === false) {
      const info = this.getModelInfo(model);
      this.emit({ type: "notification", message: `Sign in to ${providerDisplayName(info)} to use ${model}`, notificationType: "warning" });
      return;
    }
    // Only commit the active model after the switch is known to succeed — every early return above
    // leaves `modelValue` (and everything derived from it) pointing at the still-current model.
    this.modelValue = model;
    this.desiredModel = resolution.model;
    // The account chip is derived from the model, so it is stale until the new one is published.
    this.publishAccountInfo();
    void this.runtime.session.setModel(resolution.model).catch((err) => log("[PiSession] setModel failed: %O", err));
  }

  async getSupportedModels(): Promise<ModelInfo[]> {
    await this.ensureStarted().catch(() => undefined);
    return this.supportedModelsCache;
  }

  /**
   * Surface the agent-invocable slash commands the pi resource loader discovered (US-015/016): prompt
   * templates (incl. `.claude/commands` compat) and skills (as `skill:<name>`). pi's builtin TUI
   * commands are intentionally excluded — the webview already owns `BUILTIN_SLASH_COMMANDS`. Names are
   * de-duped, first wins, so a discovered command that shadows a builtin name doesn't double-list.
   */
  async getSupportedCommands(): Promise<SlashCommandInfo[]> {
    await this.ensureStarted().catch(() => undefined);
    const loader = this.folder?.services.resourceLoader;
    if (!loader) return [];

    const commands: SlashCommandInfo[] = [];
    const seen = new Set<string>();
    const add = (name: string, description?: string, argumentHint?: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      commands.push({ name, description: description ?? "", argumentHint: argumentHint ?? "" });
    };

    try {
      for (const prompt of loader.getPrompts().prompts) add(prompt.name, prompt.description, prompt.argumentHint);
    } catch (err) {
      log("[PiSession] getSupportedCommands: prompts read failed: %O", err);
    }
    try {
      for (const skill of loader.getSkills().skills) add(`skill:${skill.name}`, skill.description);
    } catch (err) {
      log("[PiSession] getSupportedCommands: skills read failed: %O", err);
    }
    return commands;
  }

  getModelInfo(model?: string): ModelInfo | undefined {
    const value = model ?? this.modelValue;
    return this.supportedModelsCache.find((m) => m.value === value);
  }

  get currentModel(): string | null {
    return this.modelValue || null;
  }

  // ---- session identity / state ------------------------------------------

  get currentSessionId(): string | null {
    // Before start() runs (a resumed/forked panel defers it until the first interaction), report the
    // pending resume/fork target so session-scoped reads (rewind history, open-log, delete) resolve
    // the right session. After start() the live session id equals it.
    return this.runtime?.session.sessionId ?? this.pendingSessionId;
  }

  /** The resume/fork target a not-yet-started panel will open, or null. */
  private get pendingSessionId(): string | null {
    if (this.resumeSessionId) return this.resumeSessionId;
    const fork = this.options.forkContext;
    if (fork && !fork.consumed && fork.piBranchedSessionId) return fork.piBranchedSessionId;
    return null;
  }

  get persistenceSessionId(): string | null {
    return this.currentSessionId;
  }

  holdsSession(sessionId: string): boolean {
    // `resumeSessionId` also names the target of a switch still in flight, while `currentSessionId`
    // reports the session being left until the switch lands.
    return this.currentSessionId === sessionId || this.resumeSessionId === sessionId;
  }

  hasConversation(): boolean {
    const fork = this.options.forkContext;
    if (this.resumeSessionId !== null || (fork && !fork.consumed && fork.piBranchedSessionId)) return true;
    if (this.processingFlag) return true;
    return (this.runtime?.session.messages.length ?? 0) > 0;
  }

  get memorySessionId(): string {
    return this.currentSessionId ?? this.options.panelId ?? "";
  }

  get conversationHead(): string | null {
    return null;
  }

  get processing(): boolean {
    return this.processingFlag;
  }

  get currentPromptIndex(): number {
    return Math.max(0, this.promptIndexCounter);
  }

  async initializeEarly(): Promise<void> {
    await this.ensureStarted().catch((err) => log("[PiSession.initializeEarly] start failed: %O", err));
  }

  /**
   * The webview restarted (view recreation / "Developer: Reload Webviews"): its dialog queue is a fresh
   * empty store, so every modal that was on screen is gone while the awaiters behind them are still
   * live. Cancelling them answers a question the user never saw. Posting them again puts the same
   * dialog back on screen, which is what the user expects a reload to do.
   *
   * `retainContextWhenHidden` means this is not routine hide/show, so it costs nothing in normal use.
   * Every re-post carries the exact message the prompt was first posted with, so nothing is rebuilt
   * and nothing can drift from what the awaiter is waiting on.
   */
  onWebviewReady(): void {
    this.options.permissionHandler.repostPendingPrompts();
    this.uiContext.repostPending();
    // The reloaded store starts at `idle`, so the cached key describes a webview that no longer exists
    // and would suppress the resync as a duplicate. Cleared before the republish, never after.
    this.lastSessionState = null;
    this.publishSessionState();
  }

  setResumeSession(sessionId: string | null): void {
    this.resumeSessionId = sessionId;
    // `start()` honors the target on a not-yet-started panel. If the runtime is already live on a
    // different session (the resumeSession message can land on a running panel), switch it to the
    // resume target now. Chained onto resetPromise so a following sendMessage awaits the switch.
    if (sessionId && this.runtime && this.currentSessionId !== sessionId) {
      this.resetPromise = (this.resetPromise ?? Promise.resolve())
        .then(() => this.switchToResumeTarget(sessionId))
        .then(() => undefined)
        .catch((err) => log("[PiSession] resume switch failed: %O", err));
    }
  }

  /** Switch the live runtime to a stored session file (resume on an already-started panel). */
  private async switchToResumeTarget(sessionId: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const filePath = await resolvePiSessionFile(this.cwd, sessionId);
    if (!filePath) {
      log("[PiSession] resume target %s not found on disk", sessionId);
      return;
    }
    const { cancelled } = await runtime.switchSession(filePath);
    // The rebind callback re-subscribed the adapter + re-registered the panel; seed the meter from
    // the now-current resumed session.
    if (!cancelled) {
      this.seedResumedUsage();
      this.interruptionCheckPending = true;
      // The switched-in session reads the current tool set on build, so a deferred reload is moot.
      this.mcpReloadPendingAfterTurn = false;
    }
  }

  /** Seed the adapter's cost baseline from the live session's loaded total (resume — US-010b). */
  private seedResumedUsage(): void {
    const cost = this.runtime?.session.getSessionStats().cost ?? 0;
    this.adapter.seedResumedUsage(cost);
  }

  /**
   * Auto-generate an AI session title after the first assistant turn (US-012). Runs once, only when the
   * session is unnamed (a user `/rename` outranks it), on the small/fast model via
   * `runStructuredCompletion`. Fails soft — no auth/error/empty title leaves the session untitled and
   * the turn unaffected. On success, refreshes the picker/header via the existing `onSessionPersisted`.
   */
  private async maybeGenerateTitle(): Promise<void> {
    if (this.titleGenerationAttempted) return;
    this.titleGenerationAttempted = true;
    // Fully fail-soft: this runs fire-and-forget, so any throw here must not surface as an unhandled
    // rejection or affect the turn.
    try {
      const session = this.runtime?.session;
      if (!session || session.sessionManager.getSessionName()) return;

      const exchange = firstExchangeForTitle(session);
      if (!exchange) return;

      const title = await generateSessionTitle(exchange, PiRuntime.get());
      // Re-check the name: a user /rename may have landed during the async completion (it outranks).
      if (!title || session.sessionManager.getSessionName()) return;
      // The completion is an unbounded async window in which a reset/clear/delete can replace or
      // dispose this session and rm its file. The captured manager still believes it flushed, so a
      // write here lands as a bare appendFileSync PAST the rm and resurrects the file holding nothing
      // but this one `session_info` line — a header-less file every reader then rejects forever.
      if (this._disposed || this.runtime?.session !== session) return;
      session.setSessionName(title.slice(0, 100));
      const sid = this.currentSessionId;
      if (sid) this.options.onSessionPersisted?.(sid);
    } catch (err) {
      log("[PiSession] title generation failed: %O", err);
    }
  }

  /**
   * Rename THIS panel's live session through its own SessionManager (US-012). When the panel owns the
   * target session the rename MUST go through the live manager: the file-based `renamePiSession` opens
   * a second writer that anchors its entry to the leaf as of open() time, so a concurrent live turn
   * would fork the branch and silently drop messages on the next reload. The marker entry makes the
   * store rank the name as a user rename (outranking an AI title).
   */
  async renameActiveSession(newName: string): Promise<void> {
    await this.ensureStarted();
    const session = this.runtime?.session;
    if (!session) throw new Error("No active session to rename");
    session.setSessionName(newName);
    session.sessionManager.appendCustomEntry(DAMOCLES_USER_RENAMED_ENTRY);
  }

  /**
   * Set/clear THIS panel's live session tag through its own SessionManager — same anti-fork reason as
   * `renameActiveSession`. `null` clears; latest wins.
   */
  async setActiveSessionTag(tag: string | null): Promise<void> {
    await this.ensureStarted();
    const session = this.runtime?.session;
    if (!session) throw new Error("No active session to tag");
    session.sessionManager.appendCustomEntry(DAMOCLES_TAG_ENTRY, { tag });
  }

  /**
   * Release this panel's live session so its file can be deleted — routed by session id like the
   * rename/tag mutators, so the panel that OWNS the session detaches even when the delete was issued
   * from another one. pi's SessionManager keeps `flushed = true` after its first write, so every later
   * append is a bare `appendFileSync`: a session still live when its file is removed recreates it as a
   * header-less one-entry file that no reader can parse and no picker can ever show again. Resolves
   * once the replacement session is installed, i.e. once the old manager can no longer write, and the
   * agents the reset aborted have stopped writing under the session's folder (bounded by
   * `ABORTED_AGENTS_SETTLE_TIMEOUT_MS`).
   */
  async detachFromDeletedSession(): Promise<void> {
    // A panel mid-`start()` has no `runtime` yet, so reset() would bail and whenReplaced() would
    // resolve instantly — while start() goes on to open a SessionManager on the very path about to be
    // removed. Let the start settle so there is a live session to actually replace. Its own failure is
    // not this method's concern (the panel then holds nothing that could write).
    await this.startPromise?.catch(() => undefined);
    // Captured before reset(), which drops the records of the subagents it aborts.
    const agentsSettled = Promise.all([this.subagentManager?.whenRunsSettled(), this.options.teamService?.whenRunSettled()]);
    this.reset();
    // Rejects when the replacement failed or was cancelled — i.e. the old session is still installed
    // and still writable. The caller MUST NOT go on to delete the file in that case.
    await this.whenReplaced();
    // The reset aborted whatever turn was running; tell this panel's own webview, which for a
    // cross-panel delete is not the one the user clicked in and would otherwise spin forever.
    this.emit({ type: "processing", isProcessing: false });
    this.emit({ type: "sessionCleared" });
    // The webview drops its stored state on that message, so the cached key now describes a store that
    // no longer holds it. Cleared before the republish, never after.
    this.lastSessionState = null;
    this.publishSessionState();
    // The aborted agents still append to files under the session's folder, which the caller removes next.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ABORTED_AGENTS_SETTLE_TIMEOUT_MS);
    });
    if ((await Promise.race([agentsSettled, timedOut])) === "timeout") {
      log("[PiSession] aborted agents still running after %dms; deleting their session data anyway", ABORTED_AGENTS_SETTLE_TIMEOUT_MS);
    }
    clearTimeout(timer);
  }

  /**
   * Persist the user's ORIGINAL typed input when a slash-command expansion made the stored user message
   * diverge from it — pi expands prompt templates inside `prompt()`, chat-handlers rewrites skills/`/init`
   * before `sendMessage` — so a reloaded transcript, the up-arrow history, and the session-list preview
   * show what the user typed rather than the expanded body. Keyed to the pi user entry just committed by
   * `prompt()`. The IDE-context prefix pi merges into the message is stripped before comparing so a plain
   * (un-expanded) message with attached context records nothing. Fail-soft: a divergence we can't key
   * (no user entry) or a write error never breaks the turn.
   */
  private recordOriginalInputIfDiverged(session: AgentSession, original: string, priorUserEntryId: string | null): void {
    // Same captured-across-an-await shape as `maybeGenerateTitle`: the session was captured before
    // `prompt()` and this runs after it resolved, so a delete in that window can have removed the file
    // while this manager still appends to it. Today pi's teardown awaits `abort()` before installing
    // the replacement, which happens to order the continuation first — an implementation detail of the
    // dependency, not a guarantee, so the liveness check is stated rather than relied upon.
    if (this._disposed || this.runtime?.session !== session) return;
    const typed = original.trim();
    if (!typed) return;
    const entry = lastUserEntry(session);
    // No new user entry committed (a pi extension command, or a streamed/queued turn) → nothing to key.
    if (!entry || entry.id === priorUserEntryId) return;
    const stored = stripIdeContext(entry.text).trim();
    if (stored === typed) return;
    try {
      session.sessionManager.appendCustomEntry(DAMOCLES_ORIGINAL_INPUT_ENTRY, { userEntryId: entry.id, original: typed });
    } catch (err) {
      log("[PiSession] recordOriginalInput failed: %O", err);
    }
  }

  /**
   * Record this completed turn as a memory extraction candidate (fail-soft). No-op when no memory
   * service is wired, the turn ran no agent (extension command), or it committed no new user message.
   * Service-side gates (memory disabled / auto-extract off / disposed) live in enqueueTurnCandidate.
   * Symmetric with recordOriginalInputIfDiverged.
   */
  private enqueueMemoryCandidate(session: AgentSession, priorUserEntryId: string | null): void {
    const memory = this.options.memoryService;
    if (!memory) return;
    if (!this.adapter.observedAgentRun()) return; // extension command / no LLM run → not a real turn
    try {
      const exchange = turnExchangeAfter(session, priorUserEntryId);
      if (!exchange || !exchange.userText.trim()) return;
      memory.enqueueTurnCandidate({
        sessionId: this.memorySessionId,
        promptIndex: this.currentPromptIndex,
        userText: exchange.userText,
        assistantText: exchange.assistantText,
        files: [],
        workspace: this.cwd,
      });
    } catch (err) {
      log("[PiSession] enqueueMemoryCandidate failed: %O", err);
    }
  }

  // ---- thinking (deferred) ------------------------------------------------

  disableThinkingForNextQuery(): void {
    this.thinkingDisabledNextQuery = true;
  }

  restoreThinkingConfig(): void {
    this.thinkingDisabledNextQuery = false;
  }

  // ---- permission / fast mode --------------------------------------------

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    // The shared `permissionHandler` mode is already updated by config-manager before this call;
    // here we enforce the matrix at the tool layer by toggling the active tool set (US-017).
    this.applyActiveToolsForMode(mode);
  }

  /**
   * Apply the mode's active tool set: the full live set, minus `PLAN_MODE_EXCLUDED_TOOLS` in plan mode
   * (US-017). SUBTRACTIVE by design — plan mode states what it BLOCKS, so a new tool subsystem is
   * available while planning without a code change (an inclusion list made MCP, then memory, then the
   * browser silently invisible until each was patched in reactively).
   *
   * The subtraction runs against the live full set, so a per-tool-disabled tool or a disabled subsystem
   * (compass, browser, web, MCP) is already absent — the setting is respected with no extra check.
   *
   * Plan mode's guarantee is no unapproved WORKSPACE WRITES and no unapproved SHELL — not "no side
   * effects anywhere", as the already-permitted MCP tools demonstrate. So Edit/Write stay active for the
   * plan file (the gate restricts them to it), bash/PowerShell stay active (the gate classifies each
   * command), memory/compass touch only extension-internal SQLite, and the browser tools stay available
   * because research frequently requires driving a running app or a live page.
   *
   * For Edit/Write/bash/PowerShell the gate is the enforcement layer and this subtraction is a second
   * one. For the gateable MODULE tools (memory/compass/browser/team) it is NOT: their gate branch
   * returns before the plan-mode branch, so this list is their only plan-mode control. See
   * `PLAN_MODE_EXCLUDED_TOOLS` for which risks that leaves accepted. Takes effect on pi's next turn.
   */
  private applyActiveToolsForMode(mode: PermissionMode): void {
    const session = this.runtime?.session;
    if (!session) return;
    const full = activeToolNamesWithDeferral(this.toolStatusDeps(), this.toolSearchActivated);
    if (mode === "plan") {
      const excluded = new Set<string>(PLAN_MODE_EXCLUDED_TOOLS);
      session.setActiveToolsByName(full.filter((name) => !excluded.has(name)));
      return;
    }
    session.setActiveToolsByName(full);
  }

  /** Snapshot the live flags/catalogs the tool-status pure functions consume. */
  private toolStatusDeps(): ToolStatusDeps {
    return {
      webEnabled: isWebSearchEnabled(),
      teamEnabled: this.isTeamEnabled(),
      teamAvailable: !!this.options.teamService,
      ...(this.options.memoryService ? { memoryService: this.options.memoryService } : {}),
      ...(this.options.compassService ? { compassService: this.options.compassService } : {}),
      browserAvailable: !!this.options.browserService,
      browserEnabled: this.isBrowserEnabled(),
      mcpEnabled: this.isMcpEnabled(),
      mcpToolNames: this.mcpToolNames(),
      disabled: this.disabledToolSet(),
    };
  }

  /**
   * The full active tool set: native pi tools + (web tools when enabled) + Damocles custom tools + the
   * live-enabled module tools, minus the per-tool disabled set. Membership is read live every call, so
   * `refreshActiveTools()` re-applies a master/per-tool toggle change on the next turn.
   */
  private fullActiveToolNames(): string[] {
    return fullActiveToolNamesFrom(this.toolStatusDeps());
  }

  /** This panel's folder MCP view, or null before `start()` resolves the folder. */
  private mcpClientManager(): McpToolSource | null {
    return this.folder?.mcp ?? null;
  }

  /** Master MCP switch — `damocles.mcp.enabled` (default true: "configured = active", Claude-Code parity). */
  private isMcpEnabled(): boolean {
    return vscode.workspace.getConfiguration("damocles.mcp").get<boolean>("enabled", true);
  }

  /** The pi tool names for every enabled MCP server's tools/resources (live + cache fallback). */
  private mcpToolNames(): string[] {
    return this.mcpClientManager()?.allToolNames() ?? [];
  }

  /** Recompute + re-apply the active tool set for the current permission mode; effective next turn.
   *  Also re-publishes ToolSearch: its description is captured at wrap time, so without this a
   *  subsystem toggled off mid-session stays advertised in the inventory the model reads. */
  refreshActiveTools(): void {
    this.applyActiveToolsForMode(this.permissionMode);
    this.folder?.republishToolSearch();
  }

  /**
   * This session's deferrable universe for `ToolSearch`. MCP groups are keyed by the prefix embedded in
   * the pi tool name (`mcp__<prefix>__<tool>`), NOT by the raw `descriptor.serverName`: the two diverge
   * whenever `buildServerPrefixMap` sanitizes or de-collides a server key, and the group name the model
   * is shown must be one the resolver accepts.
   */
  deferrableToolsSnapshot(): DeferrableSnapshot {
    const session = this.runtime?.session;
    const eligible = this.fullActiveToolNames();
    const names = deferredToolNames(eligible, this.isMcpEnabled() ? this.mcpToolNames() : []);
    const mcpGroups = new Map<string, string[]>();
    for (const name of names) {
      const group = mcpGroupName(name);
      if (!group) continue;
      mcpGroups.set(group, [...(mcpGroups.get(group) ?? []), name]);
    }
    const pendingMcpServers = (this.mcpClientManager()?.getServerStatuses() ?? [])
      .filter((status) => status.enabled && status.status !== 'connected')
      .map((status) => status.name);
    // Descriptions come from the MCP client, never from pi's tool registry: reading that registry to
    // build the ToolSearch description re-enters ToolSearch's own description getter and recurses.
    const deferrable = new Set(names);
    const mcpDescriptions = new Map<string, string>();
    for (const d of this.mcpClientManager()?.getAllToolDescriptors() ?? []) {
      if (deferrable.has(d.piName)) mcpDescriptions.set(d.piName, d.description);
    }
    return {
      names,
      loaded: new Set(session?.getActiveToolNames() ?? []),
      mcpGroups,
      ...(pendingMcpServers.length ? { pendingMcpServers } : {}),
      ...(mcpDescriptions.size ? { mcpDescriptions } : {}),
    };
  }

  /** Load deferred tools into the live active set. Synchronous, so pi's before/after active-set diff
   *  around the calling `ToolSearch.execute` observes the addition and stamps `addedToolNames`. */
  activateDeferredTools(names: string[]): void {
    for (const name of names) this.toolSearchActivated.add(name);
    this.applyActiveToolsForMode(this.permissionMode);
  }

  /**
   * Requested MCP tool names absent from the live session's registry — non-empty only when the session
   * is bound to an orphaned runtime that never got the new descriptors (multi-panel first-connect).
   */
  private missingMcpRegistryNames(session: AgentSession): string[] {
    const requested = new Set(this.fullActiveToolNames().filter(isMcpToolName));
    if (requested.size === 0) return [];
    const present = new Set(session.getAllTools().map((t) => t.name).filter(isMcpToolName));
    return [...requested].filter((name) => !present.has(name));
  }

  /**
   * Handle an MCP tools-changed for THIS panel. Fast path (registry already current): just re-apply the
   * active set. Slow path (orphaned runtime missing the new tools): rebuild via `session.reload()`, then
   * re-apply. The reload is deferred while the session is busy and flushed at the next turn.
   */
  reloadForMcpToolChange(): void {
    const session = this.runtime?.session;
    if (!session) return;
    if (this.missingMcpRegistryNames(session).length === 0) {
      // Registry already current → cheap active-set re-apply, no runtime rebuild.
      this.refreshActiveTools();
      return;
    }
    // Orphaned. `session.reload()` rebuilds the runtime + resets API providers, so never run it under any
    // in-flight work — not just an agent run: manual `compact()` aborts first (`!isIdle` false, but
    // `isCompacting` true), and `processingFlag` is set a tick before `prompt()` flips isIdle. Defer to
    // next turn.
    if (this.isSessionBusy(session)) {
      this.mcpReloadPendingAfterTurn = true;
      return;
    }
    void this.runMcpReload();
  }

  /** Any turn-level work in flight, so a runtime-rebuilding `session.reload()` must be deferred. */
  private isSessionBusy(session: AgentSession): boolean {
    return this.processingFlag || this.compacting || !session.isIdle || session.isCompacting;
  }

  /**
   * Drive `session.reload()` for the orphaned-runtime case. Fail-soft (a reload error leaves the session
   * usable), serialized with reset/newSession, and single-flight (concurrent requests coalesce).
   */
  private runMcpReload(): Promise<void> {
    this.mcpReloadPendingAfterTurn = false;
    // Single-flight: a reload already running picks up the latest registry when it settles, so just flag
    // a re-run instead of stacking a second rebuild (a burst of connects → one trailing reload).
    if (this.mcpReloadPromise) {
      this.mcpReloadRerunRequested = true;
      return this.mcpReloadPromise;
    }
    // Capture the reset gate now (not late) so reload never runs concurrently with newSession().
    const priorReset = this.resetPromise;
    const chained = (async () => {
      if (priorReset) await priorReset.catch(() => undefined);
      // Loop honors a mid-reload re-run without stacking promises — at most one extra pass, only while
      // still orphaned. The under-lock re-check also no-ops a reload made moot by an interleaved reset.
      do {
        this.mcpReloadRerunRequested = false;
        const session = this.runtime?.session;
        if (!session || this._disposed) return;
        if (this.missingMcpRegistryNames(session).length === 0) {
          this.refreshActiveTools();
          return;
        }
        await session.reload();
        this.applyActiveToolsForMode(this.permissionMode);
      } while (this.mcpReloadRerunRequested && !this._disposed);
    })().catch((err) => log("[PiSession] MCP reload failed: %O", err));
    this.mcpReloadPromise = chained.finally(() => {
      if (this.mcpReloadPromise === chained) this.mcpReloadPromise = null;
    });
    return this.mcpReloadPromise;
  }

  /**
   * Build the Tools-panel snapshot (US): each subsystem's master + availability, and every tool's live
   * enabled state. Layered: Core is always on; a toggleable module/web tool is on iff its group master
   * is enabled AND it is not in the per-tool disabled set.
   */
  getToolStatus(): ToolsSnapshot {
    return buildToolStatusFrom(this.toolStatusDeps());
  }

  /** The per-tool active-set names the user disabled (`damocles.tools.disabled`), read live. */
  private disabledToolSet(): Set<string> {
    const list = vscode.workspace.getConfiguration("damocles").get<string[]>("tools.disabled", []);
    return new Set(Array.isArray(list) ? list : []);
  }

  /** The live `damocles.browser.enabled` flag — the browser service is always wired; this gates it. */
  private isBrowserEnabled(): boolean {
    return vscode.workspace.getConfiguration("damocles.browser").get<boolean>("enabled", false);
  }

  /** The live `damocles.team.enabled` flag — Team is opt-in (disabled by default). */
  private isTeamEnabled(): boolean {
    return vscode.workspace.getConfiguration("damocles").get<boolean>("team.enabled", false);
  }

  // ---- subagents (Phase 5) ------------------------------------------------

  /** The background-subagent concurrency cap (`damocles.subagents.maxConcurrent`, default 4, clamped 1–16). */
  private maxConcurrentSetting(): number {
    const n = vscode.workspace.getConfiguration("damocles").get<number>("subagents.maxConcurrent", 4);
    return Math.min(16, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 4));
  }

  /** Whether project-scope agents/skills may load — gated on VS Code workspace trust (US-022). */
  private projectScopeTrusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  /**
   * Create the per-PiSession subagent manager once, bound to the folder's shared registry (one per
   * folder, owned by FolderRuntime). The manager holds the SAME registry instance, so a reload (which
   * mutates it via `register()`) is seen automatically. Subscribe so this panel re-emits availability + trust status when the shared
   * registry reloads (file change or workspace-trust grant).
   */
  private ensureSubagentEngine(pi: PiCodingAgentModule, folder: FolderRuntime): void {
    if (this.subagentManager) return;
    const wsAgents = folder.getWorkspaceAgentRegistry();
    this.agentRegistry = wsAgents.getRegistry();
    this.subagentManager = new AgentManager(this.buildSubagentEngine(pi, folder), this.maxConcurrentSetting());
    this.emitCustomAgents();
    this.emit({ type: "projectTrust", trusted: this.projectScopeTrusted() });
    this._agentsUnsub = wsAgents.onChange(() => {
      this.emitCustomAgents();
      this.emit({ type: "projectTrust", trusted: this.projectScopeTrusted() });
    });
    // Apply a live change to the concurrency cap (the value is otherwise only read at construction).
    this._configUnsub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("damocles.subagents.maxConcurrent")) {
        this.subagentManager?.setMaxConcurrent(this.maxConcurrentSetting());
      }
      if (e.affectsConfiguration("damocles.autoCompact")) {
        this.applyCompactionConfig();
      }
      if (e.affectsConfiguration("damocles.cacheWarming")) {
        this.applyCacheWarmingConfig();
      }
    });
  }

  /** Emit the spawnable user/project agents (defaults are builtins, shown via AVAILABLE_AGENTS). */
  private emitCustomAgents(): void {
    if (!this.agentRegistry) return;
    const agents: CustomAgentInfo[] = this.agentRegistry
      .getAvailableConfigs()
      .filter((c) => c.isDefault !== true)
      .map((c) => ({
        name: c.name,
        description: c.description,
        source: AGENT_SCOPE_BY_SOURCE[c.source ?? "default"],
        ...(c.model ? { model: c.model } : {}),
        ...(c.builtinToolNames ? { tools: c.builtinToolNames } : {}),
      }));
    this.emit({ type: "customAgents", agents });
  }

  /** Build the deps the AgentManager needs to run one subagent (model policy + budget owned here). */
  private buildSubagentEngine(pi: PiCodingAgentModule, folder: FolderRuntime): SubagentEngine {
    return {
      cwd: this.cwd,
      registry: this.agentRegistry!,
      createSession: (opts) => folder.createSubagentSession(opts),
      forgetSession: (session) => folder.forgetSubagentSession(session),
      permissionHandler: this.options.permissionHandler,
      isPlanMode: () => this.permissionMode === "plan",
      postMessage: (m) => this.emit(m),
      getParentSystemPrompt: () => this.runtime?.session.systemPrompt ?? "",
      getParentSessionId: () => this.currentSessionId ?? this.memorySessionId,
      subagentStoreDir: () => subagentsDir(ensurePiSessionDir(this.cwd), this.liveSessionId()),
      recordInvocation: (data) => this.recordAgentInvocation(data),
      parentBranch: () => this.parentBranch(),
      assertResumableModel: (path, agentId) => this.assertResumableModel(path, agentId),
      parentFullToolNames: () => this.fullActiveToolNames(),
      // ONE call per spawn: the MCP definitions are APPENDED to this agent's customTools here, exactly
      // as `buildTeamAgentCustomTools` appends the `team_*` tools, and the caller derives `tools:`,
      // `mcpToolNames:`, the deferrable set and the gate classifier from the same returned snapshot.
      buildAgentToolset: (input) => {
        const mcp = this.buildNestedMcp(pi, {
          disallowed: input.mcpDisallowed,
          agent: { agentId: input.agentId, agentName: input.agentName },
        });
        return { customTools: [...this.buildSubagentCustomTools(pi, this.noteDeliveryForSubagent(input.agentId), input.agentId), ...mcp.tools], mcp };
      },
      disposeBrowserScope: (scopeId, closeTabs) => this.options.browserService?.disposeScope(scopeId, closeTabs),
      cancelAgentDialogs: (agentId) => this.uiContext.cancelAgentDialogs(agentId),
      resolveModel: (input) => this.resolveSubagentModel(input.agentConfig),
      onSubagentCost: (delta) => this.adapter.addExternalCost(delta),
      getHooksDispatch: () => folder.getHooksDispatchDeps(),
    };
  }

  /** The live parent session's id; agent data is filed under it. */
  private liveSessionId(): string {
    const sessionId = this.runtime?.session.sessionId;
    if (!sessionId) throw new Error("No live session to file subagent data under");
    return sessionId;
  }

  /** The live session's current branch: the only index of the agents this conversation invoked. */
  parentBranch(): readonly SessionEntry[] {
    return this.runtime?.session.sessionManager.getBranch() ?? [];
  }

  /** Throw the resume error unless the model recorded in the agent session file at `path` is usable. */
  assertResumableModel(path: string, agentId: string): void {
    this.requireFolder().assertResumableModel(path, agentId);
  }

  /** Tell the model which agents were interrupted before the next user prompt. */
  requestInterruptionCheck(): void {
    this.interruptionCheckPending = true;
  }

  /** Index an agent invocation on the parent branch. The parent's assistant message holding the tool
   *  call is already flushed, so pi writes the entry to disk immediately. */
  recordAgentInvocation(data: AgentInvocationData): void {
    const session = this.runtime?.session;
    if (!session) {
      log("[PiSession] agent invocation %s not recorded: no live session", data.id);
      return;
    }
    try {
      session.sessionManager.appendCustomEntry(DAMOCLES_AGENT_INVOCATION_ENTRY, data);
    } catch (err) {
      log("[PiSession] recording agent invocation %s failed: %O", data.id, err);
      this.emit({
        type: "notification",
        message: `Could not record a ${data.kind === "team" ? "team" : "subagent"} in the session file; its card will not be restored after a reload.`,
        notificationType: "warning",
      });
    }
  }

  /**
   * Pre-settlement coordinator: two independent "keep the run going" mechanisms compose here. The
   * background keep-alive runs first; if it produces a draft the plan-mode hold is skipped, and pi
   * re-enters this boundary after the continuation round, where the background results are already
   * drained and the plan-mode hold gets its chance. Returns the entry to append, or undefined to let
   * the run settle.
   */
  private async onBeforeSettle(event: AgentBeforeSettleEvent): Promise<CustomMessageEntryDraft | undefined> {
    if (!this.runtime?.session || this.stopRequested()) return undefined;
    return (await this.tryBackgroundKeepAlive()) ?? this.tryPlanModeHold(event);
  }

  /**
   * Keep-alive: when a run is about to settle while background subagents are still running, await ALL of
   * them and carry their results into one more request as a `display:false` custom entry, so the model
   * finishes its answer using the results (the user's requirement: the parent must not finish until its
   * background subagents complete). ESC (`_aborting`, which `abortAll()`s the subagents) breaks the wait.
   */
  private async tryBackgroundKeepAlive(): Promise<CustomMessageEntryDraft | undefined> {
    const mgr = this.subagentManager;
    if (!mgr || this.stopRequested()) return undefined;
    // Gate on UNCONSUMED background results, not just still-running ones: an agent that completed
    // mid-turn but was never fetched via GetSubagentResult must still be injected, or its result is
    // silently dropped (the bug — a fast background agent that finished early vanished).
    if (!mgr.hasUnconsumedBackground()) return undefined;

    await mgr.waitForBackground();
    if (this.stopRequested()) return undefined;

    const completed = mgr.takeCompletedBackgroundResults();
    if (completed.length === 0) return undefined;

    return {
      type: "custom_message",
      customType: SUBAGENT_RESULTS_CUSTOM_TYPE,
      content: formatBackgroundResults(completed),
      display: false,
      details: backgroundResultsDetails(completed),
    };
  }

  /**
   * Plan-mode hold: deterministically funnel every plan-mode turn through `ExitPlanMode`. When a plan-mode
   * turn is about to settle WITHOUT the model having successfully exited plan mode, carry a hidden nudge
   * into one more request — the model must then call ExitPlanMode or AskUserQuestion (which keeps the turn
   * alive on its own); it can no longer silently stop with an unapproved plan. The prose guidance in
   * `plan-mode-guidance.ts` is the first line of defense; this is the deterministic backstop for when the
   * model ignores it.
   *
   * The funnel is deliberately unbounded, so convergence has to come from the nudge text rather than from
   * a retry cap: `selectPlanModeNudgeText` escalates once this turn has already produced a nudge. The
   * count selects which text goes out, never whether one does.
   *
   * Fires iff ALL hold: still in plan mode; no NON-error `ExitPlanMode` result in this turn (an approved
   * exit returns a normal result and suppresses the nudge; a rejected exit leaves only an isError result
   * and does not); the last assistant message stopped cleanly (`stopReason === 'stop'` — never on
   * error/aborted/length or an auto-retry); the user has nothing queued; and we are not aborting. The
   * mode is re-read live at every settle, so switching out of plan mode (via the UI) stops the funnel on
   * the very next turn — the user always has a non-Stop way out.
   */
  private tryPlanModeHold(event: AgentBeforeSettleEvent): CustomMessageEntryDraft | undefined {
    if (this.permissionMode !== "plan") return undefined;
    if (this.stopRequested()) return undefined;
    // Hold no opinion while the user has something queued: the nudge would land immediately ahead of
    // their own message, telling the model to exit plan mode just before a human instruction that may
    // say otherwise. It re-fires at the next settle if still needed. Reads the agent's own queue, not
    // `pendingMessageCount`: `sendCustomMessage` bypasses the mirror that one counts.
    if ((this.runtime?.session.agent.peekQueuedMessages().length ?? 0) > 0) return undefined;
    // The boundary event carries no per-turn message list, so both predicates read the session
    // projection. `turnHasNonErrorExitPlanModeResult` scopes itself to the current turn; `lastAssistant`
    // does not need to, because every run reaching this boundary has appended an assistant message, a
    // synthetic one even on hard failure (`agent.js:361-376`), so the last one is always this turn's.
    const messages = event.context.contextMessages;
    if (turnHasNonErrorExitPlanModeResult(messages)) return undefined;
    if (lastAssistant(messages)?.stopReason !== "stop") return undefined;

    return {
      type: "custom_message",
      customType: PLAN_MODE_NUDGE_CUSTOM_TYPE,
      content: selectPlanModeNudgeText(messages),
      display: false,
    };
  }

  /**
   * The frozen MCP snapshot for ONE nested spawn — the single source for that agent's `mcp__*` entries
   * in `tools:`, its MCP customTool definitions, its deferred baseline, its gate read-only classifier
   * and its ToolSearch blurbs.
   *
   * `eligible` is `fullActiveToolNames()`, read ONCE. That one read is what applies the
   * `damocles.mcp.enabled` master switch and the `damocles.tools.disabled` per-tool set to nested
   * agents — `fullActiveToolNamesFrom` already does `...(mcpEnabled ? mcpToolNames : [])` and already
   * subtracts the disabled set (`tool-status.ts:65`). There is deliberately NO second `isMcpEnabled()`
   * check here: a duplicated gate is a gate that drifts, and a nested agent silently keeping a tool the
   * panel dropped is exactly the divergence this slice removes.
   */
  private buildNestedMcp(
    pi: PiCodingAgentModule,
    opts: { disallowed?: ReadonlySet<string>; agent?: AgentUiAttribution },
  ): NestedMcpToolset {
    return buildNestedMcpToolset(pi, this.mcpClientManager(), {
      eligible: new Set(this.fullActiveToolNames()),
      ...(opts.disallowed ? { disallowed: opts.disallowed } : {}),
      // A nested session never binds this panel's `ExtensionUIContext`, so its MCP tools would resolve
      // pi's no-op UI and answer every `elicitation/create` with a silent cancel. Handing the per-agent
      // bridge in at spawn is what routes the prompt to the parent panel, attributed and cancellable.
      ...(opts.agent ? { elicitationUi: this.uiContext.forAgent(opts.agent) } : {}),
    });
  }

  /** Build a nested subagent's / team agent's customTools: the same set without the subagent tools (no
   *  manager → no recursion). `browserScopeId` (the subagent record id / team agent id) isolates this
   *  agent's browser tools to its own tab scope; omitted → the primary scope (only the main agent).
   *  `deliverUserNote` is the caller's: a subagent and a team agent are indistinguishable from
   *  `browserScopeId` alone, and each reaches its own conversation through a different channel. */
  private buildSubagentCustomTools(pi: PiCodingAgentModule, deliverUserNote: (text: string) => void, browserScopeId?: string): ToolDefinition[] {
    if (browserScopeId) this.ownedBrowserScopes.add(browserScopeId);
    return buildCustomTools({
      pi,
      cwd: this.cwd,
      permissionHandler: this.options.permissionHandler,
      ...(this.options.memoryService ? { memoryService: this.options.memoryService } : {}),
      ...(this.options.compassService ? { compassService: this.options.compassService } : {}),
      ...(this.options.browserService ? { browserService: this.options.browserService } : {}),
      ...(browserScopeId ? { browserScopeId } : {}),
      getSessionId: () => this.memorySessionId,
      getShellOptions: () => this.shellOptions(),
      shellCancel: this.shellCancel,
      deliverUserNote,
      shellJob: this.shellJob,
    });
  }

  /**
   * Resolve a spawn's model. Precedence: the agent template's `model:` > (Explore subagent only) the
   * Settings → Explore section selection (`damocles.explore.*`) / provider-matched cheap model >
   * inherit the panel's session model. The spawning LLM has NO say — there is no `model` param on the
   * `Agent` tool — so a subagent runs on the session model unless a template declares otherwise.
   * `enabledModels` scope is enforced (out-of-scope → fail soft).
   */
  private resolveSubagentModel(agentConfig: AgentConfig): ResolvedSubagentModel {
    const piRuntime = PiRuntime.get();
    const registry = piRuntime.modelRuntime;
    if (!registry) return { error: "pi runtime not initialized" };
    const openai = piRuntime.getOpenAIAuthStatus();
    const preferApiKey = this.preferOpenAIApiKey();
    const scope = resolveEnabledModels(readEnabledModels(this.cwd), registry);

    // Names the allowlist as the thing to edit: a configured `enabledModels` that resolves to nothing
    // denies every model (fail-closed by design), so one typo there fails every spawn — and a message
    // naming only the model sends the user hunting through templates instead.
    const scopeError = (model: Model<Api>): string | undefined =>
      scope && !isModelInScope(model, scope)
        ? `Model ${model.provider}/${model.id} is outside the \`enabledModels\` allowlist in pi's settings.json.`
        : undefined;
    const label = (model: Model<Api>): string => piModelToModelInfo(model).displayName;
    const thinking = agentConfig.thinking ? { thinkingLevel: agentConfig.thinking } : {};

    // 1. The agent template's `model:` — the only place a per-agent model requirement is declared.
    const explicit = agentConfig.model;
    if (explicit) {
      const curated = resolvePiModel(explicit, registry, openai, preferApiKey);
      // An unauthed model resolves to a `Model` but would die on its first request, so auth is required
      // on BOTH paths. The direct lookup is only tried when the curated one found nothing at all —
      // retrying a value that resolved and failed only on auth would hand back the model auth just
      // rejected, silently undoing the check for any `provider/modelId` template pin.
      let model = curated.authed ? curated.model : undefined;
      if (!model && !curated.model) {
        const slash = explicit.indexOf("/"); // custom-provider / direct provider/modelId
        const direct = slash !== -1 ? registry.getModel(explicit.slice(0, slash), explicit.slice(slash + 1)) : undefined;
        if (direct && registry.hasConfiguredAuth(direct.provider)) model = direct;
      }
      // A template naming an unusable model is a config error the user must fix in the template — it is
      // surfaced, never silently downgraded to the session model, which would hide the broken pin. The
      // cause is branched: an unknown id means edit the template, an unauthed one means sign in.
      if (!model) {
        const where = agentConfig.filePath ?? "the agent template";
        const cause = curated.model
          ? `its provider (${curated.model.provider}) is not signed in. Sign in to that provider, or change the \`model:\` field in ${where}.`
          : `that model is not available. Fix the \`model:\` field in ${where}, or remove it to use the session model.`;
        return { error: `Agent "${agentConfig.name}" declares model "${explicit}", but ${cause}` };
      }
      const err = scopeError(model);
      if (err) return { error: `Agent "${agentConfig.name}" declares model "${explicit}", but ${err[0]!.toLowerCase()}${err.slice(1)}` };
      return { model, modelLabel: label(model), ...thinking };
    }

    // 2. The Explore subagent only: the Settings → Explore section selection (provider + model, shared
    //    with the explore UI), else the provider-matched cheap model of the panel's main model. Plan and
    //    general-purpose are NOT lightweight — they fall through to inherit the panel's main model (step 3).
    if (agentConfig.name.toLowerCase() === "explore") {
      const explore = resolveExploreSectionModel(registry);
      if (explore && !scopeError(explore.model)) {
        const { model, thinkingLevel } = explore;
        return { model, modelLabel: label(model), ...(thinkingLevel ? { thinkingLevel, enforceThinking: true } : {}) };
      }
      const cheap = resolveCheapModelFor(this.modelValue, registry, openai, preferApiKey);
      if (cheap.model && !scopeError(cheap.model)) return { model: cheap.model, modelLabel: label(cheap.model) };
    }

    // 3. Inherit the panel's session model — the default for every agent without a template `model:`.
    //    Its effort comes with it, or pi falls back to whatever default it last persisted, which varies
    //    by machine. A template's own `thinking:` still wins, and a per-spawn `thinking` beats both.
    if (this.desiredModel) {
      const err = scopeError(this.desiredModel);
      if (err) return { error: err };
      const thinkingLevel = agentConfig.thinking ?? effortToThinkingLevel(this.options.resolveThinking(this.modelValue));
      return { model: this.desiredModel, modelLabel: label(this.desiredModel), thinkingLevel };
    }
    return {};
  }

  /** Resolve a pending pi-extension `ctx.ui.*` dialog from a webview response (US-026 seam). */
  resolveExtensionUiResponse(requestId: string, value: string | boolean | null): void {
    this.uiContext.resolve(requestId, value);
  }

  // ---- mcp / plugins / provider / browser (deferred) ----------------------

  /** Live MCP runtime status for the enabled servers; McpManager overlays disabled/imported entries. */
  async getMcpServerStatus(): Promise<McpServerStatusInfo[]> {
    return this.mcpClientManager()?.getServerStatuses() ?? [];
  }

  /**
   * Feed this panel's MCP scope: user servers to the shared user manager, the folder partition to this
   * folder's manager. Both reconciles skip an unchanged set, so every panel may feed on every change.
   */
  setMcpServers(scope: McpScope): void {
    this.mcpScope = scope;
    if (this.folder) this.applyMcpScope(scope);
  }

  private applyMcpScope(scope: McpScope): void {
    const userMcp = PiRuntime.get().getUserMcp();
    const folder = this.folder;
    if (!userMcp || !folder) return;
    void userMcp.reconcile(scope.userUnion);
    void folder.reconcileFolder(scope.folder, scope.userVisible);
    this.refreshActiveTools();
  }

  setMcpStatusListener(listener: () => void): void {
    this._mcpStatusListener = listener;
  }

  /** Reconnect (or run the OAuth flow for a needs-auth server); refresh the active set on success. */
  async reconnectMcpServerLive(serverName: string): Promise<boolean> {
    const manager = this.mcpClientManager();
    if (!manager) return false;
    const connected = await manager.reconnectOrAuthenticate(serverName);
    this.refreshActiveTools();
    return connected;
  }

  /** Clear the stored token and start a fresh interactive login; refresh the active set on success. */
  async reauthenticateMcpServerLive(serverName: string): Promise<boolean> {
    const manager = this.mcpClientManager();
    if (!manager) return false;
    const connected = await manager.reauthenticate(serverName);
    this.refreshActiveTools();
    return connected;
  }

  /** Clear the stored token and disconnect (server drops to needs-auth). */
  async signOutMcpServerLive(serverName: string): Promise<void> {
    const manager = this.mcpClientManager();
    if (!manager) return;
    await manager.signOut(serverName);
    this.refreshActiveTools();
  }

  // ---- checkpoints / cost / rewind ----------------------------------------

  seedCheckpoints(userMessageIds: Iterable<string>): void {
    for (const id of userMessageIds) this.checkpointUserIds.add(id);
    this.broadcastCheckpointInfo();
  }

  /** Mark a turn's user entry id as rewindable and push the updated set to the webview (US-013b). */
  private addCheckpoint(userEntryId: string): void {
    this.checkpointUserIds.add(userEntryId);
    this.broadcastCheckpointInfo();
  }

  /** Push the authoritative rewindable user-entry-id set, suppressing no-op re-emits. */
  private broadcastCheckpointInfo(): void {
    const size = this.checkpointUserIds.size;
    if (size === this.lastCheckpointBroadcast) return;
    this.lastCheckpointBroadcast = size;
    this.emit({ type: "checkpointInfo", userMessageIds: [...this.checkpointUserIds] });
  }
  getAccumulatedCost(): number {
    return this.adapter.accumulatedCost;
  }

  /**
   * Rewind to an earlier turn (US-013c). `userMessageId` is the pi user entry id; it resolves to the
   * matching `damocles-checkpoint` entry, then:
   *  - `code-only`: full snapshot restore of the workspace to that turn's `beforeCommit` (git reset
   *    --hard + clean -fd). An explicit rewind restores unconditionally — a best-effort safety commit
   *    of the current state is taken first so nothing is unrecoverable. Conversation kept.
   *  - `fork-conversation`: branch the pi tree at the user message's parent → a new truncated session,
   *    cloned checkpoint repo, opened in a new panel with the prompt prefilled. No file restore.
   *  - `fork-and-rewind-code`: both — restore the files AND spawn the forked panel.
   * All failures fail soft to `rewindError` (FR-6).
   */
  async rewindFiles(userMessageId: string, option: RewindOption = "code-only", promptContent?: string): Promise<void> {
    // A resumed-on-open panel defers start() until the first message, so the live session (and its tree
    // of checkpoint entries) may not exist yet — start it (which opens the resumed file) before rewinding.
    try {
      await this.ensureStarted();
    } catch (err) {
      this.emit({ type: "rewindError", message: `Failed to start session: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const session = this.runtime?.session;
    if (!session) {
      this.emit({ type: "rewindError", message: "No active session to rewind" });
      return;
    }
    try {
      const sm = session.sessionManager;
      const checkpoints = getCheckpointEntries(sm.getBranch(sm.getLeafId() ?? undefined));
      const entry = [...checkpoints].reverse().find((c) => c.userEntryId === userMessageId) ?? null;
      const needsFileRewind = option === "code-only" || option === "fork-and-rewind-code";
      const needsFork = option === "fork-conversation" || option === "fork-and-rewind-code";

      if (needsFileRewind) {
        if (!entry) {
          this.emit({ type: "rewindError", message: "No checkpoint exists for this message" });
          return;
        }
        const repo = (await this.checkpointService?.getRepo(sm)) ?? null;
        if (!repo) {
          this.emit({ type: "rewindError", message: "File rewind is unavailable (git not found)" });
          return;
        }
        // Hard-restore the workspace to the turn's pre-message state: recreate files the user deleted
        // since and drop files created after. safeCheckout takes a safety commit of the current state
        // first, so nothing is unrecoverable — so an explicit rewind resets unconditionally, with no
        // dirty guard refusing it over manual edits made since.
        const result = await repo.safeCheckout(entry.beforeCommit);
        if (!result.ok) {
          this.emit({ type: "rewindError", message: `File restore failed: ${result.error}` });
          return;
        }
      }

      if (needsFork) {
        // The anchor may be any tree entry — a user message (message rewind) or a compaction entry
        // (rewind-to-before-compaction). Guard only a genuinely missing anchor (FR-7): a stale/unknown
        // id can't be resolved to a tree node. A null `parentId` is NOT an error — it means the anchor
        // is the root (forking the very first message), which spawnPiFork handles by forwarding
        // `forkAtUuid: null` (fresh panel, no branched file). A compaction entry always has a parent, so
        // it never hits the root case anyway.
        if (!sm.getEntry(userMessageId)) {
          this.emit({ type: "rewindError", message: "This rewind point can't be resolved — the session may have changed." });
          return;
        }
        await this.spawnPiFork(session, userMessageId, promptContent);
        return;
      }

      this.emit({
        type: "rewindComplete",
        rewindToMessageId: userMessageId,
        option,
        ...(promptContent ? { promptContent } : {}),
      });
    } catch (err) {
      this.emit({ type: "rewindError", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Copy the subagent and team data the fork's branch invoked into the fork's subtree. Never throws. */
  private async copyAgentDataToFork(pi: PiCodingAgentModule, sourceSm: AgentSession["sessionManager"], forkLeafId: string, targetSessionId: string): Promise<void> {
    let failures: Error[];
    try {
      // The fork point is the fork leaf's timestamp: the fork's conversation ends there, so its agents do too.
      const forkPointMs = Date.parse(sourceSm.getEntry(forkLeafId)?.timestamp ?? "");
      if (!Number.isFinite(forkPointMs)) throw new Error(`the fork entry ${forkLeafId} has no timestamp`);
      failures = await copyForkAgentData({
        SessionManager: pi.SessionManager,
        sessionDir: ensurePiSessionDir(this.cwd),
        sourceSessionId: sourceSm.getSessionId(),
        targetSessionId,
        branch: sourceSm.getBranch(forkLeafId),
        forkPointMs,
      });
    } catch (err) {
      failures = [err instanceof Error ? err : new Error(String(err))];
    }
    if (failures.length === 0) return;
    for (const failure of failures) log("[PiSession] copying agent data to the fork failed: %O", failure);
    this.emit({
      type: "notification",
      message: "Some subagent or team history could not be copied into the fork; those cards may be incomplete and cannot be resumed there.",
      notificationType: "warning",
    });
  }

  /** Branch the pi conversation at the user message's parent and open it in a new forked panel. */
  private async spawnPiFork(session: AgentSession, userEntryId: string, promptContent?: string): Promise<void> {
    const onSpawnFork = this.options.onSpawnFork;
    if (!onSpawnFork) {
      this.emit({ type: "rewindError", message: "Fork is unavailable" });
      return;
    }
    const liveSm = session.sessionManager;
    const parentId = liveSm.getEntry(userEntryId)?.parentId ?? null;
    // Capture the source identity BEFORE branching: createBranchedSession reassigns sessionId/sessionFile
    // on whatever manager it runs on, so it must run on a throwaway manager opened on the source file —
    // never the live one (which would corrupt the source session and misdirect the checkpoint clone).
    const sourceFile = liveSm.getSessionFile();
    const sourceSessionId = this.currentSessionId ?? "";

    let piBranchedSessionId: string | undefined;
    if (parentId && sourceFile) {
      const pi = getPiCodingAgent();
      // A branch whose root→parent path holds no assistant message has nothing to replay — and pi
      // defers writing such a branched file to disk until the first assistant response (matching its
      // newSession contract), so resuming it would fail "file not found". This is the case when forking
      // the very first user message, whose only ancestors are the header + model/thinking-level
      // metadata. Treat it as a fresh-panel fork: leave `piBranchedSessionId` unset so `start()` creates
      // a fresh session and `showForked` skips history replay (the rewound prompt, if any, still
      // prefills). `getBranch(parentId)` returns the exact root→parent path pi would branch on.
      const branchHasAssistant = pi
        ? liveSm.getBranch(parentId).some((e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "assistant")
        : false;
      if (pi && branchHasAssistant) {
        // Branch on a fresh manager reading the source file so the live session is left intact (mirrors
        // pi's own AgentSessionRuntime.fork). Truncate at the parent so the prefilled prompt re-sends
        // the rewound message.
        const branchSm = pi.SessionManager.open(sourceFile, ensurePiSessionDir(this.cwd));
        const branchedPath = branchSm.createBranchedSession(parentId);
        if (branchedPath) {
          piBranchedSessionId = piSessionIdFromFile(branchedPath);
          try {
            const srcGit = getGitDir(getRepoDir(sourceFile));
            if (existsSync(srcGit)) await RepoManager.cloneFrom(srcGit, getGitDir(getRepoDir(branchedPath)));
          } catch (err) {
            log("[PiSession] checkpoint repo clone-on-fork failed: %O", err);
          }
          await this.copyAgentDataToFork(pi, liveSm, parentId, piBranchedSessionId);
        }
      }
    }
    this.emitForkHook(parentId, sourceSessionId, sourceFile, piBranchedSessionId);
    await onSpawnFork({
      sourceSdkSessionId: sourceSessionId,
      forkAtUuid: parentId,
      userMessageId: userEntryId,
      ...(promptContent ? { promptContent } : {}),
      sourcePanelId: this.options.panelId ?? "",
      ...(piBranchedSessionId ? { piBranchedSessionId } : {}),
    });
  }

  /**
   * Fire the Damocles-synthetic `session_before_fork` hook at the fork point. pi only emits this from its
   * in-place `ctx.fork()` command (a session switch), which Damocles never uses — it branches the session
   * file + opens a fresh panel — so Damocles supplies the event itself, like `permission_required` and
   * `subagent_end`. Observe-only, lazy (no cost unless a hook is configured), fail-soft.
   */
  private emitForkHook(entryId: string | null, parentSessionId: string, sourceFile: string | undefined, newSessionId: string | undefined): void {
    if (this.folder === null) return;
    const deps = this.folder.getHooksDispatchDeps();
    if (!deps.config.hasEntries("session_before_fork")) return;
    const payload = buildForkPayload(
      { session_id: parentSessionId, transcript_path: sourceFile ?? "", cwd: this.cwd },
      { parentSessionId, ...(entryId ? { entryId } : {}), ...(newSessionId ? { newSessionId } : {}) },
    );
    void dispatchObserveOnly(deps, "session_before_fork", this.cwd, payload).catch((err) =>
      log("[PiSession] session_before_fork hook failed: %O", err),
    );
  }

  // ---- context usage ------------------------------------------------------

  /**
   * Build the full `/context` breakdown for the pi path (US-CMD) so `ContextUsageOverlay.vue` renders
   * unchanged. Headline totals come from pi's `getContextUsage()` (fallback: the last assistant usage
   * snapshot); the per-message / per-tool breakdown, the system-prompt section, and the discovered
   * skills/commands/agents/MCP sections are estimated with pi's chars/4 heuristic. Sub-sections whose
   * data neither pi nor Damocles holds (memory injection, per-tool prompt snippets) are omitted rather
   * than fabricated. Mirrors the `{ reason: 'busy' }` / `{ reason: 'noQuery' }` early-returns.
   */
  async requestContextUsage(): Promise<void> {
    if (this.processingFlag) {
      this.emit({ type: "contextUsage", data: null, reason: "busy" });
      return;
    }
    try {
      await this.ensureStarted();
    } catch {
      this.emit({ type: "contextUsage", data: null, reason: "noQuery" });
      return;
    }
    const session = this.runtime?.session;
    if (!session) {
      this.emit({ type: "contextUsage", data: null, reason: "noQuery" });
      return;
    }
    try {
      const systemPrompt = await this.buildEffectiveSystemPrompt();
      this.emit({
        type: "contextUsage",
        data: buildContextUsage(session, systemPrompt, {
          maxTokens: this.contextWindowForCurrentModel(),
          modelValue: this.modelValue,
          autoCompact: this.autoCompactConfig(),
          resourceLoader: this.resourceLoader(),
          mcpEnabled: this.isMcpEnabled(),
          mcpClientManager: this.mcpClientManager(),
          agentRegistry: this.agentRegistry,
          eligibleToolNames: this.fullActiveToolNames(),
        }),
      });
    } catch (err) {
      log("[PiSession] requestContextUsage failed: %O", err);
      this.emit({ type: "contextUsage", data: null, reason: "noQuery" });
    }
  }

  /** The live effective system prompt, for the clickable `/context` system-prompt preview (US-021). */
  async getSystemPromptText(): Promise<string | undefined> {
    const sections = await this.buildEffectiveSystemPrompt();
    return sections ? renderSections(sections) || undefined : undefined;
  }

  /**
   * Reconstruct the effective Damocles system prompt from live state via the SAME assembly function the
   * `before_agent_start` turn path uses (US-021). pi holds the swapped prompt only in its per-turn
   * `_runSystemPromptOptions`, cleared when the run settles, so reading `session.systemPrompt` outside
   * a turn returns pi's boilerplate, so the `/context` preview/estimate must rebuild it instead of
   * reading that field.
   *
   * Lazily starts the session read-only first (mirrors `requestContextUsage`/`getSupportedCommands`) so
   * View Details on a never-started panel shows the real prompt; sends nothing to the model. Returns
   * undefined when the start failed (no live session), and also when a live-state read throws
   * (`getActiveToolNames`/`getPlanFilePath` reach into pi's session tree). Both callers rely on that
   * undefined arm: `getSystemPromptText`, which backs `openSystemPrompt` and has no local try/catch,
   * and the `/context` estimate. It NEVER falls back to `session.systemPrompt`: that would reintroduce
   * the pi-boilerplate bug this fixes. The loader reads and `findSessionPlanFiles` degrade to `[]`
   * internally; the outer guard covers the remaining throws.
   */
  private async buildEffectiveSystemPrompt(): Promise<DamoclesPromptSections | undefined> {
    await this.ensureStarted().catch(() => undefined);
    const session = this.runtime?.session;
    if (!session) return undefined;

    try {
      const planMode = this.options.permissionHandler.getPermissionMode() === "plan";
      const loader = this.resourceLoader();
      let contextFiles: BuildSystemPromptOptions["contextFiles"] = [];
      let skills: BuildSystemPromptOptions["skills"] = [];
      if (loader) {
        try {
          contextFiles = loader.getAgentsFiles().agentsFiles;
        } catch {
          contextFiles = [];
        }
        try {
          skills = loader.getSkills().skills;
        } catch {
          skills = [];
        }
      }
      // pi gates its own `<skills>` section on `read` OR `bash` and names the resolved tool in the
      // section's prose, so this preview must resolve it the same way the turn path does.
      const skillFileReadTool = resolveSkillFileReadTool(session.getActiveToolNames());

      return assembleDamoclesSystemPrompt({
        env: this.systemPromptEnv(),
        memoryEnabled: !!this.options.memoryService?.isEnabled,
        planMode,
        teamEnabled: !!this.options.teamService && this.isTeamEnabled(),
        webSearchEnabled: isWebSearchEnabled(),
        planFilePath: this.getPlanFilePath(),
        existingPlanFile: planMode ? undefined : (await findSessionPlanFiles(this.memorySessionId))[0],
        contextFiles,
        skills,
        skillFileReadTool,
      });
    } catch (err) {
      log("[PiSession] buildEffectiveSystemPrompt failed: %O", err);
      return undefined;
    }
  }

  /** Markdown for an MCP tool's info (name/server/description/schema), for the `/context` preview. */
  getMcpToolInfoMarkdown(piName: string): string | undefined {
    const d = this.mcpClientManager()?.getToolDescriptor(piName);
    if (!d) return undefined;
    const lines = [`# ${d.piName}`, "", `**Server:** ${d.serverName}`];
    if (d.readOnly !== undefined) lines.push(`**Read-only:** ${d.readOnly ? "yes" : "no"}`);
    if (d.description) lines.push("", d.description);
    if (d.inputSchema !== undefined) {
      lines.push("", "## Input schema", "", "```json", JSON.stringify(d.inputSchema, null, 2), "```");
    }
    return `${lines.join("\n")}\n`;
  }

  /** The resource loader, or null before the runtime initializes. */
  private resourceLoader(): import("@earendil-works/pi-coding-agent").ResourceLoader | null {
    return this.folder?.services.resourceLoader ?? null;
  }

  // ---- btw / team (deferred) ----------------------------------------------

  /**
   * Answer a `/btw` side question as an ephemeral, single-turn, tool-less aside on the panel's active
   * model (US-025). It shares the full current conversation branch (char-capped, oldest dropped first)
   * via the system prompt context, streams its answer, then disposes — nothing is persisted to the
   * session store or checkpoints. Runs as a nested `createSubagentSession` (own prompt + zero tools), not
   * a main session, so it never carries the Damocles toolset or writes to disk.
   */
  async sendBtw(btwId: string, question: string): Promise<void> {
    try {
      await this.ensureStarted();
    } catch (err) {
      this.emit({ type: "btwError", btwId, message: `pi failed to start: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const piRuntime = PiRuntime.get();
    const modelRuntime = piRuntime.modelRuntime;
    const folder = this.folder;
    if (!modelRuntime || !folder || !this.runtime) {
      this.emit({ type: "btwError", btwId, message: "Start a conversation first" });
      return;
    }
    const resolution = resolvePiModel(this.modelValue, modelRuntime, piRuntime.getOpenAIAuthStatus(), this.preferOpenAIApiKey());
    if (!resolution.model || resolution.authed === false) {
      this.emit({ type: "btwError", btwId, message: `Model ${this.modelValue} is unavailable for btw` });
      return;
    }

    const liveSession = this.runtime?.session;
    const contextBlock = liveSession ? buildBtwContextBlock(liveSession) : "";
    const prompt = contextBlock ? `<conversation_context>\n${contextBlock}\n</conversation_context>\n\n${question}` : question;

    const ac = new AbortController();
    let session: AgentSession;
    try {
      session = await folder.createSubagentSession({
        cwd: this.cwd,
        systemPrompt: BTW_SYSTEM_PROMPT,
        model: resolution.model,
        tools: [],
        customTools: [],
        excludeTools: [],
        extensionFactory: (pi) => { registerTurnEndImagePruning(pi); registerAgentStartImageReconcile(pi); },
        store: { kind: "memory" },
      });
    } catch (err) {
      this.emit({ type: "btwError", btwId, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.btwSessions.set(btwId, { session, ac });

    let streamed = "";
    const unsub = session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") streamed = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        streamed += event.assistantMessageEvent.delta;
        if (!ac.signal.aborted) this.emit({ type: "btwStreaming", btwId, text: streamed });
      }
    });

    try {
      await session.prompt(prompt);
      if (!ac.signal.aborted) {
        const finalText = (streamed.trim() || session.getLastAssistantText() || "").trim();
        if (finalText) this.emit({ type: "btwComplete", btwId, text: finalText });
        else this.emit({ type: "btwError", btwId, message: "No response received" });
      }
    } catch (err) {
      if (!ac.signal.aborted) this.emit({ type: "btwError", btwId, message: err instanceof Error ? err.message : String(err) });
    } finally {
      unsub();
      this.btwSessions.delete(btwId);
      folder.forgetSubagentSession(session);
    }
  }

  cancelBtw(btwId: string): void {
    const entry = this.btwSessions.get(btwId);
    if (!entry) return;
    entry.ac.abort();
    void entry.session.abort().catch(() => {});
  }

  async getMemoryInjection(promptIndex: number): Promise<MemoryInjectionDisplay | undefined> {
    const memory = this.options.memoryService;
    if (!memory?.isEnabled || !this.registeredSessionId) return undefined;
    await memory.ensureInitialized();
    return memory.getPersistedMemoryInjection(this.registeredSessionId, promptIndex);
  }

  get teamService(): TeamService | undefined {
    return this.options.teamService;
  }

  // ---- team (Phase 9, US-024) ---------------------------------------------

  /** The model-resolution inputs for the team role resolver (read live each call). Reads the six flat
   *  `damocles.team.*Model`/`*Effort` settings fresh; each model value goes through
   *  `migrateLegacyModelValue` so a stored value for a removed model does not permanently block a team,
   *  and each effort is parsed + run through `migrateLegacyEffortValue` so a renamed level (e.g. DeepSeek
   *  `xhigh → max`) migrates instead of silently coercing to null. */
  private teamModelDeps(): TeamModelDeps {
    const piRuntime = PiRuntime.get();
    const registry = piRuntime.modelRuntime;
    if (!registry) throw new Error("pi runtime not initialized");
    const cfg = vscode.workspace.getConfiguration('damocles');
    const activeModel = this.modelValue;
    const roleSetting = (role: TeamRole): TeamRoleSetting => {
      const model = migrateLegacyModelValue(cfg.get<string>(`team.${role}Model`, ''));
      // Validate the stored effort (no unchecked cast) and apply the effective model's pi-metadata rename
      // (e.g. DeepSeek xhigh → max in 0.80.6) so a renamed level migrates instead of silently coercing to
      // null. The effort applies against the role's model if set, else the active panel model.
      const parsed = parseEffortLevel(cfg.get<string>(`team.${role}Effort`, ''));
      const effort: EffortLevel | null =
        parsed === null ? null : migrateLegacyEffortValue(model !== '' ? model : activeModel, parsed);
      return { model, effort };
    };
    return {
      registry,
      openai: piRuntime.getOpenAIAuthStatus(),
      preferApiKey: this.preferOpenAIApiKey(),
      activeModel,
      claudeAuthMode: piRuntime.getClaudeAuthStatus().mode,
      supportedModels: this.supportedModelsCache,
      roleSettings: {
        lead: roleSetting('lead'),
        implementor: roleSetting('implementor'),
        reviewer: roleSetting('reviewer'),
      },
    };
  }

  /** Resolve a team role's model + reasoning depth from the user's per-role settings (Slice 1). A
   *  configured-but-unresolvable/unauthed slot returns `{ error }`; an unset slot fails soft to the
   *  active panel model. */
  resolveTeamRole(role: TeamRole): ResolvedTeamModel {
    return resolveRoleModel(role, this.teamModelDeps());
  }

  /**
   * Build the pi-native team engine (US-024d): how to create/dispose a nested team agent session, the
   * agent active-set tool names + customTools (built-ins + module tools + the `team_*` tools), the
   * gate-routing extension factory (inherit-parent-mode central gate), and the budget cost rollup.
   */
  buildTeamEngine(): TeamEngine {
    const pi = getPiCodingAgent();
    if (!pi) throw new Error("pi runtime not loaded");
    const folder = this.requireFolder();
    return {
      createSession: (opts) => folder.createSubagentSession(opts),
      forgetSession: (session) => folder.forgetSubagentSession(session),
      // ONE call per spawn for all three: the agent's names, its customTools (with the MCP definitions
      // appended, exactly as the `team_*` tools are) and the frozen snapshot everything else derives
      // from. `mcp.names` is NOT in `toolNames` — the caller concatenates them, so there is exactly one
      // source of MCP names per spawn.
      buildAgentToolset: (ctx) => {
        const mcp = this.buildNestedMcp(pi, {
          agent: { agentId: ctx.agentId, agentName: ctx.agentName, teamId: ctx.teamId },
        });
        return {
          toolNames: this.teamAgentToolNames(ctx.role),
          customTools: [...this.buildTeamAgentCustomTools(pi, ctx), ...mcp.tools],
          mcp,
        };
      },
      buildExtensionFactory: (_agentName, agentId, mcp) => createSubagentExtensionFactory({
        permissionHandler: this.options.permissionHandler,
        isPlanMode: () => this.permissionMode === "plan",
        parentToolUseId: agentId,
        // `buildExtensionFactory` is invoked PER AGENT SPAWN, not once at buildTeamEngine() time, so
        // `teamAgentBaseToolNames()` must be called HERE to read live panel state at spawn. Hoisting it
        // to a buildTeamEngine local would freeze the deferrable set at team-construction time and
        // silently miss a subsystem the user toggled on mid-run.
        //
        // The base set, not the role-filtered one: `team_*` names are in no deferrable group, so they
        // are intersected away regardless of role and the factory needs no role to be correct.
        //
        // The MCP half comes from the `mcp` snapshot the SAME spawn already took, never from a second
        // read: the ToolSearch inventory a nested agent is shown must be exactly what its session can
        // load, and two reads is how those drift.
        //
        // `mcp.names` must appear in BOTH arguments. `deferredToolNames(eligible, mcpNames)` builds
        // `BUILTIN ∪ mcpNames` and then INTERSECTS it with `eligible` — that intersection is the point
        // (a tool the user disabled is absent from `eligible` and so can never be resurrected by
        // ToolSearch), but it also means a name missing from `eligible` is dropped. Since
        // `teamAgentBaseToolNames()` deliberately excludes every `mcp__*`, passing it alone yields the
        // built-in groups and ZERO MCP: the agent would hold `mcp__*` in `tools:` with real definitions
        // in `customTools`, held INACTIVE by the runtime baseline, yet never advertised by its own
        // ToolSearch and unreachable through it (`resolveToolSearchEntries` → "Unknown entries").
        // This mirrors the `tools: [...toolNames, ...mcp.names]` the caller builds from the same
        // snapshot — the eligible universe is the union, in both places.
        deferrableToolNames: deferredToolNames([...this.teamAgentBaseToolNames(), ...mcp.names], mcp.names),
        mcpDescriptions: mcp.descriptions,
        isMcpReadOnly: mcp.isReadOnly,
        hooks: folder.getHooksDispatchDeps(),
      }),
      onAgentCost: (delta) => this.adapter.addExternalCost(delta),
      disposeBrowserScope: (scopeId, closeTabs) => this.options.browserService?.disposeScope(scopeId, closeTabs),
      cancelAgentDialogs: (agentId) => this.uiContext.cancelAgentDialogs(agentId),
    };
  }

  /**
   * A team agent's tool names WITHOUT its `team_*` set: the panel's full active set MINUS the subagent
   * tools, the main team tools (a team agent never spawns subagents or nested teams, the recursion
   * block), the plan-mode tools (plan mode is a top-level panel concern, a team agent never enters or
   * exits it), and every `mcp__*` name.
   *
   * MCP is excluded HERE and re-added by the caller from the spawn's frozen `NestedMcpToolset`, so the
   * `mcp__*` names in `tools:` and the definitions in `customTools` come from ONE read. Leaving them in
   * would mean two independent sources of MCP names in one spawn — which is how team agents used to
   * pass names the nested registry had no definition for, and pi drops those SILENTLY.
   */
  private teamAgentBaseToolNames(): string[] {
    const exclude = new Set<string>([
      ...SUBAGENT_PI_TOOL_NAMES,
      ...TEAM_MAIN_PI_TOOL_NAMES,
      ...PLAN_MODE_TOOLS,
    ]);
    return this.fullActiveToolNames().filter((name) => !exclude.has(name) && !isMcpToolName(name));
  }

  /**
   * A team agent's active-set tool names: the base set plus the `team_*` tools its ROLE may call. The
   * definitions come from `buildTeamAgentPiTools`, which filters on the same `ctx.role`, so both halves
   * of the spawn read one split. A name here with no matching definition is dropped SILENTLY by pi,
   * which is why the role reaches both and not just one.
   */
  private teamAgentToolNames(role: AgentMcpContext["role"]): string[] {
    return this.teamAgentBaseToolNames().concat(teamAgentPiToolNamesForRole(role));
  }

  /** Build a team agent's customTools: the subagent custom set (no subagent tools) + its `team_*` tools.
   *  `ctx.browserScopeId` (per LAUNCH, not per agent) isolates this team agent's browser tools to its OWN
   *  tab scope, so a redispatched specialist never inherits the failed attempt's tabs. `cwd` reaches the
   *  team tools because `team_record_verification` fingerprints the working tree itself. */
  private buildTeamAgentCustomTools(pi: PiCodingAgentModule, ctx: AgentMcpContext): ToolDefinition[] {
    return [...this.buildSubagentCustomTools(pi, this.noteDeliveryForTeamAgent(ctx), ctx.browserScopeId), ...buildTeamAgentPiTools(pi, ctx, this.cwd)];
  }

  /**
   * The plan-file path this session WRITES to (FR-4): `computePlanFilePath(sessionId, firstMsg)`, where
   * `firstMsg` is this session's first non-synthetic user message as the user TYPED it — the readable
   * slug. `extractFirstUserMessage` resolves the original (sidecar text for an expanded slash command,
   * IDE-context-stripped stored text otherwise); the `_firstUserMessage` fallback captures the same
   * original typed text in `sendMessage`, so both agree and the slug is stable across the session's turns.
   * Consumers (view, delete) don't recompute the slug; they match on the stable `-<id8>` suffix via
   * `findSessionPlanFiles`, so a write that happened before the slug settled is still found. Falls back to
   * `panelId` before an id.
   */
  getPlanFilePath(): string {
    const sessionId = this.currentSessionId ?? this.options.panelId ?? "";
    const session = this.runtime?.session;
    let firstMessage = "";
    if (session) {
      const sm = session.sessionManager;
      firstMessage = extractFirstUserMessage(sm.getBranch(sm.getLeafId() ?? undefined));
    }
    // Before the first user message is committed to the branch (first-turn before_agent_start), fall
    // back to the message captured in sendMessage so the path matches the resolver's preview-based one.
    if (!firstMessage) firstMessage = this._firstUserMessage ?? "";
    return computePlanFilePath(sessionId, firstMessage);
  }

  /**
   * The canonical on-disk plan content for this session, located by the stable `-<id8>` suffix (same
   * lookup as view/delete, so it survives the first-message slug drifting). This is the single source of
   * truth for plan approval/handoff. Returns `null` ONLY when the session has no plan file. A read that
   * fails after the file was located (a transient EBUSY/EMFILE, a permission error) PROPAGATES rather
   * than being masked as `null` — so a present-but-unreadable plan never silently degrades into the
   * "no plan, re-run it" path while the file is sitting right there.
   */
  async getPlanContent(): Promise<string | null> {
    const sessionId = this.currentSessionId ?? this.options.panelId ?? "";
    const file = (await findSessionPlanFiles(sessionId))[0];
    if (!file) return null;
    return await fs.promises.readFile(file, "utf8");
  }

  /**
   * The session's EXISTING plan file on disk (newest by mtime, located by the stable `-<id8>` suffix —
   * the same resolver `getPlanContent` uses), or null when the session has never bound a plan. Bind-plan
   * writes to this path so it overwrites the in-use file in place instead of the recomputed slug path,
   * which would otherwise create an orphan sharing the same suffix.
   */
  async getActivePlanFilePath(): Promise<string | null> {
    const sessionId = this.currentSessionId ?? this.options.panelId ?? "";
    return (await findSessionPlanFiles(sessionId))[0] ?? null;
  }

  // ---- helpers ------------------------------------------------------------

  private emit(m: ExtensionToWebviewMessage): void {
    if (this._disposed) return;
    this.options.onMessage(m);
  }

  /** The pi thinking level for the next turn: forced off when bracketed by disableThinkingForNextQuery,
   * else mapped from the panel's resolved effort for the active model. */
  private resolveThinkingLevel(): ThinkingLevel {
    if (this.thinkingDisabledNextQuery) return "off";
    return effortToThinkingLevel(this.options.resolveThinking(this.modelValue));
  }

  private contextWindowForCurrentModel(): number {
    // Prefer the RESOLVED pi model's window: it is provider-accurate, whereas the curated catalog
    // carries one value per model id, and a GPT model is served by two providers (API key and Codex
    // subscription) whose windows pi has set differently before. Catalog value is the fallback for a
    // not-yet-resolved model (its 272k is the conservative floor).
    return this.desiredModel?.contextWindow ?? this.getModelInfo(this.modelValue)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  }

  /**
   * The hard budget limit to enforce on this turn (US-008), or `null` when no dollar enforcement
   * applies. pi has no `maxBudgetUsd` to pass through, so Damocles enforces it itself. Read live so a
   * mid-session settings change applies on the next check. Gated to dollar-metered billing modes —
   * subscription/allowance has no per-call dollar cost, so it shows token-based usage only.
   */
  private budgetLimitForEnforcement(): number | null {
    if (!this.dollarBilled()) return null;
    const max = vscode.workspace.getConfiguration("damocles").get<number | null>("maxBudgetUsd", null);
    return max && max > 0 ? max : null;
  }

  /** Whether the active credential is dollar-metered (API key or extra-usage), vs a flat subscription. */
  private dollarBilled(): boolean {
    return dollarBilledFrom(this.accountBillingDeps());
  }

  /**
   * The session's cumulative spend: the parent session's own cost PLUS the subagent cost rolled into the
   * adapter. This must stay the exact total `enforceBudgetInFlight` measures — a gate that measured less
   * than the enforcer would admit a turn the enforcer had already stopped. Resets with a new pi session.
   */
  private cumulativeCostUsd(): number {
    return (this.runtime?.session.getSessionStats().cost ?? 0) + this.adapter.externalCost;
  }

  /**
   * Stop the in-flight turn because the hard budget limit was crossed (US-008 in-flight enforcement).
   * Graceful, not an abort: the flag makes the `finishTurn` decider end the turn at the next model
   * round-trip, so the assistant message and its tool results complete and the run settles normally
   * (which already emits done/result/processing:false/idle) — no torn stream and
   * no `sessionCancelled`. Background subagents are killed outright because they run outside the
   * parent's round-trip boundaries, so the decider never sees them.
   *
   * Overshoot is bounded to one round-trip OF THE PARENT LOOP, and that round-trip's own spend is not
   * bounded: enforcement fires at `message_end`, which pi emits BEFORE it executes the message's tool
   * calls, so those tools still run — including an `Agent`/`create_team` call that spawns agents this
   * `abortAll()` never saw. Auto-compaction does not add to that: pi reaches `prepareNextTurn` only at
   * the top of the next inner-loop iteration (`@earendil-works/pi-agent-core@^0.87.0`,
   * `agent-loop.ts:184-188`), and a decider answering `{ action: 'end' }` returns from the loop at
   * `:285-290` before it. So the bound is the tool calls of the message that tripped the limit and
   * nothing else.
   * And an in-flight TEAM keeps running to completion: unlike `beginAbort`, this
   * deliberately does not `cancelActiveTeam()` (product decision), so a team can exceed the limit without
   * a bound. The pre-prompt budget block refuses the NEXT turn.
   */
  private stopForBudget(): void {
    if (!this.processingFlag || this._budgetStopRequested) return;
    this._budgetStopRequested = true;
    this.subagentManager?.abortAll("budget");
    // A queued steer would force one more billed round trip past the limit: the loop itself ends the run
    // without polling, but `_runBeforeSettleBoundary` continues on `hasQueuedMessages()`
    // (`agent-session.ts:1544`) whatever the decider answered. `queueInput` refuses new ones from here on.
    this.clearQueuedInputs();
    // A cancel note in that queue was already echoed as a user turn, so the transcript now says the agent
    // was told something this drop means it never hears. Restoring it would let pi's post-run
    // continuation drain it and bill past the limit, so the echo is corrected instead of honoured.
    const dropped = this.runtime?.session.clearQueue().followUp ?? [];
    for (const text of dropped) {
      const echoed = this.injectedNotes.indexOf(text);
      if (echoed === -1) continue;
      this.injectedNotes.splice(echoed, 1);
      this.emit({
        type: "notification",
        message: "The budget stop discarded your cancel note before the agent read it. Send it again to have it applied.",
        notificationType: "warning",
      });
    }
    this.emit({
      type: "notification",
      message: "Budget limit reached — this turn was stopped after the current step.",
      notificationType: "warning",
    });
  }

  /** Environment facts for the Damocles system prompt (US-007), mirroring the SDK path's source. */
  private systemPromptEnv(): SystemPromptEnv {
    return {
      cwd: this.cwd,
      model: this.modelValue,
      isGitRepo: existsSync(path.join(this.cwd, ".git")),
      platform: process.platform,
      shell: process.env["SHELL"] ?? "unknown",
      osVersion: `${os.type()} ${os.release()}`,
      compassEnabled: !!this.options.compassService?.isEnabled,
      thinkingDisabled: this.resolveThinkingLevel() === "off",
    };
  }

  /** Snapshot the live auth state the account/billing pure functions consume. */
  private accountBillingDeps(): AccountBillingDeps {
    const piRuntime = PiRuntime.get();
    return {
      modelValue: this.modelValue,
      modelInfo: this.getModelInfo(this.modelValue),
      claudeAuthMode: piRuntime.getClaudeAuthStatus().mode,
      openaiAuthStatus: piRuntime.getOpenAIAuthStatus(),
      preferApiKey: this.preferOpenAIApiKey(),
    };
  }

  private buildAccountInfo(): AccountInfo {
    return buildAccountInfoFrom(this.accountBillingDeps());
  }

  /**
   * Publish the account chip to the webview. Its five inputs change independently of any turn, so every
   * mutation of one calls this and nothing else republishes. Rebuilt on each call, never cached.
   */
  publishAccountInfo(): void {
    this.emit({ type: "accountInfo", data: this.buildAccountInfo() });
  }

  /**
   * The only writer of the turn lifecycle. Every path that ends or starts a turn calls this, including
   * the ones no pi event reaches (an abort with no model stream open, a session replacement, a
   * `prompt()` that rejected before any agent run). `compacting` is deliberately not folded in: a
   * manual compaction opens no prompt and the adapter reports no turn lifecycle for it.
   */
  private setTurnState(turn: TurnState): void {
    this.turnState = turn;
    this.publishSessionState();
  }

  /** Whether `PermissionState` or `WebviewExtensionUIContext` still holds an unanswered prompt. */
  private hasPendingPrompts(): boolean {
    return this.options.permissionHandler.hasPendingPrompts() || this.uiContext.hasPendingDialogs();
  }

  /**
   * Publish the session state to the webview. Its two inputs, the turn lifecycle and the prompt maps
   * owned by `PermissionState` and `WebviewExtensionUIContext`, change independently of each other, so
   * every mutation of either calls this and nothing else emits `sessionStateChanged`. Rebuilt on each
   * call, never cached.
   */
  private publishSessionState(): void {
    const sessionId = this.runtime?.session.sessionId ?? "";
    const state: SessionState = deriveSessionState(this.turnState, this.hasPendingPrompts());
    const key = `${state}:${sessionId}`;
    if (this.lastSessionState === key) return;
    this.lastSessionState = key;
    this.emit({ type: "sessionStateChanged", state, sessionId });
  }

  /** Whether the user opted to prefer the OpenAI API key over Codex OAuth when both are configured. */
  private preferOpenAIApiKey(): boolean {
    return this.options.getPreferOpenAIApiKey?.() ?? false;
  }
}
