import { RERANK_QUERY_CHARS, classifierRerank, type ClassifierGrade, type RerankItem, type RerankRelevance } from './classifier-judges';
import type { MemorySubCallRunner } from './subcall-runner';
import { truncateToChars } from './token-estimate';

/** The snippet of each candidate both reranks send. */
export const RERANK_SNIPPET_CHARS = 160;

/** The LLM fallback's share of a rerank cap; see docs/invariants.md "Reranks stay inside their caps". */
export const LLM_RERANK_MIN_MS = 2000;

/** Grades sort high first; within a grade by `position` where the LLM gave one, then by the caller's lexical order. */
export const RERANK_SORT_WEIGHT: Readonly<Record<RerankRelevance, number>> = { high: 2, medium: 1, low: 0 };

export interface RerankGrade {
  relevance: RerankRelevance;
  /** Set when the classifier graded it. */
  classifier?: ClassifierGrade;
  /** The LLM's order among the candidates it listed; unset for one it left out. */
  position?: number;
}

// The answer is candidate numbers only: output length sets the call's latency, so it asks for no per-candidate reason.
// This wording and the prompt layout in `llmRerank` are the measured ones; rewordings and a JSON layout graded worse
// (docs/invariants.md "The LLM rerank is listwise").
const LLM_RERANK_SYSTEM_PROMPT =
  'Pick the candidate memories that are relevant to the user query. In `direct`, list the numbers of the directly relevant candidates; ' +
  'in `partial`, the numbers of the partially relevant ones; each list most relevant first. Leave out unrelated candidates; empty lists are valid. ' +
  'Judge by semantic relevance, not keyword overlap.';

const LLM_RERANK_SCHEMA = {
  type: 'object',
  properties: {
    direct: { type: 'array', items: { type: 'integer' } },
    partial: { type: 'array', items: { type: 'integer' } },
  },
  required: ['direct', 'partial'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

/**
 * The runner's `T` is an unvalidated cast. A list may be missing (read as empty), but not both, and every entry
 * must be a candidate's number: an answer that names candidates any other way is not trusted to grade the rest low.
 */
function readLists(value: unknown, count: number): { direct: number[]; partial: number[] } | null {
  if (!value || typeof value !== 'object') return null;
  const { direct = [], partial = [] } = value as { direct?: unknown; partial?: unknown };
  if (!('direct' in value) && !('partial' in value)) return null;
  const isNumbers = (list: unknown): list is number[] =>
    Array.isArray(list) && list.every((n) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= count);
  return isNumbers(direct) && isNumbers(partial) ? { direct, partial } : null;
}

/**
 * Grades every item with one listwise LLM call: `direct` is high, `partial` medium, an item in neither low.
 * A number seen before keeps its first grade. Null when the model gave no valid answer.
 */
export async function llmRerank(
  runner: MemorySubCallRunner,
  query: string,
  items: readonly RerankItem[],
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<Map<string, RerankGrade> | null> {
  const candidates = items.map((item, i) => ({ n: i + 1, title: item.title, snippet: item.snippet }));
  const { value } = await runner.run<unknown>({
    purpose: 'rerank',
    systemPrompt: LLM_RERANK_SYSTEM_PROMPT,
    prompt: `Query: ${truncateToChars(query, RERANK_QUERY_CHARS)}\n\nCandidates:\n${JSON.stringify(candidates)}`,
    schema: LLM_RERANK_SCHEMA,
    timeoutMs,
    ...(abortSignal ? { abortSignal } : {}),
  });
  const lists = readLists(value, items.length);
  if (!lists) return null;

  const grades = new Map<string, RerankGrade>();
  let position = 0;
  const take = (numbers: number[], relevance: RerankRelevance): void => {
    for (const n of numbers) {
      const item = items[n - 1]!;
      if (!grades.has(item.id)) grades.set(item.id, { relevance, position: position++ });
    }
  };
  take(lists.direct, 'high');
  take(lists.partial, 'medium');
  for (const item of items) if (!grades.has(item.id)) grades.set(item.id, { relevance: 'low' });
  return grades;
}

/**
 * Grades every item within `capMs`, or null to keep the lexical order. The classifier, when the Memory judge has one,
 * gets the cap less {@link LLM_RERANK_MIN_MS}, so its failure leaves the listwise LLM that much; the LLM gets the time
 * left and is not started with less, since it could not finish but could still be billed.
 */
export async function judgeRerank(
  runner: MemorySubCallRunner,
  query: string,
  items: readonly RerankItem[],
  capMs: number,
  abortSignal?: AbortSignal,
): Promise<Map<string, RerankGrade> | null> {
  const started = performance.now();
  if (runner.hasClassifier?.()) {
    const graded = await classifierRerank(runner, query, items, capMs - LLM_RERANK_MIN_MS, abortSignal);
    if (graded) return new Map([...graded].map(([id, classifier]) => [id, { relevance: classifier.relevance, classifier }]));
  }
  // Whole ms: the provider SDKs refuse a fractional request timeout before sending anything.
  const leftMs = Math.floor(capMs - (performance.now() - started));
  if (leftMs < LLM_RERANK_MIN_MS || abortSignal?.aborted) return null;
  return llmRerank(runner, query, items, leftMs, abortSignal);
}
