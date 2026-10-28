import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDaemonLock } from '../singleton';
import { runPaths, type RunPaths } from '../token';

// the daemon lock's proper-lockfile calls; the takeover lock's are always granted
const { lock } = vi.hoisted(() => ({ lock: vi.fn<() => Promise<() => Promise<void>>>() }));
vi.mock('proper-lockfile', () => ({
  lock: (_file: string, options: { lockfilePath: string }) => (options.lockfilePath.endsWith('.takeover') ? Promise.resolve(async () => undefined) : lock()),
}));

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const onPlatform = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { ...platform, value });
};
let paths: RunPaths;

beforeEach(() => {
  lock.mockReset();
  paths = runPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-lock-')), '0123456789abcdef');
  fs.mkdirSync(paths.runDir, { recursive: true });
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
    const taken = await acquireDaemonLock(paths, () => undefined, probes, 10_000);
    expect(taken.held).toBe(true);
    expect(probes).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledTimes(2);
  });

  it('fails with EPERM once the wait is over, and at once elsewhere, where EPERM is a refusal', async () => {
    onPlatform('win32');
    lock.mockRejectedValue(errno('EPERM'));
    await expect(acquireDaemonLock(paths, () => undefined, async () => false, 0)).rejects.toThrow('EPERM');
    onPlatform('linux');
    lock.mockReset();
    lock.mockRejectedValue(errno('EPERM'));
    await expect(acquireDaemonLock(paths, () => undefined, async () => false, 10_000)).rejects.toThrow('EPERM');
    expect(lock).toHaveBeenCalledTimes(1);
  });
});
