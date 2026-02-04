import { log } from '../logger';
import { persistQueuedMessage } from '../session';
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

  constructor(options: SessionOptions) {
    this.options = options;

    const callbacks: MessageCallbacks = {
      onMessage: options.onMessage,
      ...(options.onSessionIdChange !== undefined ? { onSessionIdChange: options.onSessionIdChange } : {}),
      onFlushedMessageComplete: async (content: string, queueMessageIds: string[]) => {
        await this.assignFlushedMessageUuid(content, queueMessageIds);
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
    this.streamingManager = new StreamingManager(callbacks, this.toolManager, checkpointTracker, options.cwd);
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

  async initializeEarly(): Promise<void> {
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

    const sessionToResume = this.checkpointManager.resumeSessionId || this.streamingManager.sessionId;
    const pendingResumeAt = this.checkpointManager.clearPendingResumeAt();

    await this.queryManager.ensureStreamingQuery(sessionToResume ?? undefined, pendingResumeAt);

    if (!this.queryManager.hasActiveQuery) {
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

    this.streamingManager.silentAbort = false;
    this.streamingManager.processing = true;
    this.streamingManager.resetTurn();
    this.checkpointManager.currentPrompt = plainPrompt;
    this.checkpointManager.currentCorrelationId = correlationId ?? null;
    this.checkpointManager.wasInterrupted = false;

    const lastKnownUserUuid = this.streamingManager.lastUserMessageId;

    await this.queryManager.sendMessage(prompt);

    const sessionId = this.streamingManager.sessionId;

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

    this.checkpointManager.currentPrompt = null;
    this.checkpointManager.currentCorrelationId = null;
  }

  cancel(): void {
    this.clearPendingCompactTimer();

    if (this.contextMonitor.currentState.autoCompactTriggered) {
      this.contextMonitor.onCompactComplete();
    }

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
      } else if (sessionId) {
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

  clear(): void {
    this.streamingManager.silentAbort = true;
    this.queryManager.closeAndReset();
    this.streamingManager.processing = false;
    this.streamingManager.resetStreaming();
    this.streamingManager.sessionId = null;
    this.checkpointManager.setResumeSession(null);
    this.clearPendingCompactTimer();
    this.contextMonitor.reset();
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
      const sessionId = this.currentSessionId;
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

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.queryManager.setPermissionMode(mode);
  }

  async setModel(model?: string): Promise<void> {
    await this.queryManager.setModel(model);
  }

  async setMaxThinkingTokens(tokens: number | null): Promise<void> {
    await this.queryManager.setMaxThinkingTokens(tokens);
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
    const sessionId = this.streamingManager.sessionId;
    const needsFileRewind = option === 'code-and-conversation' || option === 'code-only';

    if (needsFileRewind && sessionId && !this.queryManager.query) {
      await this.queryManager.ensureStreamingQuery(sessionId, null);
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
