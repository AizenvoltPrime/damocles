import { afterEach, describe, expect, it, vi } from 'vitest';
import { RERANK_QUERY_CHARS, gradeFromScore } from '../classifier-judges';
import { LLM_RERANK_MIN_MS, judgeRerank, llmRerank } from '../rerank';
import type { MemoryClassifyRequest, MemorySubCallRequest, MemorySubCallRunner } from '../subcall-runner';
import type { ClassifierAnswer } from '@earendil-works/pi-ai';
import { subCallSpy } from './subcall-spy';
import { rerankPrompt } from './test-helpers';

const items = ['alpha', 'beta', 'gamma', 'delta'].map((word) => ({ id: `id-${word}`, title: null, snippet: `${word} notes` }));

function answering(value: unknown): { runner: MemorySubCallRunner; requests: MemorySubCallRequest[] } {
  const requests: MemorySubCallRequest[] = [];
  const runner: MemorySubCallRunner = {
    async run<T>(req: MemorySubCallRequest) {
      requests.push(req);
      return { value: value as T };
    },
  };
  return { runner, requests };
}

describe('llmRerank', () => {
  it('grades direct high and partial medium in the model order, and every unlisted item low with no position', async () => {
    const { runner } = answering({ direct: [3, 1], partial: [4] });
    const grades = await llmRerank(runner, 'query', items, 4000);
    expect([...grades!]).toEqual([
      ['id-gamma', { relevance: 'high', position: 0 }],
      ['id-alpha', { relevance: 'high', position: 1 }],
      ['id-delta', { relevance: 'medium', position: 2 }],
      ['id-beta', { relevance: 'low' }],
    ]);
  });

  it('sends the bounded query and the numbered candidates without ids, under the caller timeout and signal', async () => {
    const { runner, requests } = answering({ direct: [], partial: [] });
    const signal = new AbortController().signal;
    await llmRerank(runner, 'q'.repeat(RERANK_QUERY_CHARS + 500), items, 1234, signal);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ purpose: 'rerank', timeoutMs: 1234, abortSignal: signal });
    const sent = rerankPrompt(requests[0]!.prompt);
    expect(sent.query).toBe('q'.repeat(RERANK_QUERY_CHARS));
    expect(sent.candidates).toEqual(items.map((item, i) => ({ n: i + 1, title: null, snippet: item.snippet })));
    expect(requests[0]!.prompt).not.toContain('id-alpha');
  });

  it('grades every item low on two empty lists, and reads a missing list as empty', async () => {
    const empty = await llmRerank(answering({ direct: [], partial: [] }).runner, 'query', items, 4000);
    expect([...empty!.values()].map((g) => g.relevance)).toEqual(['low', 'low', 'low', 'low']);
    const directOnly = await llmRerank(answering({ direct: [2] }).runner, 'query', items, 4000);
    expect(directOnly!.get('id-beta')).toEqual({ relevance: 'high', position: 0 });
  });

  it('keeps the first grade of a number listed twice', async () => {
    const grades = await llmRerank(answering({ direct: [2, 2], partial: [2, 1] }).runner, 'query', items, 4000);
    expect(grades!.get('id-beta')).toEqual({ relevance: 'high', position: 0 });
    expect(grades!.get('id-alpha')).toEqual({ relevance: 'medium', position: 1 });
  });

  it.each([
    ['no answer', null],
    ['neither list', { results: [] }],
    ['a list that is not an array', { direct: 2, partial: [] }],
    ['a null list', { direct: null, partial: [] }],
    ['a number out of range', { direct: [1, 5], partial: [] }],
    ['a number out of range in partial', { direct: [], partial: [5] }],
    ['zero', { direct: [0], partial: [] }],
    ['a negative number', { direct: [-1], partial: [] }],
    ['a fraction', { direct: [], partial: [1.5] }],
    ['a numeric string', { direct: ['2'], partial: [] }],
    ['an id instead of a number', { direct: ['id-alpha'], partial: [] }],
  ])('returns null for %s', async (_, value) => {
    expect(await llmRerank(answering(value).runner, 'query', items, 4000)).toBeNull();
  });
});

describe('judgeRerank', () => {
  let now = 0;
  afterEach(() => vi.restoreAllMocks());

  /** A classifier that answers `answer` after `elapsedMs` of the mocked clock, and an LLM that lists item 2 as direct. */
  function judge(answer: 'score' | 'fail', elapsedMs: number) {
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const classify = vi.fn(async (req: MemoryClassifyRequest): Promise<Record<string, ClassifierAnswer> | null> => {
      now += elapsedMs;
      if (answer === 'fail') return null;
      return Object.fromEntries(Object.keys(req.questions).map((key) => [key, { type: 'score', score: 2, confidence: 1 }]));
    });
    const run = subCallSpy(async <T,>() => ({ value: { direct: [2], partial: [] } as T }));
    const runner: MemorySubCallRunner = { run, hasClassifier: () => true, classify };
    return { runner, run, classify };
  }

  it('gives the classifier the cap less the LLM reserve and returns its grades', async () => {
    const { runner, run, classify } = judge('score', 100);
    const grades = await judgeRerank(runner, 'query', items, 4000);
    expect(classify.mock.calls[0]![0].timeoutMs).toBe(4000 - LLM_RERANK_MIN_MS);
    expect(run).not.toHaveBeenCalled();
    expect(grades!.get('id-alpha')).toEqual({ relevance: 'high', classifier: gradeFromScore(2) });
  });

  it.each([
    [4000, 1000, 3000],
    [8000, 1000, 7000],
  ])('with a cap of %i, a classifier failing after %i ms leaves the LLM %i ms', async (cap, elapsed, left) => {
    const { runner, run } = judge('fail', elapsed);
    const grades = await judgeRerank(runner, 'query', items, cap);
    expect(run.mock.calls[0]![0].timeoutMs).toBe(left);
    expect(grades!.get('id-beta')).toEqual({ relevance: 'high', position: 0 });
  });

  // The provider SDKs refuse a fractional request timeout before sending anything.
  it('gives the LLM a whole number of ms, rounded down, after a fractional elapsed time', async () => {
    const { runner, run } = judge('fail', 1000.4);
    await judgeRerank(runner, 'query', items, 4000);
    expect(run.mock.calls[0]![0].timeoutMs).toBe(2999);
  });

  it('starts no LLM call when the classifier overran its share', async () => {
    const { runner, run } = judge('fail', 4000 - LLM_RERANK_MIN_MS + 1);
    expect(await judgeRerank(runner, 'query', items, 4000)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('gives the LLM the whole cap when the judge has no classifier', async () => {
    const { runner, run, classify } = judge('score', 0);
    runner.hasClassifier = () => false;
    await judgeRerank(runner, 'query', items, 4000);
    expect(classify).not.toHaveBeenCalled();
    expect(run.mock.calls[0]![0].timeoutMs).toBe(4000);
  });

  it("ties the classifier's requests to the abort signal", async () => {
    const stop = new AbortController();
    const { runner, classify } = judge('score', 0);
    await judgeRerank(runner, 'query', items, 4000, stop.signal);
    const sent = classify.mock.calls[0]![0].abortSignal!;
    expect(sent.aborted).toBe(false);
    stop.abort();
    expect(sent.aborted).toBe(true);
  });

  it('passes the abort signal to the LLM', async () => {
    const stop = new AbortController();
    const { runner, run } = judge('fail', 0);
    await judgeRerank(runner, 'query', items, 4000, stop.signal);
    expect(run.mock.calls[0]![0].abortSignal).toBe(stop.signal);
  });

  it('starts no LLM call once the signal fired during the classifier', async () => {
    const stop = new AbortController();
    const { runner, run, classify } = judge('fail', 0);
    classify.mockImplementationOnce(async () => {
      stop.abort();
      return null;
    });
    expect(await judgeRerank(runner, 'query', items, 4000, stop.signal)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
