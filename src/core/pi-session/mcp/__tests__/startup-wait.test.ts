import { describe, it, expect, vi, afterEach } from 'vitest';
import { MCP_STARTUP_WAIT_MS, waitForPendingDirectServers } from '../startup-wait';

/** A source whose servers stay pending until `settle` empties the list and emits tools-changed. */
function source(initial: string[]) {
  let pending = [...initial];
  const listeners = new Set<() => void>();
  return {
    pendingDirectServers: () => [...pending],
    onToolsChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settle: (remaining: string[] = []) => {
      pending = remaining;
      for (const listener of [...listeners]) listener();
    },
    listeners,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForPendingDirectServers', () => {
  it('is 10 s, pi’s startup wait', () => {
    expect(MCP_STARTUP_WAIT_MS).toBe(10_000);
  });

  it('answers ready at once when nothing is pending, without subscribing', async () => {
    const s = source([]);
    await expect(waitForPendingDirectServers(s, new AbortController().signal)).resolves.toBe('ready');
    expect(s.listeners.size).toBe(0);
  });

  it('a server that connects in time ends the wait then, not at the cap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = source(['slow', 'other']);
    let outcome: string | undefined;
    const waiting = waitForPendingDirectServers(s, new AbortController().signal).then((value) => { outcome = value; });

    await vi.advanceTimersByTimeAsync(3_000);
    s.settle(['other']);
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeUndefined();

    s.settle();
    await waiting;
    expect(outcome).toBe('ready');
    expect(s.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a server that never connects lets the prompt proceed at the cap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = source(['never']);
    let outcome: string | undefined;
    const waiting = waitForPendingDirectServers(s, new AbortController().signal).then((value) => { outcome = value; });

    await vi.advanceTimersByTimeAsync(MCP_STARTUP_WAIT_MS - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(outcome).toBe('timeout');
    expect(s.listeners.size).toBe(0);
  });

  it('a stop ends the wait early, and an already-stopped signal never waits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = source(['never']);
    const stop = new AbortController();
    const waiting = waitForPendingDirectServers(s, stop.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    stop.abort();
    await expect(waiting).resolves.toBe('aborted');
    expect(s.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    await expect(waitForPendingDirectServers(s, stop.signal)).resolves.toBe('aborted');
  });

  it('a source that reports the change while subscribing ends the wait, releasing everything', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let pending = ['racing'];
    const listeners = new Set<() => void>();
    const eager = {
      pendingDirectServers: () => [...pending],
      onToolsChanged: (listener: () => void) => {
        listeners.add(listener);
        pending = [];
        listener();
        return () => listeners.delete(listener);
      },
    };
    const stop = new AbortController();
    const addAbortListener = vi.spyOn(stop.signal, 'addEventListener');

    await expect(waitForPendingDirectServers(eager, stop.signal)).resolves.toBe('ready');
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(addAbortListener).not.toHaveBeenCalled();
  });
});
