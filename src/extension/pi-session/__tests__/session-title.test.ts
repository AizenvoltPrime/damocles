import { describe, it, expect, vi, type Mock } from 'vitest';
import { generateSessionTitle, type TitleRuntime } from '../session-title';
import type { StructuredCompletionRequest } from '../structured-completion';

/**
 * The AI session-title sub-call extracted from pi-session.ts. A stub `TitleRuntime` drives the
 * auth gate, the structured-completion call, and the title extraction.
 */

type StructuredCompletionSpy = Mock<(req: StructuredCompletionRequest) => Promise<unknown>> &
  TitleRuntime['runStructuredCompletion'];

function stubRuntime(opts: { authed: boolean; result: { title?: string } | null }): TitleRuntime & {
  runStructuredCompletion: StructuredCompletionSpy;
} {
  // `Mock<T>` erases the call signature's own type parameter, so a spy cannot BE a generic
  // `runStructuredCompletion<T>`. The intersection keeps both surfaces.
  const runStructuredCompletion = vi.fn(async () => opts.result) as StructuredCompletionSpy;
  return { hasAuthedSubCallModel: () => opts.authed, runStructuredCompletion };
}

describe('generateSessionTitle', () => {
  it('returns null without calling the model when no sub-call model is authed', async () => {
    const runtime = stubRuntime({ authed: false, result: { title: 'X' } });
    expect(await generateSessionTitle('exchange', runtime)).toBeNull();
    expect(runtime.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('returns the trimmed title on success', async () => {
    const runtime = stubRuntime({ authed: true, result: { title: '  Fix The Bug  ' } });
    expect(await generateSessionTitle('exchange', runtime)).toBe('Fix The Bug');
  });

  it('returns null when the model returns an empty/whitespace title', async () => {
    expect(await generateSessionTitle('exchange', stubRuntime({ authed: true, result: { title: '   ' } }))).toBeNull();
    expect(await generateSessionTitle('exchange', stubRuntime({ authed: true, result: { title: '' } }))).toBeNull();
  });

  it('returns null when the model returns no result / no title field', async () => {
    expect(await generateSessionTitle('exchange', stubRuntime({ authed: true, result: null }))).toBeNull();
    expect(await generateSessionTitle('exchange', stubRuntime({ authed: true, result: {} }))).toBeNull();
  });

  it('forwards the exchange as the user message with the title schema/tool', async () => {
    const runtime = stubRuntime({ authed: true, result: { title: 'Ok' } });
    await generateSessionTitle('the first exchange', runtime);
    const req = runtime.runStructuredCompletion.mock.calls[0]![0];
    expect(req.userMessage).toBe('the first exchange');
    expect(req.outputToolName).toBe('set_session_title');
    expect(req.schema).toMatchObject({ type: 'object', required: ['title'] });
    expect(req.timeoutMs).toBe(15_000);
  });
});
