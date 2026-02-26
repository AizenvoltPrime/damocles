import { log } from '../logger';
import type { DatabaseInstance } from '../memory/types';
import { getLinkedEntries, getGroupEntries } from './context-database';
import { RERANKING_SCHEMA, DECOMPOSITION_SYSTEM_PROMPT, DECOMPOSITION_SCHEMA } from './prompts';
import { DEFAULT_TOKEN_BUDGET } from './types';
import type { ContextEntryRow } from './types';
import type { RetrievalConfidenceTracker } from '../shared/retrieval-confidence';
import { FTS_STOPWORDS } from '../shared/fts-stopwords';
import type { SdkQuery } from '../shared/sdk-loader';

const CHARS_PER_TOKEN = 4;
const GROUP_EXPANSION_LIMIT = 3;

function buildFtsQuery(prompt: string): string | null {
  const tokens = prompt.trim().toLowerCase().split(/\s+/)
    .filter(t => t.length > 1 && !FTS_STOPWORDS.has(t))
    .map(t => t.replace(/[^a-z0-9._-]/g, ''))
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

function runMultiPassRetrieval(
  db: DatabaseInstance,
  facets: string[],
  currentPromptIndex: number,
  limit: number,
): (ContextEntryRow & { rank: number })[] {
  const perFacetLimit = Math.ceil(limit * 1.5 / facets.length);
  const seen = new Map<number, ContextEntryRow & { rank: number }>();

  for (const facet of facets) {
    const results = runFtsRetrieval(db, facet, currentPromptIndex, perFacetLimit);
    for (const entry of results) {
      const existing = seen.get(entry.id);
      if (!existing || entry.rank < existing.rank) {
        seen.set(entry.id, entry);
      }
    }
  }

  return [...seen.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}

export async function decomposeQueryWithHaiku(
  userPrompt: string,
  model: string,
  sdkQuery: SdkQuery | null,
  timeoutMs: number,
): Promise<string[] | null> {
  if (!sdkQuery) return null;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const options = {
      model,
      systemPrompt: DECOMPOSITION_SYSTEM_PROMPT,
      tools: [] as string[],
      persistSession: false,
      abortController,
      outputFormat: { type: 'json_schema' as const, schema: DECOMPOSITION_SCHEMA },
    };

    const generator = sdkQuery({ prompt: userPrompt, options } as Parameters<typeof sdkQuery>[0]);

    let structuredOutput: { facets: string[] } | null = null;

    for await (const event of generator) {
      const msg = event as {
        type: string;
        subtype?: string;
        structured_output?: { facets: string[] };
      };

      if (msg.type === 'result') {
        if (msg.subtype === 'error_max_structured_output_retries') {
          log('[ContextRetriever] Decomposition structured output retries exhausted');
          return null;
        }
        if (msg.structured_output) {
          structuredOutput = msg.structured_output;
        }
      }
    }

    if (!structuredOutput?.facets || structuredOutput.facets.length === 0) return null;

    log('[ContextRetriever] Decomposed query into %d facets: %O', structuredOutput.facets.length, structuredOutput.facets);
    return structuredOutput.facets;
  } catch (err) {
    log('[ContextRetriever] Query decomposition failed: %O', err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

interface RetrievalOptions {
  facets?: string[];
  reranking?: {
    model: string;
    sdkQuery: SdkQuery;
    timeoutMs: number;
  };
  confidenceTracker?: RetrievalConfidenceTracker;
  annotatedEntryCount?: number;
}

export async function retrieveContext(
  db: DatabaseInstance,
  userPrompt: string,
  currentPromptIndex: number,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
  options: RetrievalOptions = {},
): Promise<string | null> {
  if (currentPromptIndex <= 0) return null;

  let charBudget = tokenBudget * CHARS_PER_TOKEN;
  const includedIds = new Set<number>();
  const sections: { continuity: string[]; relevant: string[] } = { continuity: [], relevant: [] };
  let usedChars = 0;

  const { entry: prevSummary, formatted: summaryFormatted } = getContinuitySection(db, currentPromptIndex);
  if (prevSummary && summaryFormatted) {
    sections.continuity.push(summaryFormatted);
    usedChars += summaryFormatted.length;
    includedIds.add(prevSummary.id);
  }

  const ftsLimit = options.reranking ? 100 : 50;
  const ftsResults = options.facets && options.facets.length > 0
    ? runMultiPassRetrieval(db, options.facets, currentPromptIndex, ftsLimit)
    : runFtsRetrieval(db, userPrompt, currentPromptIndex, ftsLimit);

  if (options.confidenceTracker && ftsResults.length > 0) {
    const scores = ftsResults.map(r => Math.abs(r.rank));
    const totalCandidates = options.annotatedEntryCount ?? ftsResults.length;
    const confidence = options.confidenceTracker.computeConfidence(scores, totalCandidates);
    charBudget = Math.max(usedChars + 400, Math.floor(charBudget * confidence));
    options.confidenceTracker.recordQueryScores(scores, totalCandidates);
    log('[ContextRetriever] Confidence backoff: %s, effectiveCharBudget=%d', confidence.toFixed(2), charBudget);
  }

  let orderedResults: ContextEntryRow[];

  if (options.reranking) {
    const candidates = ftsResults.slice(0, 40);

    if (options.reranking.sdkQuery && candidates.length > 0) {
      try {
        orderedResults = await rerankWithHaiku(
          candidates,
          userPrompt,
          options.reranking.model,
          options.reranking.sdkQuery,
          options.reranking.timeoutMs,
        );
      } catch (err) {
        log('[ContextRetriever] Re-ranking failed, falling back to BM25: %O', err);
        orderedResults = candidates;
      }
    } else {
      orderedResults = candidates;
    }
  } else {
    orderedResults = ftsResults;
  }

  const selectedIds: number[] = [];

  for (const entry of orderedResults) {
    if (includedIds.has(entry.id)) continue;

    const formatted = formatEntry(entry);
    if (usedChars + formatted.length > charBudget) break;

    sections.relevant.push(formatted);
    usedChars += formatted.length;
    includedIds.add(entry.id);
    selectedIds.push(entry.id);

    if (!options.reranking) {
      usedChars = expandRelatedFiles(db, entry, includedIds, sections.relevant, charBudget, usedChars);
    }
  }

  if (options.reranking && selectedIds.length > 0) {
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

  const selectedEntries = orderedResults.filter(e => includedIds.has(e.id));
  usedChars = expandSemanticGroups(db, selectedEntries, includedIds, sections.relevant, charBudget, usedChars);

  const result = buildOutputSections(sections.continuity, sections.relevant);
  if (result) {
    const mode = options.reranking ? 're-ranked' : 'BM25';
    const facetInfo = options.facets ? `, facets=${options.facets.length}` : '';
    log('[ContextRetriever] Built %s context: %d entries, %d chars, budget=%d%s',
      mode, includedIds.size, result.length, charBudget, facetInfo);
  }
  return result;
}
