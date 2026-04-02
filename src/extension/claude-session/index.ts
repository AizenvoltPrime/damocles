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
import { RemoteControlManager } from './remote-control-manager';
import { LoopJobTracker } from './loop-job-tracker';
import { BtwHandler } from './btw-handler';
import { ReadStateTracker } from './read-state-tracker';
import type { LoopJob } from '../../shared/types/loop-jobs';
import type { PermissionMode, ModelInfo } from '../../shared/types/settings';
import type { RecallConfig } from '../recall/types';
import type { SlashCommandInfo } from '../../shared/types/commands';
import type { RemoteControlStatus } from '../../shared/types/remote-control';
import { getContextWindowForModel } from '../chat-panel/settings-manager/utils';

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
  private remoteControlManager: RemoteControlManager;
  private loopJobTracker: LoopJobTracker;
  private btwHandler: BtwHandler;
  private readStateTracker: ReadStateTracker;
  private options: SessionOptions;
  private recallSessionRegistered = false;
  private currentModelId: string | null = null;
  private currentBetas: string[] = [];

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
        if (this.options.recallService?.isEnabled) {
          this.options.recallService.regenerateSessionId();
          log('[ClaudeSession] Recall SDK session ID regenerated (persistence unchanged)');
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
    this.readStateTracker = new ReadStateTracker(options.cwd);

    if (options.recallService) {
      this.toolManager.setIsRecallModeActive(() => options.recallService!.isEnabled);
      this.toolManager.setOnToolCompleted((toolName, toolUseId, result, parentToolUseId) => {
        options.recallService!.onToolResult(toolName, toolUseId, result, parentToolUseId ?? undefined);
      });
      options.recallService.onSubagentDataReady = (agentToolUseId: string, agentId: string) => {
        readAgentData(options.cwd, agentId)
          .then(agentData => {
            log('[ClaudeSession] onSubagentDataReady: agentToolId=%s, agentId=%s, messages=%d, model=%s',
              agentToolUseId, agentId, agentData.messages.length, agentData.model ?? 'unknown');
            if (agentData.model) {
              options.onMessage({
                type: 'subagentModelUpdate',
                agentToolId: agentToolUseId,
                model: agentData.model,
              });
            }
            if (agentData.messages.length > 0) {
              options.onMessage({
                type: 'subagentMessagesUpdate',
                agentToolId: agentToolUseId,
                messages: agentData.messages,
              });
            }
          })
          .catch(err => log('[ClaudeSession] Failed to handle subagent data ready:', err));
      };
      options.recallService.onRecallIteration = (promptIndex, iteration) => {
        options.onMessage({ type: 'recallIterationUpdate', promptIndex, iteration });
      };
      options.recallService.onRecallComplete = (promptIndex, trajectory) => {
        options.onMessage({ type: 'recallCompleted', promptIndex, trajectory });
      };
      options.recallService.onOrientationPhase = (promptIndex, phase, orientation) => {
        options.onMessage({ type: 'orientationPhaseUpdate', promptIndex, phase, orientation });
      };
      options.recallService.onNodeStateChanged = (payload) => {
        options.onMessage({ type: 'node-state-updated', ...payload });
      };
    }

    this.loopJobTracker = new LoopJobTracker({
      onMessage: options.onMessage,
    });

    if (options.recallService) {
      this.loopJobTracker.setCronFireCallback((prompt) => {
        if (this.streamingManager.isProcessing) {
          log('[ClaudeSession] Local cron fire skipped: session busy');
          return;
        }

        const correlationId = `cron-${Date.now()}`;
        this.options.onMessage({
          type: 'userMessage',
          content: prompt,
          correlationId,
        });

        this.sendMessage(prompt, undefined, correlationId).catch(err =>
          log('[ClaudeSession] Local cron fire failed: %O', err)
        );
      });
    }

    this.btwHandler = new BtwHandler({
      cwd: options.cwd,
      getSessionId: () => this.persistenceSessionId,
      getModel: () => this.currentModel,
      onMessage: (msg) => options.onMessage(msg),
      ...options.recallService && {
        getCrossNodeContext: (question: string) => options.recallService!.getCrossNodeContext(question),
      },
    });

    this.streamingManager = new StreamingManager(
      callbacks, this.toolManager, checkpointTracker, options.cwd,
      options.recallService, this.loopJobTracker,
    );
    this.queryManager = new QueryManager(options, callbacks, this.toolManager, this.streamingManager, () => this.memorySessionId, this.loopJobTracker, this.readStateTracker);

    let contextUsageTimer: ReturnType<typeof setTimeout> | undefined;
    this.streamingManager.onResultProcessed = () => {
      clearTimeout(contextUsageTimer);
      contextUsageTimer = setTimeout(() => void this.refreshContextUsageSummary(), 500);
    };

    this.remoteControlManager = new RemoteControlManager(
      (message) => options.onMessage(message),
    );

    this.queryManager.setPostQueryCreatedHook(async (query) => {
      if (this.remoteControlManager.isEnabled) {
        await this.remoteControlManager.reapplyToQuery(query);
      }
      if (this.readStateTracker.size > 0) {
        let seeded = 0;
        for (const [filePath, mtime] of this.readStateTracker.entries()) {
          try {
            await query.seedReadState(filePath, mtime);
            seeded++;
          } catch {
            log('[ClaudeSession] Failed to seed read state for %s, skipping', filePath);
          }
        }
        log('[ClaudeSession] Seeded %d/%d read states into new query', seeded, this.readStateTracker.size);
      }
    });

    this.queryManager.setRerouteCallback((prompt) => {
      if (this.streamingManager.silentAbort) {
        log('[ClaudeSession] Reroute suppressed: session was cancelled/aborted');
        return;
      }
      log('[ClaudeSession] Rerouting remote message through sendMessage: length=%d', prompt.length);
      this.sendMessage(prompt).catch(err =>
        log('[ClaudeSession] Remote reroute failed: %O', err)
      );
    });

    this.currentModelId = options.model || null;
    this.currentBetas = options.betas || [];
    if (this.currentModelId) {
      this.contextMonitor.setContextWindowSize(
        getContextWindowForModel(this.currentModelId, this.currentBetas),
      );
    }
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
    return this.options.recallService?.persistenceSessionId ?? this.streamingManager.sessionId;
  }

  get memorySessionId(): string {
    return this.persistenceSessionId ?? this.options.panelId ?? '';
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

  async setRecallSession(sessionId: string): Promise<void> {
    if (!this.options.recallService) return;
    await this.options.recallService.setSessionId(sessionId);
    this.streamingManager.sessionId = sessionId;
  }

  async initializeEarly(): Promise<void> {
    if (this.options.recallService?.isEnabled) return;
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

    const isRecall = !!this.options.recallService?.isEnabled;

    const plainPrompt = Array.isArray(prompt)
      ? prompt.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text).join('\n')
      : prompt;

    let nodeId: string | null = null;
    if (isRecall) {
      const recall = this.options.recallService!;
      const nm = recall.getNodeManager();
      const nodeState = nm.getNodeState();

      if (recall.currentPromptIndex >= 0 && !correlationId?.startsWith('cron-')) {
        if (nodeState.nodes.length === 0 || nm.pendingNewNode) {
          nm.clearPendingNewNode();
          const node = await nm.createNode(plainPrompt);
          nodeId = node.nodeId;
          this.options.onMessage({ type: 'node-state-updated', ...recall.buildNodeDisplayState() });
        } else {
          nodeId = nodeState.activeNodeId;
          if (!nodeId) {
            const firstActive = nodeState.nodes.find(n => n.status === 'ACTIVE');
            if (firstActive) {
              nm.setActiveNodeId(firstActive.nodeId);
              nodeId = firstActive.nodeId;
            }
          }
        }
      } else {
        nodeId = nodeState.activeNodeId;
      }
    }

    if (isRecall) {
      log('[ClaudeSession.sendMessage] RECALL path — recallSessionId=%s', this.options.recallService!.sessionId);
      try {
        const persistence = this.options.recallService!.turnPersistence;
        await persistence.initialize();
        const userUuid = await persistence.persistUser(prompt, nodeId);
        this.streamingManager.lastUserMessageId = userUuid;

        this.queryManager.closeAndReset();
        await this.queryManager.ensureStreamingQuery(undefined, null);
      } catch (err) {
        this.streamingManager.processing = false;
        throw err;
      }
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

    if (isRecall) {
      this.options.recallService!.onPromptSubmit(plainPrompt, nodeId);
    } else {
      this.options.recallService?.onPromptSubmit(plainPrompt);
    }

    this.streamingManager.resetTurn();
    this.checkpointManager.currentPrompt = plainPrompt;
    this.checkpointManager.currentCorrelationId = correlationId ?? null;
    this.checkpointManager.wasInterrupted = false;

    const lastKnownUserUuid = this.streamingManager.lastUserMessageId;

    this.streamingManager.localPromptPending = true;
    await this.queryManager.sendMessage(prompt);

    if (isRecall && !this.queryManager.hasActiveQuery && !this.streamingManager.silentAbort) {
      log('[ClaudeSession.sendMessage] Recall query died — retrying with fresh session');
      this.streamingManager.processing = true;
      await this.queryManager.ensureStreamingQuery(undefined, null);
      if (this.queryManager.hasActiveQuery) {
        this.streamingManager.resetTurn();
        this.streamingManager.localPromptPending = true;
        await this.queryManager.sendMessage(prompt);
      }
    }

    const sessionId = this.streamingManager.sessionId;

    if (isRecall) {
      const persistence = this.options.recallService!.turnPersistence;
      await persistence.flushQueue();

      if (correlationId) {
        this.options.onMessage({
          type: 'userMessageIdAssigned',
          sdkMessageId: persistence.lastUserUuid!,
          correlationId,
        });
      }

      const persistenceId = this.options.recallService!.persistenceSessionId;
      if (!this.recallSessionRegistered && persistenceId) {
        this.recallSessionRegistered = true;
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

  async stopTask(taskId: string): Promise<void> {
    const query = this.queryManager.query;
    if (query) {
      await query.stopTask(taskId);
    } else {
      log('[ClaudeSession] stopTask(%s) failed: no active query', taskId);
      this.options.onMessage({
        type: 'backgroundTaskCompleted',
        taskId,
        status: 'failed',
        summary: 'Could not stop task — no active session query',
        outputFile: null,
      });
    }
  }

  cancel(): void {
    this.clearPendingCompactTimer();
    if (this.contextMonitor.currentState.autoCompactTriggered) {
      this.contextMonitor.onCompactComplete();
    }

    this.options.recallService?.onResponseComplete();
    this.options.recallService?.cancelPendingRecall();
    this.checkpointManager.wasInterrupted = true;
    this.streamingManager.silentAbort = true;
    this.streamingManager.localPromptPending = false;
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
      } else if (sessionId && !this.options.recallService?.isEnabled) {
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
    this.remoteControlManager.reset();
    this.readStateTracker.clear();
    this.clearPendingCompactTimer();
    this.contextMonitor.reset();
    if (this.currentModelId) {
      this.contextMonitor.setContextWindowSize(
        getContextWindowForModel(this.currentModelId, this.currentBetas),
      );
    }
  }

  async dispose(): Promise<void> {
    this.reset();
    this.btwHandler.cancelAll();
    this.loopJobTracker.reset();
    this.options.recallService?.dispose();
  }

  clear(): void {
    this.reset();
    this.btwHandler.cancelAll();
    this.loopJobTracker.reset();
    this.options.recallService?.reset();
    this.recallSessionRegistered = false;
  }

  async sendBtw(btwId: string, question: string): Promise<void> {
    await this.btwHandler.sendWithContext(btwId, question);
  }

  cancelBtw(btwId: string): void {
    this.btwHandler.cancel(btwId);
  }

  getRecallService(): import('../recall').RecallService | undefined {
    return this.options.recallService;
  }

  get isRecallMode(): boolean {
    return !!this.options.recallService?.isEnabled;
  }

  get planPath(): string | null {
    return this.options.recallService?.planFilePath ?? null;
  }

  set planPath(value: string | null) {
    if (this.options.recallService) {
      this.options.recallService.planFilePath = value;
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
    this.streamingManager.localPromptPending = false;
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
   * Returns 'queued' if deferred for turn-end flush, 'flushed' if sent immediately,
   * or false if no active session.
   */
  queueInput(content: ContentInput, messageId?: string): 'queued' | 'flushed' | false {
    const disposition = this.queryManager.queueInput(content, messageId);

    if (disposition) {
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

    return disposition;
  }

  getRecallTrajectory(promptIndex: number): import('../recall/types').RecallTrajectory | undefined {
    return this.options.recallService?.getRecallTrajectory(promptIndex);
  }

  async getMemoryInjection(promptIndex: number): Promise<import('../../shared/types/context-injection').MemoryInjectionDisplay | undefined> {
    return await this.queryManager.getMemoryInjection(promptIndex);
  }

  async requestContextUsage(): Promise<void> {
    if (this.streamingManager.isProcessing) {
      this.options.onMessage({ type: 'contextUsage', data: null, reason: 'busy' });
      return;
    }

    if (!this.queryManager.hasActiveQuery) {
      await this.queryManager.ensureStreamingQuery(undefined, null);
    }

    const data = await this.queryManager.getContextUsage();
    if (!data) {
      this.options.onMessage({ type: 'contextUsage', data: null, reason: 'noQuery' });
      return;
    }

    this.options.onMessage({ type: 'contextUsage', data });
  }

  private async refreshContextUsageSummary(): Promise<void> {
    const data = await this.queryManager.getContextUsage();
    if (!data) return;

    this.contextMonitor.updateTokenUsage(data.totalTokens, data.maxTokens);

    this.options.onMessage({
      type: 'contextUsageSummary',
      totalTokens: data.totalTokens,
      maxTokens: data.maxTokens,
      percentage: data.percentage,
    });
  }

  refreshRecallConfig(config: RecallConfig): void {
    this.options.recallService?.refreshConfig(config);
  }

  get currentModel(): string | null {
    return this.queryManager.currentModel;
  }

  disableThinkingForNextQuery(): void {
    const modelInfo = this.queryManager.getModelInfo();
    const override = modelInfo?.supportsAdaptiveThinking
      ? { thinking: { type: 'disabled' } }
      : {};
    this.queryManager.setThinkingOverride(override);
    this.streamingManager.silentAbort = true;
    this.queryManager.closeAndReset();
  }

  restoreThinkingConfig(): void {
    this.queryManager.setThinkingOverride(null);
    this.streamingManager.silentAbort = true;
    this.queryManager.closeAndReset();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.queryManager.setPermissionMode(mode);
  }

  get fastMode(): boolean {
    return this.queryManager.fastMode;
  }

  setFastMode(enabled: boolean): void {
    this.queryManager.setFastMode(enabled);
  }

  setModel(model?: string): void {
    this.queryManager.setModel(model);
    if (model) {
      this.currentModelId = model;
      this.contextMonitor.setContextWindowSize(
        getContextWindowForModel(model, this.currentBetas),
      );
      if (this.options.recallService) {
        this.options.recallService.setModel(model);
      }
    }
  }

  setBetas(betas: string[]): void {
    this.currentBetas = betas;
    this.queryManager.setBetas(betas);
    if (this.currentModelId) {
      this.contextMonitor.setContextWindowSize(
        getContextWindowForModel(this.currentModelId, betas),
      );
    }
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

  async reconnectMcpServerLive(serverName: string): Promise<boolean> {
    return this.queryManager.reconnectMcpServerLive(serverName);
  }

  async reloadPlugins(): Promise<{ errorCount: number } | null> {
    return this.queryManager.reloadPlugins();
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

  setBrowserService(service?: import('../browser').BrowserService): void {
    this.queryManager.setBrowserService(service);
  }

  setChromeEnabled(enabled: boolean): void {
    this.queryManager.setChromeEnabled(enabled);
  }

  restartForChromeChange(): void {
    this.streamingManager.silentAbort = true;
    this.queryManager.restartForChromeChange();
  }

  async enableRemoteControl(): Promise<void> {
    const query = this.queryManager.query;
    if (!query) {
      this.options.onMessage({
        type: 'error',
        message: 'No active session — send a message first',
      });
      return;
    }
    await this.remoteControlManager.enable(query);
  }

  async disableRemoteControl(): Promise<void> {
    const query = this.queryManager.query;
    if (!query) {
      this.remoteControlManager.reset();
      return;
    }
    await this.remoteControlManager.disable(query);
  }

  get remoteControlStatus(): RemoteControlStatus {
    return this.remoteControlManager.status;
  }

  getLoopJobs(): LoopJob[] {
    return this.loopJobTracker.getJobs();
  }

  async cancelLoopJob(jobId: string, correlationId?: string): Promise<void> {
    this.loopJobTracker.markCancelling(jobId);
    await this.sendMessage(
      `[System] Stop scheduled job ${jobId}. Call CronDelete with id: "${jobId}".`,
      undefined,
      correlationId
    );
    // SDK in recall mode may bypass PreToolUse/canUseTool hooks entirely for CronDelete.
    // If the job is still tracked after the turn completes, force cleanup.
    if (this.loopJobTracker.isLoopJob(jobId)) {
      log('[ClaudeSession.cancelLoopJob] SDK did not process CronDelete — forcing cleanup: jobId=%s', jobId);
      this.loopJobTracker.trackDeletion(jobId);
    }
  }

  async rewindFiles(userMessageId: string, option: RewindOption = 'code-only', promptContent?: string): Promise<void> {
    const sessionId = this.persistenceSessionId;
    const needsFileRewind = option === 'code-and-conversation' || option === 'code-only';

    if (needsFileRewind && !this.options.recallService?.isEnabled) {
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
