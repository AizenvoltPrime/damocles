import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { log } from '../logger';
import { ContextStore } from './context-store';
import { HaikuObserver } from './haiku-observer';
import type { HaikuObserverCallbacks } from './haiku-observer';
import { DistillPersistence } from './distill-persistence';
import type { ContextStrategy, DistillationConfig } from './types';

export type { ContextStrategy } from './types';

const DEFAULT_OBSERVER_MODEL = 'claude-haiku-4-5-20251001';

function readConfig(): DistillationConfig {
  const config = vscode.workspace.getConfiguration('damocles');
  const strategy = config.get<ContextStrategy>('contextStrategy', 'default');
  return {
    enabled: strategy === 'distill',
    observerModel: DEFAULT_OBSERVER_MODEL,
  };
}

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
  private _titleGenerated = false;
  private _haikuProcessing = false;
  private _completionResolvers: (() => void)[] = [];
  onTitleGenerated?: (persistenceSessionId: string, title: string) => void;
  onHaikuProcessingChange?: (isProcessing: boolean) => void;

  constructor(cwd: string) {
    this.config = readConfig();
    this.cwd = cwd;
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = this._persistenceSessionId;
    this.contextStore = new ContextStore(this._persistenceSessionId);
    this.haikuObserver = this.createObserver();
    this.persistence = new DistillPersistence(cwd, this._persistenceSessionId);

    if (this.config.enabled) {
      this.contextStore.loadFromDisk().catch(err => {
        log('[ContextDistillation] Failed to load context from disk:', err);
      });
    }
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
    this._persistenceSessionId = id;
    this._sessionId = id;
    this.haikuObserver.abortPending();
    this.contextStore.dispose();
    this.contextStore = new ContextStore(this._persistenceSessionId);
    this.haikuObserver = this.createObserver();
    this.persistence.reset(id);
    this._titleGenerated = false;
    this.persistence.loadLeafUuid().catch(err => {
      log('[ContextDistillation] Failed to load leaf UUID:', err);
    });
    this.contextStore.loadFromDisk().catch(err => {
      log('[ContextDistillation] Failed to load context from disk:', err);
    });
  }

  refreshConfig(): void {
    this.config = readConfig();
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

  getContextForViewing(): { content: string; filePath: string } | null {
    if (!this.config.enabled) return null;
    const doc = this.contextStore.getContext();
    if (!doc?.content) return null;
    return { content: doc.content, filePath: this.contextStore.getContextPath() };
  }

  onPromptSubmit(userPrompt: string): void {
    if (!this.config.enabled) return;
    this._lastUserPrompt = userPrompt;
    log('[ContextDistillation.onPromptSubmit] sessionId=%s, prompt=%s', this._sessionId, userPrompt.slice(0, 80));
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
    this.haikuObserver = this.createObserver();
    this.haikuObserver.startObservation(userPrompt);
  }

  onStreamDelta(delta: string): void {
    if (!this.config.enabled) return;
    this.haikuObserver.appendContent(delta);
  }

  onResponseComplete(): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onResponseComplete] sessionId=%s', this._sessionId);
    this.haikuObserver.finalize().catch(err => {
      log('[ContextDistillation] Finalize failed:', err);
    });
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
    this.contextStore.reset();
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = this._persistenceSessionId;
    this.contextStore = new ContextStore(this._persistenceSessionId);
    this.haikuObserver = this.createObserver();
    this.persistence.reset(this._persistenceSessionId);
    this._lastUserPrompt = '';
    this._titleGenerated = false;
  }

  async dispose(): Promise<void> {
    this.cancelPendingWait();
    this.haikuObserver.abortPending();
    await this.contextStore.flush();
    this.contextStore.dispose();
  }

  private resolveDistillWaiters(): void {
    const resolvers = this._completionResolvers;
    this._completionResolvers = [];
    for (const resolve of resolvers) resolve();
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
        this.maybeGenerateTitle(content);
      },
      onProcessingChange: (isProcessing: boolean) => {
        if (generation < this._haikuWriteGeneration) return;
        this._haikuProcessing = isProcessing;
        if (!isProcessing) this.resolveDistillWaiters();
        this.onHaikuProcessingChange?.(isProcessing);
      },
    };
    return new HaikuObserver(callbacks, this.config, this.cwd);
  }

  private maybeGenerateTitle(content: string): void {
    if (this._titleGenerated || !this.onTitleGenerated) return;
    this._titleGenerated = true;

    const goalMatch = content.match(/##\s*Goal\s*\n+(.+)/);
    if (!goalMatch?.[1]) return;

    const title = goalMatch[1]
      .replace(/[[\]*_~`#]/g, '')
      .trim()
      .slice(0, 60);

    if (title) {
      this.onTitleGenerated(this._persistenceSessionId, title);
    }
  }
}
