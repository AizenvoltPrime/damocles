import { log } from '../logger';
import { persistQueuedMessage, readAgentData } from '../session';
import { extractTextFromContent } from '../../shared/utils';
import type { SessionOptions, MessageCallbacks, RewindOption, ContentInput } from './types';
import type { McpServerConfig, McpServerStatusInfo } from '../../shared/types/mcp';
import type { PluginConfig } from '../../shared/types/plugins';
import { ToolManager } from './tool-manager';
import { StreamingManager, type CheckpointTracker } from './streaming-manager/index';
import { CheckpointManager } from './checkpoint-manager';
import { QueryManager } from './query-manager';
import { ContextMonitor } from './context-monitor';
import type { PermissionMode, ModelInfo } from '../../shared/types/settings';
import type { SlashCommandInfo } from '../../shared/types/commands';

export type { SessionOptions } from './types';

const POST_INTERRUPT_DELAY_MS = 100;

/**
 * ClaudeSession coordinates the SDK interaction through focused managers.
 *
 * This is a thin facade that:
 * - Wires managers together via dependency injection
 * - Exposes the public API (unchanged from original)
 * - Delegates all logic to specialized managers
 *
 * Manager responsibilities:
 * - QueryManager: SDK lifecycle, configuration, query methods
 * - StreamingManager: Message processing, content accumulation
 * - ToolManager: Permission handling, tool correlation
 * - CheckpointManager: Rewind, checkpoints, cost tracking
 */
export class ClaudeSession {
  private toolManager: ToolManager;
  private streamingManager: StreamingManager;
  private checkpointManager: CheckpointManager;
  private queryManager: QueryManager;
  private contextMonitor: ContextMonitor;
  private options: SessionOptions;
  private distillSessionRegistered = false;

  constructor(options: SessionOptions) {
    this.options = options;

    const callbacks: MessageCallbacks = {
      onMessage: options.onMessage,
      ...(options.onSessionIdChange !== undefined ? { onSessionIdChange: options.onSessionIdChange } : {}),
      onFlushedMessageComplete: async (content: string, queueMessageIds: string[]) => {
        await this.assignFlushedMessageUuid(content, queueMessageIds);
      },
      onSessionConflict: () => {
        log('[ClaudeSession] Session conflict detected — tearing down doomed query');
        this.checkpointManager.setResumeSession(null);
        this.streamingManager.sessionId = null;
        this.queryManager.closeAndReset();
        if (this.options.contextDistillation?.isEnabled) {
          this.options.contextDistillation.regenerateSessionId();
          log('[ClaudeSession] Distill SDK session ID regenerated (persistence unchanged)');
        }
      },
    };

    this.contextMonitor = new ContextMonitor({
      onWarningLevelChange: (message) => options.onMessage(message),
      onAutoCompactTrigger: () => this.injectCompactCommand(),
    });

    const checkpointTracker: CheckpointTracker = {
      trackCheckpoint: (assistantId, userId) => this.checkpointManager.trackCheckpoint(assistantId, userId),
      updateCost: (cost) => this.checkpointManager.updateCost(cost),
      updateTokenUsage: (inputTokens, contextWindowSize) => this.contextMonitor.updateTokenUsage(inputTokens, contextWindowSize),
      setContextWindowSize: (size) => this.contextMonitor.setContextWindowSize(size),
      onCompactComplete: () => this.contextMonitor.onCompactComplete(),
    };

    this.toolManager = new ToolManager(options.permissionHandler, callbacks, options.cwd);
    this.checkpointManager = new CheckpointManager(options.cwd, callbacks);

    if (options.contextDistillation) {
      this.toolManager.setIsDistillModeActive(() => options.contextDistillation!.isEnabled);
      this.toolManager.setOnToolCompleted((toolName, toolUseId, result, parentToolUseId) => {
        options.contextDistillation!.onToolResult(toolName, toolUseId, result, parentToolUseId ?? undefined);
      });
      options.contextDistillation.onSubagentDataReady = (taskToolUseId: string, agentId: string) => {
        readAgentData(options.cwd, agentId)
          .then(agentData => {
            log('[ClaudeSession] onSubagentDataReady: taskToolId=%s, agentId=%s, messages=%d, model=%s',
              taskToolUseId, agentId, agentData.messages.length, agentData.model ?? 'unknown');
            if (agentData.model) {
              options.onMessage({
                type: 'subagentModelUpdate',
                taskToolId: taskToolUseId,
                model: agentData.model,
              });
            }
            if (agentData.messages.length > 0) {
              options.onMessage({
                type: 'subagentMessagesUpdate',
                taskToolId: taskToolUseId,
                messages: agentData.messages,
              });
            }
          })
          .catch(err => log('[ClaudeSession] Failed to handle subagent data ready:', err));
      };
    }

    this.streamingManager = new StreamingManager(
      callbacks, this.toolManager, checkpointTracker, options.cwd,
      options.contextDistillation,
    );
    this.queryManager = new QueryManager(options, callbacks, this.toolManager, this.streamingManager);
  }

  private async assignFlushedMessageUuid(content: string, queueMessageIds: string[]): Promise<void> {
    const sessionId = this.streamingManager.sessionId;
    if (!sessionId) return;

    const lastKnownUuid = this.streamingManager.lastUserMessageId;
    const uuid = await this.checkpointManager.readFlushedMessageUuid(sessionId, content, lastKnownUuid);

    if (uuid) {
      this.streamingManager.lastUserMessageId = uuid;
      if (queueMessageIds.length > 0) {
        this.options.onMessage({
          type: 'flushedMessagesAssigned',
          queueMessageIds,
          sdkMessageId: uuid,
        });
      }
    }
  }

  get currentSessionId(): string | null {
    return this.streamingManager.sessionId;
  }

  get persistenceSessionId(): string | null {
    return this.options.contextDistillation?.persistenceSessionId ?? this.streamingManager.sessionId;
  }

  get memorySessionId(): string {
    return this.streamingManager.sessionId ?? this.options.panelId ?? '';
  }

  get processing(): boolean {
    return this.streamingManager.isProcessing;
  }

  get canRewindFiles(): boolean {
    return this.queryManager.canRewind;
  }

  get conversationHead(): string | null {
    return this.checkpointManager.pendingResumeAt;
  }

  setResumeSession(sessionId: string | null): void {
    this.checkpointManager.setResumeSession(sessionId);
    this.streamingManager.sessionId = sessionId;
    if (sessionId) {
      this.streamingManager.silentAbort = true;
      this.queryManager.closeAndReset();
      this.queryManager.ensureStreamingQuery(sessionId, null).catch(err => {
        this.streamingManager.silentAbort = false;
        log('[ClaudeSession] Failed to initialize resumed session:', err);
      });
    }
  }

  setDistillSession(sessionId: string): void {
    if (!this.options.contextDistillation) return;
    this.options.contextDistillation.setSessionId(sessionId);
    this.streamingManager.sessionId = sessionId;
  }

  async initializeEarly(): Promise<void> {
    if (this.options.contextDistillation?.isEnabled) return;
    const sessionToResume = this.checkpointManager.resumeSessionId || this.streamingManager.sessionId;
    await this.queryManager.ensureStreamingQuery(sessionToResume ?? undefined, null);
  }

  async sendMessage(
    prompt: ContentInput,
    _agentId?: string,
    correlationId?: string
  ): Promise<void> {
    if (this.streamingManager.isProcessing) {
      this.options.onMessage({
        type: 'error',
        message: 'A request is already in progress',
      });
      return;
    }

    this.streamingManager.silentAbort = false;
    this.streamingManager.processing = true;

    if (this.options.contextDistillation?.isEnabled && this.options.contextDistillation.isHaikuProcessing) {
      log('[ClaudeSession.sendMessage] Waiting for distill context to update...');
      await this.options.contextDistillation.waitForDistillReady();
      if (this.streamingManager.silentAbort) {
        log('[ClaudeSession.sendMessage] Cancelled while waiting for distill context');
        this.streamingManager.processing = false;
        return;
      }
    }

    const isDistill = !!this.options.contextDistillation?.isEnabled;

    if (isDistill) {
      log('[ClaudeSession.sendMessage] DISTILL path — distillSessionId=%s', this.options.contextDistillation!.sessionId);
      const persistence = this.options.contextDistillation!.distillPersistence;
      await persistence.initialize();
      const userUuid = await persistence.persistUser(prompt);
      this.streamingManager.lastUserMessageId = userUuid;

      this.queryManager.closeAndReset();
      await this.queryManager.ensureStreamingQuery(undefined, null);
    } else {
      const sessionToResume = this.checkpointManager.resumeSessionId || this.streamingManager.sessionId;
      const pendingResumeAt = this.checkpointManager.clearPendingResumeAt();
      await this.queryManager.ensureStreamingQuery(sessionToResume ?? undefined, pendingResumeAt);
    }

    if (!this.queryManager.hasActiveQuery) {
      log('[ClaudeSession.sendMessage] FAILED: no active query after ensure');
      this.streamingManager.processing = false;
      this.options.onMessage({
        type: 'error',
        message: 'Failed to initialize streaming query',
      });
      return;
    }

    if (this.checkpointManager.resumeSessionId) {
      this.checkpointManager.clearResumeSession();
    }

    const plainPrompt = Array.isArray(prompt)
      ? prompt.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text).join('\n')
      : prompt;

    this.options.contextDistillation?.onPromptSubmit(plainPrompt);

    this.streamingManager.resetTurn();
    this.checkpointManager.currentPrompt = plainPrompt;
    this.checkpointManager.currentCorrelationId = correlationId ?? null;
    this.checkpointManager.wasInterrupted = false;

    const lastKnownUserUuid = this.streamingManager.lastUserMessageId;

    await this.queryManager.sendMessage(prompt);

    if (isDistill && !this.queryManager.hasActiveQuery && !this.streamingManager.silentAbort) {
      log('[ClaudeSession.sendMessage] Distill query died — retrying with fresh session');
      this.streamingManager.processing = true;
      await this.queryManager.ensureStreamingQuery(undefined, null);
      if (this.queryManager.hasActiveQuery) {
        this.streamingManager.resetTurn();
        await this.queryManager.sendMessage(prompt);
      }
    }

    const sessionId = this.streamingManager.sessionId;

    if (isDistill) {
      const persistence = this.options.contextDistillation!.distillPersistence;
      await persistence.flushQueue();

      if (correlationId) {
        this.options.onMessage({
          type: 'userMessageIdAssigned',
          sdkMessageId: persistence.lastUserUuid!,
          correlationId,
        });
      }

      const persistenceId = this.options.contextDistillation!.persistenceSessionId;
      if (!this.distillSessionRegistered && persistenceId) {
        this.distillSessionRegistered = true;
        this.options.onSessionPersisted?.(persistenceId);
      }
    } else {
      if (sessionId && !this.checkpointManager.wasInterrupted && correlationId) {
        const uuid = await this.checkpointManager.readUserMessageUuid(sessionId, lastKnownUserUuid);
        if (uuid) {
          this.streamingManager.lastUserMessageId = uuid;
          this.options.onMessage({
            type: 'userMessageIdAssigned',
            sdkMessageId: uuid,
            correlationId,
          });
        }
      }

      if (this.checkpointManager.wasInterrupted) {
        if (sessionId) {
          const interruptUuid = await this.checkpointManager.handleInterruptPersistence(
            sessionId,
            this.streamingManager.lastUserMessageId,
            this.streamingManager.currentStreamingContent,
            this.queryManager.currentModel
          );
          if (interruptUuid) {
            this.streamingManager.lastUserMessageId = interruptUuid;
          }
        } else if (this.checkpointManager.currentCorrelationId && this.checkpointManager.currentPrompt) {
          this.options.onMessage({
            type: 'interruptRecovery',
            correlationId: this.checkpointManager.currentCorrelationId,
            promptContent: this.checkpointManager.currentPrompt,
          });
        }
      } else if (sessionId) {
        const lastUuid = await this.checkpointManager.getLastMessageUuid(sessionId);
        if (lastUuid) {
          this.streamingManager.lastUserMessageId = lastUuid;
        }
      }
    }

    this.checkpointManager.currentPrompt = null;
    this.checkpointManager.currentCorrelationId = null;
  }

  cancel(): void {
    this.clearPendingCompactTimer();

    if (this.contextMonitor.currentState.autoCompactTriggered) {
      this.contextMonitor.onCompactComplete();
    }

    this.options.contextDistillation?.cancelPendingWait();
    this.options.contextDistillation?.onResponseComplete();
    this.checkpointManager.wasInterrupted = true;
    this.streamingManager.silentAbort = true;
    this.options.onMessage({ type: 'sessionCancelled' });
    this.queryManager.abort();
    this.streamingManager.processing = false;

    const sessionId = this.streamingManager.sessionId;
    const correlationId = this.checkpointManager.currentCorrelationId;
    const prompt = this.checkpointManager.currentPrompt;

    if (correlationId && prompt) {
      const streamingContent = this.streamingManager.currentStreamingContent;
      const hasStreamingStarted =
        streamingContent.thinking.length > 0 ||
        streamingContent.text.length > 0 ||
        streamingContent.hasStreamedTools;

      if (!hasStreamingStarted) {
        this.options.onMessage({
          type: 'interruptRecovery',
          correlationId,
          promptContent: prompt,
        });
        this.checkpointManager.currentPrompt = null;
        this.checkpointManager.currentCorrelationId = null;
      } else if (sessionId && !this.options.contextDistillation?.isEnabled) {
        this.checkpointManager.handleInterruptPersistence(
          sessionId,
          this.streamingManager.lastUserMessageId,
          streamingContent,
          this.queryManager.currentModel
        ).then(() => {
          this.checkpointManager.currentPrompt = null;
          this.checkpointManager.currentCorrelationId = null;
        }).catch(err => {
          log('[ClaudeSession] handleInterruptPersistence error:', err);
        });
      }
    }
  }

  reset(): void {
    this.streamingManager.silentAbort = true;
    this.queryManager.abort();
    this.streamingManager.processing = false;
    this.queryManager.reset();
    this.streamingManager.resetStreaming();
    this.streamingManager.sessionId = null;
    this.checkpointManager.reset();
    this.clearPendingCompactTimer();
    this.contextMonitor.reset();
  }

  async dispose(): Promise<void> {
    this.reset();
    await this.options.contextDistillation?.dispose();
  }

  clear(): void {
    this.reset();
    this.options.contextDistillation?.reset();
    this.distillSessionRegistered = false;
  }

  get distillPlanPath(): string | null {
    return this.options.contextDistillation?.planFilePath ?? null;
  }

  set distillPlanPath(value: string | null) {
    if (this.options.contextDistillation) {
      this.options.contextDistillation.planFilePath = value;
    }
  }

  private pendingCompactTimer: ReturnType<typeof setTimeout> | null = null;

  private clearPendingCompactTimer(): void {
    if (this.pendingCompactTimer) {
      clearTimeout(this.pendingCompactTimer);
      this.pendingCompactTimer = null;
    }
  }

  private injectCompactCommand(): void {
    log('[ClaudeSession] Auto-compact triggered, interrupting current stream');

    // Interrupt first, then send /compact
    this.interrupt().then(() => {
      this.pendingCompactTimer = setTimeout(() => {
        this.pendingCompactTimer = null;
        this.sendMessage('/compact').catch(err => {
          log('[ClaudeSession] Auto-compact sendMessage failed:', err);
        });
      }, POST_INTERRUPT_DELAY_MS);
    }).catch(err => {
      log('[ClaudeSession] Auto-compact interrupt failed:', err);
    });
  }

  async cancelAutoCompact(): Promise<void> {
    this.clearPendingCompactTimer();
    this.contextMonitor.onCompactComplete();

    if (this.streamingManager.isProcessing) {
      await this.interrupt();
      log('[ClaudeSession] Interrupted auto-compact in progress');
    }
  }

  async interrupt(): Promise<void> {
    this.checkpointManager.wasInterrupted = true;
    this.streamingManager.silentAbort = true;
    this.options.onMessage({ type: 'sessionCancelled' });
    this.streamingManager.processing = false;
    await this.queryManager.interrupt();
  }

  /**
   * Queue a message for injection at the next turn boundary via PostToolUse hook.
   *
   * The message is stored in a queue and injected as `additionalContext` in the
   * PostToolUse hook. This makes it visible to Claude within the current turn,
   * mimicking Claude Code CLI's h2A queue mechanism for mid-stream messages.
   *
   * Returns true if the message was queued, false if no active session.
   */
  queueInput(content: ContentInput, messageId?: string): boolean {
    const injected = this.queryManager.queueInput(content, messageId);

    if (injected) {
      const sessionId = this.persistenceSessionId;
      if (sessionId) {
        const textContent = extractTextFromContent(content);
        if (textContent) {
          persistQueuedMessage(this.options.cwd, sessionId, textContent).catch(err => {
            log('[ClaudeSession] Failed to persist queued message:', err);
          });
        }
      }
    }

    return injected;
  }

  async getHaikuActivities(): Promise<import('../../shared/types/haiku-observer').HaikuPromptActivity[] | null> {
    return this.options.contextDistillation?.getHaikuActivities() ?? null;
  }

  getHaikuLogPath(promptIndex: number): string | null {
    return this.options.contextDistillation?.getHaikuLogPath(promptIndex) ?? null;
  }

  getContextSummary(promptIndex: number): string | null {
    return this.options.contextDistillation?.getContextSummary(promptIndex) ?? null;
  }

  refreshContextStrategy(strategy: import('../../shared/types/settings').ContextStrategy): void {
    this.options.contextDistillation?.refreshConfig(strategy);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.queryManager.setPermissionMode(mode);
  }

  async setModel(model?: string): Promise<void> {
    await this.queryManager.setModel(model);
  }

  async setMaxThinkingTokens(tokens: number | null): Promise<void> {
    await this.queryManager.setMaxThinkingTokens(tokens);
  }

  setBetas(betas: string[]): void {
    this.queryManager.setBetas(betas);
  }

  setPendingPlanBind(content: string): void {
    this.queryManager.setPendingPlanBind(content);
  }

  async getSupportedModels(): Promise<ModelInfo[]> {
    return this.queryManager.getSupportedModels();
  }

  async getSupportedCommands(): Promise<SlashCommandInfo[]> {
    return this.queryManager.getSupportedCommands();
  }

  async getMcpServerStatus(): Promise<McpServerStatusInfo[]> {
    return this.queryManager.getMcpServerStatus();
  }

  setMcpServers(mcpServers: Record<string, McpServerConfig>): void {
    this.queryManager.setMcpServers(mcpServers);
  }

  restartForMcpChanges(): void {
    this.streamingManager.silentAbort = true;
    this.queryManager.restartForMcpChanges();
  }

  setPlugins(plugins: PluginConfig[]): void {
    this.queryManager.setPlugins(plugins);
  }

  restartForPluginChanges(): void {
    this.streamingManager.silentAbort = true;
    this.queryManager.restartForPluginChanges();
  }

  setProviderEnv(env: Record<string, string> | undefined): void {
    this.queryManager.setProviderEnv(env);
  }

  restartForProviderChange(): void {
    this.streamingManager.silentAbort = true;
    this.queryManager.restartForProviderChange();
  }

  async rewindFiles(userMessageId: string, option: RewindOption = 'code-only', promptContent?: string): Promise<void> {
    const sessionId = this.persistenceSessionId;
    const needsFileRewind = option === 'code-and-conversation' || option === 'code-only';

    if (needsFileRewind && !this.options.contextDistillation?.isEnabled) {
      const sdkSessionId = this.streamingManager.sessionId;
      if (sdkSessionId && !this.queryManager.query) {
        await this.queryManager.ensureStreamingQuery(sdkSessionId, null);
      }
    }

    this.streamingManager.silentAbort = true;

    await this.checkpointManager.rewindFiles(
      userMessageId,
      option,
      sessionId,
      this.queryManager.query,
      promptContent,
      (clearSession: boolean) => {
        this.queryManager.closeAndReset();
        if (clearSession) {
          this.streamingManager.sessionId = null;
          this.checkpointManager.setResumeSession(null);
        }
      }
    );
  }

  getCheckpointForMessage(assistantMessageId: string): string | undefined {
    return this.checkpointManager.getCheckpointForMessage(assistantMessageId);
  }

  getAccumulatedCost(): number {
    return this.checkpointManager.getAccumulatedCost();
  }
}
