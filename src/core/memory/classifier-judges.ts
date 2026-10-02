import type { ClassifierAnswer, ClassifierBoolQuestion, ClassifierScoreQuestion, JsonObject } from '@earendil-works/pi-ai';
import type { MemoryClassifyRequest, MemorySubCallRunner } from './subcall-runner';
import { truncateToChars } from './token-estimate';

/**
 * Jev's contradiction probability decides alone at or above `high` and at or below `low`; between them
 * the LLM judge decides. Retune only with `__tests__/classifier-eval.test.ts`.
 */
export const CONTRADICTION_THRESHOLDS = { high: 0.85, low: 0.15 } as const;

export const CONTRADICTION_TIMEOUT_MS = 15_000;

const CONTRADICTION_QUESTION: ClassifierBoolQuestion = {
  type: 'bool',
  instructions: 'Do `new_fact` and `existing_fact` make claims about the same subject that cannot both be true now?',
  criteria: {
    true: 'They contradict: if `new_fact` is true now, `existing_fact` no longer is',
    false: 'Both can be true now: they agree, concern different subjects, or one adds detail to the other',
  },
};

/** Ordered levels; Jev's score is a probability-weighted index into this list, from 0 to its length - 1. */
export const RERANK_CRITERIA = ['unrelated', 'partially relevant', 'directly relevant'] as const;

/**
 * Score questions per Jev request; batches run in parallel. TypeSafe documents no question cap, only a
 * token budget (64k per request, 32k for the state plus the longest question; OpenRouter lists 32k).
 */
export const RERANK_BATCH_SIZE = 10;

/** The query length both rerank paths send, Jev and the LLM. */
export const RERANK_QUERY_CHARS = 2000;

/** Below this much of the rerank cap, the LLM fallback cannot finish, so it is not started (and not billed). */
export const LLM_RERANK_MIN_MS = 300;

export type RerankRelevance = 'high' | 'medium' | 'low';

export interface RerankItem {
  id: string;
  title: string | null;
  snippet: string;
}

export interface ClassifierGrade {
  relevance: RerankRelevance;
  /** The score normalized to 0..1. */
  score: number;
  /** The nearest level of {@link RERANK_CRITERIA}. */
  verdict: (typeof RERANK_CRITERIA)[number];
}

const RELEVANCE_BY_LEVEL: readonly RerankRelevance[] = ['low', 'medium', 'high'];

/** Rounds Jev's score to the nearest level. */
export function gradeFromScore(score: number): ClassifierGrade {
  const top = RERANK_CRITERIA.length - 1;
  const level = Math.min(top, Math.max(0, Math.round(score)));
  return { relevance: RELEVANCE_BY_LEVEL[level]!, score: Math.min(1, Math.max(0, score / top)), verdict: RERANK_CRITERIA[level]! };
}

/** The model-facing reason on a search result; the Injected Context card renders its own localized one. */
export function classifierReason(grade: ClassifierGrade): string {
  return `Classifier: ${grade.verdict} (${grade.score.toFixed(2)})`;
}

/** `true` or `false` when Jev is decisive, `'undecided'` in the middle band. */
export function contradictionFromProbability(p: number): boolean | 'undecided' {
  if (p >= CONTRADICTION_THRESHOLDS.high) return true;
  if (p <= CONTRADICTION_THRESHOLDS.low) return false;
  return 'undecided';
}

export function contradictionRequest(newFact: string, existingFact: string): MemoryClassifyRequest {
  return {
    purpose: 'merge',
    state: { new_fact: newFact, existing_fact: existingFact },
    questions: { contradicts: CONTRADICTION_QUESTION },
    timeoutMs: CONTRADICTION_TIMEOUT_MS,
  };
}

/** Jev's verdict on whether `newFact` contradicts `existingFact`; null when no classifier answered. */
export async function classifyContradiction(
  runner: MemorySubCallRunner,
  newFact: string,
  existingFact: string,
): Promise<boolean | 'undecided' | null> {
  if (!runner.classify || !runner.hasClassifier?.()) return null;
  const answer = (await runner.classify(contradictionRequest(newFact, existingFact)))?.['contradicts'];
  return answer?.type === 'bool' ? contradictionFromProbability(answer.probability) : null;
}

export interface RerankBatch {
  state: JsonObject;
  questions: Record<string, ClassifierScoreQuestion>;
  idByKey: Map<string, string>;
}

/** One request per batch. Keys are positional (`c0`…), so no stored text reaches `questions`. */
export function buildRerankBatches(query: string, items: readonly RerankItem[]): RerankBatch[] {
  const batches: RerankBatch[] = [];
  for (let start = 0; start < items.length; start += RERANK_BATCH_SIZE) {
    const candidates: JsonObject = {};
    const questions: Record<string, ClassifierScoreQuestion> = {};
    const idByKey = new Map<string, string>();
    items.slice(start, start + RERANK_BATCH_SIZE).forEach((item, i) => {
      const key = `c${i}`;
      candidates[key] = { title: item.title, snippet: item.snippet };
      questions[key] = {
        type: 'score',
        instructions: `How relevant is the memory \`candidates.${key}\` to the user's request in \`query\`?`,
        criteria: [...RERANK_CRITERIA],
      };
      idByKey.set(key, item.id);
    });
    batches.push({ state: { query: truncateToChars(query, RERANK_QUERY_CHARS), candidates }, questions, idByKey });
  }
  return batches;
}

function gradeBatch(batch: RerankBatch, answers: Record<string, ClassifierAnswer> | null): Map<string, ClassifierGrade> | null {
  if (!answers) return null;
  const grades = new Map<string, ClassifierGrade>();
  for (const [key, id] of batch.idByKey) {
    const answer = answers[key];
    if (answer?.type !== 'score') return null;
    grades.set(id, gradeFromScore(answer.score));
  }
  return grades;
}

/**
 * Grades every item with Jev within `timeoutMs`; null when no classifier is configured or any batch fails.
 * The first failed batch aborts the others and returns at once, leaving the LLM fallback the rest of the cap.
 */
export async function classifierRerank(
  runner: MemorySubCallRunner,
  query: string,
  items: readonly RerankItem[],
  timeoutMs: number,
): Promise<Map<string, ClassifierGrade> | null> {
  const classify = runner.classify;
  if (!classify || !runner.hasClassifier?.() || items.length === 0) return null;
  const failed = new AbortController();
  const firstFailure = new Promise<null>((resolve) => failed.signal.addEventListener('abort', () => resolve(null), { once: true }));
  const batches = buildRerankBatches(query, items).map(async (b) => {
    const answers = await classify.call(runner, { purpose: 'rerank', state: b.state, questions: b.questions, timeoutMs, abortSignal: failed.signal });
    const grades = gradeBatch(b, answers);
    if (!grades) failed.abort();
    return grades;
  });
  const results = await Promise.race([Promise.all(batches), firstFailure]);
  if (!results || results.includes(null)) return null;
  return new Map(results.flatMap((grades) => [...grades!]));
}
