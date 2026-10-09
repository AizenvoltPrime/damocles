import { describe, expect, it, vi } from 'vitest';
import { CoreHost } from '../core-host';

interface FakeCore {
  readonly id: number;
  dispose(): Promise<void>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// The promise's outcome so far, read after every pending reaction has run.
async function outcome<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown } | 'pending'> {
  let settled: { value: T } | { error: unknown } | 'pending' = 'pending';
  promise.then((value) => (settled = { value }), (error: unknown) => (settled = { error }));
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

function host(opts: { dispose?: (core: FakeCore) => Promise<void>; start?: (id: number) => void; openTabs?: () => Promise<void>; drainTimeoutMs?: number } = {}) {
  const started: FakeCore[] = [];
  const retained: boolean[] = [];
  const lines: string[] = [];
  const openTabs = vi.fn(opts.openTabs ?? (async () => undefined));
  const coreHost = new CoreHost<FakeCore>({
    start: () => {
      opts.start?.(started.length + 1);
      const core: FakeCore = { id: started.length + 1, dispose: () => (opts.dispose ? opts.dispose(core) : Promise.resolve()) };
      started.push(core);
      return core;
    },
    openTabs,
    retainTabStates: (retain) => retained.push(retain),
    log: (line) => lines.push(line),
    drainTimeoutMs: opts.drainTimeoutMs ?? 3_000,
  });
  return { coreHost, started, retained, lines, openTabs };
}

describe('CoreHost', () => {
  it('joins a reload requested while one runs, so only one new core starts', async () => {
    const teardown = deferred();
    const { coreHost, started } = host({ dispose: () => teardown.promise });
    coreHost.start();

    const first = coreHost.reload();
    const second = coreHost.reload();
    teardown.resolve();
    await Promise.all([first, second]);

    expect(started.map((core) => core.id)).toEqual([1, 2]);
    expect(coreHost.current()?.id).toBe(2);
  });

  it('starts no core for a reload that the quit overtook, and disposes the one it left', async () => {
    const teardown = deferred();
    const disposed: number[] = [];
    const { coreHost, started, openTabs, retained } = host({
      dispose: async (core) => {
        if (core.id === 1) await teardown.promise;
        disposed.push(core.id);
      },
    });
    coreHost.start();

    const reload = coreHost.reload();
    const waiting = coreHost.ready();
    const quit = coreHost.dispose();
    // The request settles while the old core still disposes, so it cannot hold up the quit.
    expect(await outcome(waiting)).toEqual({ error: new Error('Core services are stopped for the quit') });
    teardown.resolve();
    await Promise.all([reload, quit]);

    expect(started).toHaveLength(1);
    expect(disposed).toEqual([1]);
    expect(openTabs).not.toHaveBeenCalled();
    expect(retained).toEqual([true]);
    expect(coreHost.current()).toBeUndefined();
    await coreHost.reload();
    expect(started).toHaveLength(1);
  });

  it('clears the retained tab states and still starts a core when the old one fails to dispose', async () => {
    const { coreHost, started, retained, lines, openTabs } = host({
      dispose: async (core) => {
        if (core.id === 1) throw new Error('lease release failed');
      },
    });
    coreHost.start();

    await coreHost.reload();

    expect(retained).toEqual([true, false]);
    expect(lines.some((line) => line.startsWith('[core] dispose failed') && line.includes('lease release failed'))).toBe(true);
    expect(started).toHaveLength(2);
    expect(openTabs).toHaveBeenCalledOnce();
  });

  it('answers a request made while a reload disposes the old core with the core the reload starts, before its chats reopen', async () => {
    const teardown = deferred();
    const reopened = deferred();
    const { coreHost } = host({ dispose: () => teardown.promise, openTabs: () => reopened.promise });
    coreHost.start();
    expect((await coreHost.ready()).id).toBe(1);

    const reload = coreHost.reload();
    const waiting = coreHost.ready();
    expect(await outcome(waiting)).toBe('pending');
    teardown.resolve();

    expect(await outcome(waiting)).toEqual({ value: expect.objectContaining({ id: 2 }) });
    expect(await outcome(reload)).toBe('pending');
    reopened.resolve();
    await reload;
    expect((await coreHost.ready()).id).toBe(2);
  });

  it('refuses a request waiting on a reload whose new core fails to start', async () => {
    const teardown = deferred();
    const { coreHost } = host({
      dispose: () => teardown.promise,
      start: (id) => {
        if (id === 2) throw new Error('settings unreadable');
      },
    });
    coreHost.start();

    const reload = coreHost.reload();
    const waiting = coreHost.ready();
    teardown.resolve();

    await expect(reload).rejects.toThrow('settings unreadable');
    expect(await outcome(waiting)).toEqual({ error: new Error('settings unreadable') });
    await expect(coreHost.ready()).rejects.toThrow('Core services are not running');
  });

  it('refuses a request waiting on a reload as soon as the quit stops the host, and starts no core for that reload', async () => {
    const teardown = deferred();
    const { coreHost, started, openTabs } = host({ dispose: () => teardown.promise });
    coreHost.start();

    const reload = coreHost.reload();
    const waiting = coreHost.ready();
    coreHost.stop();

    expect(await outcome(waiting)).toEqual({ error: new Error('Core services are stopped for the quit') });
    teardown.resolve();
    await reload;
    expect(started).toHaveLength(1);
    expect(openTabs).not.toHaveBeenCalled();
  });

  it('raises no unhandled rejection for a reload the quit stopped while nothing waited on it', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const teardown = deferred();
      const { coreHost } = host({ dispose: () => teardown.promise });
      coreHost.start();
      const reload = coreHost.reload();
      coreHost.stop();
      teardown.resolve();
      await reload;
      await outcome(Promise.resolve());
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('answers with the live core once the quit stopped the host, until the core disposes', async () => {
    const { coreHost } = host();
    coreHost.start();

    coreHost.stop();
    expect((await coreHost.ready()).id).toBe(1);
    await coreHost.dispose();

    await expect(coreHost.ready()).rejects.toThrow('Core services are stopped for the quit');
  });
});

describe('CoreHost requests during a reload', () => {
  it('lets a request running on the old core finish before the reload disposes that core, and gives a request made meanwhile the new one', async () => {
    const held = deferred();
    const disposed: number[] = [];
    const { coreHost } = host({ dispose: async (core) => void disposed.push(core.id) });
    coreHost.start();

    const running = coreHost.run('rename', async (core) => {
      await held.promise;
      return core.id;
    });
    const reload = coreHost.reload();
    const later = coreHost.run('list', async (core) => core.id);
    expect(await outcome(reload)).toBe('pending');
    expect(await outcome(later)).toBe('pending');
    expect(disposed).toEqual([]);

    held.resolve();
    expect(await outcome(running)).toEqual({ value: 1 });
    await reload;
    expect(disposed).toEqual([1]);
    expect(await later).toBe(2);
  });

  it('runs a request at once on the running core, and reports what it threw', async () => {
    const { coreHost } = host();
    coreHost.start();
    let ran = false;
    const request = coreHost.run('select', () => {
      ran = true;
      throw new Error('no such chat');
    });
    expect(ran).toBe(true);
    await expect(request).rejects.toThrow('no such chat');
  });

  it('disposes the old core once a request still running on it reaches the bound, and logs it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { coreHost, started, lines } = host({ drainTimeoutMs: 3_000 });
      coreHost.start();
      void coreHost.run('selectChat', () => new Promise<never>(() => undefined));
      void coreHost.run('listChats', async () => undefined);
      const reload = coreHost.reload();

      await vi.advanceTimersByTimeAsync(2_999);
      expect(started).toHaveLength(1);
      expect(lines).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await reload;
      expect(started).toHaveLength(2);
      expect(lines).toEqual(['[core] reloading with a request still running on the old core after 3000 ms: selectChat']);

      // The next reload waits only for requests on the core it disposes.
      await coreHost.reload();
      expect(started).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a request waiting on the reload as soon as the quit stops the host while the reload waits for a request', async () => {
    const held = deferred();
    const { coreHost, started } = host();
    coreHost.start();
    const running = coreHost.run('rename', () => held.promise);
    const reload = coreHost.reload();
    const later = coreHost.run('list', async (core) => core.id);

    const quit = coreHost.dispose();
    expect(await outcome(later)).toEqual({ error: new Error('Core services are stopped for the quit') });
    held.resolve();
    await Promise.all([running, reload, quit]);
    expect(started).toHaveLength(1);
    expect(coreHost.current()).toBeUndefined();
  });
});

describe('CoreHost reopening the tabs', () => {
  it('takes a reload asked for while the tabs reopen only once they are back, answering requests meanwhile with the running core', async () => {
    const reopened = deferred();
    const disposed: number[] = [];
    let calls = 0;
    const { coreHost, started, openTabs } = host({
      dispose: async (core) => void disposed.push(core.id),
      openTabs: () => (++calls === 1 ? reopened.promise : Promise.resolve()),
    });
    coreHost.start();
    const opening = coreHost.openTabs();

    const reload = coreHost.reload();
    expect(await outcome(reload)).toBe('pending');
    expect(await coreHost.run('list', async (core) => core.id)).toBe(1);
    expect(disposed).toEqual([]);

    reopened.resolve();
    await Promise.all([opening, reload]);
    expect(disposed).toEqual([1]);
    expect(started).toHaveLength(2);
    expect(openTabs).toHaveBeenCalledTimes(2);

    // Once the tabs are back, a reload takes over at once: a request made right after it waits for the core it starts.
    const again = coreHost.reload();
    expect((await coreHost.ready()).id).toBe(3);
    await again;
  });

  it('leaves the reopening to a reload under way', async () => {
    const teardown = deferred();
    const { coreHost, openTabs } = host({ dispose: () => teardown.promise });
    coreHost.start();
    const reload = coreHost.reload();
    const opening = coreHost.openTabs();
    teardown.resolve();
    await Promise.all([reload, opening]);
    expect(openTabs).toHaveBeenCalledOnce();
  });

  it('starts no core for a reload asked for while the tabs reopen when the quit stops the host meanwhile', async () => {
    const reopened = deferred();
    const { coreHost, started, retained } = host({ openTabs: () => reopened.promise });
    coreHost.start();
    void coreHost.openTabs();
    const reload = coreHost.reload();
    const quit = coreHost.dispose();
    reopened.resolve();
    await Promise.all([reload, quit]);
    expect(started).toHaveLength(1);
    expect(retained).toEqual([]);
    expect(coreHost.current()).toBeUndefined();
  });
});
