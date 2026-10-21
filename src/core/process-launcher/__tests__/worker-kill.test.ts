import { describe, expect, it, vi } from 'vitest';
import { SPAWN_TEST_TIMEOUT_MS } from '../../../__mocks__/spawn-budget';
import { log } from '../../logger';
import { killProcessTree } from '../../pi-session/tools/process-tree';
import type { LauncherEvent } from '../protocol';
import { createLauncherHost } from '../worker';

// A group whose leader has exited can hold only processes this user may not signal, and kill(-pgid) then fails with EPERM.
vi.mock('../../pi-session/tools/process-tree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pi-session/tools/process-tree')>()),
  killProcessTree: vi.fn(() => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  }),
}));
vi.mock('../../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../logger')>()),
  log: vi.fn(),
}));

describe('a launcher worker whose tree kill fails', { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  it('logs the failure and keeps serving its other requests', async () => {
    const events: LauncherEvent[] = [];
    const host = createLauncherHost({ post: (event) => void events.push(event) });
    const exited = (id: number): LauncherEvent | undefined => events.find((event) => event.type === 'exit' && event.id === id);
    const spec = (script: string) => ({ file: process.execPath, args: ['-e', script], detached: process.platform !== 'win32' });
    host({ type: 'spawn', id: 1, spec: spec('setInterval(() => {}, 1000)') });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'spawned' && event.id === 1)).toBe(true), { timeout: SPAWN_TEST_TIMEOUT_MS });

    expect(() => host({ type: 'kill', id: 1, tree: true })).not.toThrow();

    expect(killProcessTree).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log).mock.calls.some((call) => String(call[0]).includes('could not kill the process tree'))).toBe(true);
    host({ type: 'kill', id: 1, tree: false, signal: 'SIGKILL' });
    host({ type: 'spawn', id: 2, spec: spec('') });
    await vi.waitFor(() => expect(exited(1)).toBeDefined(), { timeout: SPAWN_TEST_TIMEOUT_MS });
    await vi.waitFor(() => expect(exited(2)).toMatchObject({ code: 0 }), { timeout: SPAWN_TEST_TIMEOUT_MS });
  });
});
