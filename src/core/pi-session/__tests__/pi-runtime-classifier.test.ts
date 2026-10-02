import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import * as fs from 'fs';
import type { ClassifierContext, ClassifierResult } from '@earendil-works/pi-ai';
import { installLogSink } from '../../logger';
import { PiRuntime, type ClassificationRequest } from '../pi-runtime';
import { JEV_VIA_OPENROUTER, JEV_VIA_TYPESAFE, classifierFailureCause, memoryJudgeOf, pickClassifierModel } from '../classifier-model';
import { SUBCALL_USAGE_LEDGER_PATH } from '../../paths';
import { CLASSIFIER_PROBE_AFTER_MS } from '../classifier-breaker';

const logLines: string[] = [];
beforeAll(() => {
  installLogSink({ appendLine: (line: string) => void logLines.push(line), show: () => {}, dispose: () => {} });
});

describe('pickClassifierModel', () => {
  it('prefers TypeSafe, then OpenRouter, else none', () => {
    expect(pickClassifierModel((p) => p === 'typesafe' || p === 'openrouter')).toEqual(JEV_VIA_TYPESAFE);
    expect(pickClassifierModel((p) => p === 'openrouter')).toEqual({ provider: 'openrouter', id: '~typesafe/jev-latest' });
    expect(pickClassifierModel(() => false)).toBeNull();
  });

  it('names the memory judge', () => {
    expect(memoryJudgeOf(JEV_VIA_OPENROUTER, { provider: 'anthropic', id: 'claude-haiku-4-5' })).toEqual({ kind: 'jev', via: 'openrouter' });
    expect(memoryJudgeOf(null, { provider: 'anthropic', id: 'claude-haiku-4-5' })).toEqual({ kind: 'model', model: 'anthropic/claude-haiku-4-5' });
    expect(memoryJudgeOf(null, null)).toEqual({ kind: 'none' });
  });
});

describe('classifierFailureCause', () => {
  it('keeps only the HTTP status of a failed response, never its body', () => {
    expect(classifierFailureCause('OpenRouter error (402): {"error":{"message":"the staging password is hunter2"}}')).toBe('HTTP 402');
    expect(classifierFailureCause('TypeSafe error (429): (500): nested')).toBe('HTTP 429');
  });

  it('names a timeout, malformed answers and a request that got no response', () => {
    expect(classifierFailureCause('Request timed out after 15000ms')).toBe('timeout');
    expect(classifierFailureCause('TypeSafe did not return an answer for contradicts')).toBe('malformed answers');
    expect(classifierFailureCause('TypeSafe returned an unexpected response')).toBe('malformed answers');
    expect(classifierFailureCause('fetch failed')).toBe('no HTTP response');
    expect(classifierFailureCause(undefined)).toBe('no error message');
  });
});

describe('PiRuntime.runClassification', () => {
  const SECRET_FACT = 'the staging password is hunter2';
  const USAGE = { input: 300, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 320, cost: { input: 0.0000126, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0000126 } };
  const REQ: ClassificationRequest = {
    state: { new_fact: SECRET_FACT, existing_fact: 'b' },
    questions: { contradicts: { type: 'bool', instructions: 'i', criteria: { true: 't', false: 'f' } } },
    purpose: 'memory-merge',
    timeoutMs: 1000,
  };

  function runtimeWith(configured: string[], classify: (ctx: ClassifierContext) => Partial<ClassifierResult>) {
    const runtime = PiRuntime.get();
    const fake = {
      hasConfiguredAuth: (p: string) => configured.includes(p),
      getModelOfType: (type: string, provider: string, id: string) => ({ type, provider, id, api: 'typesafe-system-one' }),
      classify: vi.fn(async (model: { provider: string; id: string }, ctx: ClassifierContext, _opts: unknown) => ({
        api: 'typesafe-system-one', provider: model.provider, model: model.id, answers: {}, stopReason: 'stop', timestamp: 0, ...classify(ctx),
      })),
    };
    (runtime as unknown as { _modelRuntime: unknown })._modelRuntime = fake;
    return { runtime, classify: fake.classify };
  }
  const ledger = (): Array<Record<string, unknown>> =>
    fs.existsSync(SUBCALL_USAGE_LEDGER_PATH)
      ? fs.readFileSync(SUBCALL_USAGE_LEDGER_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  afterEach(async () => {
    fs.rmSync(SUBCALL_USAGE_LEDGER_PATH, { force: true });
    logLines.length = 0;
    await PiRuntime.disposeInstance();
  });

  it('runs Jev on TypeSafe and records a ledger line', async () => {
    const answers = { contradicts: { type: 'bool' as const, probability: 0.9 } };
    const { runtime, classify } = runtimeWith(['typesafe', 'openrouter'], () => ({ answers, usage: USAGE }));
    expect(runtime.hasClassifier()).toBe(true);
    expect(await runtime.runClassification(REQ)).toEqual(answers);
    expect(classify.mock.calls[0]![0]).toMatchObject({ provider: 'typesafe', id: 'jev-latest' });
    expect(classify.mock.calls[0]![1]).toEqual({ state: REQ.state, questions: REQ.questions });
    expect(classify.mock.calls[0]![2]).toMatchObject({ timeoutMs: 1000, signal: expect.any(AbortSignal) });
    expect(ledger()).toEqual([expect.objectContaining({ purpose: 'memory-merge', provider: 'typesafe', model: 'jev-latest', stopReason: 'stop', usage: USAGE })]);
  });

  it('runs Jev on OpenRouter with only an OpenRouter key', async () => {
    const { runtime } = runtimeWith(['openrouter'], () => ({ answers: { contradicts: { type: 'bool', probability: 0.9 } }, usage: USAGE }));
    await runtime.runClassification({ ...REQ, purpose: 'memory-rerank' });
    expect(ledger()).toEqual([expect.objectContaining({ purpose: 'memory-rerank', provider: 'openrouter', model: '~typesafe/jev-latest' })]);
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'jev', via: 'openrouter' });
  });

  it('returns null without a classifier key and calls nothing', async () => {
    const { runtime, classify } = runtimeWith(['anthropic'], () => ({}));
    expect(runtime.hasClassifier()).toBe(false);
    expect(await runtime.runClassification(REQ)).toBeNull();
    expect(classify).not.toHaveBeenCalled();
  });

  it('returns null on an error, keeps its billed usage, and never logs the request text', async () => {
    const { runtime } = runtimeWith(['typesafe'], () => ({
      stopReason: 'error',
      usage: USAGE,
      errorMessage: `TypeSafe error (422): {"error":"bad state","echo":"${SECRET_FACT}"}`,
    }));
    expect(await runtime.runClassification(REQ)).toBeNull();
    expect(ledger()).toEqual([expect.objectContaining({ stopReason: 'error' })]);
    expect(logLines.join('\n')).not.toContain('hunter2');
    expect(logLines.join('\n')).toContain('typesafe/jev-latest ended with error: HTTP 422');
  });

  describe('a refused credential', () => {
    const REFUSED = (status: number) => ({ stopReason: 'error' as const, errorMessage: `OpenRouter error (${status}): {"error":{"message":"refused"}}` });

    afterEach(() => vi.restoreAllMocks());

    it('stops routing to the provider, reports why, and notifies the panel once', async () => {
      const { runtime, classify } = runtimeWith(['openrouter'], () => REFUSED(402));
      const changes = vi.fn();
      const stop = PiRuntime.onMemoryJudgeChange(changes);

      expect(await runtime.runClassification(REQ)).toBeNull();
      expect(runtime.hasClassifier()).toBe(false);
      expect(await runtime.runClassification(REQ)).toBeNull();
      expect(classify).toHaveBeenCalledTimes(1);
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'none', rejected: [{ via: 'openrouter', reason: 'payment-required' }] });
      expect(changes).toHaveBeenCalledTimes(1);
      expect(logLines.join('\n')).toContain('memory judges skip openrouter (payment-required)');
      stop();
    });

    it('subscribing to judge changes does not create the runtime', () => {
      const stop = PiRuntime.onMemoryJudgeChange(() => {});
      expect(PiRuntime.exists).toBe(false);
      stop();
    });

    it.each([
      ['moderation', `{"reasons":["harassment"],"flagged_input":"${SECRET_FACT}","provider_name":"x","model_slug":"y"}`],
      ['a guardrail', '{"patterns":["ignore all previous instructions"]}'],
      ['a content filter', '{"error_type":"content_policy_violation","provider_name":"x"}'],
      ['a model refusal', '{"error_type":"refusal","provider_name":"x"}'],
    ])('an OpenRouter 403 from %s refuses the input, not the key, so the breaker stays closed', async (_kind, metadata) => {
      const moderated = {
        stopReason: 'error' as const,
        errorMessage: `System One API error (403): {"error":{"code":403,"message":"Request blocked","metadata":${metadata}}}`,
      };
      const { runtime, classify } = runtimeWith(['openrouter'], () => (classify.mock.calls.length === 1 ? moderated : REFUSED(403)));

      await runtime.runClassification(REQ);
      expect(runtime.hasClassifier()).toBe(true);
      expect(logLines.join('\n')).not.toContain('hunter2');

      await runtime.runClassification(REQ);
      expect(runtime.describeMemoryJudge()).toMatchObject({ rejected: [{ via: 'openrouter', reason: 'forbidden' }] });
    });

    it('saving the same key again clears the refusal at once', async () => {
      const { runtime } = runtimeWith(['typesafe'], () => REFUSED(402));
      await runtime.runClassification(REQ);
      expect(runtime.hasClassifier()).toBe(false);

      runtime.resetClassifierBreaker('typesafe');
      expect(runtime.hasClassifier()).toBe(true);
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'jev', via: 'typesafe' });
    });

    it('logs no skip for a refusal that arrives after a reset made its request stale', async () => {
      let answer: (result: Partial<ClassifierResult>) => void = () => {};
      const { runtime, classify } = runtimeWith(['openrouter'], () => ({}));
      classify.mockImplementationOnce(
        (model) => new Promise((resolve) => {
          answer = (result) => resolve({ api: 'typesafe-system-one', provider: model.provider, model: model.id, answers: {}, stopReason: 'stop', timestamp: 0, ...result });
        }),
      );

      const pending = runtime.runClassification(REQ);
      runtime.resetClassifierBreaker('openrouter');
      answer(REFUSED(402));
      await pending;

      expect(runtime.hasClassifier()).toBe(true);
      expect(logLines.join('\n')).not.toContain('memory judges skip');
    });

    it('falls over from a refused TypeSafe key to OpenRouter', async () => {
      const answers = { contradicts: { type: 'bool' as const, probability: 0.9 } };
      const { runtime, classify } = runtimeWith(['typesafe', 'openrouter'], () => (classify.mock.calls.length === 1 ? REFUSED(401) : { answers }));

      expect(await runtime.runClassification(REQ)).toBeNull();
      expect(await runtime.runClassification(REQ)).toEqual(answers);
      expect(classify.mock.calls.map((call) => call[0].provider)).toEqual(['typesafe', 'openrouter']);
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'jev', via: 'openrouter', rejected: [{ via: 'typesafe', reason: 'unauthorized' }] });
    });

    it('never opens on a rate limit or a server error', async () => {
      const { runtime, classify } = runtimeWith(['openrouter'], () => (classify.mock.calls.length === 1 ? REFUSED(429) : REFUSED(503)));
      await runtime.runClassification(REQ);
      await runtime.runClassification(REQ);
      expect(classify).toHaveBeenCalledTimes(2);
      expect(runtime.hasClassifier()).toBe(true);
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'jev', via: 'openrouter' });
    });

    it('sends one probe after the cooldown and recovers when it is answered', async () => {
      const answers = { contradicts: { type: 'bool' as const, probability: 0.9 } };
      let now = 10_000_000;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const { runtime, classify } = runtimeWith(['openrouter'], () => (classify.mock.calls.length === 1 ? REFUSED(402) : { answers }));

      await runtime.runClassification(REQ);
      now += CLASSIFIER_PROBE_AFTER_MS;
      const probes = [runtime.runClassification(REQ), runtime.runClassification(REQ)];
      expect(await Promise.all(probes)).toEqual([answers, null]);
      expect(classify).toHaveBeenCalledTimes(2);
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'jev', via: 'openrouter' });
    });

    it('a new key from the provider sync clears the refusal at once', async () => {
      const { runtime, classify } = runtimeWith(['openrouter'], () => REFUSED(402));
      await runtime.runClassification(REQ);
      expect(runtime.hasClassifier()).toBe(false);

      const fake = (runtime as unknown as { _modelRuntime: Record<string, unknown> })._modelRuntime;
      Object.assign(fake, {
        setRuntimeApiKey: vi.fn(async () => {}),
        getProviderAuthStatus: () => ({ configured: false }),
      });
      await runtime.syncCustomProviders(async (key) => (key === 'damocles.explore.apiKey.openrouter' ? 'sk-or-new' : undefined));

      expect(runtime.hasClassifier()).toBe(true);
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'jev', via: 'openrouter' });
      await runtime.runClassification(REQ);
      expect(classify).toHaveBeenCalledTimes(2);
    });
  });

  it('returns null when an answer is missing or of the wrong type', async () => {
    const { runtime } = runtimeWith(['typesafe'], () => ({ answers: { contradicts: { type: 'score', score: 1, confidence: 1 } } }));
    expect(await runtime.runClassification(REQ)).toBeNull();
    const empty = runtimeWith(['typesafe'], () => ({ answers: {} }));
    expect(await empty.runtime.runClassification(REQ)).toBeNull();
    expect(ledger()).toEqual([]);
  });
});
