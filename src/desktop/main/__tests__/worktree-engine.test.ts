import { describe, expect, it } from 'vitest';
import { finishHold, type DroppingConnection } from '../worktrees/engine';

function connection(lost = false): DroppingConnection & { drop(): void; close(): void; listeners(): number } {
  const onLost = new Set<(reason: string) => void>();
  const onClose = new Set<(reason: string) => void>();
  const subscribe = (set: Set<(reason: string) => void>) => (listener: (reason: string) => void) => {
    set.add(listener);
    return { dispose: () => void set.delete(listener) };
  };
  return {
    lost: () => lost,
    onLost: subscribe(onLost),
    onClose: subscribe(onClose),
    drop: () => {
      lost = true;
      for (const listener of onLost) listener('the transport dropped');
    },
    close: () => {
      for (const listener of onClose) listener('closed');
    },
    listeners: () => onLost.size + onClose.size,
  };
}

const hold = (release: () => Promise<void>, over?: DroppingConnection) => finishHold({
  call: async () => undefined,
  stopped: () => false,
  worktreeId: 'w1',
  hold: 'h1',
  release,
  ...(over ? { connection: over } : {}),
});

const never = (): Promise<void> => new Promise(() => undefined);

const settled = async (promise: Promise<void>): Promise<boolean> => {
  let done = false;
  void promise.then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

describe('a finish hold\'s release', () => {
  it('settles when the core stopped or its connection closed before answering, since that core let go of its holds as it went', async () => {
    await expect(hold(() => Promise.reject(new Error('The endpoint closed'))).release()).resolves.toBeUndefined();
  });

  it('waits for the core\'s answer while the remote connection stays up, and stops listening once it came', async () => {
    let answer: () => void = () => undefined;
    const over = connection();
    const released = hold(() => new Promise((resolve) => { answer = resolve; }), over).release();
    expect(await settled(released)).toBe(false);
    answer();
    await released;
    expect(over.listeners()).toBe(0);
  });

  // a drop can last the daemon's 3-hour hold; a send meanwhile waits in main, behind the release
  it('settles once the remote connection drops or closes, or at once when it already dropped', async () => {
    const dropping = connection();
    const dropped = hold(never, dropping).release();
    expect(await settled(dropped)).toBe(false);
    dropping.drop();
    expect(await settled(dropped)).toBe(true);
    expect(dropping.listeners()).toBe(0);

    const closing = connection();
    const closed = hold(never, closing).release();
    closing.close();
    expect(await settled(closed)).toBe(true);

    expect(await settled(hold(never, connection(true)).release())).toBe(true);
  });
});
