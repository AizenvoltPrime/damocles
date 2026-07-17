import { existsSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import type { AgentSession, AgentSessionRuntime, BuildSystemPromptOptions, CreateAgentSessionRuntimeFactory, ToolDefinition, AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { Model, Api, ImageContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ChatSession } from "../chat-session";
import type { SessionOptions, ContentInput, RewindOption } from "../session-types";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { ModelInfo, AccountInfo, PermissionMode, AutoCompactConfig, EffortLevel } from "../../shared/types/settings";
import type { SlashCommandInfo } from "../../shared/types/commands";
import type { McpServerConfig, McpServerStatusInfo } from "../../shared/types/mcp";
import type { MemoryInjectionDisplay } from "../../shared/types/context-injection";
import type { TeamService } from "../team";
import type { UserContentBlock } from "../../shared/types/content";
import { DEFAULT_CONTEXT_WINDOW, migrateLegacyModelValue, migrateLegacyEffortValue, parseEffortLevel } from "../../shared/types/constants";
import { PLAN_MODE_TOOLS } from "../../shared/tool-names";
import { log } from "../logger";
import { PiRuntime } from "./pi-runtime";
import { getPiCodingAgent, type PiCodingAgentModule } from "./pi-loader";
import { PI_AGENT_DIR } from "./agent-dir";
import { dispatchObserveOnly } from "./hooks/dispatch";
import { buildPermissionRequiredPayload, buildForkPayload } from "./hooks/payload";
import { PiStreamAdapter, isNothingToCompact } from "./pi-stream-adapter";
import {
  piSupportedModels,
  resolvePiModel,
  providerDisplayName,
  piModelToModelInfo,
  effortToThinkingLevel,
  PI_EXCLUDED_TOOLS,
  PLAN_MODE_READONLY_PI_TOOLS,
  PLAN_MODE_INTERACTIVE_TOOLS,
  PLAN_MODE_PLAN_FILE_TOOLS,
  PLAN_MODE_SHELL_TOOLS,
} from "./pi-models";
import { buildCustomTools } from "./tools";
import { buildTeamAgentPiTools, TEAM_MAIN_PI_TOOL_NAMES, TEAM_AGENT_PI_TOOL_NAMES } from "./tools/team-tools";
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
import { resolveCheapModelFor } from "./subagents/cheap-model";
import { formatBackgroundResults, SUBAGENT_RESULTS_CUSTOM_TYPE } from "./subagents/background-results";
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
  stripIdeContext,
} from "./session-store";
import { computePlanFilePath, findSessionPlanFiles } from "../paths";
import { CheckpointService } from "./checkpoint-service";
import { getCheckpointEntries, getRepoDir, getGitDir, RepoManager } from "./checkpoints";
import { COMPASS_PI_TOOL_NAMES } from "./tools/compass-tools";
import { MEMORY_PI_TOOL_NAMES } from "./tools/memory-tools";
import { SUBAGENT_PI_TOOL_NAMES } from "./tools/tool-catalog";
import { assembleDamoclesSystemPrompt } from "./agent-start";
import type { McpClientManager } from "./mcp/mcp-client-manager";
import { isMcpToolName } from "./mcp/naming";
import { isWebSearchEnabled } from "./web-access";
import { WebviewExtensionUIContext } from "./extension-ui-context";
import type { SystemPromptEnv } from "./permission-gate";
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
  PLAN_MODE_NUDGE_TEXT,
  lastAssistant,
  turnHasNonErrorExitPlanModeResult,
} from "./plan-mode-hold";
import { BTW_SYSTEM_PROMPT, buildBtwContextBlock } from "./btw-context";
import { buildContextUsage } from "./context-usage";
import { generateSessionTitle } from "./session-title";
import {
  buildAccountInfo as buildAccountInfoFrom,
  apiKeySource as apiKeySourceFrom,
  dollarBilled as dollarBilledFrom,
  type AccountBillingDeps,
} from "./account-billing";
import {
  fullActiveToolNames as fullActiveToolNamesFrom,
  buildToolStatus as buildToolStatusFrom,
  type ToolStatusDeps,
} from "./tool-status";

/**
 * `ChatSession` implementation backed by the pi harness (US-P1-4). Owns one `AgentSessionRuntime`
 * whose factory reuses the process-singleton `PiRuntime.services` (B1) and a `PiStreamAdapter` that
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
  /** The pi sessionId currently registered in `PiRuntime.panelRegistry` (cleared/replaced on rebind). */
  private registeredSessionId: string | null = null;
  /** Debounce key for `permission_required` (US-009): one notification per (sessionId, turn). */
  private _lastPermissionNotifyKey: string | null = null;
  /** Feed the initial enabled MCP servers once; later changes flow via live setMcpServers (US-014.9). */
  private mcpServersFed = false;
  /** Pushes fresh MCP runtime status to this panel's webview on every connect/disconnect (no manual refresh). */
  private _mcpStatusListener: (() => void) | null = null;
  /** Per-session checkpoint engine driver, registered alongside the panel gate context (US-013b). */
  private checkpointService: CheckpointService | null = null;
  /** User entry ids that have a checkpoint — the rewindable set pushed via `checkpointInfo`. */
  private readonly checkpointUserIds = new Set<string>();
  /** Size of the last `checkpointInfo` broadcast, to suppress no-op re-emits. */
  private lastCheckpointBroadcast = -1;

  private desiredModel: Model<Api> | undefined;
  private modelValue: string;
  private supportedModelsCache: ModelInfo[] = [];
  private permissionMode: PermissionMode;
  private processingFlag = false;
  /** Set while a manual compaction runs. Distinct from `processingFlag` so it gates a concurrent
   * sendMessage without arming the budget-abort / context-busy behavior keyed off processingFlag. */
  private compacting = false;
  /** Set while interrupt()/cancel() tears down the in-flight turn, so the prompt() rejection it
   * triggers doesn't surface an error card on top of the sessionCancelled already emitted. */
  private _aborting = false;
  /** Set once dispose() begins, so a late hook callback draining during teardown emits nothing. */
  private _disposed = false;
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
  /** The native subagent engine (Phase 5): the shared workspace registry + a per-PiSession manager. */
  private agentRegistry: AgentRegistry | null = null;
  private subagentManager: AgentManager | null = null;
  /** Unsubscribe from the shared workspace registry's change notifications (re-emits availability). */
  private _agentsUnsub: (() => void) | null = null;
  /** VS Code config listener that re-applies the subagent concurrency cap when it changes mid-session. */
  private _configUnsub: vscode.Disposable | null = null;
  /** Live `/btw` aside sessions keyed by btwId, so `cancelBtw` can abort one mid-stream (US-025). */
  private readonly btwSessions = new Map<string, { session: AgentSession; ac: AbortController }>();

  constructor(options: SessionOptions) {
    this.options = options;
    this.cwd = options.cwd;
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
      accountInfo: () => this.buildAccountInfo(),
      permissionMode: () => this.permissionMode,
      apiKeySource: () => this.apiKeySource(),
      budgetLimit: () => this.budgetLimitForEnforcement(),
      showCacheMissNotices: () =>
        vscode.workspace.getConfiguration('damocles').get<boolean>('showCacheMissNotices', false),
      sessionCost: () => this.runtime?.session.getSessionStats().cost ?? 0,
      onBudgetStop: () => this.stopForBudget(),
      onUserMessageDelivered: () => this.onQueuedInputsDelivered(),
      onMidStreamBatchCommitted: (userEntryId) => this.recordMidStreamMarker(userEntryId),
      ...(options.onAssistantTextFinal ? { onAssistantTextFinal: options.onAssistantTextFinal } : {}),
    });
    this.uiContext = new WebviewExtensionUIContext(options.onMessage, () => this.runtime?.session.sessionId ?? "");
  }

  // ---- lifecycle ----------------------------------------------------------

  private ensureStarted(): Promise<void> {
    if (!this.startPromise)
      this.startPromise = this.start().catch((err) => {
        this.startPromise = null;
        throw err;
      });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
    await piRuntime.init();
    const pi = getPiCodingAgent();
    const services = piRuntime.services;
    if (!pi || !services) throw new Error("PiSession.start: pi runtime not initialized");

    // Wire native custom providers (StepFun/DeepSeek/OpenRouter/Gemini) from secrets so subagents AND a
    // saved StepFun/DeepSeek default model can resolve (Phase 5, US-018.8). Awaited before
    // resolveInitialModel so a saved custom-provider default isn't silently dropped to a Claude/GPT
    // fallback; syncCustomProviders is fail-soft (catches + logs) so a bad key can't block startup.
    if (this.options.secrets) {
      const secrets = this.options.secrets;
      await piRuntime.syncCustomProviders((key) => secrets.get(key));
    }

    this.supportedModelsCache = piSupportedModels();
    this.resolveInitialModel(piRuntime);

    // Native subagent engine (Phase 5): a cross-turn per-PiSession registry + manager, created before the
    // factory so the primary session's customTools include the three subagent tools.
    this.ensureSubagentEngine(pi);

    const factory: CreateAgentSessionRuntimeFactory = async (opts) => {
      const sharedRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
      // Refresh the shared extension runtime so each session binds to its own fresh runtime — a
      // disposed session marks its runtime stale, and reload() (verified) only swaps the loader's
      // current runtime without invalidating other panels' already-bound live sessions, so this also
      // isolates concurrent panels. Skipped only for the process's first-ever session (which uses the
      // pristine init runtime); the first session in every later panel still reloads.
      await sharedRuntime.prepareSessionExtensions();
      const shared = sharedRuntime.services;
      if (!shared) throw new Error("PiSession factory: pi services unavailable (B1)");
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
    if (resumePath && forkResumeId && fork) fork.consumed = true;
    const sessionManager = resumePath ? pi.SessionManager.open(resumePath, sessionDir) : pi.SessionManager.create(this.cwd, sessionDir);
    this.runtime = await pi.createAgentSessionRuntime(factory, { cwd: this.cwd, agentDir: PI_AGENT_DIR, sessionManager });

    this.bindSession(this.runtime.session);
    // Continue the token/budget meter from the resumed session's loaded total rather than zero.
    if (resumePath) this.seedResumedUsage();
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
    });

    const sid = this.runtime.session.sessionId;
    this.options.onSessionIdChange?.(sid);
  }

  /**
   * Subscribe the adapter, re-apply the B3 compaction-off invariant, register this panel in the
   * shared gate registry (keyed by the session's id), and bind the webview extension-UI context.
   * Called on initial start and on every session replacement (reset/clear → newSession).
   */
  private bindSession(session: AgentSession): void {
    this.unsubscribe = this.adapter.subscribe(session);
    // The main panel session honors `damocles.autoCompact` (US-030); pi's compaction flag lives on the
    // shared settings manager, so subagent/team/btw sessions isolate it via their own in-memory manager
    // (see PiRuntime.createSubagentSession) — they never auto-compact regardless of this toggle.
    this.applyCompactionConfig();

    const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
    const sessionId = session.sessionId;
    if (this.registeredSessionId && this.registeredSessionId !== sessionId) {
      piRuntime.unregisterPanel(this.registeredSessionId);
      // A replacement session gets a fresh checkpoint driver + rewindable set.
      piRuntime.unregisterCheckpointService(this.registeredSessionId);
      piRuntime.unregisterSessionMutator(this.registeredSessionId);
      piRuntime.unregisterActiveToolRefresher(this.registeredSessionId);
      this.checkpointService?.dispose();
      this.checkpointService = null;
      this.checkpointUserIds.clear();
      this.lastCheckpointBroadcast = -1;
    }
    piRuntime.registerPanel(sessionId, {
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
      onAgentEnd: (event) => this.onParentAgentEnd(event),
      isMcpReadOnly: (name) => this.mcpClientManager()?.isMcpReadOnly(name) ?? false,
    });
    // Register the live rename/tag surface so a mutation from any panel routes here, not to a
    // second file-writer that would fork this session's branch (US-012, cross-panel).
    piRuntime.registerSessionMutator(sessionId, this);
    // On MCP tools-changed, re-apply this session's active set and push fresh MCP status (no manual
    // refresh). `reloadForMcpToolChange` also rebuilds an orphaned-runtime session whose registry never
    // got the new tools (multi-panel); it's a plain refresh when not orphaned.
    piRuntime.registerActiveToolRefresher(sessionId, () => {
      this.reloadForMcpToolChange();
      this._mcpStatusListener?.();
    });
    this.registeredSessionId = sessionId;

    // permission_required notifier (US-009): lazy + debounced-per-turn. Fires only when a hook is
    // configured and only at the two genuine approval waits (file/shell), mapping onto the synthetic
    // `permission_required` hook. Re-set per rebind so the captured session's transcript stays current.
    // For a SUBAGENT approval, `info.parentToolUseId` is set but `session_id`/`transcript_path` (and the
    // debounce key) are the primary panel's — the approval surfaces on the primary, and the parent tool-use
    // id identifies the subagent. This is an observe-only notification, so the primary identity is benign.
    this.options.permissionHandler.setPermissionRequiredNotifier((info) => {
      const deps = PiRuntime.get(this.cwd, PI_AGENT_DIR).getHooksDispatchDeps();
      if (!deps || !deps.config.hasEntries("permission_required")) return;
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
    piRuntime.registerCheckpointService(sessionId, this.checkpointService);
    this.checkpointService.hydrate(session.sessionManager);

    // Cancel any dialogs left pending by the previous session, then bind the UI context (US-026).
    this.uiContext.cancelAll();
    void session.bindExtensions({ uiContext: this.uiContext, mode: "rpc" }).catch((err) => log("[PiSession] bindExtensions failed: %O", err));

    // Feed the initial enabled MCP servers to the shared client once (Phase 6). The manager persists
    // across session replacements (it lives on the runtime singleton), so a reset/clear must NOT re-feed
    // the now-stale creation-time set — live toggles + the .mcp.json watcher own subsequent changes.
    if (!this.mcpServersFed) {
      this.mcpServersFed = true;
      this.setMcpServers(this.options.mcpServers ?? {});
    }
  }

  /**
   * Pick the starting model: the saved value if its canonical provider is authed, otherwise the
   * first curated model the user is actually signed in for (so a codex-only user defaults to a GPT
   * model rather than an unusable Claude/gateway one). Leaves the model unset if nothing is authed.
   */
  private resolveInitialModel(piRuntime: PiRuntime): void {
    const services = piRuntime.services;
    if (!services) return;
    const registry = services.modelRuntime;
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
    for (const m of this.supportedModelsCache) {
      if (trySet(m.value)) return;
    }
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
    // Capture the session's first real user message for the deterministic plan path (FR-3/FR-4). The
    // branch doesn't yet hold this prompt when `before_agent_start` builds the plan-mode system prompt on
    // the first turn, so `getPlanFilePath` falls back to this. Prefer the user's ORIGINAL typed text
    // (`userBroadcast.content`) over the expanded `prompt` so the slug matches the branch-derived value
    // `extractFirstUserMessage` later returns (which resolves the same original via the sidecar) — else a
    // slash-command/skill first message would slug the expansion now and the original later, splitting the
    // session across two plan files. Drops `<…>`-prefixed synthetic prompts and internal sends; being a
    // pre-branch fallback, it self-heals to the branch-derived value once a qualifying message lands.
    if (!options?.isInternal && this._firstUserMessage === null) {
      const text = userBroadcast?.content ?? piMessageText(prompt);
      if (text && !text.trimStart().startsWith("<")) this._firstUserMessage = text;
    }
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
      // The turn completed (prompt resolved at agent_end). After the first real turn, auto-title the
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
      this._aborting = false;
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
    if (!session || !session.isStreaming) return false;
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
    for (const text of followUp) void session.followUp(text).catch(() => {});
  }

  /**
   * Called by the adapter when pi delivers a user message mid-run (a steer/follow-up delivery — the
   * initial prompt lives in the run's initial context and emits no such event). The held buffer has now
   * been injected, so collapse its chips into the single combined message and clear the buffer; further
   * queueing starts a fresh combination.
   */
  onQueuedInputsDelivered(): boolean {
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

  /**
   * Tear down the in-flight turn. Emits `sessionCancelled` + idle immediately, then drives
   * `session.abort()` (which aborts the agent and waits for it to go idle). The abort promise is
   * tracked so the next `sendMessage` awaits it — a turn started before pi finished winding down would
   * otherwise hit pi's "Agent is already processing" rejection.
   */
  private beginAbort(origin: "interrupt" | "cancel"): Promise<void> {
    this._aborting = true;
    this.processingFlag = false;
    this.adapter.markAborted();
    // Abort-everything: ESC kills foreground AND background subagents (Phase 5, FR-12).
    this.subagentManager?.abortAll();
    // ESC during a team aborts it; its `create_team` tool then returns the partial synthesis (US-024d).
    this.options.teamService?.cancelActiveTeam();
    this.clearQueuedInputs();
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
        if (isNothingToCompact(message)) {
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
    const sm = PiRuntime.get(this.cwd, PI_AGENT_DIR).services?.settingsManager;
    if (!sm) return;
    const cfg = this.autoCompactConfig();
    sm.setCompactionEnabled(cfg.enabled);
    if (cfg.enabled) this.refreshCompactionReserve(cfg);
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
    if (!cfg.enabled) return;
    const sm = PiRuntime.get(this.cwd, PI_AGENT_DIR).services?.settingsManager;
    if (!sm) return;
    const window = this.contextWindowForCurrentModel();
    const reserveTokens = Math.max(1, Math.round(window * (1 - cfg.triggerPercent / 100)));
    sm.applyOverrides({ compaction: { enabled: true, reserveTokens } });
  }

  reset(): void {
    this.processingFlag = false;
    this.queuedInputs = [];
    // Kill any in-flight subagents and drop their completed records so a fresh session starts clean.
    this.subagentManager?.abortAll();
    this.subagentManager?.clearCompleted();
    // A context clear with a team running aborts it (its create_team tool returns the partial synthesis).
    this.options.teamService?.cancelActiveTeam();
    // newSession() zeroes the parent session's cost; reset the adapter baselines to match so the budget
    // meter doesn't carry stale subagent/parent dollars across the context clear.
    this.adapter.resetCostBaseline();
    // A fresh session must not re-open a prior resume target, and is eligible for a new AI title.
    this.resumeSessionId = null;
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
    this.resetPromise = (this.resetPromise ?? Promise.resolve())
      .then(() => (priorReload ? priorReload.catch(() => undefined) : undefined))
      .then(() => runtime.newSession())
      .then(() => undefined)
      .catch((err) => log("[PiSession] reset newSession failed: %O", err));
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
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.uiContext.cancelAll();
    // Tear down any active team (aborts its agents + resolves the create_team tool) — the service is
    // owned by the panel, so the panel disposes it.
    this.options.teamService?.dispose();
    // Tear down the subagent engine: abort + dispose all nested sessions; unsubscribe from the shared
    // workspace registry (which is owned by PiRuntime and shared across panels — never disposed here).
    this.subagentManager?.dispose();
    this.subagentManager = null;
    this.agentRegistry = null;
    this._agentsUnsub?.();
    this._agentsUnsub = null;
    this._configUnsub?.dispose();
    this._configUnsub = null;
    // Abort any in-flight `/btw` asides. They run as direct `createSubagentSession`s on the
    // process-singleton PiRuntime (not this.runtime, not the AgentManager), so nothing above reaches
    // them — without this they keep streaming their model call until full extension shutdown.
    if (this.btwSessions.size > 0) {
      const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
      for (const { session, ac } of this.btwSessions.values()) {
        ac.abort();
        void session.abort().catch(() => {});
        piRuntime.forgetSubagentSession(session);
      }
      this.btwSessions.clear();
    }
    // Unregister FIRST so no new hook can look the checkpoint service up, then drain the runtime
    // (its dispose fires agent_end/shutdown hooks). Only once those have drained do we tear down the
    // checkpoint service, so an in-flight onAgentEnd can't race a half-disposed service or session.
    if (this.registeredSessionId) {
      const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
      piRuntime.unregisterPanel(this.registeredSessionId);
      piRuntime.unregisterCheckpointService(this.registeredSessionId);
      piRuntime.unregisterSessionMutator(this.registeredSessionId);
      piRuntime.unregisterActiveToolRefresher(this.registeredSessionId);
      this.registeredSessionId = null;
    }
    try {
      // The runtime owns the AgentSession it created via the factory and disposes it here; the
      // session was never registered with PiRuntime (createSession), so there is nothing to forget.
      await this.runtime?.dispose();
    } catch (err) {
      log("[PiSession] dispose failed: %O", err);
    }
    this.runtime = null;
    this.checkpointService?.dispose();
    this.checkpointService = null;
  }

  /** Stop a running background subagent (the Background Tasks panel "stop" button). Aborting the
   *  record drives `AgentManager.emitBackgroundTaskCompleted` (status `stopped`) — the authoritative
   *  completion — so the handler must not also post one. No-op if the task already finished. */
  async stopTask(taskId: string): Promise<void> {
    this.subagentManager?.abort(taskId);
  }

  // ---- model --------------------------------------------------------------

  setModel(model?: string): void {
    if (!model) return;
    const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
    const services = piRuntime.services;
    if (!services || !this.runtime) return;
    const resolution = resolvePiModel(model, services.modelRuntime, piRuntime.getOpenAIAuthStatus(), this.preferOpenAIApiKey());
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
    const loader = PiRuntime.get(this.cwd, PI_AGENT_DIR).services?.resourceLoader;
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

      const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
      const title = await generateSessionTitle(exchange, piRuntime);
      // Re-check the name: a user /rename may have landed during the async completion (it outranks).
      if (!title || session.sessionManager.getSessionName()) return;
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
   * Persist the user's ORIGINAL typed input when a slash-command expansion made the stored user message
   * diverge from it — pi expands prompt templates inside `prompt()`, chat-handlers rewrites skills/`/init`
   * before `sendMessage` — so a reloaded transcript, the up-arrow history, and the session-list preview
   * show what the user typed rather than the expanded body. Keyed to the pi user entry just committed by
   * `prompt()`. The IDE-context prefix pi merges into the message is stripped before comparing so a plain
   * (un-expanded) message with attached context records nothing. Fail-soft: a divergence we can't key
   * (no user entry) or a write error never breaks the turn.
   */
  private recordOriginalInputIfDiverged(session: AgentSession, original: string, priorUserEntryId: string | null): void {
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
   * Restrict the agent to read-only Damocles-native tools in plan mode, else the full active set (US-017).
   * The plan set is the read-only/interactive allow-list INTERSECTED with the live full set, so a
   * per-tool-disabled tool or a disabled subsystem (e.g. compass) is also excluded in plan mode. Keeps the
   * interactive tools (AskUserQuestion / Task* list management) + ExitPlanMode available so the model can
   * still plan, track tasks, answer questions, and exit. Edit/Write stay active so the model can maintain
   * its plan file — the gate allows them ONLY for the plan file and blocks every other write. The memory
   * and compass module tools also stay active: they touch only extension-internal state (SQLite), never
   * the workspace, so they are the same class of internal-state writes plan mode already permits. All
   * enabled MCP tools also stay available in plan mode (the user controls which servers are enabled).
   * Takes effect on pi's next agent turn.
   */
  private applyActiveToolsForMode(mode: PermissionMode): void {
    const session = this.runtime?.session;
    if (!session) return;
    const full = this.fullActiveToolNames();
    if (mode === "plan") {
      const allowed = new Set<string>([...PLAN_MODE_READONLY_PI_TOOLS, ...PLAN_MODE_INTERACTIVE_TOOLS, ...PLAN_MODE_PLAN_FILE_TOOLS, ...PLAN_MODE_SHELL_TOOLS, ...COMPASS_PI_TOOL_NAMES, ...MEMORY_PI_TOOL_NAMES]);
      // All enabled MCP tools stay usable in plan mode — the user controls which servers are enabled.
      // `full` only contains mcp__ names when MCP is enabled (master + per-server), so this respects the
      // toggle. On call they behave exactly as in other modes (auto-allow via the gate/evaluator).
      session.setActiveToolsByName(full.filter((name) => allowed.has(name) || isMcpToolName(name)));
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

  /** The process/workspace-scoped MCP client (Phase 6), or null before the runtime initializes. */
  private mcpClientManager(): McpClientManager | null {
    return PiRuntime.get(this.cwd, PI_AGENT_DIR).getMcpClientManager();
  }

  /** Master MCP switch — `damocles.mcp.enabled` (default true: "configured = active", Claude-Code parity). */
  private isMcpEnabled(): boolean {
    return vscode.workspace.getConfiguration("damocles.mcp").get<boolean>("enabled", true);
  }

  /** The pi tool names for every enabled MCP server's tools/resources (live + cache fallback). */
  private mcpToolNames(): string[] {
    return this.mcpClientManager()?.allToolNames() ?? [];
  }

  /** Recompute + re-apply the active tool set for the current permission mode; effective next turn. */
  refreshActiveTools(): void {
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
   * Create the per-PiSession subagent manager once, bound to the workspace-level shared registry
   * (Phase 5 §4.6: one source of truth, one watcher per agent dir, owned by PiRuntime). The manager
   * holds the SAME registry instance, so a reload (which mutates it via `register()`) is seen
   * automatically. Subscribe so this panel re-emits availability + trust status when the shared
   * registry reloads (file change or workspace-trust grant).
   */
  private ensureSubagentEngine(pi: PiCodingAgentModule): void {
    if (this.subagentManager) return;
    const wsAgents = PiRuntime.get(this.cwd, PI_AGENT_DIR).getWorkspaceAgentRegistry();
    this.agentRegistry = wsAgents.getRegistry();
    this.subagentManager = new AgentManager(this.buildSubagentEngine(pi), this.maxConcurrentSetting());
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
        source: c.source === "project-pi" || c.source === "project-claude" ? "project" : "user",
        ...(c.model ? { model: c.model } : {}),
        ...(c.builtinToolNames ? { tools: c.builtinToolNames } : {}),
      }));
    this.emit({ type: "customAgents", agents });
  }

  /** Build the deps the AgentManager needs to run one subagent (model policy + budget owned here). */
  private buildSubagentEngine(pi: PiCodingAgentModule): SubagentEngine {
    return {
      cwd: this.cwd,
      registry: this.agentRegistry!,
      createSession: (opts) => PiRuntime.get(this.cwd, PI_AGENT_DIR).createSubagentSession(opts),
      forgetSession: (session) => PiRuntime.get(this.cwd, PI_AGENT_DIR).forgetSubagentSession(session),
      permissionHandler: this.options.permissionHandler,
      isPlanMode: () => this.permissionMode === "plan",
      postMessage: (m) => this.emit(m),
      getParentSystemPrompt: () => this.runtime?.session.systemPrompt ?? "",
      getParentSessionId: () => this.currentSessionId ?? this.memorySessionId,
      parentFullToolNames: () => this.fullActiveToolNames(),
      buildSubagentCustomTools: () => this.buildSubagentCustomTools(pi),
      resolveModel: (input) => this.resolveSubagentModel(input.agentConfig, input.modelParam),
      onSubagentCost: (delta) => this.adapter.addExternalCost(delta),
      getHooksDispatch: () => PiRuntime.get(this.cwd, PI_AGENT_DIR).getHooksDispatchDeps() ?? undefined,
    };
  }

  /**
   * `agent_end` coordinator: two independent "hold the turn open" mechanisms compose here, ordered so
   * they never double-fire on one `agent_end`. The background keep-alive runs first; if it injects+holds
   * (returns true), this `agent_end` is already consumed and the plan-mode hold is skipped — on the NEXT
   * `agent_end` (after the synthesis round) the background results are drained and the plan-mode hold gets
   * its turn. Awaited from the shared-extension `agent_end` hook before the turn settles.
   */
  private async onParentAgentEnd(event: AgentEndEvent): Promise<void> {
    if (!this.runtime?.session || this._aborting) return;
    if (await this.tryBackgroundKeepAlive()) return;
    await this.tryPlanModeHold(event);
  }

  /**
   * Keep-alive hold: when a parent turn ends while background subagents are still running, await ALL of
   * them, then inject their results as a `display:false` custom follow-up so pi runs one more round in
   * the SAME turn and the model finishes its answer using the results (the user's requirement: the parent
   * must not finish until its background subagents complete). ESC (`_aborting`, which `abortAll()`s the
   * subagents) breaks the wait. Returns true iff it injected results and held the turn; false on every
   * early-return (nothing pending), so the coordinator can fall through to the plan-mode hold.
   */
  private async tryBackgroundKeepAlive(): Promise<boolean> {
    const mgr = this.subagentManager;
    const session = this.runtime?.session;
    if (!mgr || !session || this._aborting) return false;
    // Gate on UNCONSUMED background results, not just still-running ones: an agent that completed
    // mid-turn but was never fetched via GetSubagentResult must still be injected, or its result is
    // silently dropped (the bug — a fast background agent that finishes before agent_end vanished).
    if (!mgr.hasUnconsumedBackground()) return false;

    await mgr.waitForBackground();
    if (this._aborting) return false;

    const completed = mgr.takeCompletedBackgroundResults();
    if (completed.length === 0) return false;

    try {
      // deliverAs follow-up continues the SAME turn while streaming (the documented agent_end path);
      // triggerTurn is a safety net so a non-streaming agent_end can never leave the held turn hung.
      await session.sendCustomMessage(
        { customType: SUBAGENT_RESULTS_CUSTOM_TYPE, content: formatBackgroundResults(completed), display: false },
        { deliverAs: "followUp", triggerTurn: true },
      );
      // Only after the follow-up is queued: suppress the idle/done for THIS agent_end, since pi will now
      // continue the turn with the synthesis round (the next agent_end settles it normally), and defer
      // the checkpoint finalize so this held turn keeps its single pending checkpoint (FR: one logical
      // turn → one rewind entry) instead of minting a duplicate per continuation round.
      this.checkpointService?.deferNextFinalize();
      this.adapter.holdNextAgentEnd();
      return true;
    } catch (err) {
      log("[PiSession] background-results follow-up injection failed: %O", err);
      return false;
    }
  }

  /**
   * Plan-mode hold: deterministically funnel every plan-mode turn through `ExitPlanMode`. When a plan-mode
   * turn ends cleanly WITHOUT the model having successfully exited plan mode, inject a hidden nudge as a
   * follow-up and hold the turn so pi's loop continues — the model must then call ExitPlanMode, call
   * AskUserQuestion (which keeps the turn alive on its own), or keep planning; it can no longer silently
   * stop with an unapproved plan. The prose guidance in `plan-mode-guidance.ts` is the first line of
   * defense; this is the deterministic backstop for when the model ignores it.
   *
   * Fires iff ALL hold: still in plan mode; no NON-error `ExitPlanMode` result in this turn (an approved
   * exit returns a normal result and suppresses the nudge; a rejected exit leaves only an isError result
   * and does not); the last assistant message stopped cleanly (`stopReason === 'stop'` — never on
   * error/aborted/length or an auto-retry); and we are not aborting. Fail-soft: a throw never breaks the
   * turn. The mode is re-read live every `agent_end`, so switching out of plan mode (via the UI) stops the
   * funnel on the very next turn-end — the user always has a non-Stop way out.
   */
  private async tryPlanModeHold(event: AgentEndEvent): Promise<void> {
    if (this.permissionMode !== "plan") return;
    if (this._aborting) return;
    if (turnHasNonErrorExitPlanModeResult(event.messages)) return;
    if (lastAssistant(event.messages)?.stopReason !== "stop") return;

    const session = this.runtime?.session;
    if (!session) return;

    try {
      await session.sendCustomMessage(
        { customType: PLAN_MODE_NUDGE_CUSTOM_TYPE, content: PLAN_MODE_NUDGE_TEXT, display: false },
        { deliverAs: "followUp", triggerTurn: true },
      );
      // Defer the checkpoint finalize for this held continuation so the plan-mode turn keeps its single
      // pending checkpoint — without this each nudge round mints a duplicate checkpoint for the same user
      // entry, which surfaces as repeated identical rows in the Rewind picker.
      this.checkpointService?.deferNextFinalize();
      this.adapter.holdNextAgentEnd();
    } catch (err) {
      log("[PiSession] plan-mode hold injection failed: %O", err);
    }
  }

  /** Build a nested subagent's customTools — the SAME set MINUS the subagent tools (no manager → no recursion). */
  private buildSubagentCustomTools(pi: PiCodingAgentModule): ToolDefinition[] {
    return buildCustomTools({
      pi,
      cwd: this.cwd,
      permissionHandler: this.options.permissionHandler,
      ...(this.options.memoryService ? { memoryService: this.options.memoryService } : {}),
      ...(this.options.compassService ? { compassService: this.options.compassService } : {}),
      ...(this.options.browserService ? { browserService: this.options.browserService } : {}),
      getSessionId: () => this.memorySessionId,
    });
  }

  /**
   * Resolve a spawn's model (§4.9 precedence): explicit `Agent` param > per-definition `model:` >
   * (Explore subagent only) the Settings → Explore section selection (`damocles.explore.*`), then the
   * provider-matched cheap model > inherit the panel's main model (general-purpose, Plan, custom).
   * `enabledModels` scope is enforced (out-of-scope → fail soft).
   */
  private resolveSubagentModel(agentConfig: AgentConfig, modelParam?: string): ResolvedSubagentModel {
    const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
    const services = piRuntime.services;
    if (!services) return { error: "pi runtime not initialized" };
    const registry = services.modelRuntime;
    const openai = piRuntime.getOpenAIAuthStatus();
    const preferApiKey = this.preferOpenAIApiKey();
    const scope = resolveEnabledModels(readEnabledModels(this.cwd), registry);

    const scopeError = (model: Model<Api>): string | undefined =>
      scope && !isModelInScope(model, scope) ? `Model ${model.provider}/${model.id} is outside the enabled-models scope.` : undefined;
    const label = (model: Model<Api>): string => piModelToModelInfo(model).displayName;
    const thinking = agentConfig.thinking ? { thinkingLevel: agentConfig.thinking } : {};

    // 1/2. explicit Agent param, then per-definition model:
    const explicit = modelParam ?? agentConfig.model;
    if (explicit) {
      let model = resolvePiModel(explicit, registry, openai, preferApiKey).model;
      if (!model) {
        const slash = explicit.indexOf("/"); // custom-provider / direct provider/modelId
        if (slash !== -1) model = registry.getModel(explicit.slice(0, slash), explicit.slice(slash + 1)) ?? undefined;
      }
      if (!model) return { error: `Subagent model "${explicit}" is not available.` };
      const err = scopeError(model);
      return err ? { error: err } : { model, modelLabel: label(model), ...thinking };
    }

    // 3. The Explore subagent only: the Settings → Explore section selection (provider + model, shared
    //    with the explore UI), else the provider-matched cheap model of the panel's main model. Plan and
    //    general-purpose are NOT lightweight — they fall through to inherit the panel's main model (step 4).
    if (agentConfig.name.toLowerCase() === "explore") {
      const exploreModel = resolveExploreSectionModel(registry);
      if (exploreModel && !scopeError(exploreModel)) return { model: exploreModel, modelLabel: label(exploreModel) };
      const cheap = resolveCheapModelFor(this.modelValue, registry, openai, preferApiKey);
      if (cheap.model && !scopeError(cheap.model)) return { model: cheap.model, modelLabel: label(cheap.model) };
    }

    // 4. Inherit the parent (panel main) model — general-purpose, Plan, and any custom agent without a model.
    if (this.desiredModel) {
      const err = scopeError(this.desiredModel);
      return err ? { error: err } : { model: this.desiredModel, modelLabel: label(this.desiredModel) };
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
   * Feed the merged enabled-server set to the process/workspace MCP client (Phase 6). First call
   * eager-connects + warms tools from cache; later calls reconcile without a session restart.
   * Elicitation is routed per tool call (via `ctx.ui`) so a server prompt renders in the panel whose
   * call triggered it (H2) — not bound here, since the client is shared across this workspace's panels.
   */
  setMcpServers(servers: Record<string, McpServerConfig>): void {
    const manager = this.mcpClientManager();
    if (!manager) return;
    manager.initialize(servers);
    this.refreshActiveTools();
  }

  /** A `.mcp.json` watcher change or browser toggle: reconcile connections + re-apply the active set. */
  restartForMcpChanges(): void {
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
    const deps = PiRuntime.get(this.cwd, PI_AGENT_DIR).getHooksDispatchDeps();
    if (!deps || !deps.config.hasEntries("session_before_fork")) return;
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
      const systemPromptText = (await this.buildEffectiveSystemPrompt()) ?? "";
      this.emit({
        type: "contextUsage",
        data: buildContextUsage(session, systemPromptText, {
          maxTokens: this.contextWindowForCurrentModel(),
          modelValue: this.modelValue,
          resourceLoader: this.resourceLoader(),
          mcpEnabled: this.isMcpEnabled(),
          mcpClientManager: this.mcpClientManager(),
          agentRegistry: this.agentRegistry,
        }),
      });
    } catch (err) {
      log("[PiSession] requestContextUsage failed: %O", err);
      this.emit({ type: "contextUsage", data: null, reason: "noQuery" });
    }
  }

  /** The live effective system prompt, for the clickable `/context` system-prompt preview (US-021). */
  async getSystemPromptText(): Promise<string | undefined> {
    return (await this.buildEffectiveSystemPrompt()) || undefined;
  }

  /**
   * Reconstruct the effective Damocles system prompt from live state via the SAME assembly function the
   * `before_agent_start` turn path uses (US-021). pi only writes the swapped prompt into its mutable
   * per-turn `agent.state.systemPrompt`, so reading `session.systemPrompt` outside a turn returns pi's
   * boilerplate — the `/context` preview/estimate must rebuild it instead of reading that field.
   *
   * Lazily starts the session read-only first (mirrors `requestContextUsage`/`getSupportedCommands`) so
   * View Details on a never-started panel shows the real prompt; sends nothing to the model. Returns
   * undefined when the start failed (no live session) or — honoring the `Promise<string | undefined>`
   * contract its sole caller (`openSystemPrompt`, no local try/catch) relies on — if a live-state read
   * throws (`getActiveToolNames`/`getPlanFilePath` reach into pi's session tree). It NEVER falls back to
   * `session.systemPrompt`: that would reintroduce the pi-boilerplate bug this fixes. The loader reads
   * and `findSessionPlanFiles` degrade to `[]` internally; the outer guard covers the remaining throws.
   */
  private async buildEffectiveSystemPrompt(): Promise<string | undefined> {
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
      // `getActiveToolNames()` always returns the concrete active set (pi's `agent.state.tools` names),
      // so `includes('read')` matches the turn path exactly. The turn path's extra `!selectedTools` arm
      // only covers pi's "undefined ⇒ default tool set" case, which a live, concrete list never hits.
      const hasReadTool = session.getActiveToolNames().includes("read");

      return assembleDamoclesSystemPrompt({
        env: this.systemPromptEnv(),
        memoryEnabled: !!this.options.memoryService?.isEnabled,
        planMode,
        teamEnabled: !!this.options.teamService && this.isTeamEnabled(),
        planFilePath: this.getPlanFilePath(),
        existingPlanFile: planMode ? undefined : (await findSessionPlanFiles(this.memorySessionId))[0],
        contextFiles,
        skills,
        hasReadTool,
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
    return PiRuntime.get(this.cwd, PI_AGENT_DIR).services?.resourceLoader ?? null;
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
    const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
    const services = piRuntime.services;
    if (!services || !this.runtime) {
      this.emit({ type: "btwError", btwId, message: "Start a conversation first" });
      return;
    }
    const resolution = resolvePiModel(this.modelValue, services.modelRuntime, piRuntime.getOpenAIAuthStatus(), this.preferOpenAIApiKey());
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
      session = await piRuntime.createSubagentSession({
        cwd: this.cwd,
        systemPrompt: BTW_SYSTEM_PROMPT,
        model: resolution.model,
        tools: [],
        customTools: [],
        excludeTools: [],
        extensionFactory: () => {},
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
      piRuntime.forgetSubagentSession(session);
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
    const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
    const services = piRuntime.services;
    if (!services) throw new Error("pi runtime not initialized");
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
      registry: services.modelRuntime,
      openai: piRuntime.getOpenAIAuthStatus(),
      preferApiKey: this.preferOpenAIApiKey(),
      activeModel,
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
   * agent active-set tool names + customTools (built-ins + module tools + the 12 `team_*` tools), the
   * gate-routing extension factory (inherit-parent-mode central gate), and the budget cost rollup.
   */
  buildTeamEngine(): TeamEngine {
    const pi = getPiCodingAgent();
    if (!pi) throw new Error("pi runtime not loaded");
    return {
      createSession: (opts) => PiRuntime.get(this.cwd, PI_AGENT_DIR).createSubagentSession(opts),
      forgetSession: (session) => PiRuntime.get(this.cwd, PI_AGENT_DIR).forgetSubagentSession(session),
      agentToolNames: () => this.teamAgentToolNames(),
      buildAgentCustomTools: (ctx) => this.buildTeamAgentCustomTools(pi, ctx),
      buildExtensionFactory: (_agentName, agentId) => createSubagentExtensionFactory({
        permissionHandler: this.options.permissionHandler,
        isPlanMode: () => this.permissionMode === "plan",
        parentToolUseId: agentId,
        ...(PiRuntime.get(this.cwd, PI_AGENT_DIR).getHooksDispatchDeps() ? { hooks: PiRuntime.get(this.cwd, PI_AGENT_DIR).getHooksDispatchDeps()! } : {}),
      }),
      onAgentCost: (delta) => this.adapter.addExternalCost(delta),
    };
  }

  /**
   * A team agent's active-set tool names: the panel's full active set MINUS the subagent tools, the
   * main team tools (a team agent never spawns subagents or nested teams — recursion block), and the
   * plan-mode tools (plan mode is a top-level panel concern — a team agent never enters/exits it). The
   * 12 `team_*` agent tools are added via the agent's customTools (built per-agent over its MCP context).
   */
  private teamAgentToolNames(): string[] {
    const exclude = new Set<string>([
      ...SUBAGENT_PI_TOOL_NAMES,
      ...TEAM_MAIN_PI_TOOL_NAMES,
      ...PLAN_MODE_TOOLS,
    ]);
    return this.fullActiveToolNames().filter((name) => !exclude.has(name)).concat(TEAM_AGENT_PI_TOOL_NAMES);
  }

  /** Build a team agent's customTools: the subagent custom set (no subagent tools) + its 12 `team_*` tools. */
  private buildTeamAgentCustomTools(pi: PiCodingAgentModule, ctx: AgentMcpContext): ToolDefinition[] {
    return [...this.buildSubagentCustomTools(pi), ...buildTeamAgentPiTools(pi, ctx)];
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
    // carries one value per model id. GPT-5.6 spans two providers with different windows — as of pi
    // 0.80.6 codex (subscription) serves 372k, the API-key provider 272k — so trusting the catalog
    // would skew context-% and mistime auto-compaction on whichever provider it doesn't match. Catalog
    // value is the fallback for a not-yet-resolved model (its 272k is the conservative floor).
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

  /** The session's cumulative cost so far (resets with a new pi session). */
  private cumulativeCostUsd(): number {
    return this.runtime?.session.getSessionStats().cost ?? 0;
  }

  /** Abort the in-flight turn because the hard budget limit was crossed (US-008 in-flight enforcement). */
  private stopForBudget(): void {
    if (!this.processingFlag) return;
    this._aborting = true;
    this.processingFlag = false;
    this.adapter.markAborted();
    this.subagentManager?.abortAll();
    this.emit({ type: "processing", isProcessing: false });
    void this.runtime?.session.abort().catch((err) => log("[PiSession] budget abort failed: %O", err));
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
    };
  }

  /** Snapshot the live auth state the account/billing pure functions consume. */
  private accountBillingDeps(): AccountBillingDeps {
    const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
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

  private apiKeySource(): string {
    return apiKeySourceFrom(this.accountBillingDeps());
  }

  /** Whether the user opted to prefer the OpenAI API key over Codex OAuth when both are configured. */
  private preferOpenAIApiKey(): boolean {
    return this.options.getPreferOpenAIApiKey?.() ?? false;
  }
}
