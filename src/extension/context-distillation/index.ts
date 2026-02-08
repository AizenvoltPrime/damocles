import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import { log } from '../logger';
import { ContextStore } from './context-store';
import { HaikuObserver } from './haiku-observer';
import type { HaikuObserverCallbacks } from './haiku-observer';
import { HaikuActivityStore } from './haiku-activity-store';
import { DistillPersistence } from './distill-persistence';
import type { FlushedAssistantData } from './distill-persistence';
import type { ContextStrategy, DistillationConfig } from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { HaikuPromptActivity } from '../../shared/types/haiku-observer';
import type { ContentBlock } from '../../shared/types/content';
import { initSubagentFile, persistSubagentEntry } from '../session';

export type { ContextStrategy } from './types';

interface SubagentPersistState {
  agentId: string;
  model?: string;
  pendingToolResults: Array<{ toolUseId: string; content: string }>;
  blockPersistedForMessageId: string | null;
  pendingFinalResponse?: string;
  writeQueue: Promise<void>;
  initFailed?: boolean;
}

const DEFAULT_OBSERVER_MODEL = 'claude-haiku-4-5-20251001';

export class ContextDistillationService {
  private contextStore: ContextStore;
  private haikuObserver: HaikuObserver;
  private config: DistillationConfig;
  private _persistenceSessionId: string;
  private _sessionId: string;
  private cwd: string;
  private persistence: DistillPersistence;
  private _lastUserPrompt = '';
  private _haikuWriteGeneration = 0;
  private _lastWriteGeneration = 0;
  private _haikuProcessing = false;
  private _completionResolvers: (() => void)[] = [];
  private _promptIndex = -1;
  private _loadGeneration = 0;
  private haikuActivityStore: HaikuActivityStore;
  private _activeSubagents: Map<string, SubagentPersistState> = new Map();
  onHaikuStreamEvent?: (message: ExtensionToWebviewMessage) => void;
  onSubagentDataReady?: (taskToolUseId: string, agentId: string) => void;

  constructor(cwd: string, strategy: ContextStrategy) {
    this.config = {
      enabled: strategy === 'distill',
      observerModel: DEFAULT_OBSERVER_MODEL,
    };
    this.cwd = cwd;
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();
    this.contextStore = new ContextStore();
    this.haikuActivityStore = new HaikuActivityStore(this._persistenceSessionId);
    this.haikuObserver = this.createObserver();
    this.persistence = new DistillPersistence(cwd, this._persistenceSessionId);
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  get isHaikuProcessing(): boolean {
    return this._haikuProcessing;
  }

  waitForDistillReady(): Promise<void> {
    if (!this._haikuProcessing) return Promise.resolve();
    return new Promise(resolve => this._completionResolvers.push(resolve));
  }

  cancelPendingWait(): void {
    this._haikuProcessing = false;
    this.resolveDistillWaiters();
  }

  get sessionId(): string | null {
    return this.config.enabled ? this._sessionId : null;
  }

  get persistenceSessionId(): string | null {
    return this.config.enabled ? this._persistenceSessionId : null;
  }

  get distillPersistence(): DistillPersistence {
    return this.persistence;
  }

  get planFilePath(): string | null {
    return this.persistence.planFilePath;
  }

  set planFilePath(value: string | null) {
    this.persistence.planFilePath = value;
  }

  setSessionId(id: string): void {
    const gen = ++this._loadGeneration;
    this._persistenceSessionId = id;
    this._sessionId = crypto.randomUUID();
    this._lastUserPrompt = '';
    this.haikuObserver.abortPending();
    this.contextStore = new ContextStore();
    this.haikuObserver = this.createObserver();
    this.persistence.reset(id);
    this.haikuActivityStore.reset(id);
    this._activeSubagents.clear();
    this._promptIndex = -1;
    this.persistence.loadLeafUuid().catch(err => {
      log('[ContextDistillation] Failed to load leaf UUID:', err);
    });
    Promise.all([
      this.haikuActivityStore.loadLatestContextSnapshot(),
      this.haikuActivityStore.getMaxPromptIndex(),
    ]).then(([content, maxIndex]) => {
      if (gen !== this._loadGeneration) return;
      if (content) this.contextStore.loadContent(content);
      if (maxIndex >= 0 && this._promptIndex < maxIndex) {
        this._promptIndex = maxIndex;
        log('[ContextDistillation] Restored promptIndex to %d from existing haiku files', this._promptIndex);
      }
    }).catch(err => {
      log('[ContextDistillation] Failed to restore session state:', err);
    });
  }

  refreshConfig(strategy: ContextStrategy): void {
    this.config = {
      enabled: strategy === 'distill',
      observerModel: DEFAULT_OBSERVER_MODEL,
    };
    this.haikuObserver.abortPending();
  }

  getContextForInjection(): string | null {
    if (!this.config.enabled) return null;
    let content = this.contextStore.getContext()?.content ?? null;
    log('[ContextDistillation.getContextForInjection] sessionId=%s, hasContent=%s, contentLength=%d',
      this._sessionId, content !== null, content?.length ?? 0);
    if (content) {
      log('[ContextDistillation.getContextForInjection] first100=%s', content.slice(0, 100));
    }
    const planPath = this.persistence.planFilePath;
    if (planPath) {
      const planRef = `\n\nThis session has an associated plan file. Read it before starting implementation: ${planPath}`;
      content = content ? content + planRef : planRef.trimStart();
    }
    return content;
  }

  onPromptSubmit(userPrompt: string): void {
    if (!this.config.enabled) return;
    this._lastUserPrompt = userPrompt;
    this._promptIndex++;
    log('[ContextDistillation.onPromptSubmit] sessionId=%s, promptIndex=%d, prompt=%s', this._sessionId, this._promptIndex, userPrompt.slice(0, 80));
    this.haikuObserver.startObservation(userPrompt);
  }

  get lastFlushedLeafUuid(): string | null {
    return this.config.enabled ? this.persistence.lastFlushedLeafUuid : null;
  }

  onAssistantFlushed(uuid: string): void {
    if (!this.config.enabled) return;
    this.persistence.advanceLeafUuid(uuid);
  }

  onInterjection(text: string): void {
    if (!this.config.enabled) return;
    this.haikuObserver.appendInterjection(text);
  }

  onFlushedPromptSubmit(userPrompt: string): void {
    if (!this.config.enabled) return;
    this._lastUserPrompt = userPrompt;
    this._promptIndex++;
    this.haikuObserver = this.createObserver();
    this.haikuObserver.startObservation(userPrompt);
  }

  onThinkingBlockComplete(messageId: string, model: string, thinking: string, parentToolUseId?: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onThinkingBlockComplete] messageId=%s, thinkingLen=%d, parentToolUseId=%s',
      messageId, thinking.length, parentToolUseId ?? 'none');

    if (parentToolUseId) {
      const subState = this._activeSubagents.get(parentToolUseId);
      if (subState) {
        subState.blockPersistedForMessageId = messageId;
        const entry = this.buildAgentAssistantEntry(
          { messageId, model, stopReason: null },
          [{ type: 'thinking' as const, thinking }]
        );
        subState.writeQueue = subState.writeQueue
          .then(() => {
            if (subState.initFailed) return;
            return persistSubagentEntry(this.cwd, this._persistenceSessionId, subState.agentId, entry);
          })
          .catch(err => log('[ContextDistillation] Failed to write subagent thinking:', err));
        return;
      }
    }

    this.persistence.persistAssistantBlockQueued(messageId, model, [{ type: 'thinking', thinking }]);
  }

  onToolUse(toolName: string, input: Record<string, unknown>): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onToolUse] tool=%s', toolName);
    this.haikuObserver.appendToolUse(toolName, input);

    if (toolName === 'Write' && typeof input['file_path'] === 'string') {
      const filePath = path.resolve(input['file_path']);
      const plansDir = path.resolve(os.homedir(), '.claude', 'plans');
      if (filePath.startsWith(plansDir + path.sep) && filePath.endsWith('.md')) {
        this.persistence.persistPlanPath(filePath).catch(err => {
          log('[ContextDistillation] Failed to persist plan path:', err);
        });
      }
    }
  }

  onToolResult(toolName: string, toolUseId: string, result: string, parentToolUseId?: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onToolResult] tool=%s, toolUseId=%s, resultLen=%d, parentToolUseId=%s',
      toolName, toolUseId, result.length, parentToolUseId ?? 'none');

    if (parentToolUseId) {
      const subState = this._activeSubagents.get(parentToolUseId);
      if (subState) {
        subState.pendingToolResults.push({ toolUseId, content: result });
        return;
      }
    }

    if (toolName === 'Task') {
      const subState = this._activeSubagents.get(toolUseId);
      if (subState) {
        subState.pendingFinalResponse = result;
      }
    }

    this.haikuObserver.appendToolResult(toolName, result);
    this.persistence.persistToolResultQueued(toolUseId, result);
  }

  onStreamDelta(delta: string): void {
    if (!this.config.enabled) return;
    this.haikuObserver.appendContent(delta);
  }

  onResponseComplete(): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onResponseComplete] sessionId=%s', this._sessionId);
    this.haikuObserver.finalize();
    this.flushRemainingSubagentResponses();
  }

  private flushRemainingSubagentResponses(): void {
    for (const [toolUseId, subState] of this._activeSubagents.entries()) {
      if (!subState.pendingFinalResponse) continue;

      subState.writeQueue = subState.writeQueue
        .then(async () => {
          if (!subState.pendingFinalResponse) return;
          if (!subState.initFailed) {
            await this.writeSubagentFinalResponse(subState);
          }
          this.onSubagentDataReady?.(toolUseId, subState.agentId);
          this._activeSubagents.delete(toolUseId);
        })
        .catch(err => log('[ContextDistillation] Failed to write fallback subagent response:', err));
    }
  }

  regenerateSessionId(): void {
    const oldSdkId = this._sessionId;
    this._sessionId = crypto.randomUUID();

    log('[ContextDistillation.regenerateSessionId] sdkId %s → %s (persistenceId=%s unchanged, contextLen=%d)',
      oldSdkId.slice(0, 8), this._sessionId.slice(0, 8),
      this._persistenceSessionId.slice(0, 8),
      this.contextStore.getContext()?.content?.length ?? 0);

    this.haikuObserver = this.createObserver();

    if (this._lastUserPrompt) {
      this.haikuObserver.startObservation(this._lastUserPrompt);
    }
  }

  onSubagentStart(toolUseId: string, agentId: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onSubagentStart] toolUseId=%s, agentId=%s', toolUseId, agentId);
    const subState: SubagentPersistState = {
      agentId,
      pendingToolResults: [],
      blockPersistedForMessageId: null,
      writeQueue: Promise.resolve(),
    };
    this._activeSubagents.set(toolUseId, subState);
    subState.writeQueue = initSubagentFile(this.cwd, this._persistenceSessionId, agentId)
      .catch(err => {
        log('[ContextDistillation] Failed to init subagent file:', err);
        subState.initFailed = true;
      });
  }

  onSubagentStop(agentId: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onSubagentStop] agentId=%s', agentId);
  }

  persistAssistantData(data: FlushedAssistantData, parentToolUseId: string | null): void {
    if (!this.config.enabled) return;

    if (parentToolUseId) {
      const subState = this._activeSubagents.get(parentToolUseId);
      if (subState) {
        if (!subState.model) {
          subState.model = data.model;
        }

        const toolResults = subState.pendingToolResults.splice(0);
        const strippedContent = subState.blockPersistedForMessageId === data.messageId
          ? data.content.filter(b => b.type !== 'thinking')
          : data.content;
        subState.blockPersistedForMessageId = null;

        const hasPendingFinal = subState.pendingFinalResponse !== undefined;
        const taskToolUseId = parentToolUseId;

        subState.writeQueue = subState.writeQueue
          .then(async () => {
            if (subState.initFailed) return;
            if (strippedContent.length > 0) {
              await persistSubagentEntry(this.cwd, this._persistenceSessionId, subState.agentId,
                this.buildAgentAssistantEntry({ messageId: data.messageId, model: data.model, stopReason: data.stopReason }, strippedContent));
            }
            for (const tr of toolResults) {
              await persistSubagentEntry(this.cwd, this._persistenceSessionId, subState.agentId,
                this.buildAgentToolResultEntry(tr.toolUseId, tr.content));
            }
            if (subState.pendingFinalResponse) {
              await this.writeSubagentFinalResponse(subState);
            }
          })
          .then(() => {
            if (hasPendingFinal) {
              this.onSubagentDataReady?.(taskToolUseId, subState.agentId);
              this._activeSubagents.delete(taskToolUseId);
            }
          })
          .catch(err => log('[ContextDistillation] Failed to write subagent assistant:', err));
        return;
      }
    }

    this.persistence.persistAssistantQueued(data);
    if (data.uuid) {
      this.onAssistantFlushed(data.uuid);
    }
  }

  private async writeSubagentFinalResponse(subState: SubagentPersistState): Promise<void> {
    const content = this.parseSubagentFinalContent(subState.pendingFinalResponse!);
    delete subState.pendingFinalResponse;
    if (content.length === 0) return;

    const model = subState.model ?? 'unknown';
    const messageId = `msg_final_${subState.agentId}`;
    const entry = this.buildAgentAssistantEntry(
      { messageId, model, stopReason: 'end_turn' },
      content
    );

    await persistSubagentEntry(this.cwd, this._persistenceSessionId, subState.agentId, entry);
  }

  private parseSubagentFinalContent(result: string): ContentBlock[] {
    try {
      const parsed = JSON.parse(result);
      const items = parsed.content as Array<{ type: string; text?: string }> | undefined;
      if (!items || !Array.isArray(items)) return [];
      return items
        .filter(item => item.type === 'text' && item.text)
        .map(item => ({ type: 'text' as const, text: item.text! }));
    } catch {
      log('[ContextDistillation] Failed to parse Task result for final response');
      return [];
    }
  }

  private buildAgentAssistantEntry(
    data: { messageId: string; model: string; stopReason: string | null },
    content: ContentBlock[]
  ): Record<string, unknown> {
    return {
      type: 'assistant',
      sessionId: this._persistenceSessionId,
      cwd: this.cwd,
      message: {
        id: data.messageId,
        model: data.model,
        type: 'message',
        role: 'assistant',
        content: content.map(block => {
          switch (block.type) {
            case 'thinking': return { type: 'thinking', thinking: block.thinking };
            case 'text': return { type: 'text', text: block.text };
            case 'tool_use': return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
            default: return block;
          }
        }),
        stop_reason: data.stopReason ?? 'end_turn',
      },
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private buildAgentToolResultEntry(toolUseId: string, content: string): Record<string, unknown> {
    return {
      type: 'user',
      sessionId: this._persistenceSessionId,
      cwd: this.cwd,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
      },
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  reset(): void {
    this.cancelPendingWait();
    this.haikuObserver.abortPending();
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();
    this.contextStore = new ContextStore();
    this.haikuObserver = this.createObserver();
    this.persistence.reset(this._persistenceSessionId);
    this.haikuActivityStore.reset(this._persistenceSessionId);
    this._activeSubagents.clear();
    this._promptIndex = -1;
    this._lastUserPrompt = '';
  }

  dispose(): void {
    this.cancelPendingWait();
    this.haikuObserver.abortPending();
  }

  private resolveDistillWaiters(): void {
    const resolvers = this._completionResolvers;
    this._completionResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  async getHaikuActivities(): Promise<HaikuPromptActivity[]> {
    return this.haikuActivityStore.loadAllActivities();
  }

  private createObserver(): HaikuObserver {
    const generation = ++this._haikuWriteGeneration;
    const callbacks: HaikuObserverCallbacks = {
      getContext: () => this.contextStore.getContext()?.content ?? null,
      updateContext: (content: string) => {
        if (generation < this._lastWriteGeneration) {
          log('[ContextDistillation] Ignoring stale Haiku result (gen %d < lastWrite %d)', generation, this._lastWriteGeneration);
          return;
        }
        this._lastWriteGeneration = generation;
        this.contextStore.updateContext(content);
      },
      onProcessingChange: (isProcessing: boolean) => {
        if (generation < this._haikuWriteGeneration) return;
        this._haikuProcessing = isProcessing;
        if (!isProcessing) this.resolveDistillWaiters();
      },
      onObservationStart: () => {
        if (generation < this._haikuWriteGeneration) return;
        this.haikuActivityStore.logEvent(this._promptIndex, {
          event: 'observation_start',
          timestamp: Date.now(),
        });
        this.onHaikuStreamEvent?.({ type: 'haikuObservationStart', promptIndex: this._promptIndex });
      },
      onStreamDelta: (deltaType: 'thinking' | 'text', delta: string) => {
        if (generation < this._haikuWriteGeneration) return;
        this.onHaikuStreamEvent?.({ type: 'haikuStreamDelta', promptIndex: this._promptIndex, deltaType, delta });
      },
      onObservationComplete: (thinking: string, text: string) => {
        if (generation < this._haikuWriteGeneration) return;
        this.haikuActivityStore.logEvent(this._promptIndex, {
          event: 'observation_complete',
          thinking,
          text,
          contextSnapshot: text,
          timestamp: Date.now(),
        });
        this.haikuActivityStore.saveContextSnapshot(this._promptIndex, text);
        this.onHaikuStreamEvent?.({
          type: 'haikuObservationComplete',
          promptIndex: this._promptIndex,
          thinking,
          text,
          contextSnapshot: text,
        });
      },
    };
    return new HaikuObserver(callbacks, this.config, this.cwd);
  }

}
