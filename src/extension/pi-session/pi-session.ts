import { existsSync } from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import type { AgentSession, AgentSessionRuntime, CreateAgentSessionRuntimeFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model, Api, ImageContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ChatSession } from "../claude-session/chat-session";
import type { SessionOptions, ContentInput, RewindOption } from "../claude-session/types";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { ModelInfo, AccountInfo, PermissionMode } from "../../shared/types/settings";
import type { SlashCommandInfo } from "../../shared/types/commands";
import type { ContextUsageData } from "../../shared/types/session";
import type { McpServerConfig, McpServerStatusInfo } from "../../shared/types/mcp";
import type { RemoteControlStatus } from "../../shared/types/remote-control";
import type { MemoryInjectionDisplay } from "../../shared/types/context-injection";
import type { RecallConfig, RecallTrajectory } from "../recall/types";
import type { RecallService } from "../recall";
import type { TeamService } from "../team";
import type { BrowserService } from "../browser";
import type { UserContentBlock } from "../../shared/types/content";
import { DEFAULT_CONTEXT_WINDOW } from "../../shared/types/constants";
import { log } from "../logger";
import { PiRuntime } from "./pi-runtime";
import { getPiCodingAgent, type PiCodingAgentModule } from "./pi-loader";
import { PI_AGENT_DIR } from "./agent-dir";
import { PiStreamAdapter } from "./pi-stream-adapter";
import {
  piSupportedModels,
  resolvePiModel,
  piModelToModelInfo,
  effortToThinkingLevel,
  PI_NATIVE_ACTIVE_TOOLS,
  PI_EXCLUDED_TOOLS,
  WEB_TOOLS,
  PLAN_MODE_READONLY_PI_TOOLS,
  PLAN_MODE_INTERACTIVE_TOOLS,
} from "./pi-models";
import { buildCustomTools, CUSTOM_TOOL_NAMES, moduleToolNames } from "./tools";
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
  DAMOCLES_USER_RENAMED_ENTRY,
  DAMOCLES_TAG_ENTRY,
} from "./session-store";
import { CheckpointService } from "./checkpoint-service";
import { getCheckpointEntries, getRepoDir, getGitDir, RepoManager } from "./checkpoints";
import { COMPASS_PI_TOOL_NAMES } from "./tools/compass-tools";
import { FULL_TOOL_CATALOG } from "./tools/tool-catalog";
import type { McpClientManager } from "./mcp/mcp-client-manager";
import { isWebSearchEnabled } from "./web-access";
import { WebviewExtensionUIContext } from "./extension-ui-context";
import type { SystemPromptEnv } from "./permission-gate";
import type { ToolsSnapshot, ToolGroupStatus, ToolStatusInfo, ToolGroup } from "../../shared/types/tools";

const DISABLED_REMOTE_CONTROL: RemoteControlStatus = {
  enabled: false,
  connectionState: "disconnected",
  sessionUrl: null,
  connectUrl: null,
  environmentId: null,
  error: null,
};

function extractText(content: ContentInput): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Convert webview Anthropic-shaped image blocks to pi `ImageContent`. */
function extractImages(content: ContentInput): ImageContent[] {
  if (typeof content === "string") return [];
  return content
    .filter((b): b is Extract<UserContentBlock, { type: "image" }> => b.type === "image")
    .map((b) => ({ type: "image", data: b.source.data, mimeType: b.source.media_type }));
}

/** Join the text blocks of a pi message's content (used for the title exchange). */
function piMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => !!b && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join(" ");
}

const TITLE_OUTPUT_TOOL = "set_session_title";
const TITLE_SYSTEM_PROMPT =
  "You generate a short, descriptive title for a coding assistant conversation. Call the " +
  `${TITLE_OUTPUT_TOOL} tool with a concise 3-6 word title in Title Case, summarizing the user's intent. ` +
  "No surrounding quotes and no trailing punctuation.";
const TITLE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string", description: "A concise 3-6 word Title Case summary of the conversation." },
  },
  required: ["title"],
  additionalProperties: false,
};

/**
 * `ChatSession` implementation backed by the pi harness (US-P1-4). Owns one `AgentSessionRuntime`
 * whose factory reuses the process-singleton `PiRuntime.services` (B1) and a `PiStreamAdapter` that
 * reproduces the existing webview message contract. Deferred subsystems (write/edit/bash, the
 * permission gate, recall, team, checkpoints, btw, remote control) degrade gracefully — no method
 * reachable from a live handler throws (FR-10).
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
  /** The pi sessionId currently registered in `PiRuntime.panelRegistry` (cleared/replaced on rebind). */
  private registeredSessionId: string | null = null;
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
  private _planPath: string | null = null;
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
      contextWindow: () => this.contextWindowForCurrentModel(),
      supportedModels: () => this.supportedModelsCache,
      accountInfo: () => this.buildAccountInfo(),
      permissionMode: () => this.permissionMode,
      apiKeySource: () => this.apiKeySource(),
      budgetLimit: () => this.budgetLimitForEnforcement(),
      sessionCost: () => this.runtime?.session.getSessionStats().cost ?? 0,
      onBudgetStop: () => this.stopForBudget(),
      onUserMessageDelivered: () => this.onQueuedInputsDelivered(),
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

    // Wire native custom providers (StepFun/OpenRouter/Gemini) from the explore secrets so subagents can
    // reach those models by explicit id with no loopback proxy (Phase 5, US-018.8). Fire-and-forget.
    if (this.options.secrets) {
      const secrets = this.options.secrets;
      void piRuntime.syncCustomProviders((key) => secrets.get(key));
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
        ...(this.subagentManager ? { subagentManager: this.subagentManager } : {}),
      });
      const result = await pi.createAgentSessionFromServices({
        services: shared,
        sessionManager: opts.sessionManager,
        ...(this.desiredModel ? { model: this.desiredModel } : {}),
        tools: this.fullActiveToolNames(),
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
    session.setAutoCompactionEnabled(false);

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
      postMessage: (message) => this.emit(message),
      currentPromptIndex: () => this.currentPromptIndex,
      onAgentEnd: () => this.onParentAgentEnd(),
      isMcpReadOnly: (name) => this.mcpClientManager()?.isMcpReadOnly(name) ?? false,
    });
    // Register the live rename/tag surface so a mutation from any panel routes here, not to a
    // second file-writer that would fork this session's branch (US-012, cross-panel).
    piRuntime.registerSessionMutator(sessionId, this);
    // Re-apply this session's active set whenever MCP tools change (cold connect / list_changed), and
    // push fresh MCP status so the webview reflects connecting → connected without a manual refresh.
    piRuntime.registerActiveToolRefresher(sessionId, () => {
      this.refreshActiveTools();
      this._mcpStatusListener?.();
    });
    this.registeredSessionId = sessionId;

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
    const registry = services.modelRegistry;
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
    if (this.processingFlag) {
      this.adapter.emitAlreadyInProgress();
      return;
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
        nodeId: null,
        ...(isInternal ? { isInjected: true } : {}),
      });
    }

    this.processingFlag = true;
    this._aborting = false;
    session.setThinkingLevel(this.resolveThinkingLevel());
    this.adapter.beginTurn(correlationId);

    const text = extractText(prompt);
    const images = extractImages(prompt);
    try {
      // Defense in depth: if pi is unexpectedly still streaming (a desync the reset/abort awaits above
      // didn't cover), queue this as a follow-up instead of letting pi reject the bare prompt. The
      // message runs as a continuation rather than being lost.
      const promptOpts = {
        ...(images.length > 0 ? { images } : {}),
        ...(session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
      };
      await session.prompt(text, Object.keys(promptOpts).length > 0 ? promptOpts : undefined);
      // An extension slash command (e.g. `/todos`) is handled synchronously inside prompt() and starts
      // no agent run, so no terminal event settles the turn — the spinner would hang. When prompt()
      // resolved without an observed run and the agent isn't streaming, release the turn ourselves.
      if (!this._aborting && !session.isStreaming && !this.adapter.observedAgentRun()) {
        this.adapter.endTurnWithoutAgentRun();
      }
      // The turn completed (prompt resolved at agent_end). After the first real turn, auto-title the
      // session (US-012). Fire-and-forget so it never blocks the next interaction.
      if (!isInternal) void this.maybeGenerateTitle();
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
    // Gate on pi's own streaming state, not `processingFlag`: the two can momentarily disagree, and a
    // queue routed to a non-streaming session must be refused so the caller can fall back.
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
  onQueuedInputsDelivered(): void {
    if (this.queuedInputs.length === 0) return;
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
    // Compaction is force-disabled on the pi path (B3); nothing to cancel.
  }

  reset(): void {
    this.processingFlag = false;
    this.queuedInputs = [];
    // Kill any in-flight subagents and drop their completed records so a fresh session starts clean.
    this.subagentManager?.abortAll();
    this.subagentManager?.clearCompleted();
    // newSession() zeroes the parent session's cost; reset the adapter baselines to match so the budget
    // meter doesn't carry stale subagent/parent dollars across the context clear.
    this.adapter.resetCostBaseline();
    // A fresh session must not re-open a prior resume target, and is eligible for a new AI title.
    this.resumeSessionId = null;
    this.titleGenerationAttempted = false;
    const runtime = this.runtime;
    if (!runtime) return;
    // newSession() disposes the old AgentSession (which aborts any in-flight turn) and installs a
    // fresh idle one via setRebindSession. Track the promise so a sendMessage that follows
    // synchronously (plan "clear context & start fresh") waits for the fresh session.
    //
    // Chain off any in-flight replacement so two rapid reset()/clear() calls run newSession()
    // serially, not concurrently — concurrent replacements interleave the rebind callbacks and can
    // leave registeredSessionId on an intermediate session / double-register panels. Mirrors the
    // _reloadSync serialization in PiRuntime.
    this.resetPromise = (this.resetPromise ?? Promise.resolve())
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
    // Tear down the subagent engine: abort + dispose all nested sessions; unsubscribe from the shared
    // workspace registry (which is owned by PiRuntime and shared across panels — never disposed here).
    this.subagentManager?.dispose();
    this.subagentManager = null;
    this.agentRegistry = null;
    this._agentsUnsub?.();
    this._agentsUnsub = null;
    this._configUnsub?.dispose();
    this._configUnsub = null;
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

  async stopTask(_taskId: string): Promise<void> {
    // No background tasks on the read-only pi slice.
  }

  // ---- model --------------------------------------------------------------

  setModel(model?: string): void {
    if (!model) return;
    const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
    const services = piRuntime.services;
    if (!services || !this.runtime) return;
    const resolution = resolvePiModel(model, services.modelRegistry, piRuntime.getOpenAIAuthStatus(), this.preferOpenAIApiKey());
    if (resolution.authRequired) {
      this.emit({ type: "openaiAuthRequired", modelValue: model });
      return;
    }
    if (!resolution.model) {
      this.emit({ type: "notification", message: `Model ${model} is unavailable on the pi harness`, notificationType: "error" });
      return;
    }
    if (resolution.authed === false) {
      this.emit({ type: "notification", message: `Sign in to Anthropic to use ${model}`, notificationType: "warning" });
      return;
    }
    // Only commit the active model after the switch is known to succeed — every early return above
    // leaves `modelValue` (and everything derived from it) pointing at the still-current model.
    this.modelValue = model;
    this.desiredModel = resolution.model;
    void this.runtime.session.setModel(resolution.model).catch((err) => log("[PiSession] setModel failed: %O", err));
  }

  setBetas(_betas: string[]): void {
    // Anthropic betas are SDK-only; no-op on the pi path.
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
    if (!cancelled) this.seedResumedUsage();
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

      const exchange = this.firstExchangeForTitle(session);
      if (!exchange) return;

      const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
      if (!piRuntime.hasAuthedSubCallModel()) return;
      const result = await piRuntime.runStructuredCompletion<{ title?: string }>({
        systemPrompt: TITLE_SYSTEM_PROMPT,
        userMessage: exchange,
        outputToolName: TITLE_OUTPUT_TOOL,
        outputToolDescription: "Record the conversation title.",
        schema: TITLE_SCHEMA,
        timeoutMs: 15_000,
      });
      const title = result?.title?.trim();
      // Re-check the name: a user /rename may have landed during the async completion (it outranks).
      if (!title || session.sessionManager.getSessionName()) return;
      session.setSessionName(title.slice(0, 100));
      const sid = this.currentSessionId;
      if (sid) this.options.onSessionPersisted?.(sid);
    } catch (err) {
      log("[PiSession] title generation failed: %O", err);
    }
  }

  /** The first user+assistant exchange (truncated) used as the title-generation input, or null. */
  private firstExchangeForTitle(session: AgentSession): string | null {
    const sm = session.sessionManager;
    const branch = sm.getBranch(sm.getLeafId() ?? undefined);
    let userText = "";
    let assistantText = "";
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const message = (entry as { message?: { role?: string; content?: unknown } }).message;
      if (!userText && message?.role === "user") userText = piMessageText(message.content);
      else if (!assistantText && message?.role === "assistant") assistantText = piMessageText(message.content);
      if (userText && assistantText) break;
    }
    if (!userText) return null;
    return `User: ${userText.slice(0, 2000)}\n\nAssistant: ${assistantText.slice(0, 2000)}`;
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

  async setRecallSession(_sessionId: string): Promise<void> {
    // Recall is not driven from the pi path in this phase.
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
   * Restrict the agent to read-only tools in plan mode, else the full active set (US-017). The plan set
   * is the read-only/interactive allow-list INTERSECTED with the live full set, so a per-tool-disabled
   * tool or a disabled subsystem (e.g. compass) is also excluded in plan mode. Keeps the interactive
   * tools (AskUserQuestion / Task* list management) + ExitPlanMode available so the model can still
   * plan, track tasks, answer questions, and exit. Takes effect on pi's next agent turn.
   */
  private applyActiveToolsForMode(mode: PermissionMode): void {
    const session = this.runtime?.session;
    if (!session) return;
    const full = this.fullActiveToolNames();
    if (mode === "plan") {
      const allowed = new Set<string>([...PLAN_MODE_READONLY_PI_TOOLS, ...PLAN_MODE_INTERACTIVE_TOOLS, ...COMPASS_PI_TOOL_NAMES]);
      // Read-only MCP tools stay usable in plan mode; non-read MCP tools stay blocked (US-014.4).
      const mcp = this.isMcpEnabled() ? this.mcpClientManager() : null;
      session.setActiveToolsByName(full.filter((name) => allowed.has(name) || (mcp?.isMcpReadOnly(name) ?? false)));
      return;
    }
    session.setActiveToolsByName(full);
  }

  /**
   * The full active tool set: native pi tools + (web tools when enabled) + Damocles custom tools + the
   * live-enabled module tools, minus the per-tool disabled set. Membership is read live every call, so
   * `refreshActiveTools()` re-applies a master/per-tool toggle change on the next turn.
   */
  private fullActiveToolNames(): string[] {
    const disabled = this.disabledToolSet();
    const names = [
      ...PI_NATIVE_ACTIVE_TOOLS,
      ...(isWebSearchEnabled() ? WEB_TOOLS : []),
      ...CUSTOM_TOOL_NAMES,
      ...moduleToolNames({
        ...(this.options.memoryService ? { memoryService: this.options.memoryService } : {}),
        ...(this.options.compassService ? { compassService: this.options.compassService } : {}),
        browserEnabled: this.isBrowserEnabled(),
      }),
      ...(this.isMcpEnabled() ? this.mcpToolNames() : []),
    ];
    // pi's setActiveToolsByName pushes one definition per name occurrence (no internal de-dup), so a
    // duplicate name would make the provider reject the request ("Tool names must be unique"). De-dup
    // defensively, mirroring pi's own `[...new Set(...)]` active-set contract.
    return [...new Set(names.filter((name) => !disabled.has(name)))];
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
   * Build the Tools-panel snapshot (US): each subsystem's master + availability, and every tool's live
   * enabled state. Layered: Core is always on; a toggleable module/web tool is on iff its group master
   * is enabled AND it is not in the per-tool disabled set.
   */
  getToolStatus(): ToolsSnapshot {
    const disabled = this.disabledToolSet();
    const groupEnabled: Record<ToolGroup, boolean> = {
      core: true,
      memory: !!this.options.memoryService?.isEnabled,
      compass: !!this.options.compassService?.isEnabled,
      browser: this.isBrowserEnabled(),
      web: isWebSearchEnabled(),
      subagents: true,
    };
    const groups: ToolGroupStatus[] = [
      { group: "memory", enabled: groupEnabled.memory, available: !!this.options.memoryService },
      { group: "compass", enabled: groupEnabled.compass, available: !!this.options.compassService },
      { group: "browser", enabled: groupEnabled.browser, available: !!this.options.browserService },
      { group: "web", enabled: groupEnabled.web, available: true },
      { group: "subagents", enabled: groupEnabled.subagents, available: true },
      { group: "core", enabled: true, available: true },
    ];
    const tools: ToolStatusInfo[] = FULL_TOOL_CATALOG.map((entry) => ({
      ...entry,
      enabled: entry.toggleable ? groupEnabled[entry.group] && !disabled.has(entry.name) : true,
    }));
    return { groups, tools };
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
    };
  }

  /**
   * Keep-alive hold: when a parent turn ends while background subagents are still running, await ALL of
   * them, then inject their results as a `display:false` custom follow-up so pi runs one more round in
   * the SAME turn and the model finishes its answer using the results (the user's requirement: the parent
   * must not finish until its background subagents complete). Awaited from the `agent_end` hook before the
   * turn settles; ESC (`_aborting`, which `abortAll()`s the subagents) breaks the wait. No-op when nothing
   * is pending, so a turn without background subagents ends immediately.
   */
  private async onParentAgentEnd(): Promise<void> {
    const mgr = this.subagentManager;
    const session = this.runtime?.session;
    if (!mgr || !session || this._aborting) return;
    // Gate on UNCONSUMED background results, not just still-running ones: an agent that completed
    // mid-turn but was never fetched via GetSubagentResult must still be injected, or its result is
    // silently dropped (the bug — a fast background agent that finishes before agent_end vanished).
    if (!mgr.hasUnconsumedBackground()) return;

    await mgr.waitForBackground();
    if (this._aborting) return;

    const completed = mgr.takeCompletedBackgroundResults();
    if (completed.length === 0) return;

    try {
      // deliverAs follow-up continues the SAME turn while streaming (the documented agent_end path);
      // triggerTurn is a safety net so a non-streaming agent_end can never leave the held turn hung.
      await session.sendCustomMessage(
        { customType: SUBAGENT_RESULTS_CUSTOM_TYPE, content: formatBackgroundResults(completed), display: false },
        { deliverAs: "followUp", triggerTurn: true },
      );
      // Only after the follow-up is queued: suppress the idle/done for THIS agent_end, since pi will now
      // continue the turn with the synthesis round (the next agent_end settles it normally).
      this.adapter.holdNextAgentEnd();
    } catch (err) {
      log("[PiSession] background-results follow-up injection failed: %O", err);
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
    const registry = services.modelRegistry;
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
        if (slash !== -1) model = registry.find(explicit.slice(0, slash), explicit.slice(slash + 1)) ?? undefined;
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

  get fastMode(): boolean {
    return false;
  }

  setFastMode(_enabled: boolean): void {
    // Fast mode is an Anthropic-tier feature; no-op on the pi path.
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
  setProviderEnv(_env: Record<string, string> | undefined): void {}
  restartForProviderChange(): void {}
  setBrowserService(_service?: BrowserService): void {}

  // ---- remote control (dropped subsystem) ---------------------------------

  async enableRemoteControl(): Promise<void> {}
  async disableRemoteControl(): Promise<void> {}
  get remoteControlStatus(): RemoteControlStatus {
    return DISABLED_REMOTE_CONTROL;
  }

  // ---- checkpoints / cost / rewind ----------------------------------------

  getCheckpointForMessage(_assistantMessageId: string): string | undefined {
    // No live consumer on the pi path (the assistant→user map would be dead code). Rewind eligibility
    // is driven entirely by the user-entry-id set in `checkpointInfo`.
    return undefined;
  }

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
      if (pi) {
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
    await onSpawnFork({
      sourceSdkSessionId: sourceSessionId,
      forkAtUuid: parentId,
      userMessageId: userEntryId,
      ...(promptContent ? { promptContent } : {}),
      sourcePanelId: this.options.panelId ?? "",
      ...(piBranchedSessionId ? { piBranchedSessionId } : {}),
    });
  }

  // ---- context usage ------------------------------------------------------

  /**
   * Build the full `/context` breakdown for the pi path (US-CMD), mirroring the SDK producer's contract
   * (`src/extension/claude-session/index.ts`) so `ContextUsageOverlay.vue` renders unchanged. Headline
   * totals come from pi's `getContextUsage()` (fallback: the last assistant usage snapshot); the
   * per-message / per-tool breakdown, the system-prompt section, and the discovered
   * skills/commands/agents/MCP sections are estimated with pi's chars/4 heuristic. Sub-sections whose
   * data neither pi nor Damocles holds (memory injection, per-tool prompt snippets) are omitted rather
   * than fabricated. Mirrors the SDK `{ reason: 'busy' }` / `{ reason: 'noQuery' }` early-returns.
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
      this.emit({ type: "contextUsage", data: this.buildContextUsage(session) });
    } catch (err) {
      log("[PiSession] requestContextUsage failed: %O", err);
      this.emit({ type: "contextUsage", data: null, reason: "noQuery" });
    }
  }

  /** The live effective system prompt, for the clickable `/context` system-prompt preview (US-021). */
  getSystemPromptText(): string | undefined {
    const sp = this.runtime?.session.systemPrompt;
    return typeof sp === "string" && sp.length > 0 ? sp : undefined;
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

  /** chars/4 token estimate (pi's own heuristic), conservative — used for every estimated section. */
  private estimateTextTokens(text: string): number {
    return text ? Math.ceil(text.length / 4) : 0;
  }

  /** Assemble the `ContextUsageData` for `/context`; all sub-sections degrade independently. */
  private buildContextUsage(session: AgentSession): ContextUsageData {
    const maxTokens = this.contextWindowForCurrentModel();
    const usage = this.safeContextUsage(session);
    const stats = session.getSessionStats?.();
    const occupied =
      usage?.tokens ??
      (stats ? stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite : 0);
    const totalTokens = Math.max(0, occupied);
    const percentage = maxTokens > 0 ? Math.round((totalTokens / maxTokens) * 100) : 0;

    const breakdown = this.messageBreakdown(session);
    const systemPromptTokens = this.estimateTextTokens(
      typeof session.systemPrompt === "string" ? session.systemPrompt : "",
    );
    const skills = this.skillsSection();
    const commands = this.slashCommandsSection();
    const agents = this.agentsSection();
    const mcpTools = this.mcpToolsSection();

    const messageTokens =
      breakdown.userMessageTokens +
      breakdown.assistantMessageTokens +
      breakdown.toolCallTokens +
      breakdown.toolResultTokens;

    const categories: ContextUsageData["categories"] = [
      { name: "System prompt", tokens: systemPromptTokens, color: "#a78bfa" },
      { name: "Messages & tools", tokens: messageTokens, color: "#38bdf8" },
      { name: "Skills", tokens: skills.tokens, color: "#34d399" },
      { name: "MCP tools", tokens: mcpTools.reduce((sum, t) => sum + t.tokens, 0), color: "#fbbf24" },
    ];

    const apiUsage = stats
      ? {
          input_tokens: stats.tokens.input,
          output_tokens: stats.tokens.output,
          cache_creation_input_tokens: stats.tokens.cacheWrite,
          cache_read_input_tokens: stats.tokens.cacheRead,
        }
      : null;

    const data: ContextUsageData = {
      model: this.modelValue,
      totalTokens,
      maxTokens,
      rawMaxTokens: maxTokens,
      percentage,
      categories,
      memoryFiles: [],
      mcpTools,
      agents,
      apiUsage,
    };
    if (systemPromptTokens > 0) data.systemPromptSections = [{ name: "Damocles system prompt", tokens: systemPromptTokens }];
    if (skills.skillFrontmatter.length > 0) data.skills = skills;
    if (commands) data.slashCommands = commands;
    if (breakdown.hasMessages) data.messageBreakdown = breakdown.value;
    return data;
  }

  /** pi's per-model context usage, or undefined when unavailable (degrades to the stats snapshot). */
  private safeContextUsage(session: AgentSession): { tokens: number | null } | undefined {
    try {
      return session.getContextUsage?.();
    } catch {
      return undefined;
    }
  }

  /** Per-message + per-tool token breakdown from the active branch, estimated with chars/4. */
  private messageBreakdown(session: AgentSession): {
    hasMessages: boolean;
    userMessageTokens: number;
    assistantMessageTokens: number;
    toolCallTokens: number;
    toolResultTokens: number;
    value: NonNullable<ContextUsageData["messageBreakdown"]>;
  } {
    const empty = {
      hasMessages: false,
      userMessageTokens: 0,
      assistantMessageTokens: 0,
      toolCallTokens: 0,
      toolResultTokens: 0,
      value: {
        toolCallTokens: 0,
        toolResultTokens: 0,
        attachmentTokens: 0,
        assistantMessageTokens: 0,
        userMessageTokens: 0,
        toolCallsByType: [] as { name: string; callTokens: number; resultTokens: number }[],
        attachmentsByType: [] as { name: string; tokens: number }[],
      },
    };
    const sm = session.sessionManager;
    if (!sm?.getBranch || !sm.getLeafId) return empty;

    let branch: readonly unknown[];
    try {
      branch = sm.getBranch(sm.getLeafId() ?? undefined);
    } catch {
      return empty;
    }

    let userMessageTokens = 0;
    let assistantMessageTokens = 0;
    let toolCallTokens = 0;
    let toolResultTokens = 0;
    const byType = new Map<string, { call: number; result: number }>();
    const bucket = (name: string): { call: number; result: number } => {
      let b = byType.get(name);
      if (!b) byType.set(name, (b = { call: 0, result: 0 }));
      return b;
    };

    for (const raw of branch) {
      const entry = raw as { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string } };
      if (entry.type !== "message") continue;
      const message = entry.message;
      const role = message?.role;
      const text = piMessageText(message?.content);
      if (role === "user") {
        userMessageTokens += this.estimateTextTokens(text);
      } else if (role === "assistant") {
        const blocks = Array.isArray(message?.content) ? message.content : [];
        for (const block of blocks) {
          const b = block as { type?: string; text?: string; name?: string; arguments?: unknown };
          if (b.type === "text" && typeof b.text === "string") {
            assistantMessageTokens += this.estimateTextTokens(b.text);
          } else if (b.type === "toolCall") {
            const tokens = this.estimateTextTokens(JSON.stringify(b.arguments ?? {}));
            toolCallTokens += tokens;
            if (b.name) bucket(b.name).call += tokens;
          }
        }
      } else if (role === "toolResult") {
        toolResultTokens += this.estimateTextTokens(text);
      }
    }

    const toolCallsByType = [...byType.entries()].map(([name, v]) => ({ name, callTokens: v.call, resultTokens: v.result }));
    const hasMessages = userMessageTokens + assistantMessageTokens + toolCallTokens + toolResultTokens > 0;
    return {
      hasMessages,
      userMessageTokens,
      assistantMessageTokens,
      toolCallTokens,
      toolResultTokens,
      value: {
        toolCallTokens,
        toolResultTokens,
        attachmentTokens: 0,
        assistantMessageTokens,
        userMessageTokens,
        toolCallsByType,
        attachmentsByType: [],
      },
    };
  }

  /** The resource loader, or null before the runtime initializes. */
  private resourceLoader(): import("@earendil-works/pi-coding-agent").ResourceLoader | null {
    return PiRuntime.get(this.cwd, PI_AGENT_DIR).services?.resourceLoader ?? null;
  }

  /** Discovered skills as a context section, each row carrying its source + clickable file path. */
  private skillsSection(): NonNullable<ContextUsageData["skills"]> {
    const empty = { totalSkills: 0, includedSkills: 0, tokens: 0, skillFrontmatter: [] };
    const loader = this.resourceLoader();
    if (!loader) return empty;
    let skills: ReturnType<typeof loader.getSkills>["skills"];
    try {
      skills = loader.getSkills().skills;
    } catch {
      return empty;
    }
    const skillFrontmatter = skills.map((s) => ({
      name: s.name,
      source: s.sourceInfo.scope,
      tokens: this.estimateTextTokens(s.description),
      ...(s.filePath ? { filePath: s.filePath } : {}),
    }));
    const included = skills.filter((s) => !s.disableModelInvocation).length;
    return {
      totalSkills: skills.length,
      includedSkills: included,
      tokens: skillFrontmatter.reduce((sum, s) => sum + s.tokens, 0),
      skillFrontmatter,
    };
  }

  /** Discovered prompt templates as the slash-commands section, with file paths. */
  private slashCommandsSection(): ContextUsageData["slashCommands"] | undefined {
    const loader = this.resourceLoader();
    if (!loader) return undefined;
    const commands: { name: string; source: string; filePath: string; tokens: number }[] = [];
    const seen = new Set<string>();
    const add = (name: string, source: string, filePath: string, text: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      commands.push({ name, source, filePath, tokens: this.estimateTextTokens(text) });
    };
    try {
      for (const prompt of loader.getPrompts().prompts) {
        if (prompt.filePath) add(prompt.name, prompt.sourceInfo.scope, prompt.filePath, prompt.content ?? prompt.description ?? "");
      }
    } catch (err) {
      log("[PiSession] slashCommandsSection: prompts read failed: %O", err);
    }
    if (commands.length === 0) return undefined;
    const tokens = commands.reduce((sum, c) => sum + c.tokens, 0);
    return { totalCommands: commands.length, includedCommands: commands.length, tokens, commands };
  }

  /** Spawnable user/project agents as a context section, each row carrying its template file path. */
  private agentsSection(): ContextUsageData["agents"] {
    if (!this.agentRegistry) return [];
    return this.agentRegistry
      .getAvailableConfigs()
      .filter((c) => c.isDefault !== true)
      .map((c) => ({
        agentType: c.name,
        source: c.source === "project-pi" || c.source === "project-claude" ? "project" : "user",
        tokens: this.estimateTextTokens(c.systemPrompt),
        ...(c.filePath ? { filePath: c.filePath } : {}),
      }));
  }

  /** Enabled MCP tools as a context section, each row estimated from its description. */
  private mcpToolsSection(): ContextUsageData["mcpTools"] {
    if (!this.isMcpEnabled()) return [];
    const manager = this.mcpClientManager();
    if (!manager) return [];
    return manager.getAllToolDescriptors().map((d) => ({
      name: d.piName,
      serverName: d.serverName,
      tokens: this.estimateTextTokens(d.description),
      isLoaded: true,
    }));
  }

  // ---- btw / explore / recall / team (deferred) ---------------------------

  async sendBtw(btwId: string, _question: string): Promise<void> {
    this.emit({ type: "btwError", btwId, message: "btw is not available on the pi harness yet" });
  }
  cancelBtw(_btwId: string): void {}
  async emitExploreHistory(_sessionId: string): Promise<void> {}

  get recallService(): RecallService | undefined {
    return undefined;
  }
  getRecallService(): RecallService | undefined {
    return undefined;
  }
  get isRecallMode(): boolean {
    return false;
  }
  getRecallTrajectory(_promptIndex: number): RecallTrajectory | undefined {
    return undefined;
  }
  async getMemoryInjection(_promptIndex: number): Promise<MemoryInjectionDisplay | undefined> {
    return undefined;
  }
  refreshRecallConfig(_config: RecallConfig): void {}

  get teamService(): TeamService | undefined {
    return undefined;
  }

  get planPath(): string | null {
    return this._planPath;
  }
  set planPath(value: string | null) {
    this._planPath = value;
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
    return this.getModelInfo(this.modelValue)?.contextWindow ?? this.desiredModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
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
    const source = this.apiKeySource();
    return source === "apikey" || source === "extra" || source === "openai-api-key";
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

  private buildAccountInfo(): AccountInfo {
    const info: AccountInfo = { model: this.modelValue };
    const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
    if (this.getModelInfo(this.modelValue)?.backend === "openai") {
      info.tokenSource = this.openaiTokenSource();
    } else {
      info.subscriptionType = piRuntime.getClaudeAuthStatus().mode;
    }
    return info;
  }

  private apiKeySource(): string {
    if (this.getModelInfo(this.modelValue)?.backend === "openai") {
      return this.openaiTokenSource();
    }
    return PiRuntime.get(this.cwd, PI_AGENT_DIR).getClaudeAuthStatus().mode;
  }

  /** Whether the user opted to prefer the OpenAI API key over Codex OAuth when both are configured. */
  private preferOpenAIApiKey(): boolean {
    return this.options.getPreferOpenAIApiKey?.() ?? false;
  }

  /** The active OpenAI credential path, honoring the prefer-API-key toggle when a key is configured. */
  private openaiTokenSource(): "codex-oauth" | "openai-api-key" {
    const status = PiRuntime.get(this.cwd, PI_AGENT_DIR).getOpenAIAuthStatus();
    if (this.preferOpenAIApiKey() && status.apiKey) return "openai-api-key";
    return status.codex ? "codex-oauth" : "openai-api-key";
  }
}
