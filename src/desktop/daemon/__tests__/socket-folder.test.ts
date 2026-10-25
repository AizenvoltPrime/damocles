// POSIX only: Windows has no socket folder. Written to run on Linux CI and macOS.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostStarters } from '../../workspace/host-starters';
import { checkSocketFolder, createSocketFolder, readPidFile, socketFolderBase } from '../token';
import { startInProcessDaemon } from './in-process-daemon';
import { connectClient } from './test-client';

const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this test'); },
  startFormatterHost: () => { throw new Error('no formatter host in this test'); },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === 'win32')('the socket folder', () => {
  it('is an unpredictable 0700 folder of this user under the socket base', async () => {
    const base = await socketFolderBase();
    const folder = await createSocketFolder(base);
    expect(path.dirname(folder)).toBe(base);
    expect(path.basename(folder)).toMatch(/^damocles-.{6}$/);
    const stat = fs.lstatSync(folder);
    expect(stat.mode & 0o777).toBe(0o700);
    expect(stat.uid).toBe(process.getuid!());
    fs.rmdirSync(folder);
  });

  it('lives in TMPDIR on macOS and in /tmp on Linux without linger', async () => {
    expect(await socketFolderBase({ TMPDIR: '/private/var/folders/x/T' }, 'darwin')).toBe('/private/var/folders/x/T');
    expect(await socketFolderBase({}, 'linux')).toBe('/tmp');
  });

  it('refuses a symlinked, foreign-owned, open or network folder', async () => {
    const real = await createSocketFolder(await socketFolderBase());
    const link = path.join(os.tmpdir(), `dm-link-${process.pid}`);
    fs.symlinkSync(real, link);
    await expect(checkSocketFolder(link)).rejects.toThrow(/not a folder/);
    if (process.getuid!() !== 0) await expect(checkSocketFolder('/')).rejects.toThrow(/belongs to uid 0/);
    fs.chmodSync(real, 0o755);
    await expect(checkSocketFolder(real)).rejects.toThrow(/mode 755/);
    fs.chmodSync(real, 0o700);
    if (process.platform === 'linux') {
      vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ type: 0x6969 } as fs.StatsFs);
      await expect(checkSocketFolder(real)).rejects.toThrow(/on NFS/);
    }
    fs.unlinkSync(link);
    fs.rmdirSync(real);
  });

  it('binds again with a new folder and token when the folder was removed before a touch, and keeps running', async () => {
    const lines: string[] = [];
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, touchIntervalMs: 20, log: (line) => lines.push(line) });
    let exit: string | undefined;
    void daemon.exited.then((reason) => {
      exit = reason;
    });
    const first = (await readPidFile(daemon.paths.pidFile))!;
    fs.rmSync(first.socketFolder!, { recursive: true });
    await vi.waitFor(async () => {
      const now = await readPidFile(daemon.paths.pidFile);
      expect(now?.socketFolder).not.toBe(first.socketFolder);
      expect(fs.existsSync(now!.endpoint)).toBe(true);
    }, { timeout: 5000 });
    expect(exit).toBeUndefined();
    expect(lines.filter((line) => line.includes('shutting down'))).toEqual([]);
    expect((await connectClient(await daemon.connect(), { clientId: 'a' })).outcome.kind).toBe('welcome');
    await daemon.shutdown();
  });
});
