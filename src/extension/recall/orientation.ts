import { log } from '../logger';
import { expandQuery } from '../memory/query-expansion';
import { createBM25Index } from './bm25';
import type { SubCallHandler } from './sub-call-handler';
import type { StructuredTurn } from './types';
import type { OrientationData, OrientationPhase } from '../../shared/types/recall';

const LOW_CONFIDENCE_THRESHOLD = 2.0;
const ORIENTATION_TIMEOUT_MS = 15_000;
const INVESTIGATION_CHUNK_CHARS = 50_000;
const RELEVANCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export interface TurnIndexEntry {
  promptIndex: number;
  summary: string;
  keywords: string[];
  filesTouched: string[];
}

export interface OrientationContext extends OrientationData {
  turnIndex: TurnIndexEntry[];
}

export interface CompassTermProvider {
  getGraphTerms(queryTerms: string[]): string[];
}

export async function buildOrientationContext(
  history: StructuredTurn[],
  userPrompt: string,
  subCallHandler: SubCallHandler,
  abortSignal?: AbortSignal,
  onPhase?: (phase: OrientationPhase, orientation: OrientationData) => void,
  compassProvider?: CompassTermProvider,
): Promise<OrientationContext> {
  const start = Date.now();

  let expandedTerms: string[] = [];
  try {
    expandedTerms = await expandQuery(userPrompt);
  } catch (err) {
    log('[Orientation] Query expansion failed: %O', err);
  }

  let graphTerms: string[] = [];
  if (compassProvider) {
    try {
      const queryTerms = userPrompt.split(/\s+/).filter(t => t.length > 2).map(t => t.toLowerCase());
      graphTerms = compassProvider.getGraphTerms(queryTerms);
    } catch (err) {
      log('[Orientation] Graph term expansion failed: %O', err);
    }
  }

  onPhase?.('expanding', { expandedTerms, graphTerms, bm25Results: [], investigationReport: null, durationMs: Date.now() - start });

  const bm25Index = createBM25Index(history);
  const combinedQuery = [userPrompt, ...expandedTerms, ...graphTerms].join(' ');
  const bm25Results = bm25Index.search(combinedQuery, 15);

  onPhase?.('searching', { expandedTerms, bm25Results, investigationReport: null, durationMs: Date.now() - start });

  const turnIndex: TurnIndexEntry[] = history.map(t => ({
    promptIndex: t.promptIndex,
    summary: t.summary ?? t.userMessage.slice(0, 80),
    keywords: t.keywords ?? [],
    filesTouched: t.filesTouched,
  }));

  let investigationReport: string | null = null;
  const topScore = bm25Results[0]?.score ?? 0;

  if (topScore < LOW_CONFIDENCE_THRESHOLD && !abortSignal?.aborted) {
    const remaining = ORIENTATION_TIMEOUT_MS - (Date.now() - start);
    if (remaining > 3000) {
      let timeoutHandle: ReturnType<typeof setTimeout>;
      try {
        const timeoutRace = new Promise<null>(resolve => {
          timeoutHandle = setTimeout(() => resolve(null), remaining);
        });
        investigationReport = await Promise.race([
          runChunkInvestigation(history, userPrompt, expandedTerms, subCallHandler, abortSignal),
          timeoutRace,
        ]);
        onPhase?.('investigating', { expandedTerms, bm25Results, investigationReport, durationMs: Date.now() - start });
      } catch (err) {
        log('[Orientation] Investigation failed: %O', err);
      } finally {
        clearTimeout(timeoutHandle!);
      }
    }
  }

  return {
    expandedTerms,
    graphTerms,
    bm25Results,
    turnIndex,
    investigationReport,
    durationMs: Date.now() - start,
  };
}

async function runChunkInvestigation(
  history: StructuredTurn[],
  userPrompt: string,
  expandedTerms: string[],
  subCallHandler: SubCallHandler,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (history.length === 0) return null;

  const turnBlocks = history.map((t, arrayIdx) => ({
    index: arrayIdx,
    text: `[Turn ${arrayIdx}] User: ${t.userMessage.slice(0, 2000)}\n` +
          `Assistant: ${t.assistantResponse.slice(0, 2000)}\n` +
          `Files: ${t.filesTouched.join(', ')}`,
  }));

  const chunks: typeof turnBlocks[] = [];
  let current: typeof turnBlocks = [];
  let currentSize = 0;

  for (const block of turnBlocks) {
    if (currentSize + block.text.length > INVESTIGATION_CHUNK_CHARS && current.length > 0) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(block);
    currentSize += block.text.length;
  }
  if (current.length > 0) chunks.push(current);

  const hypothesis = expandedTerms.length > 0
    ? `${userPrompt} (related terms: ${expandedTerms.join(', ')})`
    : userPrompt;

  const prompts = chunks.map(chunk => {
    const turnText = chunk.map(b => b.text).join('\n\n');
    const startIdx = chunk[0]!.index;
    const endIdx = chunk[chunk.length - 1]!.index;
    return buildInvestigatorPrompt(hypothesis, turnText, startIdx, endIdx);
  });

  if (abortSignal?.aborted) return null;

  const responses = await subCallHandler.queryBatched(prompts, undefined, abortSignal);

  const allHits: Array<{ turnIndex: number; relevance: string; reason: string }> = [];
  for (const response of responses) {
    allHits.push(...parseInvestigatorResponse(response));
  }

  const deduped = deduplicateHits(allHits);
  if (deduped.length === 0) return null;

  deduped.sort((a, b) =>
    (RELEVANCE_RANK[b.relevance] ?? 0) - (RELEVANCE_RANK[a.relevance] ?? 0) || a.turnIndex - b.turnIndex,
  );

  return deduped
    .map(h => `Turn ${h.turnIndex} [${h.relevance}]: ${h.reason}`)
    .join('\n');
}

function buildInvestigatorPrompt(
  hypothesis: string,
  turnText: string,
  startIdx: number,
  endIdx: number,
): string {
  return `You are investigating conversation history for implicit evidence.

HYPOTHESIS: "${hypothesis}"

Search the following conversation turns for ANY evidence — direct or indirect — that relates to this hypothesis. Look for:
- Explicit mentions of the topic
- Implicit references (code changes in related files without naming the topic)
- Decisions or trade-offs that would impact the hypothesis
- Files touched that are related

CONVERSATION TURNS (indices ${startIdx}-${endIdx}):
${turnText}

Return a JSON array. Each finding: {"turnIndex": N, "relevance": "high"|"medium"|"low", "reason": "brief explanation (max 100 chars)"}
If NO turns are relevant, return: []
Return ONLY the JSON array.`;
}

export function parseInvestigatorResponse(response: string): Array<{ turnIndex: number; relevance: string; reason: string }> {
  const start = response.indexOf('[');
  const end = response.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  try {
    const parsed = JSON.parse(response.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item: unknown): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null &&
        typeof (item as Record<string, unknown>)['turnIndex'] === 'number' &&
        typeof (item as Record<string, unknown>)['reason'] === 'string' &&
        ['high', 'medium', 'low'].includes(String((item as Record<string, unknown>)['relevance'])),
      )
      .map((item: Record<string, unknown>) => ({
        turnIndex: item['turnIndex'] as number,
        relevance: item['relevance'] as string,
        reason: String(item['reason']).slice(0, 150),
      }));
  } catch {
    return [];
  }
}

export function deduplicateHits(
  hits: Array<{ turnIndex: number; relevance: string; reason: string }>,
): Array<{ turnIndex: number; relevance: string; reason: string }> {
  const map = new Map<number, typeof hits[number]>();
  for (const hit of hits) {
    const existing = map.get(hit.turnIndex);
    if (!existing || (RELEVANCE_RANK[hit.relevance] ?? 0) > (RELEVANCE_RANK[existing.relevance] ?? 0)) {
      map.set(hit.turnIndex, hit);
    }
  }
  return [...map.values()];
}

export function formatOrientationForPrompt(
  orientation: OrientationContext,
  userPrompt: string,
): string {
  const sections: string[] = [];

  if (orientation.expandedTerms.length > 0) {
    sections.push(`EXPANDED TERMS: "${userPrompt}" → ${orientation.expandedTerms.join(', ')}`);
  }

  if (orientation.bm25Results.length > 0) {
    const ranked = orientation.bm25Results.map(r =>
      `  [Turn ${r.turnIndex}] (score ${r.score.toFixed(1)}) ${r.preview}`,
    ).join('\n');
    sections.push(`TOP TURNS BY KEYWORD RELEVANCE:\n${ranked}`);
  } else {
    sections.push('TOP TURNS: No keyword matches found. Use investigation results or llm_query to analyze turns.');
  }

  if (orientation.investigationReport) {
    sections.push(`INVESTIGATION (auto-triggered, low keyword overlap with query):\n${orientation.investigationReport}`);
  }

  return sections.join('\n\n');
}
