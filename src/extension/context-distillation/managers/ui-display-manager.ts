import * as fs from 'fs/promises';
import * as path from 'path';
import { getSummaryEntriesByPrompt, getEntriesForPrompt } from '../context-database';
import { buildAnnotationDisplayData } from '../utils';
import { CONTEXT_DIR } from '../types';
import type { DatabaseInstance } from '../../memory/types';
import type { AnnotationResult } from '../types';
import type { HaikuPromptActivity, HaikuDisplayBlock } from '../../../shared/types/haiku-observer';

export interface UIDisplayDeps {
  getDb: () => DatabaseInstance | null;
  getPersistenceSessionId: () => string;
}

export class UIDisplayManager {
  private deps: UIDisplayDeps;

  constructor(deps: UIDisplayDeps) {
    this.deps = deps;
  }

  async getHaikuActivities(): Promise<HaikuPromptActivity[]> {
    const db = this.deps.getDb();
    if (!db) return [];

    const sessionId = this.deps.getPersistenceSessionId();
    const summaries = getSummaryEntriesByPrompt(db, sessionId);
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
    return path.join(CONTEXT_DIR, 'haiku', this.deps.getPersistenceSessionId(), `prompt-${promptIndex}`, 'haiku.jsonl');
  }

  getContextSummary(promptIndex: number): string | null {
    const db = this.deps.getDb();
    if (!db) return null;

    const sessionId = this.deps.getPersistenceSessionId();
    const entries = getEntriesForPrompt(db, sessionId, promptIndex);
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
    const db = this.deps.getDb();
    const sessionId = this.deps.getPersistenceSessionId();

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
        if (db) {
          const currentEntries = getEntriesForPrompt(db, sessionId, promptIndex);
          const displayData = buildAnnotationDisplayData(db, result, currentEntries);
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
}
