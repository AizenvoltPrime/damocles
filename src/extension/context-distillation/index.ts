import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { log } from '../logger';
import { openContextDatabase, getMaxPromptIndex, getSummaryEntriesByPrompt, getEntriesForPrompt, getRecentAnnotatedEntries, applyAnnotations, getEntriesByIds } from './context-database';
import { EntryTracker, summarizeToolInput, extractTaskResultTexts } from './entry-tracker';
import { retrieveContextForPrompt, retrieveContextWithReranking } from './context-retriever';
import { STRUCTURED_ANNOTATION_SYSTEM_PROMPT, ANNOTATION_OUTPUT_SCHEMA, buildAnnotationPrompt } from './prompts';
import { DistillPersistence } from './distill-persistence';
import type { FlushedAssistantData } from './distill-persistence';
import { CONTEXT_DIR } from './types';
import type { DistillationConfig, AnnotationResult, ContextEntryRow } from './types';
import type { DatabaseInstance } from '../memory/types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { HaikuPromptActivity, HaikuDisplayBlock, AnnotationEntryDisplay, AnnotationLinkDisplay } from '../../shared/types/haiku-observer';
import type { ContentBlock } from '../../shared/types/content';
import { initSubagentFile, persistSubagentEntry } from '../session';


interface SubagentPersistState {
  agentId: string;
  model?: string;
  pendingToolResults: Array<{ toolUseId: string; content: string }>;
  blockPersistedForMessageId: string | null;
  pendingFinalResponse?: string;
  writeQueue: Promise<void>;
  initFailed?: boolean;
}

type SdkQuery = typeof import('@anthropic-ai/claude-agent-sdk').query;

export { DEFAULT_OBSERVER_MODEL, DEFAULT_TOKEN_BUDGET } from './types';
const HAIKU_TIMEOUT_MS = 120_000;

export class ContextDistillationService {
  private config: DistillationConfig;
  private _persistenceSessionId: string;
  private _sessionId: string;
  private cwd: string;
  private persistence: DistillPersistence;
  private _lastUserPrompt = '';
  private _haikuProcessing = false;
  private _completionResolvers: (() => void)[] = [];
  private _promptIndex = -1;
  private _activeSubagents: Map<string, SubagentPersistState> = new Map();

  private contextDb: DatabaseInstance | null = null;
  private entryTracker: EntryTracker | null = null;
  private assistantTextBuffer = '';
  private currentAbort: AbortController | null = null;
  private sdkQuery: SdkQuery | null = null;

  onHaikuStreamEvent?: (message: ExtensionToWebviewMessage) => void;
  onSubagentDataReady?: (taskToolUseId: string, agentId: string) => void;

  constructor(cwd: string, config: DistillationConfig) {
    this.config = config;
    this.cwd = cwd;
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();
    this.persistence = new DistillPersistence(cwd, this._persistenceSessionId);

    if (this.config.enabled) {
      this.contextDb = openContextDatabase(this._persistenceSessionId);
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
    this.currentAbort?.abort();
    this.currentAbort = null;
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
    this._persistenceSessionId = id;
    this._sessionId = crypto.randomUUID();
    this._lastUserPrompt = '';
    this.cancelPendingWait();
    this._activeSubagents.clear();
    this._promptIndex = -1;
    this.assistantTextBuffer = '';
    this.entryTracker = null;

    this.closeDb();
    this.contextDb = openContextDatabase(id);

    if (this.contextDb) {
      const maxIdx = getMaxPromptIndex(this.contextDb, id);
      if (maxIdx >= 0) {
        this._promptIndex = maxIdx;
        log('[ContextDistillation] Restored promptIndex to %d from DB', this._promptIndex);
      }
    }

    this.persistence.reset(id);
    this.persistence.loadLeafUuid().catch(err => {
      log('[ContextDistillation] Failed to load leaf UUID:', err);
    });
  }

  refreshConfig(config: DistillationConfig): void {
    this.config = config;
    this.cancelPendingWait();
  }

  async getContextForInjection(userPrompt?: string): Promise<string | null> {
    if (!this.config.enabled || !this.contextDb) return null;

    const prompt = userPrompt ?? this._lastUserPrompt;
    let content: string | null;

    if (this.config.reranking.enabled) {
      content = await retrieveContextWithReranking(
        this.contextDb,
        prompt,
        this._promptIndex,
        this.config.tokenBudget,
        this.config.reranking,
        this.config.observerModel,
        this.loadSdkQuery(),
      );
    } else {
      content = retrieveContextForPrompt(
        this.contextDb,
        prompt,
        this._promptIndex,
        this.config.tokenBudget,
      );
    }

    log('[ContextDistillation.getContextForInjection] sessionId=%s, hasContent=%s, contentLength=%d',
      this._sessionId, content !== null, content?.length ?? 0);

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
    this.assistantTextBuffer = '';
    log('[ContextDistillation.onPromptSubmit] sessionId=%s, promptIndex=%d, prompt=%s',
      this._sessionId, this._promptIndex, userPrompt.slice(0, 80));

    if (this.contextDb) {
      this.entryTracker = new EntryTracker(this.contextDb, this._persistenceSessionId, this._promptIndex);
    }
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
    this.assistantTextBuffer += `\n[User interjection]: ${text}\n`;
  }

  onFlushedPromptSubmit(userPrompt: string): void {
    if (!this.config.enabled) return;
    this._lastUserPrompt = userPrompt;
    this._promptIndex++;
    this.assistantTextBuffer = '';

    if (this.contextDb) {
      this.entryTracker = new EntryTracker(this.contextDb, this._persistenceSessionId, this._promptIndex);
    }
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

    this.entryTracker?.onToolUse(toolName, input, toolUseId);
    this.assistantTextBuffer += `\n[${toolName}] ${summarizeToolInput(toolName, input)}\n`;
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

    const preview = result.length > 300 ? result.slice(0, 300) + '...' : result;
    this.assistantTextBuffer += `→ ${preview}\n`;

    if (toolName === 'Task') {
      const subState = this._activeSubagents.get(toolUseId);
      if (subState) {
        subState.pendingFinalResponse = result;
      }
    }

    this.persistence.persistToolResultQueued(toolUseId, result);
  }

  onStreamDelta(delta: string): void {
    if (!this.config.enabled) return;
    this.assistantTextBuffer += delta;
  }

  onResponseComplete(): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onResponseComplete] sessionId=%s', this._sessionId);

    if (this.entryTracker) {
      this.entryTracker.finalize();
      this.fireHaikuAnnotation();
    }

    this.flushRemainingSubagentResponses();
  }

  regenerateSessionId(): void {
    const oldSdkId = this._sessionId;
    this._sessionId = crypto.randomUUID();

    log('[ContextDistillation.regenerateSessionId] sdkId %s → %s (persistenceId=%s unchanged)',
      oldSdkId.slice(0, 8), this._sessionId.slice(0, 8),
      this._persistenceSessionId.slice(0, 8));

    if (this.contextDb && this._lastUserPrompt) {
      this.entryTracker = new EntryTracker(this.contextDb, this._persistenceSessionId, this._promptIndex);
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

  reset(): void {
    this.cancelPendingWait();
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();
    this._activeSubagents.clear();
    this._promptIndex = -1;
    this._lastUserPrompt = '';
    this.assistantTextBuffer = '';
    this.entryTracker = null;

    this.closeDb();
    this.contextDb = openContextDatabase(this._persistenceSessionId);

    this.persistence.reset(this._persistenceSessionId);
  }

  dispose(): void {
    this.cancelPendingWait();
    this.closeDb();
  }

  async getHaikuActivities(): Promise<HaikuPromptActivity[]> {
    if (!this.contextDb) return [];

    const summaries = getSummaryEntriesByPrompt(this.contextDb, this._persistenceSessionId);
    const activities: HaikuPromptActivity[] = [];

    for (const s of summaries) {
      const logPath = this.getHaikuLogPath(s.prompt_index);
      const blocks = await this.parseHaikuLogBlocks(logPath, s.prompt_index);

      activities.push({
        promptIndex: s.prompt_index,
        thinking: '',
        text: s.description ?? '',
        blocks: blocks.length > 0 ? blocks : (s.description ? [{ type: 'text' as const, content: s.description }] : []),
        contextSnapshot: s.description ?? '',
        timestamp: s.created_at,
      });
    }

    return activities;
  }

  getHaikuLogPath(promptIndex: number): string {
    return path.join(CONTEXT_DIR, 'haiku', this._persistenceSessionId, `prompt-${promptIndex}`, 'haiku.jsonl');
  }

  getContextSummary(promptIndex: number): string | null {
    if (!this.contextDb) return null;

    const entries = getEntriesForPrompt(this.contextDb, this._persistenceSessionId, promptIndex);
    const summary = entries.find(e => e.entry_type === 'summary');
    if (!summary?.description) return null;

    const lines: string[] = [
      `# Context Summary — Prompt ${promptIndex}`,
      '',
      summary.description,
    ];
    if (summary.tags) lines.push('', `**Tags:** ${summary.tags}`);

    const contextEntries = entries.filter(e => e.entry_type !== 'summary' && e.description);
    if (contextEntries.length > 0) {
      lines.push('', '---', '', '## Annotated Entries', '');
      for (const entry of contextEntries) {
        lines.push(`- **${entry.file_path ?? entry.entry_type}**: ${entry.description}`);
      }
    }

    return lines.join('\n');
  }

  private resolveDistillWaiters(): void {
    const resolvers = this._completionResolvers;
    this._completionResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private appendToHaikuLog(logDir: string, entry: unknown): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    return fs.appendFile(path.join(logDir, 'haiku.jsonl'), line, 'utf-8');
  }

  private async parseHaikuLogBlocks(logPath: string, promptIndex: number): Promise<HaikuDisplayBlock[]> {
    let raw: string;
    try {
      raw = await fs.readFile(logPath, 'utf-8');
    } catch {
      return [];
    }

    type LogEntry = { type: string; structured_annotation?: AnnotationResult; message?: { content?: Array<Record<string, unknown>> } };
    const logEntries: LogEntry[] = [];

    for (const line of raw.split('\n')) {
      if (!line) continue;
      let entry: LogEntry;
      try { entry = JSON.parse(line); } catch { continue; }
      logEntries.push(entry);
    }

    const blocks: HaikuDisplayBlock[] = [];

    for (const entry of logEntries) {
      if (entry.type === 'structured_annotation' && entry.structured_annotation) {
        const result = entry.structured_annotation;
        const annotated = result.annotations.filter(a => !a.low_relevance).length;
        const lowRelevance = result.annotations.filter(a => a.low_relevance).length;
        const groups = [...new Set(result.annotations.map(a => a.semantic_group).filter(Boolean))];

        const block: HaikuDisplayBlock = {
          type: 'annotation_summary',
          content: result.prompt_summary?.summary ?? '',
          annotationCount: annotated,
          lowRelevanceCount: lowRelevance,
          linkCount: result.links.length,
          summary: result.prompt_summary?.summary ?? '',
          groups,
        };
        if (this.contextDb) {
          const currentEntries = getEntriesForPrompt(this.contextDb, this._persistenceSessionId, promptIndex);
          const displayData = this.buildAnnotationDisplayData(result, currentEntries);
          block.entries = displayData.entries;
          block.links = displayData.links;
        }

        blocks.push(block);
        continue;
      }

      if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;

      for (const block of entry.message!.content!) {
        if (block['type'] === 'thinking' && block['thinking']) {
          blocks.push({ type: 'thinking', content: block['thinking'] as string });
        } else if (block['type'] === 'text' && block['text']) {
          blocks.push({ type: 'text', content: block['text'] as string });
        }
      }
    }

    return blocks;
  }

  private buildAnnotationDisplayData(
    structuredOutput: AnnotationResult,
    currentEntries: ContextEntryRow[],
  ): { entries: AnnotationEntryDisplay[]; links: AnnotationLinkDisplay[] } {
    const entryMap = new Map(currentEntries.map(e => [e.id, e]));

    const entries: AnnotationEntryDisplay[] = structuredOutput.annotations.map(a => {
      const row = entryMap.get(a.entry_id);
      return {
        entryId: a.entry_id,
        filePath: row?.file_path ?? null,
        entryType: row?.entry_type ?? 'unknown',
        description: a.description,
        tags: a.tags ? a.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        confidence: a.confidence,
        semanticGroup: a.semantic_group,
        lowRelevance: a.low_relevance,
      };
    });

    const targetIds = structuredOutput.links
      .map(l => l.target_entry_id)
      .filter(id => !entryMap.has(id));

    const targetEntries = targetIds.length > 0 && this.contextDb
      ? new Map(getEntriesByIds(this.contextDb, targetIds).map(e => [e.id, e]))
      : new Map<number, ContextEntryRow>();

    const links: AnnotationLinkDisplay[] = structuredOutput.links.map(l => {
      const source = entryMap.get(l.source_entry_id);
      const target = entryMap.get(l.target_entry_id) ?? targetEntries.get(l.target_entry_id);
      const desc = target?.description ?? '';
      return {
        linkType: l.link_type,
        sourceEntryId: l.source_entry_id,
        sourceFilePath: source?.file_path ?? null,
        targetEntryId: l.target_entry_id,
        targetFilePath: target?.file_path ?? null,
        targetDescription: desc,
        targetPromptIndex: target?.prompt_index ?? -1,
      };
    });

    return { entries, links };
  }

  private closeDb(): void {
    if (this.contextDb) {
      try { this.contextDb.close(); } catch { /* ignore */ }
      this.contextDb = null;
    }
  }

  private fireHaikuAnnotation(): void {
    if (!this.contextDb) return;

    const promptIndex = this._promptIndex;
    const userPrompt = this._lastUserPrompt;
    const assistantText = this.assistantTextBuffer;

    this._haikuProcessing = true;
    this.onHaikuStreamEvent?.({ type: 'haikuObservationStart', promptIndex });

    this.runHaikuAnnotation(promptIndex, userPrompt, assistantText).catch(err => {
      if (err?.name !== 'AbortError') {
        log('[ContextDistillation] Haiku annotation failed: %O', err);
      }
    }).finally(() => {
      this._haikuProcessing = false;
      this.currentAbort = null;
      this.resolveDistillWaiters();
    });
  }

  private async runHaikuAnnotation(
    promptIndex: number,
    userPrompt: string,
    assistantText: string,
  ): Promise<void> {
    const db = this.contextDb;
    if (!db) return;

    const query = this.loadSdkQuery();
    if (!query) return;

    const currentEntries = getEntriesForPrompt(db, this._persistenceSessionId, promptIndex);
    if (currentEntries.length === 0) {
      log('[ContextDistillation] No entries for prompt %d, skipping annotation', promptIndex);
      this.onHaikuStreamEvent?.({
        type: 'haikuObservationComplete',
        promptIndex,
        thinking: '',
        text: '',
        contextSnapshot: '',
      });
      return;
    }

    const historicalEntries = getRecentAnnotatedEntries(db, this._persistenceSessionId, promptIndex, 30);
    const prompt = buildAnnotationPrompt(userPrompt, assistantText, currentEntries, historicalEntries);

    this.currentAbort = new AbortController();
    const abortController = new AbortController();
    const signal = this.currentAbort.signal;

    const onAbort = () => abortController.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      log('[ContextDistillation] Haiku annotation timed out after %dms', HAIKU_TIMEOUT_MS);
      abortController.abort();
    }, HAIKU_TIMEOUT_MS);

    try {
      const options = {
        model: this.config.observerModel,
        cwd: this.cwd,
        systemPrompt: STRUCTURED_ANNOTATION_SYSTEM_PROMPT,
        tools: [] as string[],
        persistSession: false,
        abortController,
        includePartialMessages: true,
        outputFormat: { type: 'json_schema' as const, schema: ANNOTATION_OUTPUT_SCHEMA },
      };

      log('[ContextDistillation] Firing annotation query: model=%s, entries=%d, historical=%d, promptLen=%d',
        this.config.observerModel, currentEntries.length, historicalEntries.length, prompt.length);
      const generator = query({ prompt, options } as Parameters<typeof query>[0]);
      let accumulatedText = '';

      const logSessionId = this._persistenceSessionId;
      const logDir = path.join(CONTEXT_DIR, 'haiku', logSessionId, `prompt-${promptIndex}`);
      const dirReady = fs.mkdir(logDir, { recursive: true }).catch(() => {});

      let logBlocks: unknown[] = [];
      let logMsgId = '';
      let logModel = '';
      let logStopReason: string | null = null;

      const flushAssistantLog = (): void => {
        if (logBlocks.length === 0) return;
        const entry = {
          type: 'assistant',
          sessionId: logSessionId,
          cwd: this.cwd,
          message: {
            id: logMsgId,
            model: logModel,
            type: 'message',
            role: 'assistant',
            content: logBlocks,
            stop_reason: logStopReason ?? 'end_turn',
          },
          uuid: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        };
        dirReady.then(() => this.appendToHaikuLog(logDir, entry)).catch(() => {});
        logBlocks = [];
        logStopReason = null;
      };

      let structuredOutput: AnnotationResult | null = null;
      let isRetryError = false;

      for await (const event of generator) {
        if (signal.aborted) return;

        const msg = event as {
          type: string;
          subtype?: string;
          structured_output?: AnnotationResult;
          event?: {
            type: string;
            message?: { id?: string; model?: string };
            content_block?: { type: string };
            delta?: { type: string; text?: string; thinking?: string; stop_reason?: string };
          };
        };

        if (msg.type === 'stream_event' && msg.event) {
          const evt = msg.event;

          if (evt.type === 'message_start') {
            logMsgId = evt.message?.id ?? `msg_haiku_${promptIndex}`;
            logModel = evt.message?.model ?? this.config.observerModel;
          } else if (evt.type === 'content_block_start') {
            if (evt.content_block?.type === 'text') {
              logBlocks.push({ type: 'text', text: '' });
            } else if (evt.content_block?.type === 'thinking') {
              logBlocks.push({ type: 'thinking', thinking: '' });
            }
          } else if (evt.type === 'content_block_delta' && evt.delta) {
            if (evt.delta.type === 'text_delta' && evt.delta.text) {
              accumulatedText += evt.delta.text;
              const last = logBlocks[logBlocks.length - 1] as Record<string, unknown> | undefined;
              if (last?.['type'] === 'text') last['text'] = (last['text'] as string) + evt.delta.text;
              this.onHaikuStreamEvent?.({ type: 'haikuStreamDelta', promptIndex, deltaType: 'text', delta: evt.delta.text });
            } else if (evt.delta.type === 'thinking_delta' && evt.delta.thinking) {
              const last = logBlocks[logBlocks.length - 1] as Record<string, unknown> | undefined;
              if (last?.['type'] === 'thinking') last['thinking'] = (last['thinking'] as string) + evt.delta.thinking;
              this.onHaikuStreamEvent?.({ type: 'haikuStreamDelta', promptIndex, deltaType: 'thinking', delta: evt.delta.thinking });
            }
          } else if (evt.type === 'message_delta') {
            logStopReason = evt.delta?.stop_reason ?? null;
          } else if (evt.type === 'message_stop') {
            flushAssistantLog();
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'error_max_structured_output_retries') {
            log('[ContextDistillation] Structured output retries exhausted for prompt %d', promptIndex);
            isRetryError = true;
          } else if (msg.structured_output) {
            structuredOutput = msg.structured_output;
          }
        }
      }

      flushAssistantLog();

      if (structuredOutput && !isRetryError) {
        const validEntryIds = new Set(currentEntries.map(e => e.id));
        const validAnnotations = structuredOutput.annotations.filter(a => validEntryIds.has(a.entry_id));
        const rejectedCount = structuredOutput.annotations.length - validAnnotations.length;
        if (rejectedCount > 0) {
          log('[ContextDistillation] Rejected %d annotations with invalid entry IDs', rejectedCount);
        }
        structuredOutput.annotations = validAnnotations;

        applyAnnotations(db, this._persistenceSessionId, promptIndex, structuredOutput);

        const auditEntry = {
          type: 'structured_annotation',
          sessionId: logSessionId,
          promptIndex,
          structured_annotation: structuredOutput,
          timestamp: new Date().toISOString(),
        };
        dirReady.then(() => this.appendToHaikuLog(logDir, auditEntry)).catch(() => {});

        const annotated = structuredOutput.annotations.filter(a => !a.low_relevance).length;
        const lowRelevance = structuredOutput.annotations.filter(a => a.low_relevance).length;
        const groups = [...new Set(structuredOutput.annotations.map(a => a.semantic_group).filter(Boolean))];
        const displayData = this.buildAnnotationDisplayData(structuredOutput, currentEntries);

        log('[ContextDistillation] Annotation complete for prompt %d: %d annotated, %d low-relevance, %d links, %d groups',
          promptIndex, annotated, lowRelevance, structuredOutput.links.length, groups.length);

        this.onHaikuStreamEvent?.({
          type: 'haikuObservationComplete',
          promptIndex,
          thinking: '',
          text: accumulatedText,
          contextSnapshot: structuredOutput.prompt_summary?.summary ?? accumulatedText,
          annotationResult: {
            annotationCount: annotated,
            lowRelevanceCount: lowRelevance,
            linkCount: structuredOutput.links.length,
            summary: structuredOutput.prompt_summary?.summary ?? '',
            groups,
            entries: displayData.entries,
            links: displayData.links,
          },
        });
      } else {
        log('[ContextDistillation] Annotation skipped for prompt %d (retryError=%s)', promptIndex, isRetryError);
        this.onHaikuStreamEvent?.({
          type: 'haikuObservationComplete',
          promptIndex,
          thinking: '',
          text: accumulatedText,
          contextSnapshot: accumulatedText,
        });
      }
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private loadSdkQuery(): SdkQuery | null {
    if (this.sdkQuery) return this.sdkQuery;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk');
      this.sdkQuery = sdk.query;
      return this.sdkQuery;
    } catch (err) {
      log('[ContextDistillation] Failed to load SDK module: %O', err);
      return null;
    }
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
    const texts = extractTaskResultTexts(result);
    if (!texts) return [];
    return texts.map(text => ({ type: 'text' as const, text }));
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
}
