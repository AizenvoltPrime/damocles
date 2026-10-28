// Windows only: the daemon's named pipe and its user-only run folder.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { windowsSystemTool } from '../../../core/system-tools';
import type { HostStarters } from '../../workspace/host-starters';
import { openEndpoint } from '../endpoint-server';
import { localRunPaths, makeRunDir, pipeName, readPidFile, tokenPath } from '../token';
import { startInProcessDaemon } from './in-process-daemon';
import { connectClient } from './test-client';

const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this test'); },
  startFormatterHost: () => { throw new Error('no formatter host in this test'); },
};

describe.runIf(process.platform === 'win32')('the daemon pipe on Windows', () => {
  it('has a 128-bit random name', () => {
    const name = pipeName();
    expect(name).toMatch(/^\\\\\.\\pipe\\damocles-server-[0-9a-f]{32}$/);
    expect(pipeName()).not.toBe(name);
  });

  it('fails a start whose pipe name is taken and picks a new one', async () => {
    const paths = await localRunPaths();
    await makeRunDir(paths);
    const taken = pipeName();
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(taken, resolve));
    const names = [taken, pipeName()];
    const logged: string[] = [];
    const endpoint = await openEndpoint(paths, (socket) => socket.destroy(), (line) => logged.push(line), () => names.shift()!);
    expect(endpoint.endpoint).not.toBe(taken);
    expect(logged).toEqual([`[daemon] the pipe name ${taken} is taken; picking another`]);
    expect(fs.existsSync(tokenPath(paths, endpoint))).toBe(true);
    await endpoint.close();
    squatter.close();
  });

  const icacls = (...args: string[]): string => execFileSync(windowsSystemTool('icacls'), args, { encoding: 'utf8' });

  async function expectUserAlone(home?: string): Promise<void> {
    const paths = await localRunPaths(home);
    await makeRunDir(paths);
    const endpoint = await openEndpoint(paths, (socket) => socket.destroy(), () => undefined);
    const user = `${process.env['USERDOMAIN']}\\${os.userInfo().username}`.toLowerCase();
    for (const target of [paths.runDir, tokenPath(paths, endpoint)]) {
      // icacls prints the path before the first entry and a summary line last
      const entries = icacls(target).replace(target, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[^ ]+\\?[^:]*:\(/.test(line));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.toLowerCase().startsWith(`${user}:`)).toBe(true);
    }
    await endpoint.close();
  }

  it('keeps the run folder and the token to the user alone', async () => {
    await expectUserAlone();
  });

  // What is made under a folder that hands nothing down holds the creating token's default DACL as explicit entries
  // (SYSTEM, and Administrators under an elevated token), which /inheritance:r keeps.
  it('keeps them to the user alone under a home that hands nothing down', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-pipe-home-'));
    try {
      const sid = /"(S-1-[0-9-]+)"\s*$/.exec(execFileSync(windowsSystemTool('whoami'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim())![1]!;
      icacls(home, '/inheritance:r', '/grant:r', `*${sid}:F`);
      await expectUserAlone(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('binds a new pipe with a new token when the token was removed before a touch, and keeps running', async () => {
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, touchIntervalMs: 20 });
    let exit: string | undefined;
    void daemon.exited.then((reason) => {
      exit = reason;
    });
    const first = (await readPidFile(daemon.paths.pidFile))!;
    fs.rmSync(tokenPath(daemon.paths, first));
    await vi.waitFor(async () => {
      expect((await readPidFile(daemon.paths.pidFile))?.endpoint).not.toBe(first.endpoint);
      expect(fs.existsSync(tokenPath(daemon.paths, first))).toBe(true);
    }, { timeout: 5000 });
    expect(exit).toBeUndefined();
    expect((await connectClient(await daemon.connect(), { clientId: 'a' })).outcome.kind).toBe('welcome');
    await daemon.shutdown();
  });
});
