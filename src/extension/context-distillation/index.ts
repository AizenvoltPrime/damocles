import * as crypto from 'crypto';
import { log } from '../logger';
import { ContextStore } from './context-store';
import { HaikuObserver } from './haiku-observer';
import type { HaikuObserverCallbacks } from './haiku-observer';
import { HaikuActivityStore } from './haiku-activity-store';
import { DistillPersistence } from './distill-persistence';
import type { ContextStrategy, DistillationConfig } from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { HaikuPromptActivity } from '../../shared/types/haiku-observer';

export type { ContextStrategy } from './types';

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
  onHaikuStreamEvent?: (message: ExtensionToWebviewMessage) => void;

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
    const content = this.contextStore.getContext()?.content ?? null;
    log('[ContextDistillation.getContextForInjection] sessionId=%s, hasContent=%s, contentLength=%d',
      this._sessionId, content !== null, content?.length ?? 0);
    if (content) {
      log('[ContextDistillation.getContextForInjection] first100=%s', content.slice(0, 100));
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

  onThinkingBlockComplete(messageId: string, model: string, thinking: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onThinkingBlockComplete] messageId=%s, thinkingLen=%d', messageId, thinking.length);
    this.persistence.persistAssistantBlockQueued(messageId, model, [{ type: 'thinking', thinking }]);
  }

  onToolUse(toolName: string, input: Record<string, unknown>): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onToolUse] tool=%s', toolName);
    this.haikuObserver.appendToolUse(toolName, input);
  }

  onToolResult(toolName: string, toolUseId: string, result: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onToolResult] tool=%s, toolUseId=%s, resultLen=%d', toolName, toolUseId, result.length);
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

  reset(): void {
    this.cancelPendingWait();
    this.haikuObserver.abortPending();
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();
    this.contextStore = new ContextStore();
    this.haikuObserver = this.createObserver();
    this.persistence.reset(this._persistenceSessionId);
    this.haikuActivityStore.reset(this._persistenceSessionId);
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
