import { describe, it, expect, vi, beforeEach } from 'vitest';

const runStructuredCompletion = vi.fn();
const hasAuthedSubCallModel = vi.fn();

/** Mock the PiRuntime the runner pulls its small/fast structured-completion sink from. */
function mockPiRuntime(): void {
  vi.doMock('../../pi-session/pi-runtime', () => ({
    PiRuntime: { get: () => ({ hasAuthedSubCallModel, runStructuredCompletion }) },
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
    runStructuredCompletion.mockResolvedValue({ rank: [1, 2, 3] });

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner();
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
    const runner = createMemorySubCallRunner();
    const result = await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'rerank' });

    expect(result).toEqual({ value: null, failure: 'no-model' });
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('null completion → transient', async () => {
    mockPiRuntime();
    hasAuthedSubCallModel.mockReturnValue(true);
    runStructuredCompletion.mockResolvedValue(null);

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner();
    const result = await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'extract' });

    expect(result).toEqual({ value: null, failure: 'transient' });
  });
});
