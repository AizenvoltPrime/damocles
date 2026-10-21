import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuitLifecycle, shutDown, type QuitApp, type ShutdownSteps } from '../shutdown';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function steps(overrides: Partial<ShutdownSteps> = {}): { steps: ShutdownSteps; order: string[]; lines: string[] } {
  const order: string[] = [];
  const lines: string[] = [];
  const step = (name: string) => async (): Promise<void> => {
    order.push(name);
  };
  return {
    order,
    lines,
    steps: {
      closeWindows: step('closeWindows'),
      disposeCore: step('disposeCore'),
      flushStores: step('flushStores'),
      disposeTerminals: step('disposeTerminals'),
      closeWatchers: step('closeWatchers'),
      closeTimeoutMs: 3_000,
      timeoutMs: 10_000,
      log: (line) => lines.push(line),
      ...overrides,
    },
  };
}

describe('shutDown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('disposes nothing a page can call until every window has closed and its requests settled', async () => {
    const closed = deferred();
    const { steps: run, order } = steps({
      closeWindows: async () => {
        order.push('closeWindows');
        await closed.promise;
        order.push('windowsClosed');
      },
    });

    const done = shutDown(run);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['closeWindows']);

    closed.resolve();
    await done;
    expect(order.slice(0, 2)).toEqual(['closeWindows', 'windowsClosed']);
    expect(order.slice(2).sort()).toEqual(['closeWatchers', 'disposeCore', 'disposeTerminals', 'flushStores']);
  });

  it('flushes the stores only once the core has disposed, which can still write them', async () => {
    const core = deferred();
    const { steps: run, order } = steps({
      disposeCore: async () => {
        order.push('disposeCore');
        await core.promise;
        order.push('coreDisposed');
      },
    });

    const done = shutDown(run);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).not.toContain('flushStores');

    core.resolve();
    await done;
    expect(order.indexOf('flushStores')).toBeGreaterThan(order.indexOf('coreDisposed'));
  });

  it('flushes the stores even when the core dispose fails', async () => {
    const { steps: run, order } = steps({
      disposeCore: () => Promise.reject(new Error('dispose failed')),
    });

    await expect(shutDown(run)).rejects.toThrow('dispose failed');
    expect(order).toContain('flushStores');
  });

  it('settles only once the file watchers have closed, so no native watcher work outlives the quit', async () => {
    const watchers = deferred();
    const { steps: run } = steps({ closeWatchers: () => watchers.promise });

    let settled = false;
    const done = shutDown(run).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    watchers.resolve();
    await done;
    expect(settled).toBe(true);
  });

  it('disposes the core, the terminals and the watchers and flushes the stores once the window\'s requests outlast their bound', async () => {
    vi.useFakeTimers();
    const { steps: run, order, lines } = steps({ closeWindows: () => new Promise<void>(() => undefined), closeTimeoutMs: 30, timeoutMs: 100 });

    const done = shutDown(run);
    await vi.advanceTimersByTimeAsync(29);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(order.sort()).toEqual(['closeWatchers', 'disposeCore', 'disposeTerminals', 'flushStores']);
    expect(lines).toEqual(['[shutdown] the window\'s requests did not settle within 30 ms; disposing anyway']);
  });

  it('gives up after the whole bound when the dispose hangs, so a hung teardown cannot block quitting', async () => {
    vi.useFakeTimers();
    const { steps: run, lines } = steps({ disposeCore: () => new Promise<void>(() => undefined), closeTimeoutMs: 30, timeoutMs: 50 });

    const done = shutDown(run);
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(lines).toEqual(['[shutdown] teardown did not finish within 50 ms; quitting anyway']);
  });
});

function quitApp(): QuitApp & { quits: number; relaunches: number; emitQuit(): void; lifecycle: QuitLifecycle | undefined } {
  const listeners = new Set<() => void>();
  const fake = {
    quits: 0,
    relaunches: 0,
    lifecycle: undefined as QuitLifecycle | undefined,
    // Electron emits before-quit inside app.quit().
    quit() {
      fake.quits++;
      fake.lifecycle?.onBeforeQuit({ preventDefault: () => undefined });
    },
    relaunch() {
      fake.relaunches++;
    },
    once(_event: 'quit', listener: () => void) {
      listeners.add(listener);
    },
    removeListener(_event: 'quit', listener: () => void) {
      listeners.delete(listener);
    },
    emitQuit() {
      for (const listener of [...listeners]) {
        listeners.delete(listener);
        listener();
      }
    },
  };
  return fake;
}

function lifecycle(answers: boolean[]): { quit: QuitLifecycle; app: ReturnType<typeof quitApp>; asked: () => number; answer: (proceed: boolean) => void; disposed: () => number } {
  const app = quitApp();
  const pending: Array<(proceed: boolean) => void> = [];
  let asked = 0;
  let disposed = 0;
  const quit = new QuitLifecycle({
    app,
    release: () => {
      asked++;
      const scripted = answers.shift();
      return scripted !== undefined ? Promise.resolve(scripted) : new Promise<boolean>((resolve) => pending.push(resolve));
    },
    dispose: async () => {
      disposed++;
    },
    log: () => undefined,
  });
  app.lifecycle = quit;
  return { quit, app, asked: () => asked, answer: (proceed) => pending.shift()!(proceed), disposed: () => disposed };
}

describe('QuitLifecycle', () => {
  it('shares one question among every close and quit that arrives while it is open', async () => {
    const { quit, asked, answer } = lifecycle([]);
    const closing = quit.release();
    const first = quit.quit();
    const second = quit.quit();
    quit.onBeforeQuit({ preventDefault: () => undefined });
    await new Promise((resolve) => setImmediate(resolve));
    expect(asked()).toBe(1);
    expect(quit.releasing).toBe(true);

    answer(false);
    await expect(Promise.all([closing, first, second])).resolves.toEqual([false, true, true]);
    expect(quit.phase).toBe('running');
    expect(quit.releasing).toBe(false);
  });

  it('asks again on the next quit after a cancelled one, and resolves false once the teardown ran', async () => {
    const { quit, app, asked, disposed } = lifecycle([false, true]);
    await expect(quit.quit()).resolves.toBe(true);
    expect(disposed()).toBe(0);
    await expect(quit.quit()).resolves.toBe(false);
    expect(asked()).toBe(2);
    expect(disposed()).toBe(1);
    expect(quit.phase).toBe('done');
    await new Promise((resolve) => setImmediate(resolve));
    // the final app.quit, which before-quit no longer prevents
    expect(app.quits).toBe(3);
  });

  it('arms the relaunch only for a quit nobody cancelled', async () => {
    const { quit, app } = lifecycle([false, true]);
    await quit.relaunch();
    app.emitQuit();
    expect(app.relaunches).toBe(0);

    await quit.relaunch();
    app.emitQuit();
    expect(app.relaunches).toBe(1);
  });
});
