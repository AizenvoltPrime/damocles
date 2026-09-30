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

function host(opts: { dispose?: (core: FakeCore) => Promise<void> } = {}) {
  const started: FakeCore[] = [];
  const retained: boolean[] = [];
  const lines: string[] = [];
  const openTabs = vi.fn(async () => undefined);
  const coreHost = new CoreHost<FakeCore>({
    start: () => {
      const core: FakeCore = { id: started.length + 1, dispose: () => (opts.dispose ? opts.dispose(core) : Promise.resolve()) };
      started.push(core);
      return core;
    },
    openTabs,
    retainTabStates: (retain) => retained.push(retain),
    log: (line) => lines.push(line),
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
    const quit = coreHost.dispose();
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
});
