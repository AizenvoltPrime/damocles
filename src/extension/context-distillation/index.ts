import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import { log } from '../logger';
import { openContextDatabase, getMaxPromptIndex, recoverStaleEntries, insertContextInjection, getContextInjection, getAnnotatedEntryCount } from './context-database';
import { retrieveContext, decomposeQueryWithHaiku } from './context-retriever';
import { loadSdkQuery } from './utils';
import { DistillPersistence } from './distill-persistence';
import type { FlushedAssistantData } from './distill-persistence';
import { HaikuAnnotationManager } from './managers/haiku-annotation-manager';
import { SubagentManager } from './managers/subagent-manager';
import { EntryCoordinator } from './managers/entry-coordinator';
import { UIDisplayManager } from './managers/ui-display-manager';
import { RERANKING_MIN_ENTRIES } from './types';
import type { DistillationConfig, ContextInjectionRecord } from './types';
import type { DatabaseInstance } from '../memory/types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { HaikuPromptActivity } from '../../shared/types/haiku-observer';

export { DEFAULT_OBSERVER_MODEL, DEFAULT_TOKEN_BUDGET } from './types';

export class ContextDistillationService {
  private config: DistillationConfig;
  private _persistenceSessionId: string;
  private _sessionId: string;
  private persistence: DistillPersistence;
  private contextDb: DatabaseInstance | null = null;

  private haikuAnnotation: HaikuAnnotationManager;
  private subagentManager: SubagentManager;
  private entryCoordinator: EntryCoordinator;
  private uiDisplay: UIDisplayManager;
  private injectionFallbackCache = new Map<number, ContextInjectionRecord & { createdAt: number }>();

  onHaikuStreamEvent?: (message: ExtensionToWebviewMessage) => void;
  onSubagentDataReady?: (taskToolUseId: string, agentId: string) => void;

  constructor(cwd: string, config: DistillationConfig) {
    this.config = config;
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();
    this.persistence = new DistillPersistence(cwd, this._persistenceSessionId);

    if (this.config.enabled) {
      this.contextDb = openContextDatabase(this._persistenceSessionId);
    }

    this.haikuAnnotation = new HaikuAnnotationManager({
      cwd,
      getConfig: () => this.config,
      getDb: () => this.contextDb,
      getPersistenceSessionId: () => this._persistenceSessionId,
      sendStreamEvent: (msg) => this.onHaikuStreamEvent?.(msg),
    });

    this.entryCoordinator = new EntryCoordinator({
      getDb: () => this.contextDb,
      getPersistenceSessionId: () => this._persistenceSessionId,
    });

    this.subagentManager = new SubagentManager({
      cwd,
      getPersistenceSessionId: () => this._persistenceSessionId,
      onSubagentDataReady: (id, agentId) => this.onSubagentDataReady?.(id, agentId),
    });

    this.uiDisplay = new UIDisplayManager({
      getDb: () => this.contextDb,
      getPersistenceSessionId: () => this._persistenceSessionId,
    });
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  get isHaikuProcessing(): boolean {
    return this.haikuAnnotation.isProcessing;
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

  get lastFlushedLeafUuid(): string | null {
    return this.config.enabled ? this.persistence.lastFlushedLeafUuid : null;
  }

  waitForDistillReady(): Promise<void> {
    return this.haikuAnnotation.waitForReady();
  }

  cancelPendingWait(): void {
    this.haikuAnnotation.cancelPendingWait();
  }

  refreshConfig(config: DistillationConfig): void {
    this.config = config;
    this.cancelPendingWait();
  }

  setSessionId(id: string): void {
    this._persistenceSessionId = id;
    this._sessionId = crypto.randomUUID();
    this.cancelPendingWait();

    this.entryCoordinator.reset();
    this.subagentManager.reset();
    this.injectionFallbackCache.clear();

    this.closeDb();
    this.contextDb = openContextDatabase(id);

    if (this.contextDb) {
      const maxIdx = getMaxPromptIndex(this.contextDb, id);
      if (maxIdx >= 0) {
        this.entryCoordinator.promptIndex = maxIdx;
        log('[ContextDistillation] Restored promptIndex to %d from DB', maxIdx);
      }

      const recovered = recoverStaleEntries(this.contextDb, id);
      if (recovered > 0) {
        log('[ContextDistillation] Recovered %d stale entries to failed status', recovered);
      }
    }

    this.persistence.reset(id);
    this.persistence.loadLeafUuid().catch(err => {
      log('[ContextDistillation] Failed to load leaf UUID:', err);
    });
  }

  async getContextForInjection(userPrompt?: string): Promise<string | null> {
    if (!this.config.enabled || !this.contextDb) return null;

    const prompt = userPrompt ?? this.entryCoordinator.lastUserPrompt;
    const sdkQuery = loadSdkQuery();

    let facets: string[] | null = null;
    if (this.config.queryDecomposition.enabled) {
      facets = await decomposeQueryWithHaiku(
        prompt,
        this.config.observerModel,
        sdkQuery,
        this.config.queryDecomposition.timeoutMs,
      );
    }

    const baseOptions = facets ? { facets } : {};

    const bm25Content = await retrieveContext(
      this.contextDb,
      prompt,
      this.entryCoordinator.promptIndex,
      this.config.tokenBudget,
      baseOptions,
    );

    let rerankedContent: string | null = null;
    if (this.config.reranking.enabled) {
      if (!sdkQuery) {
        log('[ContextDistillation] Skipping reranking: SDK query unavailable');
      } else {
        const entryCount = getAnnotatedEntryCount(this.contextDb, this._persistenceSessionId, this.entryCoordinator.promptIndex);
        if (entryCount >= RERANKING_MIN_ENTRIES) {
          rerankedContent = await retrieveContext(
            this.contextDb,
            prompt,
            this.entryCoordinator.promptIndex,
            this.config.tokenBudget,
            {
              ...baseOptions,
              reranking: {
                model: this.config.observerModel,
                sdkQuery,
                timeoutMs: this.config.reranking.timeoutMs,
              },
            },
          );
        } else {
          log('[ContextDistillation] Skipping reranking: %d annotated entries < threshold %d', entryCount, RERANKING_MIN_ENTRIES);
        }
      }
    }

    let content = rerankedContent ?? bm25Content;

    log('[ContextDistillation.getContextForInjection] sessionId=%s, hasContent=%s, contentLength=%d',
      this._sessionId, content !== null, content?.length ?? 0);

    const planPath = this.persistence.planFilePath;
    if (planPath) {
      const planRef = `\n\nThis session has an associated plan file. Read it before starting implementation: ${planPath}`;
      content = content ? content + planRef : planRef.trimStart();
    }

    if (content) {
      const entryCount = (content.match(/\[Prompt /g) ?? []).length;
      const record: ContextInjectionRecord = {
        bm25Context: bm25Content,
        rerankedContext: rerankedContent,
        injectedContext: content,
        entryCount,
        rerankingEnabled: this.config.reranking.enabled,
        tokenBudget: this.config.tokenBudget,
        planFilePath: planPath ?? null,
        decompositionFacets: facets,
      };

      try {
        insertContextInjection(this.contextDb, this._persistenceSessionId, this.entryCoordinator.promptIndex, record);
        this.injectionFallbackCache.delete(this.entryCoordinator.promptIndex);
      } catch (err) {
        log('[ContextDistillation] Failed to persist context injection: %O', err);
        this.injectionFallbackCache.set(this.entryCoordinator.promptIndex, { ...record, createdAt: Date.now() });
      }
    }

    return content;
  }

  getContextInjectionForPrompt(promptIndex: number): (ContextInjectionRecord & { createdAt: number }) | undefined {
    if (!this.contextDb) return this.injectionFallbackCache.get(promptIndex);
    return getContextInjection(this.contextDb, this._persistenceSessionId, promptIndex)
      ?? this.injectionFallbackCache.get(promptIndex);
  }

  onPromptSubmit(userPrompt: string): void {
    if (!this.config.enabled) return;
    this.entryCoordinator.onPromptSubmit(userPrompt);
    log('[ContextDistillation.onPromptSubmit] sessionId=%s, promptIndex=%d',
      this._sessionId, this.entryCoordinator.promptIndex);
  }

  onFlushedPromptSubmit(userPrompt: string): void {
    if (!this.config.enabled) return;
    this.entryCoordinator.onFlushedPromptSubmit(userPrompt);
  }

  onAssistantFlushed(uuid: string): void {
    if (!this.config.enabled) return;
    this.persistence.advanceLeafUuid(uuid);
  }

  onInterjection(text: string): void {
    if (!this.config.enabled) return;
    this.entryCoordinator.onInterjection(text);
  }

  onThinkingBlockComplete(messageId: string, model: string, thinking: string, parentToolUseId?: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onThinkingBlockComplete] messageId=%s, thinkingLen=%d, parentToolUseId=%s',
      messageId, thinking.length, parentToolUseId ?? 'none');

    if (this.subagentManager.onThinkingBlockComplete(messageId, model, thinking, parentToolUseId)) return;

    this.persistence.persistAssistantBlockQueued(messageId, model, [{ type: 'thinking', thinking }]);
  }

  onToolUse(toolName: string, input: Record<string, unknown>, toolUseId?: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onToolUse] tool=%s, id=%s', toolName, toolUseId ?? 'none');

    if (toolName === 'Write' && typeof input['file_path'] === 'string') {
      const filePath = path.resolve(input['file_path']);
      const plansDir = path.resolve(os.homedir(), '.claude', 'plans');
      if (filePath.startsWith(plansDir + path.sep) && filePath.endsWith('.md')) {
        this.persistence.persistPlanPath(filePath).catch(err => {
          log('[ContextDistillation] Failed to persist plan path:', err);
        });
        return;
      }
    }

    this.entryCoordinator.onToolUse(toolName, input, toolUseId);
  }

  onToolResult(toolName: string, toolUseId: string, result: string, parentToolUseId?: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onToolResult] tool=%s, toolUseId=%s, resultLen=%d, parentToolUseId=%s',
      toolName, toolUseId, result.length, parentToolUseId ?? 'none');

    if (this.subagentManager.onToolResult(toolName, toolUseId, result, parentToolUseId)) return;

    const preview = result.length > 300 ? result.slice(0, 300) + '...' : result;
    this.entryCoordinator.appendToBuffer(`→ ${preview}\n`);

    this.persistence.persistToolResultQueued(toolUseId, result);
  }

  onStreamDelta(delta: string): void {
    if (!this.config.enabled) return;
    this.entryCoordinator.appendToBuffer(delta);
  }

  onResponseComplete(): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onResponseComplete] sessionId=%s', this._sessionId);

    const snapshot = this.entryCoordinator.finalize();
    if (snapshot) {
      this.haikuAnnotation.fireAnnotation(snapshot.promptIndex, snapshot.userPrompt, snapshot.assistantText);
    }

    this.subagentManager.flushRemainingResponses();
  }

  persistAssistantData(data: FlushedAssistantData, parentToolUseId: string | null): void {
    if (!this.config.enabled) return;

    if (this.subagentManager.persistAssistantData(data, parentToolUseId)) return;

    this.persistence.persistAssistantQueued(data);
    if (data.uuid) {
      this.onAssistantFlushed(data.uuid);
    }
  }

  regenerateSessionId(): void {
    const oldSdkId = this._sessionId;
    this._sessionId = crypto.randomUUID();

    log('[ContextDistillation.regenerateSessionId] sdkId %s → %s (persistenceId=%s unchanged)',
      oldSdkId.slice(0, 8), this._sessionId.slice(0, 8),
      this._persistenceSessionId.slice(0, 8));

    this.entryCoordinator.regenerateTracker();
  }

  onSubagentStart(toolUseId: string, agentId: string): void {
    if (!this.config.enabled) return;
    this.subagentManager.onSubagentStart(toolUseId, agentId);
  }

  onSubagentStop(agentId: string): void {
    if (!this.config.enabled) return;
    this.subagentManager.onSubagentStop(agentId);
  }

  reset(): void {
    this.cancelPendingWait();
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();

    this.entryCoordinator.reset();
    this.subagentManager.reset();
    this.injectionFallbackCache.clear();

    this.closeDb();
    this.contextDb = openContextDatabase(this._persistenceSessionId);

    this.persistence.reset(this._persistenceSessionId);
  }

  dispose(): void {
    this.cancelPendingWait();
    this.closeDb();
  }

  async getHaikuActivities(): Promise<HaikuPromptActivity[]> {
    return this.uiDisplay.getHaikuActivities();
  }

  getHaikuLogPath(promptIndex: number): string {
    return this.uiDisplay.getHaikuLogPath(promptIndex);
  }

  getContextSummary(promptIndex: number): string | null {
    return this.uiDisplay.getContextSummary(promptIndex);
  }

  private closeDb(): void {
    if (this.contextDb) {
      try { this.contextDb.close(); } catch { /* ignore */ }
      this.contextDb = null;
    }
  }
}
