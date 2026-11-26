import { describe, expect, it, vi } from 'vitest';
import type { OwnRun, Run } from '../../../daemon/control-messages';
import type { RemoteConnection } from '../connection';
import { followOwnRuns } from '../own-runs';

const chat = (id: string): OwnRun => ({ kind: 'chat', id, projectKey: '/srv/app', title: id, state: 'running', providers: [] });

// A connection whose runs events the test fires and whose listOwnRuns answers resolve when the test says.
function connection() {
  const listeners = new Set<(runs: readonly Run[]) => void>();
  const answers: Array<(runs: readonly OwnRun[]) => void> = [];
  const request = vi.fn(() => new Promise<{ runs: readonly OwnRun[] }>((resolve) => answers.push((runs) => resolve({ runs }))));
  const fake = {
    onRuns: (listener: (runs: readonly Run[]) => void) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    control: { request },
  } as unknown as Pick<RemoteConnection, 'onRuns' | 'control'>;
  return { fake, request, answers, fire: () => { for (const listener of listeners) listener([]); } };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('this device\'s own runs', () => {
  it('counts the chat runs listOwnRuns answers after each runs event, one request at a time, asking once more for events during one', async () => {
    const { fake, request, answers, fire } = connection();
    const own = followOwnRuns(fake, () => undefined);
    expect(own.count()).toBe(0);
    fire();
    fire();
    fire();
    expect(request).toHaveBeenCalledTimes(1);
    answers.shift()!([chat('a'), chat('b')]);
    await settle();
    expect(own.count()).toBe(2);
    expect(request).toHaveBeenCalledTimes(2);
    answers.shift()!([chat('a')]);
    await settle();
    expect(own.count()).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
    own.dispose();
    fire();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps the last count and logs when a request fails', async () => {
    const { fake, request, answers, fire } = connection();
    const lines: string[] = [];
    const own = followOwnRuns(fake, (line) => lines.push(line));
    fire();
    answers.shift()!([chat('a')]);
    await settle();
    request.mockImplementationOnce(() => Promise.reject(new Error('closed')));
    fire();
    await settle();
    expect(own.count()).toBe(1);
    expect(lines).toEqual(['[remote] listing this device\'s runs failed: closed']);
  });
});
