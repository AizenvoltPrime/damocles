import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { killProcessTree } from '../utils';

// Passthrough, so only the taskkill call a case sets up is faked.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const spawnMock = vi.mocked(spawn);
const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
});

describe('killProcessTree', () => {
  /** Drive one taskkill attempt whose fake killer emits the given events, in order, on later ticks. */
  function runWithKiller(emit: (killer: EventEmitter) => void): { kill: ReturnType<typeof vi.spyOn>; done: Promise<void> } {
    const killer = new EventEmitter();
    spawnMock.mockImplementationOnce(() => {
      setImmediate(() => emit(killer));
      return killer as unknown as ReturnType<typeof spawn>;
    });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    return { kill, done: killProcessTree(4242) };
  }

  it('kills the server process when taskkill cannot be spawned, so no MCP child outlives its shutdown', async () => {
    setPlatform('win32');
    const enoent: NodeJS.ErrnoException = new Error('spawn taskkill ENOENT');
    enoent.code = 'ENOENT';
    // spawn reports a missing taskkill on a later tick as an 'error' event, never by throwing, so a
    // stub that throws would pass against code that only resolves.
    const { kill, done } = runWithKiller((k) => k.emit('error', enoent));

    await done;

    expect(kill).toHaveBeenCalledWith(4242, 'SIGKILL');
  });

  it('kills the server process when taskkill ran and refused, which reports as a non-zero exit', async () => {
    setPlatform('win32');
    // Access denied and "no such process" both spawn fine and exit non-zero, so an error-only fallback
    // sees nothing and the server survives its own shutdown.
    const { kill, done } = runWithKiller((k) => {
      k.emit('exit', 128, null);
      k.emit('close', 128, null);
    });

    await done;

    expect(kill).toHaveBeenCalledWith(4242, 'SIGKILL');
  });

  it('kills the server process when taskkill was itself signalled, which reports a null code', async () => {
    setPlatform('win32');
    const { kill, done } = runWithKiller((k) => {
      k.emit('exit', null, 'SIGTERM');
      k.emit('close', null, 'SIGTERM');
    });

    await done;

    expect(kill).toHaveBeenCalledWith(4242, 'SIGKILL');
  });

  it('leaves the process alone when taskkill exits 0, because the tree is already gone', async () => {
    setPlatform('win32');
    const { kill, done } = runWithKiller((k) => {
      k.emit('exit', 0, null);
      k.emit('close', 0, null);
    });

    await done;

    expect(kill).not.toHaveBeenCalled();
  });

  it('falls back once when a spawn error is followed by a non-zero exit', async () => {
    setPlatform('win32');
    const enoent: NodeJS.ErrnoException = new Error('spawn taskkill ENOENT');
    enoent.code = 'ENOENT';
    // Node emits both for a failed spawn. Killing twice would send a second SIGKILL to whatever
    // inherited the pid in between.
    const { kill, done } = runWithKiller((k) => {
      k.emit('error', enoent);
      k.emit('exit', null, null);
      k.emit('close', null, null);
    });

    await done;

    expect(kill).toHaveBeenCalledTimes(1);
  });
});
