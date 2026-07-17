import { describe, it, expect, vi } from 'vitest';
import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai';
import { runStructuredCompletion, type PiCompleteFn } from '../structured-completion';

const MODEL = { id: 'claude-haiku-4-5-20251001', provider: 'anthropic' } as unknown as Model<Api>;

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, api: 'anthropic', provider: 'anthropic', model: 'm', usage: {} as never, stopReason, timestamp: 0 } as unknown as AssistantMessage;
}

const REQ = {
  systemPrompt: 'sys',
  userMessage: 'hi',
  outputToolName: 'submit_terms',
  outputToolDescription: 'desc',
  schema: { type: 'object', properties: { terms: { type: 'array', items: { type: 'string' } } }, required: ['terms'] },
};

describe('runStructuredCompletion', () => {
  it('returns the terminating tool call arguments as the structured output', async () => {
    const complete: PiCompleteFn = vi.fn(async () =>
      assistant([{ type: 'toolCall', id: '1', name: 'submit_terms', arguments: { terms: ['a', 'b'] } }]),
    );
    const out = await runStructuredCompletion<{ terms: string[] }>(complete, MODEL, REQ);
    expect(out).toEqual({ terms: ['a', 'b'] });
  });

  it('passes the schema-as-parameters and the system prompt through to complete()', async () => {
    const complete = vi.fn(async () => assistant([{ type: 'toolCall', id: '1', name: 'submit_terms', arguments: { terms: [] } }]));
    await runStructuredCompletion(complete as unknown as PiCompleteFn, MODEL, REQ);
    const [model, context] = complete.mock.calls[0] as [Model<Api>, Context];
    expect(model).toBe(MODEL);
    expect(context.systemPrompt).toBe('sys');
    expect(context.tools?.[0]).toMatchObject({ name: 'submit_terms', parameters: REQ.schema });
  });

  it('forwards signal + timeoutMs into the complete() options (credentials are resolved by the complete-fn itself)', async () => {
    const complete = vi.fn(async () => assistant([{ type: 'toolCall', id: '1', name: 'submit_terms', arguments: { terms: [] } }]));
    const abortSignal = new AbortController().signal;
    await runStructuredCompletion(complete as unknown as PiCompleteFn, MODEL, { ...REQ, abortSignal, timeoutMs: 1234 });
    const options = complete.mock.calls[0]?.[2] as { signal?: AbortSignal; timeoutMs?: number; apiKey?: unknown; headers?: unknown };
    expect(options.signal).toBe(abortSignal);
    expect(options.timeoutMs).toBe(1234);
    // No credential plumbing leaks into options — completeSimple resolves auth internally.
    expect(options.apiKey).toBeUndefined();
    expect(options.headers).toBeUndefined();
  });

  it('falls back to JSON parsed from text when the model answers in prose (no toolChoice forcing)', async () => {
    const complete: PiCompleteFn = vi.fn(async () => assistant([{ type: 'text', text: 'Here: {"terms":["x"]}' }]));
    const out = await runStructuredCompletion<{ terms: string[] }>(complete, MODEL, REQ);
    expect(out).toEqual({ terms: ['x'] });
  });

  it('returns null on an aborted/error completion', async () => {
    const aborted: PiCompleteFn = vi.fn(async () => assistant([], 'aborted'));
    expect(await runStructuredCompletion(aborted, MODEL, REQ)).toBeNull();
  });

  it('returns null when complete() throws (fail soft)', async () => {
    const throwing: PiCompleteFn = vi.fn(async () => { throw new Error('network'); });
    expect(await runStructuredCompletion(throwing, MODEL, REQ)).toBeNull();
  });

  it('returns null when there is neither a tool call nor parseable text', async () => {
    const empty: PiCompleteFn = vi.fn(async () => assistant([{ type: 'text', text: 'no json here' }]));
    expect(await runStructuredCompletion(empty, MODEL, REQ)).toBeNull();
  });
});
