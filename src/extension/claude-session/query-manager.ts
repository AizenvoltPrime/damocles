import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { existsSync } from "fs";
import { log } from "../logger";
import { extractTextFromContent } from "../../shared/utils";
import type { Query, SessionOptions, StreamingInputController, MessageCallbacks, ContentInput, HookDependencies } from "./types";
import type { ToolManager } from "./tool-manager";
import type { LoopJobTracker } from "./loop-job-tracker";
import type { ReadStateTracker } from "./read-state-tracker";
import type { StreamingManager } from "./streaming-manager";
import type { AccountInfo, ModelInfo, PermissionMode, SandboxConfig } from "../../shared/types/settings";
import type { SlashCommandInfo } from "../../shared/types/commands";
import type { McpServerStatusInfo } from "../../shared/types/mcp";
import type { PluginConfig } from "../../shared/types/plugins";
import type { MemoryInjectionDisplay } from "../../shared/types/context-injection";
import { buildHooksConfig } from "./hook-handlers";
import { MEMORY_SYSTEM_PROMPT } from "../memory/system-prompt";
import { RECALL_SYSTEM_PROMPT } from "../recall/prompts";
import { buildSystemPrompt } from "./system-prompt";
import { DEFAULT_MODELS, DEFAULT_FALLBACK_MODEL, DEFAULT_THINKING_TOKENS } from "../../shared/types/constants";
import { CONTEXT_1M_BETA } from "../chat-panel/settings-manager/utils";
import {
  QueryWarmupManager,
  createStreamingInput,
  stableStringify,
} from "./query-warmup";
import type { WarmupInputs } from "./query-warmup";
import { loadSdkQuery } from "../shared/sdk-loader";
import { buildSdkEnv, getSdkEnvExtensionContext } from "../auth/sdk-env";
import type { ExploreService } from "../explore";
import {
  OpenAIAuthRequiredError,
  provisionOpenAIBridge,
  buildOpenAIBridgeEnv,
} from "../openai-bridge";
import type { OpenAIBridgeProvisioning, OpenAIBridgeProvisionDeps } from "../openai-bridge";
import {
  resolveOpenAIAccountInfo,
  resolveOpenAISupportedModels,
} from "../openai-bridge/account-info";
import packageJson from "../../../package.json";

export { OpenAIAuthRequiredError };

/**
 * Bridge-related deps injected into the QueryManager from `ChatPanelProvider`.
 * Kept narrow so QueryManager never imports `ExtensionContext` directly — the
 * facade closes over context for `getOpenAIAuthStatus()` / `getPreferApiKey()`.
 */
export type OpenAIBridgeDependencies = OpenAIBridgeProvisionDeps;

function buildThinkingOptions(
  modelInfo: ModelInfo | undefined,
  thinkingDisabled: boolean,
  effort: string | null,
  maxThinkingTokens: number | null,
): Record<string, unknown> {
  log(
    '[Thinking] buildThinkingOptions inputs model=%s supportsAdaptiveThinking=%s thinkingDisabled=%s effort=%s maxThinkingTokens=%s',
    modelInfo?.value ?? '<unknown>',
    modelInfo?.supportsAdaptiveThinking ?? false,
    thinkingDisabled,
    effort ?? 'null',
    maxThinkingTokens ?? 'null',
  );
  if (modelInfo?.backend === 'openai') {
    log('[Thinking] openai backend — thinking option omitted (reasoning driven by ModelInfo.openaiReasoningEffort via openai-bridge/openai-transform.ts)');
    return {};
  }
  if (thinkingDisabled) {
    const result = { thinking: { type: 'disabled' } };
    log('[Thinking] disabled (universal signal) result=%j', result);
    return result;
  }
  if (modelInfo?.supportsAdaptiveThinking) {
    const result = {
      thinking: { type: 'adaptive', display: 'summarized' },
      ...(effort && { effort }),
    };
    log('[Thinking] adaptive branch result=%j', result);
    return result;
  }
  const budget = maxThinkingTokens ?? DEFAULT_THINKING_TOKENS;
  const result = { thinking: { type: 'enabled', budgetTokens: budget } };
  log('[Thinking] legacy branch result=%j (budget from %s)', result, maxThinkingTokens ? 'config' : 'default');
  return result;
}

/** Callbacks for SDK hooks */
export interface HookCallbacks {
  onFlush: () => void;
  onMessage: (message: import("../../shared/types/messages").ExtensionToWebviewMessage) => void;
}

/**
 * QueryManager handles SDK query lifecycle and configuration.
 *
 * Responsibilities:
 * - Dynamic SDK import
 * - Create/maintain streaming queries
 * - Build SDK hooks configuration
 * - Model/permission/thinking configuration
 * - Query methods (supportedModels, supportedCommands, mcpServerStatus)
 */
export class QueryManager {
  private abortController: AbortController | null = null;
  private _currentQuery: Query | null = null;
  private _sessionInitializing = false;
  private _streamingInputController: StreamingInputController | null = null;
  private _currentModel: string | null = null;
  private _configuredModel: string | null = null;
  private cachedModels: ModelInfo[] | null = [...DEFAULT_MODELS];
  private maxBudgetUsd: number | null = null;
  private _queuedMessages: Array<{ id: string | null; content: ContentInput }> = [];
  private _thinkingOverride: Record<string, unknown> | null = null;
  private _currentPermissionMode: PermissionMode | null = null;
  private _fastMode = false;
  private _memoryPromptIndex = -1;
  private _memoryInjectionMap = new Map<number, MemoryInjectionDisplay>();
  private _postQueryCreatedHook: ((query: Query) => Promise<void>) | null = null;
  private _onRerouteRemoteMessage: ((prompt: string, correlationId?: string) => void) | null = null;
  private _loopJobTracker: LoopJobTracker;
  private _readStateTracker: ReadStateTracker;
  private _exploreService: ExploreService | null;
  private _warmup = new QueryWarmupManager();
  private _configListener: vscode.Disposable | null = null;
  private _rearmScheduled = false;
  private _disposed = false;

  private options: SessionOptions;
  private callbacks: MessageCallbacks;
  private toolManager: ToolManager;
  private streamingManager: StreamingManager;
  private getMemorySessionId: () => string;
  private _openaiBridgeDeps: OpenAIBridgeDependencies | null;
  private _activeOpenAIBackend: "anthropic" | "openai" | null = null;

  constructor(
    options: SessionOptions,
    callbacks: MessageCallbacks,
    toolManager: ToolManager,
    streamingManager: StreamingManager,
    getMemorySessionId: () => string,
    loopJobTracker: LoopJobTracker,
    readStateTracker: ReadStateTracker,
    exploreService: ExploreService | null = null,
    openaiBridgeDeps: OpenAIBridgeDependencies | null = null,
  ) {
    this.options = options;
    this.callbacks = callbacks;
    this.toolManager = toolManager;
    this.streamingManager = streamingManager;
    this.getMemorySessionId = getMemorySessionId;
    this._loopJobTracker = loopJobTracker;
    this._readStateTracker = readStateTracker;
    this._exploreService = exploreService;
    this._openaiBridgeDeps = openaiBridgeDeps;
    this._configListener = vscode.workspace.onDidChangeConfiguration(e => this.onConfigChanged(e));
  }

  /**
   * Invalidate the warm subprocess whenever any config key baked into the
   * warmup fingerprint changes. Catches settings the webview mutates through
   * {@link vscode.workspace.getConfiguration} (effort, thinking, sandbox,
   * debug, budget, file-checkpointing, progress summaries, maxTurns) that
   * would otherwise produce a fingerprint-diff MISS on the first prompt.
   */
  private onConfigChanged(e: vscode.ConfigurationChangeEvent): void {
    const keys = [
      'damocles.maxTurns',
      'damocles.maxBudgetUsd',
      'damocles.taskBudget',
      'damocles.maxThinkingTokens',
      'damocles.thinkingDisabled',
      'damocles.effortByModel',
      'damocles.sandbox',
      'damocles.debug',
      'damocles.debugFile',
      'damocles.enableFileCheckpointing',
      'damocles.agentProgressSummaries',
    ];
    for (const k of keys) {
      if (e.affectsConfiguration(k)) {
        this.invalidateWarmup(`config:${k}`);
        return;
      }
    }
  }

  setPostQueryCreatedHook(hook: ((query: Query) => Promise<void>) | null): void {
    this._postQueryCreatedHook = hook;
  }

  setRerouteCallback(callback: ((prompt: string, correlationId?: string) => void) | null): void {
    this._onRerouteRemoteMessage = callback;
  }

  get query(): Query | null {
    return this._currentQuery;
  }

  get isInitializing(): boolean {
    return this._sessionInitializing;
  }

  get canRewind(): boolean {
    return this._currentQuery !== null;
  }

  get hasActiveQuery(): boolean {
    return this._streamingInputController !== null;
  }

  get currentModel(): string | null {
    return this._currentModel;
  }

  get configuredModel(): string | null {
    return this._configuredModel;
  }

  getModelInfo(model?: string): ModelInfo | undefined {
    const target = model ?? this._configuredModel ?? "";
    return this.cachedModels?.find(m => m.value === target)
      ?? DEFAULT_MODELS.find(m => m.value === target);
  }

  get abortSignal(): AbortSignal | null {
    return this.abortController?.signal ?? null;
  }

  /**
   * Build the `env` record passed to the SDK's query / startup options.
   *
   * Layered on top of `buildSdkEnv()` (sanitized process.env + Damocles config
   * dir) with main-chat-only additions: an augmented PATH (so the SDK can find
   * the bundled Node binary) and feature flags the streaming-manager consumes
   * (`CLAUDE_CODE_ENABLE_TASKS`, `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`).
   *
   * `providerEnv` is spread last and may intentionally re-introduce
   * `ANTHROPIC_API_KEY` (or other credentials) for user-configured Bedrock /
   * OpenRouter / Z.AI profiles. That is by design — the user explicitly asked
   * to route through that provider with that key. The strip in `buildSdkEnv`
   * targets only shell-level leaks of the *Claude Code CLI's* auth surface,
   * never the provider-specific credentials a user has deliberately configured.
   *
   * Precedence, lowest → highest: sanitized process.env < Damocles constants <
   * main-chat flags < providerEnv.
   */
  private buildEnv(bridge: OpenAIBridgeProvisioning | null): Record<string, string | undefined> {
    return {
      ...buildSdkEnv(),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env["PATH"] || ""}`,
      CLAUDE_CODE_ENABLE_TASKS: "true",
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      ...this.options.providerEnv,
      ...buildOpenAIBridgeEnv(bridge, packageJson.version),
    };
  }

  /**
   * Pre-flight async hook that provisions a bridge endpoint when the active model
   * is OpenAI-backed. Returns `null` for Anthropic-backed models (the SDK talks to
   * Anthropic directly). Throws `OpenAIAuthRequiredError` when neither auth path is
   * configured for the selected GPT model — the caller surfaces this as the
   * `openaiAuthRequired` webview message.
   *
   * Delegates to the shared `provisionOpenAIBridge` helper so Team's specialist
   * spawn site applies the identical auth/mode resolution.
   */
  private provisionOpenAIBridge(modelInfo: ModelInfo | undefined): Promise<OpenAIBridgeProvisioning | null> {
    return provisionOpenAIBridge(modelInfo, this._openaiBridgeDeps);
  }

  /**
   * Real OpenAI account metadata for the active panel. Returns a stub when the
   * extension context isn't registered (pre-activation) — see {@link resolveOpenAIAccountInfo}
   * for the auth-mode resolution logic and network-failure fallback.
   */
  private resolveOpenAIAccountInfoForPanel(): Promise<AccountInfo> {
    const context = getSdkEnvExtensionContext();
    if (!context) {
      log("[QueryManager] resolveOpenAIAccountInfoForPanel: extension context not registered yet");
      return Promise.resolve({ subscriptionType: "unknown" });
    }
    return resolveOpenAIAccountInfo({
      context,
      modelInfo: this.getModelInfo(),
      preferApiKey: this._openaiBridgeDeps?.getPreferApiKey() ?? false,
    });
  }

  /**
   * Supported-models catalog for OpenAI-backed sessions. Stub-only when the
   * extension context isn't registered — see {@link resolveOpenAISupportedModels}
   * for the API-key vs Codex selection logic.
   */
  private resolveOpenAISupportedModelsForPanel(): Promise<ModelInfo[]> {
    const context = getSdkEnvExtensionContext();
    const gptCatalog = DEFAULT_MODELS.filter(m => m.backend === "openai");
    if (!context) return Promise.resolve(gptCatalog);
    return resolveOpenAISupportedModels({
      context,
      modelInfo: this.getModelInfo(),
      preferApiKey: this._openaiBridgeDeps?.getPreferApiKey() ?? false,
    });
  }

  /**
   * Resolve model name based on provider environment overrides.
   * Providers like Z.AI and OpenRouter use ANTHROPIC_DEFAULT_* env vars to map models.
   * Returns the provider's model if set, otherwise returns the original model.
   *
   * For OpenAI-backed models the returned identifier is the upstream `openaiModelId`
   * (e.g. `gpt-5.5`) so the SDK sends the right model in the request body — the
   * bridge proxy reads this from the inbound JSON and forwards it to Codex.
   */
  private resolveModelForProvider(configuredModel: string): string {
    const modelInfo = this.getModelInfo(configuredModel);
    if (modelInfo?.backend === "openai") {
      return modelInfo.openaiModelId ?? configuredModel;
    }

    const env = this.options.providerEnv;
    if (!env) {
      return configuredModel;
    }

    let providerModel: string | undefined;
    if (/^claude-opus-/.test(configuredModel)) {
      providerModel = env["ANTHROPIC_DEFAULT_OPUS_MODEL"];
    } else if (/^claude-haiku-/.test(configuredModel)) {
      providerModel = env["ANTHROPIC_DEFAULT_HAIKU_MODEL"];
    } else if (/^claude-sonnet-/.test(configuredModel)) {
      providerModel = env["ANTHROPIC_DEFAULT_SONNET_MODEL"];
    }

    if (providerModel) {
      return providerModel;
    }

    return configuredModel;
  }

  /**
   * Build the full SDK query options and a matching input fingerprint.
   *
   * Both warmup (`startup(...)`) and on-demand (`query(...)`) paths call this helper so
   * the same inputs deterministically produce the same options. The returned `inputs`
   * captures every input that varies across panel-open lifetimes — warmup consumption
   * is gated on shallow equality of those inputs.
   */
  private buildQueryOptions(args: {
    abortController: AbortController;
    resumeSessionId: string | null;
    resumeSessionAt: string | null;
    ephemeral: boolean;
    forkSession?: boolean;
    openaiBridge: OpenAIBridgeProvisioning | null;
  }): { queryOptions: Record<string, unknown>; inputs: WarmupInputs; model: string; configuredModel: string } {
    const config = vscode.workspace.getConfiguration("damocles");
    const maxTurns = config.get<number>("maxTurns", 100);
    const configuredModel = this.options.model || config.get<string>("model", "") || DEFAULT_FALLBACK_MODEL;
    const has1mBeta = (this.options.betas || []).includes(CONTEXT_1M_BETA);
    const resolvedModel = this.resolveModelForProvider(configuredModel);
    const modelInfo = this.getModelInfo(configuredModel);
    const alwaysOneM = !!modelInfo?.alwaysUses1mContext;
    const model = (has1mBeta || alwaysOneM) && resolvedModel === configuredModel
      ? `${resolvedModel}[1m]`
      : resolvedModel;
    log(
      '[QueryManager.buildQueryOptions] configuredModel=%s alwaysOneM=%s has1mBeta=%s → cliModel=%s',
      configuredModel,
      alwaysOneM,
      has1mBeta,
      model,
    );
    this.maxBudgetUsd = config.get<number | null>("maxBudgetUsd", null);
    const taskBudget = config.get<number | null>("taskBudget", null);
    const { thinkingDisabled, effort, maxThinkingTokens } = this.options.resolveThinking(configuredModel);
    const enableFileCheckpointing = config.get<boolean>("enableFileCheckpointing", true);
    const sandboxConfig = config.get<SandboxConfig>("sandbox", { enabled: false });
    const debugEnabled = config.get<boolean>("debug", false);
    const debugFile = config.get<string | null>("debugFile", null);
    const agentProgressSummaries = config.get<boolean>("agentProgressSummaries", true);
    const worktreeBaseRef = config.get<'fresh' | 'head'>("worktreeBaseRef", "head");

    const thinkingBlock = this._thinkingOverride ?? buildThinkingOptions(modelInfo, thinkingDisabled, effort, maxThinkingTokens);
    log(
      '[Thinking] resolved query thinkingBlock overrideActive=%s configuredModel=%s resolvedModel=%s ephemeral=%s block=%j',
      this._thinkingOverride !== null,
      configuredModel,
      model,
      args.ephemeral,
      thinkingBlock,
    );
    const sandboxBlock = sandboxConfig?.enabled
      ? {
        enabled: true,
        autoAllowBashIfSandboxed: sandboxConfig.autoAllowBashIfSandboxed,
        allowUnsandboxedCommands: sandboxConfig.allowUnsandboxedCommands,
        ...(sandboxConfig.networkAllowedDomains?.length && {
          network: { allowLocalBinding: sandboxConfig.networkAllowLocalBinding },
        }),
      }
      : null;
    const debugBlock = debugFile ? { debugFile } : debugEnabled ? { debug: true } : {};

    const queryOptions: Record<string, unknown> = {
      cwd: this.options.cwd,
      abortController: args.abortController,
      includePartialMessages: true,
      includeHookEvents: true,
      maxTurns,
      model,
      stderr: (data: string) => {
        log("[QueryManager] CLI stderr: %s", data.trim());
        if (data.includes('already in use') && this.options.recallService?.isEnabled) {
          this.streamingManager.sessionConflict = true;
        }
      },
      env: this.buildEnv(args.openaiBridge),
      ...(this.maxBudgetUsd && { maxBudgetUsd: this.maxBudgetUsd }),
      ...(taskBudget != null && { taskBudget: { total: taskBudget } }),
      ...thinkingBlock,
      ...debugBlock,
      enableFileCheckpointing,
      ...(agentProgressSummaries && { agentProgressSummaries: true }),
      ...(sandboxBlock && { sandbox: sandboxBlock }),
      ...(this.options.mcpServers &&
        Object.keys(this.options.mcpServers).length > 0 && {
          mcpServers: this.options.mcpServers,
        }),
      ...(this.options.plugins &&
        this.options.plugins.length > 0 && {
          plugins: this.options.plugins,
        }),
      canUseTool: async (toolName: string, input: Record<string, unknown>, context: { signal: AbortSignal; suggestions?: import('../../shared/types/permissions').PermissionUpdate[]; blockedPath?: string; decisionReason?: string }) => {
        return this.toolManager.handleCanUseTool(toolName, input, context, () => this.streamingManager.flushPendingAssistant());
      },
      settingSources: ['user', 'project', 'local'],
      skills: 'all',
      managedSettings: { worktree: { baseRef: worktreeBaseRef } },
      systemPrompt: (() => {
        const parts: string[] = [
          buildSystemPrompt({
            cwd: this.options.cwd,
            model,
            isGitRepo: existsSync(path.join(this.options.cwd, '.git')),
            platform: process.platform,
            shell: process.env['SHELL'] ?? 'unknown',
            osVersion: `${os.type()} ${os.release()}`,
            compassEnabled: !!this.options.compassService?.isEnabled,
          }),
        ];
        if (this.options.recallService?.isEnabled) parts.push(RECALL_SYSTEM_PROMPT);
        if (this.options.memoryService?.isEnabled) parts.push(MEMORY_SYSTEM_PROMPT);
        return parts.join('\n\n');
      })(),
      tools: { type: "preset", preset: "claude_code" },
      toolConfig: { askUserQuestion: { previewFormat: 'html' } },
      hooks: buildHooksConfig(this.getHookDependencies()),
      onElicitation: async (request: import("@anthropic-ai/claude-agent-sdk").ElicitationRequest, { signal }: { signal: AbortSignal }) => {
        return this.options.permissionHandler.requestElicitation({
          serverName: request.serverName,
          message: request.message,
          mode: request.mode ?? 'form',
          elicitationId: request.elicitationId ?? crypto.randomUUID(),
          ...(request.url !== undefined ? { url: request.url } : {}),
          ...(request.requestedSchema !== undefined ? { requestedSchema: request.requestedSchema } : {}),
        }, signal);
      },
    };

    if (this._fastMode) {
      const existing = (queryOptions['settings'] ?? {}) as Record<string, unknown>;
      queryOptions['settings'] = { ...existing, fastMode: true };
    }

    const recallSessionId = this.options.recallService?.isEnabled
      ? this.options.recallService.sessionId
      : null;
    if (recallSessionId) {
      queryOptions['sessionId'] = recallSessionId;
      queryOptions['persistSession'] = false;
    } else if (args.ephemeral) {
      queryOptions['persistSession'] = false;
    }

    if (args.resumeSessionId && !recallSessionId) {
      queryOptions['resume'] = args.resumeSessionId;
    }

    if (args.resumeSessionAt && !recallSessionId) {
      queryOptions['resumeSessionAt'] = args.resumeSessionAt;
    }

    if (args.forkSession && !recallSessionId) {
      queryOptions['forkSession'] = true;
    }

    if (this.options.chromeEnabled) {
      queryOptions['extraArgs'] = {
        ...((queryOptions['extraArgs'] as Record<string, string | null>) ?? {}),
        chrome: null,
      };
    }

    if (this.options.memoryService?.isEnabled) {
      try {
        const memoryMcp = this.options.memoryService.getMcpServerConfig(
          this.getMemorySessionId,
          this.options.cwd,
        );
        if (memoryMcp) {
          const currentMcp = (queryOptions['mcpServers'] ?? {}) as Record<string, unknown>;
          queryOptions['mcpServers'] = { ...currentMcp, 'damocles-memory': memoryMcp };
        }
      } catch (err) {
        log("[QueryManager] Failed to create memory MCP server:", err);
      }
    }

    if (this.options.browserService) {
      try {
        const browserMcp = this.options.browserService.getMcpServerConfig();
        if (browserMcp) {
          const currentMcp = (queryOptions['mcpServers'] ?? {}) as Record<string, unknown>;
          queryOptions['mcpServers'] = { ...currentMcp, 'damocles-browser': browserMcp };
        }
      } catch (err) {
        log("[QueryManager] Failed to create browser MCP server:", err);
      }
    }

    if (this.options.compassService?.isEnabled) {
      try {
        const compassMcp = this.options.compassService.getMcpServerConfig(
          this.getMemorySessionId,
          this.options.cwd,
        );
        if (compassMcp) {
          const currentMcp = (queryOptions['mcpServers'] ?? {}) as Record<string, unknown>;
          queryOptions['mcpServers'] = { ...currentMcp, 'damocles-compass': compassMcp };
        }
      } catch (err) {
        log("[QueryManager] Failed to create compass MCP server:", err);
      }
      this.options.recallService?.setCompassProvider(this.options.compassService);
    }

    if (this.options.teamService?.isEnabled) {
      try {
        const teamMcp = this.options.teamService.getMcpServerConfig();
        if (teamMcp) {
          const currentMcp = (queryOptions['mcpServers'] ?? {}) as Record<string, unknown>;
          queryOptions['mcpServers'] = { ...currentMcp, 'damocles-team': teamMcp };
        }
      } catch {
        // team MCP server creation failed — non-fatal
      }
    }

    const mcpServerNames = Object.keys((queryOptions['mcpServers'] ?? {}) as Record<string, unknown>).sort();
    const providerEnv = this.options.providerEnv;
    const backendSignature = args.openaiBridge
      ? `openai:${args.openaiBridge.authMode}:${args.openaiBridge.url}:${args.openaiBridge.bearer}`
      : 'anthropic';
    const inputs: WarmupInputs = {
      model,
      configuredModel,
      ephemeral: args.ephemeral,
      fastMode: this._fastMode,
      resumeSessionId: args.resumeSessionId,
      resumeSessionAt: args.resumeSessionAt,
      mcpServerNamesHash: mcpServerNames.join('|'),
      providerEnvHash: providerEnv ? stableStringify(providerEnv) : '',
      chromeEnabled: !!this.options.chromeEnabled,
      maxTurns,
      thinkingSignature: stableStringify(thinkingBlock),
      sandboxSignature: stableStringify(sandboxBlock),
      debugSignature: stableStringify(debugBlock),
      pluginsSignature: stableStringify(this.options.plugins ?? []),
      enableFileCheckpointing,
      agentProgressSummaries,
      backendSignature,
    };

    return { queryOptions, inputs, model, configuredModel };
  }

  /**
   * Eagerly spawn the Claude Code CLI subprocess at panel open so the first user
   * message streams without cold-start delay. Fire-and-forget by design — never
   * blocks the UI. Safe to call multiple times; a prior unused warm is disposed.
   *
   * When the active model is OpenAI-backed, the bridge endpoint is provisioned
   * first so the warmed subprocess's env carries the correct loopback URL +
   * bearer. `OpenAIAuthRequiredError` aborts the warmup silently — the next
   * user-initiated send emits the webview banner via `ensureStreamingQuery`.
   */
  async warmupForSession(resumeSessionId: string | null, resumeSessionAt: string | null): Promise<void> {
    if (this.options.recallService?.isEnabled) {
      log('[Warmup] SKIP — recall mode active (stateless per-turn queries)');
      return;
    }
    if (resumeSessionAt) {
      log('[Warmup] SKIP — resuming from checkpoint (resumeSessionAt=%s)', resumeSessionAt);
      return;
    }

    const configuredModel = this.options.model || vscode.workspace.getConfiguration("damocles").get<string>("model", "") || DEFAULT_FALLBACK_MODEL;
    const modelInfo = this.getModelInfo(configuredModel);
    let openaiBridge: OpenAIBridgeProvisioning | null;
    try {
      openaiBridge = await this.provisionOpenAIBridge(modelInfo);
    } catch (err) {
      if (err instanceof OpenAIAuthRequiredError) {
        log('[Warmup] SKIP — OpenAI auth required for model=%s', err.modelValue);
        return;
      }
      log('[Warmup] SKIP — bridge provisioning failed: %O', err);
      return;
    }
    this._activeOpenAIBackend = openaiBridge ? "openai" : "anthropic";

    await this._warmup.start(
      (abortController) => this.buildQueryOptions({
        abortController,
        resumeSessionId,
        resumeSessionAt,
        ephemeral: false,
        openaiBridge,
      }),
      (model, configuredModel) => {
        this._currentModel = model;
        this._configuredModel = configuredModel;
      },
    );
  }

  /**
   * Single invalidation protocol: tear down the current warm subprocess (sync,
   * idempotent) and schedule exactly one rearm on the next microtask. Rapid
   * synchronous invalidations from a single UI action (e.g., `setModel` then
   * `setBetas` inside one handler) coalesce into a single spawn instead of
   * aborting-and-respawning the in-flight subprocess.
   *
   * The idle-state check runs at fire time so we don't race with a session
   * initialization that starts between `invalidateWarmup()` and the deferred
   * rearm.
   */
  private invalidateWarmup(reason: string): void {
    this._warmup.dispose(reason);
    if (this._disposed || this._rearmScheduled) return;
    this._rearmScheduled = true;
    queueMicrotask(() => {
      this._rearmScheduled = false;
      if (this._disposed || this._streamingInputController || this._sessionInitializing) return;
      this.warmupForSession(null, null)
        .catch(err => log('[Warmup] rearm after %s failed: %O', reason, err));
    });
  }

  /**
   * Ensure a streaming query exists for this session.
   * Uses streaming input mode (AsyncIterable) so the query stays alive between messages.
   *
   * Pass `ephemeral: true` to create a non-persistent query even in default (non-recall)
   * mode. Used for internal SDK commands like `/context` that should not write to the JSONL.
   */
  async ensureStreamingQuery(
    resumeSessionId: string | undefined,
    pendingResumeAt: string | null,
    options?: { ephemeral?: boolean; forkSession?: boolean },
  ): Promise<void> {
    if (this._streamingInputController || this._sessionInitializing) {
      log('[QueryManager.ensure] SKIP — controller=%s, initializing=%s', !!this._streamingInputController, this._sessionInitializing);
      return;
    }

    const inFlight = this._warmup.inFlight;
    if (inFlight) {
      log('[Warmup] WAIT — first prompt arrived before warmup finished; blocking until ready');
      try {
        await inFlight;
      } catch (err) {
        log('[Warmup] REJECTED during wait — falling back to cold-start:', err);
        this._warmup.dispose();
      }
    }

    log('[QueryManager.ensure] Creating query — resume=%s, resumeAt=%s', resumeSessionId ?? 'none', pendingResumeAt ?? 'none');

    this._sessionInitializing = true;

    const ephemeral = !!options?.ephemeral;
    const forkSession = !!options?.forkSession;
    const resumeId = resumeSessionId ?? null;

    const configuredModel = this.options.model || vscode.workspace.getConfiguration("damocles").get<string>("model", "") || DEFAULT_FALLBACK_MODEL;
    const modelInfo = this.getModelInfo(configuredModel);
    let openaiBridge: OpenAIBridgeProvisioning | null;
    try {
      openaiBridge = await this.provisionOpenAIBridge(modelInfo);
    } catch (err) {
      this._sessionInitializing = false;
      if (err instanceof OpenAIAuthRequiredError) {
        log('[QueryManager.ensure] OpenAI auth required for model=%s — emitting webview banner', err.modelValue);
        this.callbacks.onMessage({ type: 'openaiAuthRequired', modelValue: err.modelValue });
        return;
      }
      throw err;
    }
    this._activeOpenAIBackend = openaiBridge ? "openai" : "anthropic";

    const canConsumeWarm =
      this._warmup.hasWarm
      && !this.options.recallService?.isEnabled
      && !pendingResumeAt
      && !forkSession;

    if (canConsumeWarm) {
      const tentativeAbort = new AbortController();
      const current = this.buildQueryOptions({
        abortController: tentativeAbort,
        resumeSessionId: resumeId,
        resumeSessionAt: pendingResumeAt,
        ephemeral,
        forkSession,
        openaiBridge,
      });
      const handle = this._warmup.consume(current.inputs);
      if (handle) {
        try {
          const result = handle.warm.query(handle.stream.inputStream as unknown as string);
          this._streamingInputController = handle.stream.controller;
          this.abortController = handle.abortController;
          await this.postQueryCreated(result, current.model, current.configuredModel, handle.abortController);
          return;
        } catch (err) {
          log('[Warmup] CONSUME FAILED — falling back to cold-start:', err);
          try { handle.abortController.abort(); } catch { /* benign */ }
          try { handle.stream.controller.close(); } catch { /* benign */ }
          this._streamingInputController = null;
          this.abortController = null;
        }
      } else {
        log('[Warmup] MISS — input fingerprint changed since warmup (model/mcp/env/mode); discarding warm subprocess');
        this._warmup.dispose();
      }
    } else if (this._warmup.hasWarm) {
      this._warmup.dispose();
    }

    const queryFn = loadSdkQuery();
    if (!queryFn) {
      this._sessionInitializing = false;
      return;
    }

    const streamState = createStreamingInput();
    this._streamingInputController = streamState.controller;

    const abortController = new AbortController();
    const { queryOptions, model } = this.buildQueryOptions({
      abortController,
      resumeSessionId: resumeId,
      resumeSessionAt: pendingResumeAt,
      ephemeral,
      forkSession,
      openaiBridge,
    });

    log('[QueryManager.ensure] recallSessionId=%s, ephemeral=%s',
      this.options.recallService?.isEnabled ? this.options.recallService.sessionId : 'none',
      ephemeral);

    try {
      const typedOptions = queryOptions as Parameters<typeof queryFn>[0]["options"];
      const result = queryFn({
        prompt: streamState.inputStream as unknown as string,
        ...(typedOptions !== undefined ? { options: typedOptions } : {}),
      });

      this.abortController = abortController;
      await this.postQueryCreated(result, model, configuredModel, abortController);
    } catch (err) {
      log("[QueryManager] Failed to create streaming query:", err);
      this._sessionInitializing = false;
      this._streamingInputController = null;
    }
  }

  /**
   * Post-query setup shared by warm-consumption and fresh `queryFn()` paths:
   * reapply permission mode, run the post-query hook, fetch account/model info,
   * wire the turn-end flush, and start background consumption.
   */
  private async postQueryCreated(
    result: Query,
    model: string,
    configuredModel: string,
    localAbortController: AbortController,
  ): Promise<void> {
    this._currentQuery = result;
    this._currentModel = model;
    this._configuredModel = configuredModel;
    this._sessionInitializing = false;

    if (this._currentPermissionMode) {
      try {
        await result.setPermissionMode(this._currentPermissionMode);
      } catch (err) {
        log("[QueryManager] Failed to reapply permission mode:", err);
      }
    }

    if (this._currentQuery !== result) return;

    if (this._postQueryCreatedHook) {
      try {
        await this._postQueryCreatedHook(result);
      } catch (err) {
        log('[QueryManager] Post-query hook error:', err);
      }
    }

    if (this._currentQuery !== result) return;

    if (this._activeOpenAIBackend === "openai") {
      void this.resolveOpenAIAccountInfoForPanel()
        .then((data) => {
          if (this._currentQuery !== result) return;
          this.callbacks.onMessage({ type: "accountInfo", data });
        })
        .catch((err) => {
          if (this._currentQuery !== result) return;
          log("[QueryManager] OpenAI accountInfo resolution failed: %O", err);
        });
    } else {
      result.accountInfo().then(
        (account) => {
          if (this._currentQuery !== result) return;
          this.callbacks.onMessage({
            type: "accountInfo",
            data: {
              email: account.email,
              subscriptionType: account.subscriptionType,
              apiKeySource: account.apiKeySource,
            } as AccountInfo,
          });
        },
        (err) => {
          if (this._currentQuery !== result) return;
          log("[QueryManager] Failed to get account info:", err);
        },
      );
    }

    if (this._activeOpenAIBackend === "openai") {
      void this.resolveOpenAISupportedModelsForPanel()
        .then((models) => {
          if (this._currentQuery !== result) return;
          this.cachedModels = models;
        })
        .catch((err) => {
          if (this._currentQuery !== result) return;
          log("[QueryManager] resolveOpenAISupportedModels failed: %O", err);
        });
    } else {
      result.supportedModels().then(
        (sdkModels) => {
          if (this._currentQuery !== result) return;
          this.cachedModels = sdkModels.map(sdk => {
            const local = DEFAULT_MODELS.find(d => d.value === sdk.value);
            return local ? { ...local, ...sdk } : sdk as ModelInfo;
          });
        },
        (err) => {
          if (this._currentQuery !== result) return;
          log("[QueryManager] Failed to get supported models:", err);
        },
      );
    }

    const controllerForThisQuery = this._streamingInputController;

    this.streamingManager.onTurnEndFlush = () => {
      return this.flushQueuedMessagesAsNewTurn();
    };

    this.streamingManager
      .consumeQueryInBackground(result, this.maxBudgetUsd, localAbortController.signal, () => {
        const isStaleQuery = this._streamingInputController !== controllerForThisQuery;
        if (!isStaleQuery) {
          this._streamingInputController = null;
        }
        if (!isStaleQuery) {
          this.streamingManager.onTurnComplete = null;
          this.streamingManager.onTurnEndFlush = null;
        }
      })
      .catch((err) => {
        log("[QueryManager] Background query consumption error:", err);
      });
  }

  private getHookDependencies(): HookDependencies {
    return {
      toolManager: this.toolManager,
      streamingManager: this.streamingManager,
      callbacks: this.callbacks,
      options: this.options,
      getQueuedMessages: () => this._queuedMessages,
      spliceQueuedMessages: () => this._queuedMessages.splice(0),
      getMemoryContext: async (prompt?: string) => {
        const sessionId = this.getMemorySessionId() || null;
        const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? null;
        const pushPromptIndex = this.options.recallService?.currentPromptIndex ?? this._memoryPromptIndex;
        try {
          const result = await this.options.memoryService?.buildInjectionContext(sessionId, this.options.cwd, activeFile, prompt);
          if (result) {
            this._memoryPromptIndex++;
            if (result.metadata) {
              this._memoryInjectionMap.set(this._memoryPromptIndex, result.metadata);
              const idx = this.options.recallService?.currentPromptIndex ?? this._memoryPromptIndex;
              this.callbacks.onMessage({
                type: 'memoryInjectionUpdate',
                promptIndex: idx,
                data: result.metadata,
              });
              if (sessionId) {
                await this.options.memoryService?.persistMemoryInjection(sessionId, this._memoryPromptIndex, result.metadata);
              }
            }
            return result.context;
          }
          return '';
        } finally {
          if (pushPromptIndex >= 0) {
            this.callbacks.onMessage({ type: 'contextInjectionComplete', promptIndex: pushPromptIndex });
          }
        }
      },
      getRecallContext: async (userPrompt?: string) => {
        const promptIndex = this.options.recallService?.currentPromptIndex ?? -1;
        if (promptIndex >= 0) {
          this.callbacks.onMessage({ type: 'contextInjectionStarted', promptIndex });
        }
        return await this.options.recallService?.getContextForInjection(userPrompt) ?? null;
      },
      isFirstMessageOfSession: () => {
        const sessionId = this.getMemorySessionId() || null;
        return sessionId ? this.options.memoryService?.isFirstMessageOfSession(sessionId) ?? true : true;
      },
      markFirstMessageSent: () => {
        const sessionId = this.getMemorySessionId() || null;
        if (sessionId) this.options.memoryService?.markFirstMessageSent(sessionId);
      },
      rerouteRemoteMessage: (prompt: string, correlationId?: string) => {
        setTimeout(() => this._onRerouteRemoteMessage?.(prompt, correlationId), 0);
      },
      loopJobTracker: this._loopJobTracker,
      readStateTracker: this._readStateTracker,
      getCompassContext: () => {
        try {
          if (!this.options.compassService?.isEnabled) return '';
          const status = this.options.compassService.getStatus();
          const lastMs = status.lastIndexedAt;
          let indexedAgo = 'never';
          if (lastMs) {
            const diffMin = Math.floor((Date.now() - lastMs) / 60_000);
            indexedAgo = diffMin < 1 ? 'just now' : diffMin < 60 ? `${diffMin}m ago` : `${Math.floor(diffMin / 60)}h ago`;
          }
          const isStale = lastMs ? (Date.now() - lastMs) > 30 * 60_000 : false;
          const staleAttr = isStale ? ' stale="true"' : '';
          const errorAttr = status.state === 'error' && status.error ? ` error="${status.error.replace(/"/g, '&quot;')}"` : '';
          const xmlTag = `<damocles_compass state="${status.state}" nodes="${status.nodeCount}" edges="${status.edgeCount}" indexed="${indexedAgo}"${staleAttr}${errorAttr}/>`;

          if (status.state === 'error') return `${xmlTag}\nCompass is unavailable. Use Glob/Grep for code search.`;
          if (isStale) return `${xmlTag}\nCompass graph is stale (indexed ${indexedAgo}). Verify Compass results with file reads.`;
          return `${xmlTag}\nCompass is ready (${status.nodeCount} entities). Use compass_search before Glob/Grep for entity lookup. Use compass_query for callers/importers/children.`;
        } catch {
          return '';
        }
      },
      isCompassEnabled: () => !!this.options.compassService?.isEnabled,
      exploreService: this._exploreService,
      getAbortSignal: () => this.abortSignal,
    };
  }

  /** Send message through streaming input controller */
  sendMessage(content: ContentInput): Promise<void> {
    return new Promise<void>((resolve) => {
      this.streamingManager.onTurnComplete = resolve;
      this._streamingInputController?.sendMessage(content);
    });
  }

  /**
   * Queue a message for injection at the next turn boundary via PostToolUse hook.
   *
   * Unlike sendMessage(), this does NOT create a new turn. Instead, the message
   * is injected as additionalContext in the PostToolUse hook, making it visible
   * to Claude within the current turn.
   *
   * This mirrors Claude Code CLI's h2A queue mechanism for mid-stream messages.
   */
  queueInput(content: ContentInput, messageId?: string): 'queued' | 'flushed' | false {
    if (!this._streamingInputController) {
      log("[QueryManager] queueInput: no active query");
      return false;
    }
    log("[QueryManager] queueInput: queuing message for PostToolUse injection");
    this._queuedMessages.push({ id: messageId ?? null, content });

    if (!this.streamingManager.isProcessing || !this.streamingManager.onTurnEndFlush) {
      this.flushQueuedMessagesAsNewTurn();
      return 'flushed';
    }

    return 'queued';
  }

  /**
   * Flush any remaining queued messages as a new user turn.
   *
   * Called at turn end when PostToolUse hook didn't fire (text-only responses).
   * Combines all queued messages into a single message and sends via the
   * streaming input controller as a proper SDK turn.
   */
  flushQueuedMessagesAsNewTurn(): boolean {
    if (this._queuedMessages.length === 0 || !this._streamingInputController) {
      return false;
    }

    const queued = this._queuedMessages.splice(0);
    log("[QueryManager] Flushing %d queued messages as new turn", queued.length);

    const combinedContent = this.combineQueuedContent(queued.map((m) => m.content));
    const displayText = extractTextFromContent(combinedContent);
    const contentBlocks = Array.isArray(combinedContent) ? combinedContent : undefined;

    const messageIds = queued.map((m) => m.id).filter((id): id is string => id !== null);
    if (messageIds.length > 0) {
      this.callbacks.onMessage({
        type: "queueBatchProcessed",
        messageIds,
        combinedContent: displayText,
        ...(contentBlocks !== undefined ? { contentBlocks } : {}),
      });
    }

    this.streamingManager.processing = true;

    if (this.callbacks.onFlushedMessageComplete) {
      const callback = this.callbacks.onFlushedMessageComplete;
      this.streamingManager.onTurnComplete = () => {
        log("[QueryManager] Flushed turn complete, triggering UUID assignment");
        callback(displayText, messageIds).catch((err) => {
          log("[QueryManager] Error in onFlushedMessageComplete:", err);
        });
      };
    }

    this.options.recallService?.onFlushedPromptSubmit(displayText);
    this.streamingManager.localPromptPending = true;
    this._streamingInputController.sendMessage(combinedContent);
    return true;
  }

  setThinkingOverride(override: Record<string, unknown> | null): void {
    this._thinkingOverride = override;
  }

  private combineQueuedContent(contents: ContentInput[]): ContentInput {
    const hasMultimodal = contents.some((c) => Array.isArray(c));
    if (!hasMultimodal) {
      return (contents as string[]).join("\n\n");
    }

    const blocks: import("../../shared/types/content").UserContentBlock[] = [];
    for (let i = 0; i < contents.length; i++) {
      const content = contents[i];
      if (typeof content === "string") {
        if (i > 0) blocks.push({ type: "text", text: "\n\n" });
        blocks.push({ type: "text", text: content });
      } else if (content) {
        if (i > 0 && blocks.length > 0) {
          blocks.push({ type: "text", text: "\n\n" });
        }
        blocks.push(...content);
      }
    }
    return blocks;
  }

  /** Abort the current query */
  abort(): void {
    if (this.abortController) {
      this.options.permissionHandler.setSessionAborting(true);
      this.abortController.abort();
      this.options.permissionHandler.setSessionAborting(false);
      this.abortController = null;
    }
  }

  /** Interrupt the current query (may fail silently if query not in streaming mode) */
  async interrupt(): Promise<void> {
    if (this.abortController) {
      this.options.permissionHandler.setSessionAborting(true);
      this.abortController.abort();
      this.options.permissionHandler.setSessionAborting(false);
    }

    if (this._currentQuery) {
      try {
        await this._currentQuery.interrupt();
      } catch (err) {
        log("[QueryManager] Interrupt failed (expected if not streaming):", err);
      }
    }
  }

  /** Close streaming input and reset query state */
  closeAndReset(): void {
    log('[QueryManager.closeAndReset] controller=%s, initializing=%s', !!this._streamingInputController, this._sessionInitializing);
    this._warmup.dispose();
    if (this.abortController) {
      this.options.permissionHandler.setSessionAborting(true);
      this.abortController.abort();
      this.options.permissionHandler.setSessionAborting(false);
      this.abortController = null;
    }
    if (this._streamingInputController) {
      this._streamingInputController.close();
      this._streamingInputController = null;
    }
    this._currentQuery = null;
    this._sessionInitializing = false;
    this._queuedMessages = [];
  }

  /** Tear down once at session disposal: release the config-change listener. */
  dispose(): void {
    this._disposed = true;
    this._configListener?.dispose();
    this._configListener = null;
    this._warmup.dispose('session-dispose');
  }

  /** Full reset including cached data */
  reset(): void {
    this.abort();
    this.closeAndReset();
    this._queuedMessages = [];
    this._onRerouteRemoteMessage = null;
    this.cachedModels = [...DEFAULT_MODELS];
    this._currentModel = null;
    this._configuredModel = null;
    this.maxBudgetUsd = null;
    this._thinkingOverride = null;
    this._currentPermissionMode = null;
    this._fastMode = false;
    this._memoryPromptIndex = -1;
    this._memoryInjectionMap.clear();
  }

  async getMemoryInjection(promptIndex: number): Promise<MemoryInjectionDisplay | undefined> {
    const cached = this._memoryInjectionMap.get(promptIndex);
    if (cached) return cached;
    const sessionId = this.getMemorySessionId();
    if (!sessionId) return undefined;
    const persisted = await this.options.memoryService?.getPersistedMemoryInjection(sessionId, promptIndex);
    if (persisted) this._memoryInjectionMap.set(promptIndex, persisted);
    return persisted;
  }

  /**
   * Update MCP servers configuration.
   * Called when user toggles MCP servers in the UI.
   */
  setMcpServers(mcpServers: Record<string, import("../../shared/types/mcp").McpServerConfig>): void {
    this.options.mcpServers = mcpServers;
    this.invalidateWarmup('setMcpServers');
  }

  /**
   * Close the query to trigger recreation with new MCP config.
   * Must call setMcpServers() first to update the configuration.
   * Session ID is preserved - next query will resume.
   */
  restartForMcpChanges(): void {
    if (this._streamingInputController) {
      this.closeAndReset();
    }
  }

  async reconnectMcpServerLive(serverName: string): Promise<boolean> {
    if (!this._currentQuery) return false;
    try {
      await this._currentQuery.reconnectMcpServer(serverName);
      return true;
    } catch (err) {
      log("[QueryManager] reconnectMcpServerLive failed:", err);
      return false;
    }
  }

  async reloadPlugins(): Promise<{ errorCount: number } | null> {
    if (!this._currentQuery) return null;
    try {
      const response = await this._currentQuery.reloadPlugins();
      return { errorCount: response.error_count };
    } catch (err) {
      log("[QueryManager] reloadPlugins failed:", err);
      return null;
    }
  }

  setPlugins(plugins: PluginConfig[]): void {
    this.options.plugins = plugins;
    this.invalidateWarmup('setPlugins');
  }

  /**
   * Close the query to trigger recreation with new plugins.
   * Must call setPlugins() first to update the configuration.
   * Session ID is preserved - next query will resume.
   */
  restartForPluginChanges(): void {
    if (this._streamingInputController) {
      this.closeAndReset();
    }
  }

  /**
   * Update provider environment variables configuration.
   * Called when user switches provider profiles in the UI.
   */
  setProviderEnv(env: Record<string, string> | undefined): void {
    if (env !== undefined) {
      this.options.providerEnv = env;
    } else {
      delete this.options.providerEnv;
    }
    this.invalidateWarmup('setProviderEnv');
  }

  /**
   * Close the query to trigger recreation with new provider env vars.
   * Must call setProviderEnv() first to update the configuration.
   * Session ID is preserved - next query will resume.
   */
  restartForProviderChange(): void {
    if (this._streamingInputController) {
      this.closeAndReset();
    }
  }

  setBrowserService(service: import('../browser').BrowserService | undefined): void {
    if (service) {
      this.options.browserService = service;
    } else {
      delete this.options.browserService;
    }
  }

  setChromeEnabled(enabled: boolean): void {
    this.options.chromeEnabled = enabled;
    this.invalidateWarmup('setChromeEnabled');
  }

  restartForChromeChange(): void {
    if (this._streamingInputController) {
      this.closeAndReset();
    }
  }

  /** Set permission mode — tracked for reapplication after query recreation */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this._currentPermissionMode = mode;
    if (this._currentQuery) {
      try {
        await this._currentQuery.setPermissionMode(mode);
      } catch (err) {
        log("[QueryManager] setPermissionMode failed:", err);
      }
    }
  }

  get fastMode(): boolean {
    return this._fastMode;
  }

  setFastMode(enabled: boolean): void {
    this._fastMode = enabled;
    if (this._streamingInputController) {
      this.closeAndReset();
    } else {
      this.invalidateWarmup('setFastMode');
    }
  }

  setModel(model?: string): void {
    if (model) {
      this.options.model = model;
    }
    const nextBackend: "anthropic" | "openai" = (() => {
      const info = this.getModelInfo(model);
      return info?.backend === "openai" ? "openai" : "anthropic";
    })();
    const backendTransition =
      this._activeOpenAIBackend !== null && this._activeOpenAIBackend !== nextBackend;
    if (this._streamingInputController || backendTransition) {
      this.closeAndReset();
    } else {
      this.invalidateWarmup('setModel');
    }
  }

  setBetas(betas: string[]): void {
    this.options.betas = betas;
    if (this._streamingInputController) {
      this.closeAndReset();
    } else {
      this.invalidateWarmup('setBetas');
    }
  }

  async getSupportedModels(): Promise<ModelInfo[]> {
    if (this.cachedModels) {
      return this.cachedModels;
    }
    if (this._currentQuery) {
      try {
        const sdkModels = await this._currentQuery.supportedModels();
        this.cachedModels = sdkModels.map(sdk => {
          const local = DEFAULT_MODELS.find(d => d.value === sdk.value);
          return local ? { ...local, ...sdk } : sdk as ModelInfo;
        });
        return this.cachedModels;
      } catch (err) {
        log("[QueryManager] getSupportedModels failed:", err);
        return [];
      }
    }
    return [];
  }

  async getSupportedCommands(): Promise<SlashCommandInfo[]> {
    if (this._currentQuery) {
      try {
        const commands = await this._currentQuery.supportedCommands();
        return commands as SlashCommandInfo[];
      } catch (err) {
        log("[QueryManager] getSupportedCommands failed:", err);
        return [];
      }
    }
    return [];
  }

  async getContextUsage(): Promise<import('../../shared/types/session').ContextUsageData | null> {
    if (!this._currentQuery) return null;
    try {
      const response = await this._currentQuery.getContextUsage() as Record<string, unknown>;
      return {
        ...response,
        categories: Array.isArray(response['categories']) ? response['categories'] : [],
        memoryFiles: Array.isArray(response['memoryFiles']) ? response['memoryFiles'] : [],
        mcpTools: Array.isArray(response['mcpTools']) ? response['mcpTools'] : [],
        agents: Array.isArray(response['agents']) ? response['agents'] : [],
        isAutoCompactEnabled: typeof response['isAutoCompactEnabled'] === 'boolean' ? response['isAutoCompactEnabled'] : false,
        apiUsage: response['apiUsage'] ?? null,
      } as import('../../shared/types/session').ContextUsageData;
    } catch (err) {
      log("[QueryManager] getContextUsage failed:", err);
      return null;
    }
  }

  async getMcpServerStatus(): Promise<McpServerStatusInfo[]> {
    if (this._currentQuery) {
      try {
        const status = await this._currentQuery.mcpServerStatus();
        return status as McpServerStatusInfo[];
      } catch (err) {
        log("[QueryManager] getMcpServerStatus failed:", err);
        return [];
      }
    }
    return [];
  }
}
