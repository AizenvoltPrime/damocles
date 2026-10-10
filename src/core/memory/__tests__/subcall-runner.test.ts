import { describe, it, expect, vi, beforeEach } from 'vitest';

const runStructuredCompletion = vi.fn();
const hasAuthedSubCallModel = vi.fn();
const runClassification = vi.fn();
const hasClassifier = vi.fn();

/** Mock the PiRuntime the runner pulls its small/fast structured-completion sink from. */
function mockPiRuntime(): void {
  vi.doMock('../../pi-session/pi-runtime', () => ({
    PiRuntime: { get: () => ({ hasAuthedSubCallModel, runStructuredCompletion, runClassification, hasClassifier }) },
  }));
}

describe('createMemorySubCallRunner', () => {
  beforeEach(() => {
    vi.resetModules();
    runStructuredCompletion.mockReset();
    hasAuthedSubCallModel.mockReset();
  });

  it('returns the structured value when the runtime resolves one', async () => {
    mockPiRuntime();
    hasAuthedSubCallModel.mockReturnValue(true);
    runStructuredCompletion.mockResolvedValue({ kind: 'answered', value: { rank: [1, 2, 3] } });

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(new AbortController().signal);
    const result = await runner.run<{ rank: number[] }>({
      prompt: 'p',
      systemPrompt: 's',
      schema: { type: 'object' },
      purpose: 'rerank',
    });

    expect(result).toEqual({ value: { rank: [1, 2, 3] } });
    expect(runStructuredCompletion).toHaveBeenCalledOnce();
  });

  it('no authed sub-call model → no-model (without touching the completion sink)', async () => {
    mockPiRuntime();
    hasAuthedSubCallModel.mockReturnValue(false);

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(new AbortController().signal);
    const result = await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'rerank' });

    expect(result).toEqual({ value: null, failure: 'no-model' });
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it.each(['unanswered', 'rejected', 'unreachable'] as const)('a %s completion surfaces as that failure kind', async (kind) => {
    mockPiRuntime();
    hasAuthedSubCallModel.mockReturnValue(true);
    runStructuredCompletion.mockResolvedValue({ kind });

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(new AbortController().signal);
    const result = await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'extract' });

    expect(result).toEqual({ value: null, failure: kind });
  });

  it('an unreachable completion with a credential cause surfaces as a credential failure', async () => {
    mockPiRuntime();
    hasAuthedSubCallModel.mockReturnValue(true);
    runStructuredCompletion.mockResolvedValue({ kind: 'unreachable', cause: 'credential' });

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(new AbortController().signal);
    const result = await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'extract' });

    expect(result).toEqual({ value: null, failure: 'credential' });
  });

  it('routes classify to the runtime under the memory ledger purpose', async () => {
    mockPiRuntime();
    hasClassifier.mockReturnValue(true);
    runClassification.mockResolvedValue({ q: { type: 'bool', probability: 0.9 } });

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(new AbortController().signal);
    const questions = { q: { type: 'bool' as const, instructions: 'i', criteria: { true: 't', false: 'f' } } };
    expect(runner.hasClassifier?.()).toBe(true);
    expect(await runner.classify?.({ purpose: 'merge', state: { a: 'x' }, questions, timeoutMs: 5 })).toEqual({ q: { type: 'bool', probability: 0.9 } });
    expect(runClassification).toHaveBeenCalledWith({ state: { a: 'x' }, questions, purpose: 'memory-merge', timeoutMs: 5, abortSignal: expect.any(AbortSignal) });
  });

  it('after the lifetime aborts, resolves without a value and never reaches the runtime', async () => {
    mockPiRuntime();
    hasAuthedSubCallModel.mockReturnValue(true);
    hasClassifier.mockReturnValue(true);
    runClassification.mockReset();
    const lifetime = new AbortController();
    lifetime.abort();

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(lifetime.signal);
    const questions = { q: { type: 'bool' as const, instructions: 'i', criteria: { true: 't', false: 'f' } } };

    expect(await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'extract' })).toEqual({ value: null, failure: 'unreachable' });
    expect(runner.hasClassifier?.()).toBe(false);
    expect(await runner.classify?.({ purpose: 'merge', state: {}, questions, timeoutMs: 5 })).toBeNull();
    expect(runStructuredCompletion).not.toHaveBeenCalled();
    expect(runClassification).not.toHaveBeenCalled();
  });

  it('aborting the lifetime cancels a call in flight, alongside the caller signal', async () => {
    mockPiRuntime();
    hasAuthedSubCallModel.mockReturnValue(true);
    runStructuredCompletion.mockResolvedValue({ kind: 'unreachable' });
    const lifetime = new AbortController();
    const caller = new AbortController();

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(lifetime.signal);
    await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'extract', abortSignal: caller.signal });
    await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'extract' });

    const [withCaller, withoutCaller] = runStructuredCompletion.mock.calls.map((call) => (call[0] as { abortSignal: AbortSignal }).abortSignal);
    expect(withCaller!.aborted).toBe(false);
    lifetime.abort();
    expect(withCaller!.aborted).toBe(true);
    expect(withoutCaller!.aborted).toBe(true);
  });
});
