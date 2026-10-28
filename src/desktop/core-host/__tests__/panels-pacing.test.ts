import { describe, expect, it } from 'vitest';
import type { CoreEndpoint } from '../../core-protocol';
import { createCorePanels, PACE_CHARS } from '../platform/panels';

function panels() {
  const posted: Array<{ type: string; json: string }> = [];
  const asked: string[] = [];
  let answer: (() => void) | undefined;
  let fail: ((err: Error) => void) | undefined;
  const endpoint = {
    postPanel: (_id: string, op: string, payload: { type: string; json: string }) => {
      if (op === 'post') posted.push(payload);
    },
    request: (method: string, params: { viewId: string }) => {
      asked.push(`${method} ${params.viewId}`);
      return new Promise<void>((resolve, reject) => {
        answer = resolve;
        fail = reject;
      });
    },
    onPanel: () => ({ dispose: () => undefined }),
    onMirror: () => ({ dispose: () => undefined }),
    emit: () => undefined,
  } as unknown as CoreEndpoint;
  const host = createCorePanels({ endpoint, resourceRoot: '/app' }).attach('view-1');
  return { host, posted, asked, answer: () => answer!(), fail: (err: Error) => fail!(err) };
}

const text = (chars: number): { type: string; text: string } => ({ type: 'assistantReplay', text: 'x'.repeat(chars) });
const partial = (streamingText: string) => ({ type: 'partial', data: { type: 'partial', content: [], messageId: 'm1', streamingText } });
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('a core panel paces its posts by the queue toward its page', () => {
  it('asks views.drained once PACE_CHARS went out, and drained() settles only with the answer', async () => {
    const { host, asked, answer } = panels();
    await host.postMessage(text(PACE_CHARS / 2));
    await expect(host.drained!()).resolves.toBeUndefined();
    expect(asked).toEqual([]);
    await host.postMessage(text(PACE_CHARS / 2));
    expect(asked).toEqual(['views.drained view-1']);
    let drained = false;
    void host.drained!().then(() => { drained = true; });
    await settle();
    expect(drained).toBe(false);
    answer();
    await settle();
    expect(drained).toBe(true);
  });

  it('ends the pause when views.drained fails, so a replay awaiting drained() goes on and the held partials go out', async () => {
    const { host, posted, fail } = panels();
    await host.postMessage(text(PACE_CHARS));
    await host.postMessage(partial('a'));
    await host.postMessage(null);
    const drained = host.drained!();
    fail(new Error('Damocles Core stopped'));
    await expect(drained).resolves.toBeUndefined();
    await settle();
    expect(posted.map((post) => post.type)).toEqual(['assistantReplay', 'partial', '']);
  });

  it('keeps only the newest partial of a stream while the answer is out, and posts it on the answer or before the next other message', async () => {
    const { host, posted, answer } = panels();
    await host.postMessage(text(PACE_CHARS));
    for (const streamed of ['a', 'ab', 'abc']) await host.postMessage(partial(streamed));
    expect(posted.map((post) => post.type)).toEqual(['assistantReplay']);
    answer();
    await settle();
    expect(posted.slice(1).map((post) => JSON.parse(post.json) as unknown)).toEqual([partial('abc')]);
    await host.postMessage(text(PACE_CHARS));
    await host.postMessage(partial('abcd'));
    await host.postMessage(partial('abcde'));
    await host.postMessage({ type: 'toolStatus' });
    expect(posted.slice(2).map((post) => post.type === 'partial' ? (JSON.parse(post.json) as ReturnType<typeof partial>).data.streamingText : post.type)).toEqual(['assistantReplay', 'abcde', 'toolStatus']);
  });
});
