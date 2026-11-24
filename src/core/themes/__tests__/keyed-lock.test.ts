import { describe, expect, it } from 'vitest';
import { createKeyedLock } from '../keyed-lock';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function gate(): { readonly open: () => void; readonly wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait };
}

describe('createKeyedLock', () => {
  it('runs the bodies of one key one after another, in arrival order', async () => {
    const lock = createKeyedLock();
    const order: string[] = [];
    const first = gate();
    const a = lock.run('k', undefined, async () => {
      order.push('a start');
      await first.wait;
      order.push('a end');
    });
    const b = lock.run('k', undefined, async () => { order.push('b'); });
    const c = lock.run('k', undefined, async () => { order.push('c'); });
    await tick();
    expect(order).toEqual(['a start']);
    first.open();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a start', 'a end', 'b', 'c']);
  });

  it('runs bodies of different keys side by side', async () => {
    const lock = createKeyedLock();
    const held = gate();
    const order: string[] = [];
    const a = lock.run('a', undefined, async () => { await held.wait; order.push('a'); });
    await lock.run('b', undefined, async () => { order.push('b'); });
    expect(order).toEqual(['b']);
    held.open();
    await a;
  });

  it('lets an aborted waiter leave the queue with the abort reason, and the next one still waits for the running body', async () => {
    const lock = createKeyedLock();
    const held = gate();
    const order: string[] = [];
    const a = lock.run('k', undefined, async () => { await held.wait; order.push('a'); });
    const abort = new AbortController();
    const b = lock.run('k', abort.signal, async () => { order.push('b'); });
    const reason = new Error('stopped');
    abort.abort(reason);
    await expect(b).rejects.toBe(reason);
    const c = lock.run('k', undefined, async () => { order.push('c'); });
    await tick();
    expect(order).toEqual([]);
    held.open();
    await Promise.all([a, c]);
    expect(order).toEqual(['a', 'c']);
  });

  it('keeps the key while the running body outlasts a later waiter that aborted', async () => {
    const lock = createKeyedLock();
    const held = gate();
    const a = lock.run('k', undefined, async () => { await held.wait; });
    const abort = new AbortController();
    const b = lock.run('k', abort.signal, async () => undefined);
    abort.abort(new Error('stopped'));
    await expect(b).rejects.toThrow('stopped');
    await tick();
    expect(lock.size()).toBe(1);
    held.open();
    await a;
    await tick();
    expect(lock.size()).toBe(0);
  });

  it('runs the waiter queued behind a body that throws, and keeps no key after', async () => {
    const lock = createKeyedLock();
    const held = gate();
    const order: string[] = [];
    const a = lock.run('k', undefined, async () => {
      await held.wait;
      throw new Error('no');
    });
    const b = lock.run('k', undefined, async () => { order.push('b'); });
    await tick();
    expect(order).toEqual([]);
    held.open();
    await expect(a).rejects.toThrow('no');
    await b;
    expect(order).toEqual(['b']);
    await tick();
    expect(lock.size()).toBe(0);
  });

  it('refuses at once with a signal already aborted', async () => {
    const lock = createKeyedLock();
    const abort = new AbortController();
    abort.abort(new Error('gone'));
    await expect(lock.run('k', abort.signal, async () => 1)).rejects.toThrow('gone');
  });

  it('keeps no key once its bodies are done, a failed one included', async () => {
    const lock = createKeyedLock();
    await lock.run('a', undefined, async () => 1);
    await expect(lock.run('b', undefined, async () => { throw new Error('no'); })).rejects.toThrow('no');
    await tick();
    expect(lock.size()).toBe(0);
  });
});
