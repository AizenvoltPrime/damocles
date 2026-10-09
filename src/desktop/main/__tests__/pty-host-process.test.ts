import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeChild = EventEmitter & { stderr: EventEmitter };

const electron = vi.hoisted(() => ({ app: undefined as unknown as EventEmitter, forks: [] as Array<{ args: unknown[]; child: FakeChild }> }));

vi.mock('electron', () => ({
  app: (electron.app = new EventEmitter()),
  utilityProcess: {
    fork: (...args: unknown[]) => {
      const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), postMessage: vi.fn(), kill: vi.fn() });
      electron.forks.push({ args, child });
      return child;
    },
  },
}));

import { MAX_HOST_MESSAGE_CHARS } from '../../pty-host/protocol';
import { PTY_HOST_GONE_WAIT_MS, PTY_HOST_SERVICE_NAME, spawnPtyHost } from '../terminal/pty-host-process';
import type { PtyHostExit } from '../terminal/terminal-service';

beforeEach(() => {
  vi.useFakeTimers();
  electron.forks.length = 0;
  electron.app.removeAllListeners();
});

afterEach(() => {
  vi.useRealTimers();
});

function spawn(): { child: FakeChild; exits: PtyHostExit[] } {
  const host = spawnPtyHost('pty-host.js', 'node-pty');
  const exits: PtyHostExit[] = [];
  host.onExit((exit) => exits.push(exit));
  return { child: electron.forks.at(-1)!.child, exits };
}

const gone = (details: Record<string, unknown>): void => {
  electron.app.emit('child-process-gone', {}, { type: 'Utility', serviceName: 'node.mojom.NodeService', name: PTY_HOST_SERVICE_NAME, ...details });
};

describe('spawnPtyHost', () => {
  it('pipes only the host\'s stderr, which it reads for the host\'s last error', () => {
    spawn();
    expect(electron.forks[0]!.args[2]).toMatchObject({ serviceName: PTY_HOST_SERVICE_NAME, stdio: ['ignore', 'ignore', 'pipe'] });
  });

  it('reports an abnormal exit with the reason Electron gives and the last error the host printed', () => {
    const { child, exits } = spawn();
    child.stderr.emit('data', Buffer.from('C:\\app\\pty-host.js:12\n  throw err;\n  ^\n\nError: the pty host received a malformed req'));
    child.stderr.emit('data', Buffer.from('uest\n    at handle (pty-host.js:12:9)\n\nNode.js v24.21.0\n'));
    child.emit('exit', 1);
    expect(exits).toEqual([]);
    gone({ name: 'Another Service', reason: 'crashed', exitCode: 5 });
    gone({ type: 'GPU', reason: 'crashed', exitCode: 5 });
    expect(exits).toEqual([]);
    gone({ reason: 'killed', exitCode: 1 });
    expect(exits).toEqual([{
      code: 1,
      reason: 'killed',
      error: 'C:\\app\\pty-host.js:12\n  throw err;\n  ^\n\nError: the pty host received a malformed request\n    at handle (pty-host.js:12:9)\n\nNode.js v24.21.0',
    }]);
    expect(electron.app.listenerCount('child-process-gone')).toBe(0);
  });

  it('prefers V8\'s fatal error location, and bounds what it keeps of the stderr', () => {
    const { child, exits } = spawn();
    child.stderr.emit('data', `Error: first\n${'x'.repeat(MAX_HOST_MESSAGE_CHARS * 2)}`);
    child.emit('error', 'FatalError', 'v8::internal::Heap::FatalProcessOutOfMemory', '{}');
    child.emit('exit', 134);
    gone({ reason: 'oom', exitCode: 134 });
    expect(exits).toEqual([{ code: 134, reason: 'oom', error: 'FatalError at v8::internal::Heap::FatalProcessOutOfMemory' }]);

    const second = spawn();
    second.child.stderr.emit('data', `Error: first\n${'x'.repeat(MAX_HOST_MESSAGE_CHARS * 2)}`);
    second.child.emit('exit', 1);
    vi.advanceTimersByTime(PTY_HOST_GONE_WAIT_MS);
    expect(second.exits).toEqual([{ code: 1, reason: null, error: 'x'.repeat(MAX_HOST_MESSAGE_CHARS) }]);
  });

  it('reports a clean exit at once, and an abnormal one without a reason once Electron gave none in time', () => {
    const clean = spawn();
    clean.child.emit('exit', 0);
    expect(clean.exits).toEqual([{ code: 0, reason: null, error: null }]);

    const silent = spawn();
    silent.child.emit('exit', 3);
    vi.advanceTimersByTime(PTY_HOST_GONE_WAIT_MS - 1);
    expect(silent.exits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(silent.exits).toEqual([{ code: 3, reason: null, error: null }]);
    gone({ reason: 'crashed', exitCode: 3 });
    expect(silent.exits).toHaveLength(1);
    expect(electron.app.listenerCount('child-process-gone')).toBe(0);
  });
});
