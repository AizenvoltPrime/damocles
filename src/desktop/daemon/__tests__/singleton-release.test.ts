import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDaemonLock } from '../singleton';
import type { RunPaths } from '../token';

const { lock } = vi.hoisted(() => ({ lock: vi.fn<() => Promise<() => Promise<void>>>() }));
vi.mock('proper-lockfile', () => ({ lock: () => lock() }));

const PATHS = { runDir: '/run', lockFile: '/run/daemon.lock' } as RunPaths;
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const onPlatform = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { ...platform, value });
};

beforeEach(() => {
  lock.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
});

// Windows answers a mkdir of a folder whose removal is still pending with EPERM (measured: 48 of 2,000 races of mkdir
// against rmdir of the same folder), which is a holder's release in flight, not a refusal.
describe('a start racing the holder\'s release', () => {
  it('waits on Windows when the lock folder is still being removed, and takes it next', async () => {
    onPlatform('win32');
    const release = vi.fn(async () => undefined);
    lock.mockRejectedValueOnce(errno('EPERM')).mockResolvedValueOnce(release);
    const probes = vi.fn(async () => false);
    const taken = await acquireDaemonLock(PATHS, () => undefined, probes, 10_000);
    expect(taken.held).toBe(true);
    expect(probes).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledTimes(2);
  });

  it('fails with EPERM once the wait is over, and at once elsewhere, where EPERM is a refusal', async () => {
    onPlatform('win32');
    lock.mockRejectedValue(errno('EPERM'));
    await expect(acquireDaemonLock(PATHS, () => undefined, async () => false, 0)).rejects.toThrow('EPERM');
    onPlatform('linux');
    lock.mockReset();
    lock.mockRejectedValue(errno('EPERM'));
    await expect(acquireDaemonLock(PATHS, () => undefined, async () => false, 10_000)).rejects.toThrow('EPERM');
    expect(lock).toHaveBeenCalledTimes(1);
  });
});
