import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { log } from '../../logger';
import { getEntriesForPrompt, getRecentAnnotatedEntries, applyAnnotations, setAnnotationStatus, getFailedEntries, upsertSemanticGroup } from '../context-database';
import { STRUCTURED_ANNOTATION_SYSTEM_PROMPT, ANNOTATION_OUTPUT_SCHEMA, buildAnnotationPrompt } from '../prompts';
import { loadSdkQuery, buildAnnotationDisplayData } from '../utils';
import { CONTEXT_DIR, MAX_FAILED_RETRY_ENTRIES } from '../types';
import type { DistillationConfig, AnnotationResult } from '../types';
import type { DatabaseInstance } from '../../memory/types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';


export interface HaikuAnnotationDeps {
  cwd: string;
  getConfig: () => DistillationConfig;
  getDb: () => DatabaseInstance | null;
  getPersistenceSessionId: () => string;
  sendStreamEvent: (message: ExtensionToWebviewMessage) => void;
}

export class HaikuAnnotationManager {
  private cwd: string;
  private deps: HaikuAnnotationDeps;
  private _haikuProcessing = false;
  private _completionResolvers: (() => void)[] = [];
  private currentAbort: AbortController | null = null;

  constructor(deps: HaikuAnnotationDeps) {
    this.deps = deps;
    this.cwd = deps.cwd;
  }

  get isProcessing(): boolean {
    return this._haikuProcessing;
  }

  waitForReady(): Promise<void> {
    if (!this._haikuProcessing) return Promise.resolve();
    return new Promise(resolve => this._completionResolvers.push(resolve));
  }

  cancelPendingWait(): void {
    this._haikuProcessing = false;
    this.currentAbort?.abort();
    this.currentAbort = null;
    this.resolveDistillWaiters();
  }

  fireAnnotation(promptIndex: number, userPrompt: string, assistantText: string): void {
    const db = this.deps.getDb();
    if (!db) return;

    if (this._haikuProcessing) {
      this.currentAbort?.abort();
      this.currentAbort = null;
    }

    this._haikuProcessing = true;
    this.deps.sendStreamEvent({ type: 'haikuObservationStart', promptIndex });

    this.runAnnotation(db, promptIndex, userPrompt, assistantText).catch(err => {
      if (err?.name !== 'AbortError') {
        log('[HaikuAnnotation] Annotation failed: %O', err);
      }
    }).finally(() => {
      this._haikuProcessing = false;
      this.currentAbort = null;
      this.resolveDistillWaiters();
    });
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

  private async runAnnotation(
    db: DatabaseInstance,
    promptIndex: number,
    userPrompt: string,
    assistantText: string,
  ): Promise<void> {
    const query = loadSdkQuery();
    if (!query) return;

    const sessionId = this.deps.getPersistenceSessionId();

    const currentEntries = getEntriesForPrompt(db, sessionId, promptIndex);
    if (currentEntries.length === 0) {
      log('[HaikuAnnotation] No entries for prompt %d, skipping annotation', promptIndex);
      this.deps.sendStreamEvent({
        type: 'haikuObservationComplete',
        promptIndex,
        thinking: '',
        text: '',
        contextSnapshot: '',
      });
      return;
    }

    const currentEntryIds = currentEntries.map(e => e.id);
    setAnnotationStatus(db, currentEntryIds, 'annotating');

    const failedEntries = getFailedEntries(db, sessionId, MAX_FAILED_RETRY_ENTRIES);
    const failedIds = failedEntries.map(e => e.id);
    if (failedIds.length > 0) {
      setAnnotationStatus(db, failedIds, 'annotating');
      log('[HaikuAnnotation] Retrying %d failed entries from prior prompts', failedIds.length);
    }

    const allInflightIds = [...currentEntryIds, ...failedIds];

    const historicalEntries = getRecentAnnotatedEntries(db, sessionId, promptIndex, 30);
    const prompt = buildAnnotationPrompt(
      userPrompt, assistantText, currentEntries, historicalEntries,
      failedEntries.length > 0 ? failedEntries : undefined,
    );

    this.currentAbort = new AbortController();
    const abortController = new AbortController();
    const signal = this.currentAbort.signal;

    const onAbort = () => abortController.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const options = {
        model: this.deps.getConfig().observerModel,
        cwd: this.cwd,
        systemPrompt: STRUCTURED_ANNOTATION_SYSTEM_PROMPT,
        tools: [] as string[],
        persistSession: false,
        abortController,
        includePartialMessages: true,
        outputFormat: { type: 'json_schema' as const, schema: ANNOTATION_OUTPUT_SCHEMA },
      };

      log('[HaikuAnnotation] Firing query: model=%s, entries=%d, retries=%d, historical=%d, promptLen=%d',
        this.deps.getConfig().observerModel, currentEntries.length, failedEntries.length, historicalEntries.length, prompt.length);
      const generator = query({ prompt, options } as Parameters<typeof query>[0]);
      let accumulatedText = '';

      const logSessionId = sessionId;
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

      for await (const event of generator) {
        if (signal.aborted) {
          setAnnotationStatus(db, allInflightIds, 'failed');
          return;
        }

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
            logModel = evt.message?.model ?? this.deps.getConfig().observerModel;
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
              this.deps.sendStreamEvent({ type: 'haikuStreamDelta', promptIndex, deltaType: 'text', delta: evt.delta.text });
            } else if (evt.delta.type === 'thinking_delta' && evt.delta.thinking) {
              const last = logBlocks[logBlocks.length - 1] as Record<string, unknown> | undefined;
              if (last?.['type'] === 'thinking') last['thinking'] = (last['thinking'] as string) + evt.delta.thinking;
              this.deps.sendStreamEvent({ type: 'haikuStreamDelta', promptIndex, deltaType: 'thinking', delta: evt.delta.thinking });
            }
          } else if (evt.type === 'message_delta') {
            logStopReason = evt.delta?.stop_reason ?? null;
          } else if (evt.type === 'message_stop') {
            flushAssistantLog();
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'error_max_structured_output_retries') {
            log('[HaikuAnnotation] Structured output retries exhausted for prompt %d', promptIndex);
          }
          if (msg.structured_output) {
            structuredOutput = msg.structured_output;
          }
        }
      }

      flushAssistantLog();

      if (structuredOutput) {
        const validEntryIds = new Set([...currentEntries.map(e => e.id), ...failedIds]);
        const validAnnotations = structuredOutput.annotations.filter(a => validEntryIds.has(a.entry_id));
        const rejectedCount = structuredOutput.annotations.length - validAnnotations.length;
        if (rejectedCount > 0) {
          log('[HaikuAnnotation] Rejected %d annotations with invalid entry IDs', rejectedCount);
        }
        structuredOutput.annotations = validAnnotations;

        const failedIdSet = new Set(failedIds);
        const annotatedIds = applyAnnotations(db, sessionId, promptIndex, structuredOutput, failedIdSet);

        const annotatedIdSet = new Set(annotatedIds);
        const unannotatedIds = [...validEntryIds].filter(id => !annotatedIdSet.has(id));
        if (unannotatedIds.length > 0) {
          setAnnotationStatus(db, unannotatedIds, 'failed');
        }

        const groupLabels = [...new Set(
          structuredOutput.annotations.map(a => a.semantic_group).filter(Boolean)
        )];
        for (const label of groupLabels) {
          upsertSemanticGroup(db, sessionId, label, promptIndex);
        }

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
        const failedCount = unannotatedIds.length;
        const displayData = buildAnnotationDisplayData(db, structuredOutput, currentEntries, failedEntries);

        log('[HaikuAnnotation] Complete for prompt %d: %d annotated, %d low-relevance, %d failed, %d links, %d groups',
          promptIndex, annotated, lowRelevance, failedCount, structuredOutput.links.length, groups.length);

        this.deps.sendStreamEvent({
          type: 'haikuObservationComplete',
          promptIndex,
          thinking: '',
          text: accumulatedText,
          contextSnapshot: structuredOutput.prompt_summary?.summary ?? accumulatedText,
          annotationResult: {
            annotationCount: annotated,
            lowRelevanceCount: lowRelevance,
            linkCount: structuredOutput.links.length,
            failedCount,
            summary: structuredOutput.prompt_summary?.summary ?? '',
            groups,
            entries: displayData.entries,
            links: displayData.links,
          },
        });
      } else {
        setAnnotationStatus(db, allInflightIds, 'failed');
        log('[HaikuAnnotation] Failed for prompt %d, marked %d entries as failed', promptIndex, allInflightIds.length);
        this.deps.sendStreamEvent({
          type: 'haikuObservationComplete',
          promptIndex,
          thinking: '',
          text: accumulatedText,
          contextSnapshot: accumulatedText,
        });
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
