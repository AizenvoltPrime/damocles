import * as crypto from 'crypto';
import { log } from '../logger';
import { getEntriesByIds } from './context-database';
import { extractTaskResultTexts } from './entry-tracker';
import type { DatabaseInstance } from '../memory/types';
import type { AnnotationResult, ContextEntryRow, SdkQuery } from './types';
import type { ContentBlock } from '../../shared/types/content';
import type { AnnotationEntryDisplay, AnnotationLinkDisplay } from '../../shared/types/haiku-observer';

let cachedSdkQuery: SdkQuery | null = null;

export function loadSdkQuery(): SdkQuery | null {
  if (cachedSdkQuery) return cachedSdkQuery;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk');
    cachedSdkQuery = sdk.query;
    return cachedSdkQuery;
  } catch (err) {
    log('[ContextDistillation] Failed to load SDK module: %O', err);
    return null;
  }
}

export function parseSubagentFinalContent(result: string): ContentBlock[] {
  const texts = extractTaskResultTexts(result);
  if (!texts) return [];
  return texts.map(text => ({ type: 'text' as const, text }));
}

export function buildAgentAssistantEntry(
  data: { messageId: string; model: string; stopReason: string | null },
  content: ContentBlock[],
  sessionId: string,
  cwd: string,
): Record<string, unknown> {
  return {
    type: 'assistant',
    sessionId,
    cwd,
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

export function buildAgentToolResultEntry(
  toolUseId: string,
  content: string,
  sessionId: string,
  cwd: string,
): Record<string, unknown> {
  return {
    type: 'user',
    sessionId,
    cwd,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

export function buildAnnotationDisplayData(
  db: DatabaseInstance,
  structuredOutput: AnnotationResult,
  currentEntries: ContextEntryRow[],
  failedRetryEntries?: ContextEntryRow[],
): { entries: AnnotationEntryDisplay[]; links: AnnotationLinkDisplay[] } {
  const entryMap = new Map(currentEntries.map(e => [e.id, e]));
  if (failedRetryEntries) {
    for (const e of failedRetryEntries) entryMap.set(e.id, e);
  }

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

  const targetEntries = targetIds.length > 0
    ? new Map(getEntriesByIds(db, targetIds).map(e => [e.id, e]))
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
