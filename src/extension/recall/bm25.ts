import type { OrientationBM25Result } from '../../shared/types/recall';
import type { StructuredTurn } from './types';

export type BM25SearchResult = OrientationBM25Result;

export interface BM25Index {
  search(query: string, topK?: number): BM25SearchResult[];
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'through', 'after', 'before', 'up', 'down', 'out', 'off', 'over',
  'under', 'again', 'then', 'once', 'here', 'there', 'when', 'where',
  'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if',
  'while', 'that', 'this', 'what', 'which', 'who', 'it', 'its', 'my',
  'your', 'his', 'her', 'our', 'their', 'me', 'him', 'us', 'them',
  'i', 'we', 'you', 'he', 'she', 'they',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

export function createBM25Index(turns: StructuredTurn[]): BM25Index {
  const K1 = 1.2;
  const B = 0.75;
  const N = turns.length;
  if (N === 0) return { search: () => [] };

  const docTexts = turns.map(t => [
    t.userMessage,
    t.assistantResponse,
    t.filesTouched.join(' '),
    t.toolCalls.map(tc => tc.name).join(' '),
    (t.keywords ?? []).join(' '),
  ].join(' '));

  const docTokens = docTexts.map(tokenize);
  const docLengths = docTokens.map(t => t.length);
  const avgDl = docLengths.reduce((sum, l) => sum + l, 0) / N || 1;

  const df = new Map<string, number>();
  const invertedIndex = new Map<string, Array<{ docIdx: number; tf: number }>>();

  for (let docIdx = 0; docIdx < N; docIdx++) {
    const tfMap = new Map<string, number>();
    for (const token of docTokens[docIdx]!) {
      tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
    }
    for (const [term, tf] of tfMap) {
      df.set(term, (df.get(term) ?? 0) + 1);
      let postings = invertedIndex.get(term);
      if (!postings) {
        postings = [];
        invertedIndex.set(term, postings);
      }
      postings.push({ docIdx, tf });
    }
  }

  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
  }

  const previews = turns.map(t => {
    const slice = t.userMessage.slice(0, 200);
    const lastSpace = slice.lastIndexOf(' ');
    return lastSpace > 150 ? slice.slice(0, lastSpace) + '...' : slice;
  });

  return {
    search(query: string, topK = 10): BM25SearchResult[] {
      const queryTokens = tokenize(query);
      if (queryTokens.length === 0) return [];

      const scores = new Array<number>(N).fill(0);
      for (const term of queryTokens) {
        const termIdf = idf.get(term);
        if (termIdf === undefined) continue;
        for (const { docIdx, tf } of invertedIndex.get(term) ?? []) {
          const dl = docLengths[docIdx]!;
          const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / avgDl)));
          scores[docIdx]! += termIdf * tfNorm;
        }
      }

      const results: BM25SearchResult[] = [];
      for (let i = 0; i < N; i++) {
        if (scores[i]! > 0) {
          results.push({ turnIndex: i, promptIndex: turns[i]!.promptIndex, score: scores[i]!, preview: previews[i]! });
        }
      }
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, topK);
    },
  };
}
