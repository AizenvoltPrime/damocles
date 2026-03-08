import * as vscode from "vscode";
import * as path from "path";
import { log } from "../logger";
import { extractTextFromContent } from "../../shared/utils";
import type { Query, SessionOptions, StreamingInputController, MessageCallbacks, ContentInput, HookDependencies } from "./types";
import type { ToolManager } from "./tool-manager";
import type { LoopJobTracker } from "./loop-job-tracker";
import type { StreamingManager } from "./streaming-manager";
import type { AccountInfo, ModelInfo, PermissionMode, SandboxConfig } from "../../shared/types/settings";
import type { SlashCommandInfo } from "../../shared/types/commands";
import type { McpServerStatusInfo } from "../../shared/types/mcp";
import type { PluginConfig } from "../../shared/types/plugins";
import type { MemoryInjectionDisplay } from "../../shared/types/context-injection";
import { buildHooksConfig } from "./hook-handlers";
import { MEMORY_SYSTEM_PROMPT } from "../memory/system-prompt";
import { DEFAULT_MODELS } from "../../shared/types/constants";

function buildThinkingOptions(
  modelInfo: ModelInfo | undefined,
  thinkingDisabled: boolean,
  effort: string | null,
  maxThinkingTokens: number | null,
): Record<string, unknown> {
  if (modelInfo?.supportsAdaptiveThinking) {
    return {
      thinking: thinkingDisabled ? { type: 'disabled' } : { type: 'adaptive' },
      ...(!thinkingDisabled && effort && { effort }),
    };
  }
  if (maxThinkingTokens) {
    return { thinking: { type: 'enabled', budgetTokens: maxThinkingTokens } };
  }
  return {};
}

let queryFn: typeof import("@anthropic-ai/claude-agent-sdk").query | undefined;

async function loadSDK() {
  if (!queryFn) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    queryFn = sdk.query;
  }
  return queryFn;
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
  private _onRerouteRemoteMessage: ((prompt: string) => void) | null = null;
  private _loopJobTracker: LoopJobTracker;

  private options: SessionOptions;
  private callbacks: MessageCallbacks;
  private toolManager: ToolManager;
  private streamingManager: StreamingManager;
  private getMemorySessionId: () => string;

  constructor(
    options: SessionOptions,
    callbacks: MessageCallbacks,
    toolManager: ToolManager,
    streamingManager: StreamingManager,
    getMemorySessionId: () => string,
    loopJobTracker: LoopJobTracker,
  ) {
    this.options = options;
    this.callbacks = callbacks;
    this.toolManager = toolManager;
    this.streamingManager = streamingManager;
    this.getMemorySessionId = getMemorySessionId;
    this._loopJobTracker = loopJobTracker;
  }

  setPostQueryCreatedHook(hook: ((query: Query) => Promise<void>) | null): void {
    this._postQueryCreatedHook = hook;
  }

  setRerouteCallback(callback: ((prompt: string) => void) | null): void {
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
    return this.cachedModels?.find(m => m.value === target);
  }

  get abortSignal(): AbortSignal | null {
    return this.abortController?.signal ?? null;
  }

  /**
   * Resolve model name based on provider environment overrides.
   * Providers like Z.AI and OpenRouter use ANTHROPIC_DEFAULT_* env vars to map models.
   * Returns the provider's model if set, otherwise returns the original model.
   */
  private resolveModelForProvider(configuredModel: string): string {
    const env = this.options.providerEnv;
    if (!env) {
      return configuredModel;
    }

    // Match Claude model tiers explicitly (claude-opus-*, claude-sonnet-*, claude-haiku-*)
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
   * Ensure a streaming query exists for this session.
   * Uses streaming input mode (AsyncIterable) so the query stays alive between messages.
   *
   * Pass `ephemeral: true` to create a non-persistent query even in default (non-distill)
   * mode. Used for internal SDK commands like `/context` that should not write to the JSONL.
   *
   * Note: The SDK prompt parameter accepts string | AsyncIterable, but TypeScript types
   * don't properly reflect AsyncIterable support, requiring an `as unknown as string` cast.
   */
  async ensureStreamingQuery(
    resumeSessionId: string | undefined,
    pendingResumeAt: string | null,
    options?: { ephemeral?: boolean },
  ): Promise<void> {
    if (this._streamingInputController || this._sessionInitializing) {
      log('[QueryManager.ensure] SKIP — controller=%s, initializing=%s', !!this._streamingInputController, this._sessionInitializing);
      return;
    }
    log('[QueryManager.ensure] Creating query — resume=%s, resumeAt=%s', resumeSessionId ?? 'none', pendingResumeAt ?? 'none');

    this._sessionInitializing = true;

    const queryFn = await loadSDK();
    if (!queryFn) {
      this._sessionInitializing = false;
      return;
    }

    type UserMessage = {
      type: "user";
      message: { role: "user"; content: ContentInput };
      parent_tool_use_id: null;
    };

    let resolveNext: ((content: ContentInput | null) => void) | null = null;

    async function* inputStream(): AsyncGenerator<UserMessage, void, unknown> {
      while (true) {
        const content = await new Promise<ContentInput | null>((resolve) => {
          resolveNext = resolve;
        });
        if (content === null) {
          break;
        }
        yield {
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
        };
      }
    }

    this._streamingInputController = {
      sendMessage: (content: ContentInput) => {
        if (resolveNext) {
          resolveNext(content);
        }
      },
      close: () => {
        if (resolveNext) {
          resolveNext(null);
        }
      },
    };

    const config = vscode.workspace.getConfiguration("damocles");
    const maxTurns = config.get<number>("maxTurns", 100);
    const configuredModel = this.options.model || config.get<string>("model", "") || "claude-opus-4-6";
    const model = this.resolveModelForProvider(configuredModel);
    this.maxBudgetUsd = config.get<number | null>("maxBudgetUsd", null);
    const maxThinkingTokens = config.get<number | null>("maxThinkingTokens", null);
    const thinkingDisabled = config.get<boolean>("thinkingDisabled", false);
    const effort = config.get<string | null>("effort", null);
    const betasEnabled = (this.options.betas || []).filter((b): b is "context-1m-2025-08-07" => b === "context-1m-2025-08-07");
    const enableFileCheckpointing = config.get<boolean>("enableFileCheckpointing", true);
    const sandboxConfig = config.get<SandboxConfig>("sandbox", { enabled: false });
    const debugEnabled = config.get<boolean>("debug", false);
    const debugFile = config.get<string | null>("debugFile", null);

    const queryOptions: Record<string, unknown> = {
      cwd: this.options.cwd,
      abortController: new AbortController(),
      includePartialMessages: true,
      maxTurns,
      model,
      stderr: (data: string) => {
        log("[QueryManager] CLI stderr: %s", data.trim());
        if (data.includes('already in use') && this.options.contextDistillation?.isEnabled) {
          this.streamingManager.sessionConflict = true;
        }
      },
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env["PATH"] || ""}`,
        CLAUDE_CODE_ENABLE_TASKS: "true",
        ...(this.options.providerEnv && Object.keys(this.options.providerEnv).length > 0 && this.options.providerEnv),
      },
      ...(this.maxBudgetUsd && { maxBudgetUsd: this.maxBudgetUsd }),
      ...(this._thinkingOverride ?? buildThinkingOptions(this.getModelInfo(configuredModel), thinkingDisabled, effort, maxThinkingTokens)),
      ...(debugFile ? { debugFile } : debugEnabled ? { debug: true } : {}),
      ...(betasEnabled.length > 0 && { betas: betasEnabled }),
      enableFileCheckpointing,
      ...(sandboxConfig?.enabled && {
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: sandboxConfig.autoAllowBashIfSandboxed,
          allowUnsandboxedCommands: sandboxConfig.allowUnsandboxedCommands,
          ...(sandboxConfig.networkAllowedDomains?.length && {
            network: {
              allowLocalBinding: sandboxConfig.networkAllowLocalBinding,
            },
          }),
        },
      }),
      // MCP servers merged with fresh memory MCP below
      ...(this.options.mcpServers &&
        Object.keys(this.options.mcpServers).length > 0 && {
          mcpServers: this.options.mcpServers,
        }),
      // Pass plugins explicitly - SDK doesn't auto-discover from standard locations
      ...(this.options.plugins &&
        this.options.plugins.length > 0 && {
          plugins: this.options.plugins,
        }),
      canUseTool: async (toolName: string, input: Record<string, unknown>, context: { signal: AbortSignal; suggestions?: import('../../shared/types/permissions').PermissionUpdate[]; blockedPath?: string; decisionReason?: string }) => {
        return this.toolManager.handleCanUseTool(toolName, input, context, () => this.streamingManager.flushPendingAssistant());
      },
      // Let SDK load settings files for hooks, env, CLAUDE.md, etc.
      // Permissions are handled by PreToolUse hook via EvaluatorManager (short-circuits SDK rules)
      settingSources: ['user', 'project', 'local'],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(this.options.memoryService?.isEnabled ? { append: MEMORY_SYSTEM_PROMPT } : {}),
      },
      tools: { type: "preset", preset: "claude_code" },
      toolConfig: { askUserQuestion: { previewFormat: 'html' } },
      hooks: buildHooksConfig(this.getHookDependencies()),
    };

    if (this._fastMode) {
      const existing = (queryOptions['settings'] ?? {}) as Record<string, unknown>;
      queryOptions['settings'] = { ...existing, fastMode: true };
    }

    const distillSessionId = this.options.contextDistillation?.isEnabled
      ? this.options.contextDistillation.sessionId
      : null;
    log('[QueryManager.ensure] distillSessionId=%s, ephemeral=%s', distillSessionId ?? 'none', !!options?.ephemeral);
    if (distillSessionId) {
      queryOptions['sessionId'] = distillSessionId;
      queryOptions['persistSession'] = false;
    } else if (options?.ephemeral) {
      queryOptions['persistSession'] = false;
    }

    if (resumeSessionId && !distillSessionId) {
      queryOptions['resume'] = resumeSessionId;
    }

    if (pendingResumeAt && !distillSessionId) {
      queryOptions['resumeSessionAt'] = pendingResumeAt;
    }

    try {
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

      const typedOptions = queryOptions as Parameters<typeof queryFn>[0]["options"];
      const result = queryFn({
        prompt: inputStream() as unknown as string,
        ...(typedOptions !== undefined ? { options: typedOptions } : {}),
      });

      const localAbortController = queryOptions['abortController'] as AbortController;
      this._currentQuery = result;
      this.abortController = localAbortController;
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

      result.supportedModels().then(
        (models) => {
          if (this._currentQuery !== result) return;
          this.cachedModels = models as ModelInfo[];
        },
        (err) => {
          if (this._currentQuery !== result) return;
          log("[QueryManager] Failed to get supported models:", err);
        },
      );

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
    } catch (err) {
      log("[QueryManager] Failed to create streaming query:", err);
      this._sessionInitializing = false;
      this._streamingInputController = null;
    }
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
        const result = await this.options.memoryService?.buildInjectionContext(sessionId, this.options.cwd, activeFile, prompt);
        if (result) {
          this._memoryPromptIndex++;
          if (result.metadata) {
            this._memoryInjectionMap.set(this._memoryPromptIndex, result.metadata);
            if (sessionId) {
              this.options.memoryService?.persistMemoryInjection(sessionId, this._memoryPromptIndex, result.metadata);
            }
          }
          return result.context;
        }
        return '';
      },
      getDistilledContext: async (userPrompt?: string) => {
        return await this.options.contextDistillation?.getContextForInjection(userPrompt) ?? null;
      },
      isFirstMessageOfSession: () => {
        const sessionId = this.getMemorySessionId() || null;
        return sessionId ? this.options.memoryService?.isFirstMessageOfSession(sessionId) ?? true : true;
      },
      markFirstMessageSent: () => {
        const sessionId = this.getMemorySessionId() || null;
        if (sessionId) this.options.memoryService?.markFirstMessageSent(sessionId);
      },
      rerouteRemoteMessage: (prompt: string) => {
        setTimeout(() => this._onRerouteRemoteMessage?.(prompt), 0);
      },
      loopJobTracker: this._loopJobTracker,
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
  queueInput(content: ContentInput, messageId?: string): boolean {
    if (!this._streamingInputController) {
      log("[QueryManager] queueInput: no active query");
      return false;
    }
    log("[QueryManager] queueInput: queuing message for PostToolUse injection");
    this._queuedMessages.push({ id: messageId ?? null, content });
    return true;
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

    this.options.contextDistillation?.onFlushedPromptSubmit(displayText);
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

  /** Full reset including cached data */
  reset(): void {
    this.abort();
    this.closeAndReset();
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

  getMemoryInjection(promptIndex: number): MemoryInjectionDisplay | undefined {
    const cached = this._memoryInjectionMap.get(promptIndex);
    if (cached) return cached;
    const sessionId = this.getMemorySessionId();
    if (!sessionId) return undefined;
    const persisted = this.options.memoryService?.getPersistedMemoryInjection(sessionId, promptIndex);
    if (persisted) this._memoryInjectionMap.set(promptIndex, persisted);
    return persisted;
  }

  /**
   * Update MCP servers configuration.
   * Called when user toggles MCP servers in the UI.
   */
  setMcpServers(mcpServers: Record<string, import("../../shared/types/mcp").McpServerConfig>): void {
    this.options.mcpServers = mcpServers;
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

  /**
   * Update plugins configuration.
   * Called when user toggles plugins in the UI.
   */
  setPlugins(plugins: PluginConfig[]): void {
    this.options.plugins = plugins;
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

  setChromeEnabled(enabled: boolean): void {
    this.options.chromeEnabled = enabled;
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
    }
  }

  setModel(model?: string): void {
    if (model) {
      this.options.model = model;
    }
    if (this._streamingInputController) {
      this.closeAndReset();
    }
  }

  setBetas(betas: string[]): void {
    this.options.betas = betas;
  }

  async getSupportedModels(): Promise<ModelInfo[]> {
    if (this.cachedModels) {
      return this.cachedModels;
    }
    if (this._currentQuery) {
      try {
        const models = await this._currentQuery.supportedModels();
        this.cachedModels = models as ModelInfo[];
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
