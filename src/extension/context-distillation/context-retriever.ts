import { log } from '../logger';
import type { DatabaseInstance } from '../memory/types';
import { getLinkedEntries, getGroupEntries } from './context-database';
import { RERANKING_SCHEMA } from './prompts';
import { DEFAULT_TOKEN_BUDGET } from './types';
import type { ContextEntryRow, RerankingConfig } from './types';

type SdkQuery = typeof import('@anthropic-ai/claude-agent-sdk').query;

const CHARS_PER_TOKEN = 4;
const GROUP_EXPANSION_LIMIT = 3;

const STOPWORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but',
  'his', 'by', 'from', 'they', 'we', 'her', 'she', 'or', 'an', 'will',
  'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so', 'up',
  'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make',
  'can', 'like', 'no', 'just', 'him', 'know', 'take', 'into', 'your',
  'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now', 'its',
  'also', 'after', 'how', 'our', 'two', 'way', 'did', 'has', 'am', 'is',
  'are', 'was', 'were', 'been', 'being', 'had', 'does', 'done', 'should',
  'help', 'please', 'want', 'need',
]);

function buildFtsQuery(prompt: string): string | null {
  const tokens = prompt.trim().toLowerCase().split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .map(t => t.replace(/[*^]/g, ''))
    .filter(t => t.length > 0)
    .slice(0, 16);
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

function formatEntry(entry: ContextEntryRow): string {
  if (entry.entry_type === 'summary') {
    return `[Prompt ${entry.prompt_index} summary]: ${entry.description ?? '(no summary)'}`;
  }
  const filePart = entry.file_path ? entry.file_path : entry.entry_type;
  const groupPart = entry.semantic_group ? ` (${entry.semantic_group})` : '';
  const desc = entry.description ?? summarizeFromToolCalls(entry);
  return `[Prompt ${entry.prompt_index}]: ${filePart}${groupPart} — ${desc}`;
}

function summarizeFromToolCalls(entry: ContextEntryRow): string {
  try {
    const calls = JSON.parse(entry.tool_calls as string) as Array<{ tool_name: string; input_summary: string }>;
    if (calls.length === 0) return '(no description)';
    return calls.map(c => `${c.tool_name}: ${c.input_summary}`).join('; ').slice(0, 150);
  } catch {
    return '(no description)';
  }
}

function getContinuitySection(
  db: DatabaseInstance,
  currentPromptIndex: number,
): { entry: ContextEntryRow | undefined; formatted: string | null } {
  const prevSummary = db.prepare(
    `SELECT * FROM context_entries
     WHERE prompt_index = ? AND entry_type = 'summary'
     LIMIT 1`
  ).get(currentPromptIndex - 1) as ContextEntryRow | undefined;

  if (!prevSummary) return { entry: undefined, formatted: null };
  return { entry: prevSummary, formatted: formatEntry(prevSummary) };
}

function runFtsRetrieval(
  db: DatabaseInstance,
  userPrompt: string,
  currentPromptIndex: number,
  limit: number,
): (ContextEntryRow & { rank: number })[] {
  const ftsQuery = buildFtsQuery(userPrompt);
  if (!ftsQuery) return [];

  try {
    return db.prepare(
      `SELECT ce.*, fts.rank FROM context_entries_fts fts
       JOIN context_entries ce ON ce.id = fts.rowid
       WHERE context_entries_fts MATCH ?
       AND ce.low_relevance = 0
       AND ce.annotation_status = 'annotated'
       AND ce.prompt_index < ?
       ORDER BY fts.rank
       LIMIT ?`
    ).all(ftsQuery, currentPromptIndex, limit) as (ContextEntryRow & { rank: number })[];
  } catch (err) {
    log('[ContextRetriever] FTS query failed: %O', err);
    return [];
  }
}

function buildOutputSections(
  continuity: string[],
  relevant: string[],
): string | null {
  if (continuity.length === 0 && relevant.length === 0) return null;

  const parts: string[] = [];
  if (continuity.length > 0) {
    parts.push(`<last_activity>\n${continuity.join('\n')}\n</last_activity>`);
  }
  if (relevant.length > 0) {
    parts.push(`<relevant_context>\n${relevant.join('\n')}\n</relevant_context>`);
  }
  return parts.join('\n\n');
}

function expandSemanticGroups(
  db: DatabaseInstance,
  selectedEntries: ContextEntryRow[],
  includedIds: Set<number>,
  output: string[],
  charBudget: number,
  usedChars: number,
): number {
  const groups = [...new Set(
    selectedEntries
      .map(e => e.semantic_group)
      .filter((g): g is string => g !== null && g !== undefined)
  )];
  if (groups.length === 0) return usedChars;

  const sessionId = selectedEntries[0]?.session_id;
  if (!sessionId) return usedChars;

  for (const groupLabel of groups) {
    const groupEntries = getGroupEntries(db, sessionId, groupLabel, includedIds, GROUP_EXPANSION_LIMIT);
    for (const entry of groupEntries) {
      if (includedIds.has(entry.id)) continue;

      const formatted = formatEntry(entry);
      if (usedChars + formatted.length > charBudget) return usedChars;

      output.push(formatted);
      usedChars += formatted.length;
      includedIds.add(entry.id);
    }
  }
  return usedChars;
}

export function retrieveContextForPrompt(
  db: DatabaseInstance,
  userPrompt: string,
  currentPromptIndex: number,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): string | null {
  if (currentPromptIndex <= 0) return null;

  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  const includedIds = new Set<number>();
  const sections: { continuity: string[]; relevant: string[] } = { continuity: [], relevant: [] };
  let usedChars = 0;

  const { entry: prevSummary, formatted: summaryFormatted } = getContinuitySection(db, currentPromptIndex);
  if (prevSummary && summaryFormatted) {
    sections.continuity.push(summaryFormatted);
    usedChars += summaryFormatted.length;
    includedIds.add(prevSummary.id);
  }

  const ftsResults = runFtsRetrieval(db, userPrompt, currentPromptIndex, 50);

  for (const entry of ftsResults) {
    if (includedIds.has(entry.id)) continue;

    const formatted = formatEntry(entry);
    if (usedChars + formatted.length > charBudget) break;

    sections.relevant.push(formatted);
    usedChars += formatted.length;
    includedIds.add(entry.id);

    usedChars = expandRelatedFiles(db, entry, includedIds, sections.relevant, charBudget, usedChars);
  }

  const selectedEntries = ftsResults.filter(e => includedIds.has(e.id));
  usedChars = expandSemanticGroups(db, selectedEntries, includedIds, sections.relevant, charBudget, usedChars);

  const result = buildOutputSections(sections.continuity, sections.relevant);
  if (result) {
    log('[ContextRetriever] Built context: %d entries, %d chars, budget=%d',
      includedIds.size, result.length, charBudget);
  }
  return result;
}

export async function retrieveContextWithReranking(
  db: DatabaseInstance,
  userPrompt: string,
  currentPromptIndex: number,
  tokenBudget: number,
  rerankingConfig: RerankingConfig,
  observerModel: string,
  sdkQuery: SdkQuery | null,
): Promise<string | null> {
  if (currentPromptIndex <= 0) return null;

  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  const includedIds = new Set<number>();
  const sections: { continuity: string[]; relevant: string[] } = { continuity: [], relevant: [] };
  let usedChars = 0;

  const { entry: prevSummary, formatted: summaryFormatted } = getContinuitySection(db, currentPromptIndex);
  if (prevSummary && summaryFormatted) {
    sections.continuity.push(summaryFormatted);
    usedChars += summaryFormatted.length;
    includedIds.add(prevSummary.id);
  }

  const ftsResults = runFtsRetrieval(db, userPrompt, currentPromptIndex, 100);
  const candidates = ftsResults.slice(0, 40);

  let reranked: ContextEntryRow[];

  if (sdkQuery && candidates.length > 0) {
    try {
      reranked = await rerankWithHaiku(
        candidates,
        userPrompt,
        observerModel,
        sdkQuery,
        rerankingConfig.timeoutMs,
      );
    } catch (err) {
      log('[ContextRetriever] Re-ranking failed, falling back to BM25: %O', err);
      reranked = candidates;
    }
  } else {
    reranked = candidates;
  }

  const selectedIds: number[] = [];

  for (const entry of reranked) {
    if (includedIds.has(entry.id)) continue;

    const formatted = formatEntry(entry);
    if (usedChars + formatted.length > charBudget) break;

    sections.relevant.push(formatted);
    usedChars += formatted.length;
    includedIds.add(entry.id);
    selectedIds.push(entry.id);
  }

  if (selectedIds.length > 0) {
    const linked = getLinkedEntries(db, selectedIds, currentPromptIndex, 10);
    for (const entry of linked) {
      if (includedIds.has(entry.id)) continue;

      const formatted = formatEntry(entry);
      if (usedChars + formatted.length > charBudget) break;

      sections.relevant.push(formatted);
      usedChars += formatted.length;
      includedIds.add(entry.id);
    }
  }

  const selectedEntries = reranked.filter(e => includedIds.has(e.id));
  usedChars = expandSemanticGroups(db, selectedEntries, includedIds, sections.relevant, charBudget, usedChars);

  const result = buildOutputSections(sections.continuity, sections.relevant);
  if (result) {
    log('[ContextRetriever] Built re-ranked context: %d entries, %d chars, budget=%d',
      includedIds.size, result.length, charBudget);
  }
  return result;
}

async function rerankWithHaiku(
  candidates: ContextEntryRow[],
  userPrompt: string,
  model: string,
  sdkQuery: SdkQuery,
  timeoutMs: number,
): Promise<ContextEntryRow[]> {
  const entriesText = candidates
    .map(e => `[${e.id}] ${formatEntry(e)}`)
    .join('\n');

  const prompt = `<query>${userPrompt}</query>\n<entries>\n${entriesText}\n</entries>`;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const options = {
      model,
      systemPrompt: 'You are a relevance scorer. Given a query and context entries, score each entry\'s relevance to the query from 0 (irrelevant) to 10 (highly relevant).',
      tools: [] as string[],
      persistSession: false,
      abortController,
      outputFormat: { type: 'json_schema' as const, schema: RERANKING_SCHEMA },
    };

    const generator = sdkQuery({ prompt, options } as Parameters<typeof sdkQuery>[0]);

    let structuredOutput: { rankings: Array<{ id: number; relevance: number }> } | null = null;

    for await (const event of generator) {
      const msg = event as {
        type: string;
        subtype?: string;
        structured_output?: { rankings: Array<{ id: number; relevance: number }> };
      };

      if (msg.type === 'result') {
        if (msg.subtype === 'error_max_structured_output_retries') {
          log('[ContextRetriever] Re-ranking structured output retries exhausted');
          return candidates;
        }
        if (msg.structured_output) {
          structuredOutput = msg.structured_output;
        }
      }
    }

    if (!structuredOutput?.rankings) return candidates;

    const scoreMap = new Map<number, number>();
    for (const r of structuredOutput.rankings) {
      scoreMap.set(r.id, r.relevance);
    }

    return [...candidates].sort((a, b) => {
      const scoreA = scoreMap.get(a.id) ?? 0;
      const scoreB = scoreMap.get(b.id) ?? 0;
      return scoreB - scoreA;
    });
  } finally {
    clearTimeout(timeout);
  }
}

function expandRelatedFiles(
  db: DatabaseInstance,
  entry: ContextEntryRow,
  includedIds: Set<number>,
  output: string[],
  charBudget: number,
  usedChars: number,
): number {
  let relatedFiles: string[];
  try {
    relatedFiles = JSON.parse(entry.related_files as string);
  } catch {
    return usedChars;
  }
  if (!Array.isArray(relatedFiles) || relatedFiles.length === 0) return usedChars;

  for (const filePath of relatedFiles) {
    const related = db.prepare(
      `SELECT * FROM context_entries
       WHERE prompt_index = ? AND file_path = ? AND low_relevance = 0 AND annotation_status = 'annotated' AND id != ?
       LIMIT 3`
    ).all(entry.prompt_index, filePath, entry.id) as ContextEntryRow[];

    for (const relEntry of related) {
      if (includedIds.has(relEntry.id)) continue;

      const formatted = formatEntry(relEntry);
      if (usedChars + formatted.length > charBudget) return usedChars;

      output.push(formatted);
      usedChars += formatted.length;
      includedIds.add(relEntry.id);
    }
  }
  return usedChars;
}
