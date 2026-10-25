import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ children: [] as Array<{ child: unknown; entry: string; options: unknown }>, app: undefined as unknown }));
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  const { PassThrough: Stream } = await import('node:stream');
  H.app = new Emitter();
  return {
    app: H.app,
    utilityProcess: {
      fork: (entry: string, _args: string[], options: unknown) => {
        const child = Object.assign(new Emitter(), { pid: 4242, stderr: new Stream(), postMessage: vi.fn(), kill: vi.fn() });
        H.children.push({ child, entry, options });
        return child;
      },
    },
  };
});

import { CORE_GONE_WAIT_MS, CORE_KILL_GRACE_MS, CORE_SERVICE_NAME, forkCore } from '../core-process';

type FakeChild = EventEmitter & { pid: number | undefined; stderr: PassThrough; postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
const lastChild = (): FakeChild => H.children.at(-1)!.child as FakeChild;

afterEach(() => {
  H.children.length = 0;
  vi.useRealTimers();
});

describe('forkCore', () => {
  it('forks the entry as "Damocles Core" with main\'s environment minus Electron\'s, its stdout following echo', () => {
    process.env['ELECTRON_RUN_AS_NODE'] = '1';
    try {
      forkCore('/app/dist/core-host.js', true);
    } finally {
      delete process.env['ELECTRON_RUN_AS_NODE'];
    }
    const { entry, options } = H.children[0]!;
    expect(entry).toBe('/app/dist/core-host.js');
    expect(options).toMatchObject({ serviceName: CORE_SERVICE_NAME, stdio: ['ignore', 'inherit', 'pipe'] });
    expect((options as { env: Record<string, string> }).env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    forkCore('/app/dist/core-host.js', false);
    expect(H.children[1]!.options).toMatchObject({ stdio: ['ignore', 'ignore', 'pipe'] });
  });

  it('carries messages both ways over the child\'s one channel', () => {
    const core = forkCore('/core.js', false);
    const received: unknown[] = [];
    const subscription = core.transport.onMessage((raw) => received.push(raw));
    lastChild().emit('message', { kind: 'event' });
    subscription.dispose();
    lastChild().emit('message', { kind: 'late' });
    core.transport.post({ kind: 'request' });
    expect(received).toEqual([{ kind: 'event' }]);
    expect(lastChild().postMessage).toHaveBeenCalledWith({ kind: 'request' });
  });

  it('reports the exit at once, and how it ended once Chromium told why, with the tail of stderr', async () => {
    const core = forkCore('/core.js', false);
    const exits: number[] = [];
    core.onExit((code) => exits.push(code));
    lastChild().stderr.write('[core] Core protocol violation: init\n');
    lastChild().emit('exit', 3);
    await vi.waitFor(() => expect(exits).toEqual([3]));
    (H.app as EventEmitter).emit('child-process-gone', {}, { type: 'Utility', name: CORE_SERVICE_NAME, reason: 'crashed' });
    expect(await core.ended).toEqual({ code: 3, reason: 'crashed', stderr: '[core] Core protocol violation: init' });
  });

  describe('kill', () => {
    const realPlatform = process.platform;
    const setPlatform = (platform: NodeJS.Platform): void => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    };
    afterEach(() => {
      setPlatform(realPlatform);
      vi.restoreAllMocks();
    });

    // A core whose event loop is blocked never runs signal-exit's SIGTERM listener, so SIGTERM alone never ends it.
    it('sends SIGKILL on POSIX when the process has not exited CORE_KILL_GRACE_MS after the kill', async () => {
      setPlatform('linux');
      vi.useFakeTimers();
      const signals = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const core = forkCore('/core.js', false);
      core.kill();
      expect(lastChild().kill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(CORE_KILL_GRACE_MS - 1);
      expect(signals).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(signals).toHaveBeenCalledWith(4242, 'SIGKILL');
    });

    it('sends nothing more once the process exited, and nothing more on Windows, whose kill is TerminateProcess', async () => {
      vi.useFakeTimers();
      const signals = vi.spyOn(process, 'kill').mockImplementation(() => true);
      setPlatform('linux');
      forkCore('/core.js', false).kill();
      lastChild().emit('exit', 0);
      setPlatform('win32');
      forkCore('/core.js', false).kill();
      await vi.advanceTimersByTimeAsync(CORE_KILL_GRACE_MS * 2);
      expect(signals).not.toHaveBeenCalled();
    });
  });

  it('gives up waiting for Chromium\'s reason after CORE_GONE_WAIT_MS', async () => {
    vi.useFakeTimers();
    const core = forkCore('/core.js', false);
    lastChild().emit('exit', 0);
    await vi.advanceTimersByTimeAsync(CORE_GONE_WAIT_MS);
    expect(await core.ended).toEqual({ code: 0, reason: null, stderr: null });
  });
});
