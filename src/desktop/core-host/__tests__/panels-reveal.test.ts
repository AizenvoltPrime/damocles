// A reveal inside a device's work asks the daemon to show the panel on that device and settles once it did; core's own work
// and a local core, which has no actor, post the reveal panel op.
import { describe, expect, it, vi } from 'vitest';
import { processActor, type CoreEndpoint } from '../../core-protocol';
import { createCorePanels } from '../platform/panels';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function proxy() {
  const ops: unknown[] = [];
  const asked: unknown[] = [];
  const answers: Array<{ resolve: (shown: boolean) => void; reject: (err: Error) => void }> = [];
  const endpoint = {
    postPanel: (id: string, op: string, payload: unknown) => ops.push([id, op, payload]),
    request: (method: string, params: unknown) => {
      asked.push([method, params]);
      return new Promise<boolean>((resolve, reject) => answers.push({ resolve, reject }));
    },
    onPanel: () => ({ dispose: () => undefined }),
    onMirror: () => ({ dispose: () => undefined }),
    emit: () => undefined,
  } as unknown as CoreEndpoint;
  const host = createCorePanels({ endpoint, resourceRoot: '/app' }).attach('view-1');
  return { host, ops, asked, answers };
}

describe('a core panel\'s reveal', () => {
  it('asks the daemon to show it on the acting device, and settles with whether it shows there once the daemon answered', async () => {
    const { host, ops, asked, answers } = proxy();
    let settled: unknown = 'pending';
    void Promise.resolve(processActor.run('device-a', () => host.reveal(2))).then((shown) => (settled = shown));
    expect(asked).toEqual([['chats.reveal', { viewId: 'view-1', column: 2 }]]);
    expect(ops).toEqual([]);
    await settle();
    expect(settled).toBe('pending');
    answers[0]!.resolve(true);
    await vi.waitFor(() => expect(settled).toBe(true));
    const refused = processActor.run('device-a', () => host.reveal());
    answers[1]!.resolve(false);
    await expect(refused).resolves.toBe(false);
  });

  it('settles as not shown when the daemon\'s answer fails, so a caller waiting for it goes on and tells the user', async () => {
    const { host, answers } = proxy();
    const revealed = processActor.run('device-a', () => host.reveal());
    answers[0]!.reject(new Error('the connection closed'));
    await expect(revealed).resolves.toBe(false);
  });

  it('posts the reveal panel op outside every device\'s work', () => {
    const { host, ops, asked } = proxy();
    host.reveal();
    host.reveal(1);
    expect(ops).toEqual([['view-1', 'reveal', {}], ['view-1', 'reveal', { column: 1 }]]);
    expect(asked).toEqual([]);
  });
});
