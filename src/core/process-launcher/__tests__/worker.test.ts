import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPAWN_TEST_TIMEOUT_MS } from '../../../__mocks__/spawn-budget';
import { log } from '../../logger';
import { createShellJob, killProcessTree } from '../../pi-session/tools/process-tree';
import type { LauncherEvent } from '../protocol';
import { createLauncherHost } from '../worker';

vi.mock('../../pi-session/tools/process-tree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pi-session/tools/process-tree')>();
  return { ...actual, createShellJob: vi.fn(actual.createShellJob), killProcessTree: vi.fn(actual.killProcessTree) };
});
vi.mock('../../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../logger')>()),
  log: vi.fn(),
}));

const pids: number[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  vi.mocked(killProcessTree).mockClear();
});

function host(): { handle: ReturnType<typeof createLauncherHost>; events: LauncherEvent[]; find: <T extends LauncherEvent['type']>(type: T, id: number) => Extract<LauncherEvent, { type: T }> | undefined } {
  const events: LauncherEvent[] = [];
  const handle = createLauncherHost({ post: (event) => void events.push(event) });
  const find = <T extends LauncherEvent['type']>(type: T, id: number) =>
    events.find((event): event is Extract<LauncherEvent, { type: T }> => event.type === type && 'id' in event && event.id === id);
  return { handle, events, find };
}

const node = (script: string) => ({ file: process.execPath, args: ['-e', script], detached: process.platform !== 'win32' });

describe('a launcher worker', { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  it('keeps a process it started tracked and killable when its job could not be made', async () => {
    vi.mocked(createShellJob).mockImplementationOnce(() => {
      throw new Error('the sentinel could not start');
    });
    const { handle, find } = host();
    handle({ type: 'spawn', id: 1, spec: node('setInterval(() => {}, 1000)') });

    const spawned = find('spawned', 1);
    expect(spawned).toBeDefined();
    pids.push(spawned!.pid);
    expect(find('error', 1)).toBeUndefined();
    expect(vi.mocked(log).mock.calls.some((call) => String(call[0]).includes('runs without its job'))).toBe(true);

    handle({ type: 'kill', id: 1, tree: false, signal: 'SIGKILL' });
    await vi.waitFor(() => expect(find('close', 1)).toBeDefined(), { timeout: SPAWN_TEST_TIMEOUT_MS });
  });

  it('refuses a kill made only while the process runs once it saw the exit, and still runs a plain tree kill', async () => {
    // Exits at once, leaving a child that holds its output, so the process stays open past its exit. Detached on Windows
    // only, where libuv's own job would kill a non-detached child with its node parent; on POSIX it stays in the group.
    const leaving = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: process.platform === 'win32' }); c.unref(); process.stdout.write(String(c.pid));";
    const { handle, find, events } = host();
    handle({ type: 'spawn', id: 1, spec: node(leaving) });
    await vi.waitFor(() => expect(find('exit', 1)).toBeDefined(), { timeout: SPAWN_TEST_TIMEOUT_MS });
    const output = events.flatMap((event) => (event.type === 'data' ? [Buffer.from(event.chunk)] : []));
    pids.push(Number(Buffer.concat(output).toString()));

    handle({ type: 'kill', id: 1, tree: true, whileRunning: true });
    expect(killProcessTree).not.toHaveBeenCalled();

    handle({ type: 'kill', id: 1, tree: true });
    if (process.platform === 'win32') expect(killProcessTree).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(find('close', 1)).toBeDefined(), { timeout: SPAWN_TEST_TIMEOUT_MS });
  });
});
