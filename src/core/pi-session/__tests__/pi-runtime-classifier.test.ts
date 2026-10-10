import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { ClassifierContext, ClassifierResult } from '@earendil-works/pi-ai';
import { installLogSink } from '../../logger';
import { PiRuntime, type ClassificationRequest } from '../pi-runtime';
import { JEV_VIA_OPENROUTER, JEV_VIA_TYPESAFE, classifierFailureCause, memoryJudgeOf, pickClassifierModel } from '../classifier-model';
import { SUBCALL_USAGE_LEDGER_PATH } from '../../paths';
import { CLASSIFIER_PROBE_AFTER_MS } from '../classifier-breaker';
import { PI_AGENT_DIR } from '../agent-dir';
import { installFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { createMemorySubCallRunner } from '../../memory/subcall-runner';
import { classifyContradiction } from '../../memory/classifier-judges';

const logLines: string[] = [];
beforeAll(() => {
  installLogSink({ appendLine: (line: string) => void logLines.push(line), show: () => {}, dispose: () => {} });
});

describe('pickClassifierModel', () => {
  it('prefers TypeSafe, then OpenRouter, then GPT-6 Luna, else none', () => {
    expect(pickClassifierModel(() => true)).toEqual(JEV_VIA_TYPESAFE);
    expect(pickClassifierModel((ref) => ref.provider !== 'typesafe')).toEqual({ provider: 'openrouter', id: '~typesafe/jev-latest' });
    expect(pickClassifierModel((ref) => ref.provider === 'openai')).toEqual({ provider: 'openai', id: 'gpt-6-luna' });
    expect(pickClassifierModel(() => false)).toBeNull();
  });

  it('serves GPT-6 Luna from the pi-ai catalog on the Decisions API', () => {
    const url = new URL('../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/openai.json', import.meta.url);
    const catalog = JSON.parse(fs.readFileSync(url, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(catalog['openai-decisions']?.['classifier:gpt-6-luna']).toMatchObject({ type: 'classifier', provider: 'openai', id: 'gpt-6-luna', api: 'openai-decisions' });
  });

  it('names the memory judge', () => {
    expect(memoryJudgeOf(JEV_VIA_OPENROUTER, { provider: 'anthropic', id: 'claude-haiku-5-5' })).toEqual({ kind: 'classifier', via: 'openrouter' });
    expect(memoryJudgeOf(null, { provider: 'anthropic', id: 'claude-haiku-5-5' })).toEqual({ kind: 'model', model: 'anthropic/claude-haiku-5-5' });
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
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'openrouter' });
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
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'typesafe' });
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
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'openrouter', rejected: [{ via: 'typesafe', reason: 'unauthorized' }] });
    });

    it('never opens on a rate limit or a server error', async () => {
      const { runtime, classify } = runtimeWith(['openrouter'], () => (classify.mock.calls.length === 1 ? REFUSED(429) : REFUSED(503)));
      await runtime.runClassification(REQ);
      await runtime.runClassification(REQ);
      expect(classify).toHaveBeenCalledTimes(2);
      expect(runtime.hasClassifier()).toBe(true);
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'openrouter' });
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
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'openrouter' });
    });

    it('while a probe is due the status names the classifier the probe goes to, and while it runs the fallback', async () => {
      const answers = { contradicts: { type: 'bool' as const, probability: 0.9 } };
      let now = 10_000_000;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      let answer: (result: Partial<ClassifierResult>) => void = () => {};
      const { runtime, classify } = runtimeWith(['typesafe', 'openrouter'], () => (classify.mock.calls.length === 1 ? REFUSED(402) : { answers }));
      await runtime.runClassification(REQ);
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'openrouter', rejected: [{ via: 'typesafe', reason: 'payment-required' }] });

      now += CLASSIFIER_PROBE_AFTER_MS;
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'typesafe' });

      classify.mockImplementationOnce(
        (model) => new Promise((resolve) => {
          answer = (result) => resolve({ api: 'typesafe-system-one', provider: model.provider, model: model.id, answers: {}, stopReason: 'stop', timestamp: 0, ...result });
        }),
      );
      const probe = runtime.runClassification(REQ);
      expect(classify.mock.calls.at(-1)![0]).toMatchObject({ provider: 'typesafe' });
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'openrouter', rejected: [{ via: 'typesafe', reason: 'payment-required' }] });

      answer({ answers });
      expect(await probe).toEqual(answers);
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'typesafe' });
    });

    it('tells judge listeners when a refused provider becomes due for its probe', async () => {
      vi.useFakeTimers();
      try {
        const { runtime } = runtimeWith(['openrouter'], () => REFUSED(402));
        await runtime.runClassification(REQ);
        const changes = vi.fn();
        const stop = PiRuntime.onMemoryJudgeChange(changes);
        vi.advanceTimersByTime(CLASSIFIER_PROBE_AFTER_MS);
        expect(changes).toHaveBeenCalledTimes(1);
        stop();
      } finally {
        vi.useRealTimers();
      }
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
      expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'openrouter' });
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

/**
 * `damocles.memory.judge*` through `PiRuntime.resolveMemoryJudge`, which classification, the merge and rerank
 * sub-calls and the status line all read. Chat models come from the catalog files pi-ai ships, so the clamp sees
 * real level maps.
 */
describe('PiRuntime memory judge', () => {
  const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const USAGE = { ...ZERO, input: 300, totalTokens: 300, cost: { ...ZERO.cost, input: 0.00003, total: 0.00003 } };
  const ANSWERS = { contradicts: { type: 'bool' as const, probability: 0.9 } };
  const REQ: ClassificationRequest = {
    state: { new_fact: 'a', existing_fact: 'b' },
    questions: { contradicts: { type: 'bool', instructions: 'i', criteria: { true: 't', false: 'f' } } },
    purpose: 'memory-rerank',
    timeoutMs: 1000,
  };
  const SUB_CALL = { systemPrompt: 's', userMessage: 'u', outputToolName: 'submit_result', outputToolDescription: 'd', schema: { type: 'object' } };

  function chatModel(file: string, api: string, id: string): { provider: string; id: string } {
    const url = new URL(`../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/${file}`, import.meta.url);
    return (JSON.parse(fs.readFileSync(url, 'utf8')) as Record<string, Record<string, { provider: string; id: string }>>)[api]![`chat:${id}`]!;
  }
  const CHAT_MODELS = [
    chatModel('anthropic.json', 'anthropic-messages', 'claude-haiku-5-5'),
    chatModel('anthropic.json', 'anthropic-messages', 'claude-sonnet-5-5'),
    chatModel('openai.json', 'openai-responses', 'gpt-6-luna'),
  ];

  interface Options {
    configured: string[];
    openaiKey?: boolean;
    settings?: Record<string, unknown>;
    classify?: () => Partial<ClassifierResult>;
  }

  function judged(opts: Options) {
    const platform: FakePlatform = installFakePlatform({ settings: { user: opts.settings ?? {} } });
    const runtime = PiRuntime.get();
    const configured = new Set(opts.configured);
    const sent: Array<{ model: string; reasoning: unknown }> = [];
    const fake = {
      hasConfiguredAuth: (p: string) => configured.has(p),
      getModel: (provider: string, id: string) => CHAT_MODELS.find((m) => m.provider === provider && m.id === id),
      getModelOfType: (type: string, provider: string, id: string) => ({ type, provider, id, api: provider === 'openai' ? 'openai-decisions' : 'typesafe-system-one' }),
      classify: vi.fn(async (model: { provider: string; id: string; api: string }, _ctx: ClassifierContext, _opts: unknown) => ({
        api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason: 'stop', timestamp: 0, ...(opts.classify?.() ?? { answers: ANSWERS, usage: USAGE }),
      })),
      completeSimple: vi.fn(async (m: { provider: string; id: string }, _c: unknown, options: Record<string, unknown>) => {
        sent.push({ model: `${m.provider}/${m.id}`, reasoning: options['reasoning'] });
        return { role: 'assistant', stopReason: 'toolUse', usage: ZERO, content: [{ type: 'toolCall', id: '1', name: 'submit_result', arguments: { contradicts: false } }] };
      }),
    };
    const internals = runtime as unknown as { _modelRuntime: unknown; _folders: Map<string, unknown>; _openaiKeyPresent: boolean };
    internals._modelRuntime = fake;
    internals._folders.set('/ws', {});
    internals._openaiKeyPresent = opts.openaiKey ?? false;
    return { runtime, platform, fake, configured, sent };
  }

  const ledger = (): Array<Record<string, unknown>> =>
    fs.existsSync(SUBCALL_USAGE_LEDGER_PATH)
      ? fs.readFileSync(SUBCALL_USAGE_LEDGER_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  const signInChatGPT = (): void => {
    fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(PI_AGENT_DIR, 'auth.json'), JSON.stringify({ openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 9_999_999_999_999 } }));
  };

  afterEach(async () => {
    fs.rmSync(SUBCALL_USAGE_LEDGER_PATH, { force: true });
    fs.rmSync(path.join(PI_AGENT_DIR, 'auth.json'), { force: true });
    await PiRuntime.disposeInstance();
  });

  it('Automatic takes TypeSafe, then OpenRouter, then GPT-6 Luna, then the small-model order', () => {
    const { runtime, configured } = judged({ configured: ['typesafe', 'openrouter', 'openai', 'anthropic'], openaiKey: true });
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'typesafe' });
    configured.delete('typesafe');
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'openrouter' });
    configured.delete('openrouter');
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'openai' });
    configured.delete('openai');
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'model', model: 'anthropic/claude-haiku-5-5' });
    expect(runtime.hasClassifier()).toBe(false);
  });

  it('judges on GPT-6 Luna through the Decisions API with only an OpenAI API key, and bills it to openai/gpt-6-luna', async () => {
    const { runtime, fake } = judged({ configured: ['openai'], openaiKey: true });
    expect(runtime.classifierCredentials()).toEqual({ typesafe: 'no-key', openrouter: 'no-key', openai: 'ok' });
    expect(await runtime.runClassification(REQ)).toEqual(ANSWERS);
    expect(fake.classify.mock.calls[0]![0]).toMatchObject({ provider: 'openai', id: 'gpt-6-luna', api: 'openai-decisions' });
    expect(ledger()).toEqual([expect.objectContaining({ purpose: 'memory-rerank', provider: 'openai', model: 'gpt-6-luna' })]);
  });

  it('never sends a Decisions request while ChatGPT is the active OpenAI credential', async () => {
    signInChatGPT();
    const { runtime, platform, fake } = judged({ configured: ['openai'], openaiKey: true });
    expect(runtime.classifierCredentials().openai).toBe('chatgpt-active');
    expect(runtime.hasClassifier()).toBe(false);
    expect(await runtime.runClassification(REQ)).toBeNull();
    expect(fake.classify).not.toHaveBeenCalled();
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'model', model: 'openai/gpt-6-luna' });

    await platform.settings.update('damocles.memory.judge', 'gpt-6-luna-classifier', 'user');
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'none', forced: { choice: 'gpt-6-luna-classifier', reason: 'chatgpt-active' } });

    await platform.state.global.update('damocles.openai.preferApiKey', true);
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'openai' });
  });

  it('a 401 on GPT-6 Luna opens its breaker, Automatic moves on, and an OpenAI credential change closes it', async () => {
    const { runtime } = judged({
      configured: ['openai', 'anthropic'],
      openaiKey: true,
      classify: () => ({ stopReason: 'error', errorMessage: 'OpenAI Decisions error (401): {"error":{"message":"bad key"}}' }),
    });
    expect(await runtime.runClassification(REQ)).toBeNull();
    expect(runtime.hasClassifier()).toBe(false);
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'model', model: 'anthropic/claude-haiku-5-5', rejected: [{ via: 'openai', reason: 'unauthorized' }] });

    (runtime as unknown as { _openaiCredentialChanged: () => void })._openaiCredentialChanged();
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'openai' });
  });

  it('Automatic moves on to the next classifier when one has no model in the catalog', async () => {
    const { runtime, fake } = judged({ configured: ['typesafe', 'openrouter', 'anthropic'] });
    Object.assign(fake, {
      getModelOfType: (type: string, provider: string, id: string) => (provider === 'typesafe' ? undefined : { type, provider, id, api: 'typesafe-system-one' }),
    });
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'openrouter' });
    expect(await runtime.runClassification(REQ)).toEqual(ANSWERS);
    expect(fake.classify.mock.calls[0]![0]).toMatchObject({ provider: 'openrouter' });
  });

  it('a chosen classifier with its key but no model in the catalog is reported as missing from the catalog, not keyless', async () => {
    const { runtime, fake } = judged({ configured: ['typesafe', 'openrouter', 'anthropic'], settings: { 'damocles.memory.judge': 'jev-typesafe' } });
    Object.assign(fake, {
      getModelOfType: (type: string, provider: string, id: string) => (provider === 'typesafe' ? undefined : { type, provider, id, api: 'typesafe-system-one' }),
    });
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'none', forced: { choice: 'jev-typesafe', reason: 'not-in-catalog' } });
    expect(await runtime.runClassification(REQ)).toBeNull();
    expect(fake.classify).not.toHaveBeenCalled();
  });

  it('a stored judge outside the catalog is no judge, reported as unrecognized rather than signed out', () => {
    const { runtime } = judged({ configured: ['anthropic', 'typesafe'], settings: { 'damocles.memory.judge': 'claude-opus-1' } });
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'none', forced: { choice: 'claude-opus-1', reason: 'unrecognized' } });
    expect(runtime.hasAuthedSubCallModel('memory-merge')).toBe(false);
  });

  it('a chosen catalog model whose provider is signed out is reported as signed out', () => {
    const { runtime } = judged({ configured: ['typesafe'], settings: { 'damocles.memory.judge': 'claude-sonnet-5-5' } });
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'none', forced: { choice: 'claude-sonnet-5-5', reason: 'signed-out' } });
  });

  // auth.json is read synchronously with sleeping retries, inside the injection's time cap.
  it('reads the OpenAI auth state once per judge resolution', async () => {
    const { runtime } = judged({ configured: ['typesafe', 'openrouter', 'openai', 'anthropic'], openaiKey: true });
    const reads = vi.spyOn(runtime, 'getOpenAIAuthStatus');
    runtime.describeMemoryJudge();
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockClear();
    await runtime.runClassification(REQ);
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockClear();
    runtime.classifierCredentials();
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('a chosen Jev on TypeSafe with no key is no judge, and merges defer without a request to anything else', async () => {
    const { runtime, fake } = judged({ configured: ['openrouter', 'openai', 'anthropic'], openaiKey: true, settings: { 'damocles.memory.judge': 'jev-typesafe' } });
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'none', forced: { choice: 'jev-typesafe', reason: 'no-key' } });
    expect(runtime.hasAuthedSubCallModel('memory-merge')).toBe(false);
    expect(runtime.hasAuthedSubCallModel('memory-rerank')).toBe(false);
    expect(runtime.hasAuthedSubCallModel('memory-extract')).toBe(true);

    const runner = createMemorySubCallRunner(new AbortController().signal);
    expect(await classifyContradiction(runner, 'new', 'old')).toBeNull();
    expect(await runner.run({ purpose: 'merge', prompt: 'p', systemPrompt: 's', schema: { type: 'object' } })).toEqual({ value: null, failure: 'no-model' });
    expect(await runtime.runStructuredCompletion({ ...SUB_CALL, purpose: 'memory-rerank' })).toEqual({ kind: 'unreachable' });
    expect(fake.classify).not.toHaveBeenCalled();
    expect(fake.completeSimple).not.toHaveBeenCalled();
  });

  it('a chosen classifier whose key was refused is no judge until its key changes', async () => {
    const { runtime, fake } = judged({
      configured: ['typesafe', 'openrouter'],
      settings: { 'damocles.memory.judge': 'jev-typesafe' },
      classify: () => ({ stopReason: 'error', errorMessage: 'System One API error (402): {}' }),
    });
    await runtime.runClassification(REQ);
    expect(runtime.describeMemoryJudge()).toEqual({
      kind: 'none',
      forced: { choice: 'jev-typesafe', reason: 'rejected' },
      rejected: [{ via: 'typesafe', reason: 'payment-required' }],
    });
    expect(await runtime.runClassification(REQ)).toBeNull();
    expect(fake.classify).toHaveBeenCalledTimes(1);

    runtime.resetClassifierBreaker('typesafe');
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'typesafe' });
  });

  it('a chosen Sonnet 5.5 at High runs merge and rerank as structured completions at high, and the writing jobs stay on the Background model', async () => {
    const { runtime, fake, sent } = judged({
      configured: ['anthropic', 'typesafe'],
      settings: { 'damocles.memory.judge': 'claude-sonnet-5-5', 'damocles.memory.judgeEffort': 'high' },
    });
    expect(runtime.hasClassifier()).toBe(false);
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'model', model: 'anthropic/claude-sonnet-5-5' });
    for (const purpose of ['memory-merge', 'memory-rerank', 'memory-extract'] as const) {
      expect(await runtime.runStructuredCompletion({ ...SUB_CALL, purpose })).toEqual({ kind: 'answered', value: { contradicts: false } });
    }
    expect(sent).toEqual([
      { model: 'anthropic/claude-sonnet-5-5', reasoning: 'high' },
      { model: 'anthropic/claude-sonnet-5-5', reasoning: 'high' },
      { model: 'anthropic/claude-haiku-5-5', reasoning: 'low' },
    ]);
    expect(fake.classify).not.toHaveBeenCalled();
  });

  it('the Background setting never changes the judge, nor its fallback after a classifier', async () => {
    const { runtime, configured, sent } = judged({
      configured: ['anthropic'],
      settings: { 'damocles.background.model': 'claude-sonnet-5-5', 'damocles.background.effort': 'high' },
    });
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'model', model: 'anthropic/claude-haiku-5-5' });
    await runtime.runStructuredCompletion({ ...SUB_CALL, purpose: 'memory-merge' });
    configured.add('typesafe');
    expect(runtime.describeMemoryJudge()).toEqual({ kind: 'classifier', via: 'typesafe' });
    await runtime.runStructuredCompletion({ ...SUB_CALL, purpose: 'memory-rerank' });
    await runtime.runStructuredCompletion({ ...SUB_CALL, purpose: 'session-title' });
    expect(sent).toEqual([
      { model: 'anthropic/claude-haiku-5-5', reasoning: 'low' },
      { model: 'anthropic/claude-haiku-5-5', reasoning: 'low' },
      { model: 'anthropic/claude-sonnet-5-5', reasoning: 'high' },
    ]);
  });
});
