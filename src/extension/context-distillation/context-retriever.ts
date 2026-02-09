import { log } from '../logger';
import type { DatabaseInstance } from '../memory/types';
import type { ContextEntryRow } from './types';

const DEFAULT_TOKEN_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;

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
  const desc = entry.description ?? summarizeFromToolCalls(entry);
  return `[Prompt ${entry.prompt_index}]: ${filePart} — ${desc}`;
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

  const prevSummary = db.prepare(
    `SELECT * FROM context_entries
     WHERE prompt_index = ? AND entry_type = 'summary'
     LIMIT 1`
  ).get(currentPromptIndex - 1) as ContextEntryRow | undefined;

  if (prevSummary) {
    const formatted = formatEntry(prevSummary);
    sections.continuity.push(formatted);
    usedChars += formatted.length;
    includedIds.add(prevSummary.id);
  }

  const ftsQuery = buildFtsQuery(userPrompt);
  if (ftsQuery) {
    try {
      const ftsResults = db.prepare(
        `SELECT ce.*, fts.rank FROM context_entries_fts fts
         JOIN context_entries ce ON ce.id = fts.rowid
         WHERE context_entries_fts MATCH ?
         AND ce.low_relevance = 0
         AND ce.prompt_index < ?
         ORDER BY fts.rank
         LIMIT 50`
      ).all(ftsQuery, currentPromptIndex) as (ContextEntryRow & { rank: number })[];

      for (const entry of ftsResults) {
        if (includedIds.has(entry.id)) continue;

        const formatted = formatEntry(entry);
        if (usedChars + formatted.length > charBudget) break;

        sections.relevant.push(formatted);
        usedChars += formatted.length;
        includedIds.add(entry.id);

        usedChars = expandRelatedFiles(db, entry, includedIds, sections.relevant, charBudget, usedChars);
      }
    } catch (err) {
      log('[ContextRetriever] FTS query failed: %O', err);
    }
  }

  if (sections.continuity.length === 0 && sections.relevant.length === 0) return null;

  const parts: string[] = [];

  if (sections.continuity.length > 0) {
    parts.push(`<last_activity>\n${sections.continuity.join('\n')}\n</last_activity>`);
  }

  if (sections.relevant.length > 0) {
    parts.push(`<relevant_context>\n${sections.relevant.join('\n')}\n</relevant_context>`);
  }

  const result = parts.join('\n\n');
  log('[ContextRetriever] Built context: %d entries, %d chars, budget=%d',
    includedIds.size, result.length, charBudget);
  return result;
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
       WHERE prompt_index = ? AND file_path = ? AND low_relevance = 0 AND id != ?
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
