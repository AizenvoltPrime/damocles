import { describe, expect, it, vi } from 'vitest';
import { reopenInWsl, type ReopenDeps } from '../reopen-in-wsl';
import { linuxToWslUnc, wslUncToLinux } from '../wsl-paths';

describe('WSL UNC paths', () => {
  it('maps \\\\wsl.localhost and \\\\wsl$ paths to the distro and the Linux path, in any case and with either separator', () => {
    expect(wslUncToLinux('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\app')).toEqual({ distro: 'Ubuntu-24.04', path: '/home/me/app' });
    expect(wslUncToLinux('\\\\wsl$\\Ubuntu\\home\\me\\app')).toEqual({ distro: 'Ubuntu', path: '/home/me/app' });
    expect(wslUncToLinux('\\\\WSL.LOCALHOST\\Ubuntu\\srv')).toEqual({ distro: 'Ubuntu', path: '/srv' });
    expect(wslUncToLinux('\\\\Wsl$\\Ubuntu\\srv\\')).toEqual({ distro: 'Ubuntu', path: '/srv' });
    expect(wslUncToLinux('//wsl.localhost/Ubuntu/home/me')).toEqual({ distro: 'Ubuntu', path: '/home/me' });
    expect(wslUncToLinux('\\\\wsl.localhost\\Ubuntu')).toEqual({ distro: 'Ubuntu', path: '/' });
  });

  it('refuses a path that names no distro, a distro wsl.exe could not name, or another share', () => {
    for (const notWsl of [
      '\\\\wsl.localhost\\',
      '\\\\wsl.localhost',
      '\\\\wsl$',
      '\\\\wsl.localhost\\-d\\x',
      '\\\\wsl.localhost\\Ub untu\\x',
      '\\\\wsl.localhost\\Ubuntu\\home\\..\\etc',
      '\\\\server\\share\\app',
      '\\\\wsl.localhostx\\Ubuntu\\app',
      'C:\\work\\app',
      '\\wsl.localhost\\Ubuntu\\app',
      '\\\\wsl.localhost\\..\\x',
      '\\\\wsl$\\.\\x',
      '\\\\wsl.localhost\\...\\x',
    ]) expect(wslUncToLinux(notWsl), notWsl).toBeUndefined();
    // a name with dots and other characters is a name
    expect(wslUncToLinux('\\\\wsl.localhost\\.alpine.3\\x')).toEqual({ distro: '.alpine.3', path: '/x' });
  });

  it('names a Linux folder for File Explorer, refusing a path it cannot name', () => {
    expect(linuxToWslUnc('Ubuntu-24.04', '/home/me/app')).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\app');
    expect(linuxToWslUnc('Ubuntu', '/')).toBe('\\\\wsl.localhost\\Ubuntu');
    for (const [distro, linuxPath] of [['Ubuntu', 'home/me'], ['Ubuntu', '/home/../etc'], ['Ubuntu', '/a\\b'], ['Ubuntu', '/a\nb'], ['-x', '/home'], ['..', '/home'], ['.', '/home']] as const) {
      expect(linuxToWslUnc(distro, linuxPath)).toBeUndefined();
    }
  });
});

describe('Reopen in WSL', () => {
  function deps(local: { fsPath: string; trusted: boolean } | undefined, overrides: Partial<ReopenDeps> = {}) {
    const calls: string[] = [];
    const made: ReopenDeps = {
      localProject: () => local,
      wslpath: vi.fn(async () => ({ ok: true as const, path: '/mnt/c/work/app' })),
      distroHost: async (distro) => {
        calls.push(`host ${distro}`);
        return distro === 'Missing' ? undefined : { hostId: 'h1', authorityKey: `wsl+${distro}` };
      },
      connect: async (hostId) => void calls.push(`connect ${hostId}`),
      open: async (authorityKey, folder, trusted) => {
        calls.push(`open ${authorityKey} ${folder} ${String(trusted)}`);
        return `${authorityKey}|${folder}`;
      },
      failureCode: () => 'unknown',
      log: () => undefined,
      ...overrides,
    };
    return { made, calls };
  }

  it('opens a UNC project\'s folder in its own distro, connected first, with the local project\'s trust', async () => {
    const { made, calls } = deps({ fsPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\app', trusted: true });
    expect(await reopenInWsl(made, 'key')).toEqual({ ok: true, projectKey: 'wsl+Ubuntu-24.04|/home/me/app' });
    expect(calls).toEqual(['host Ubuntu-24.04', 'connect h1', 'open wsl+Ubuntu-24.04 /home/me/app true']);
    expect(made.wslpath).not.toHaveBeenCalled();
    const untrusted = deps({ fsPath: '\\\\wsl$\\Ubuntu\\srv', trusted: false });
    await reopenInWsl(untrusted.made, 'key');
    expect(untrusted.calls.at(-1)).toBe('open wsl+Ubuntu /srv false');
  });

  it('opens a Windows-drive project through wslpath in the chosen distro, and an untrusted one stays untrusted', async () => {
    const { made, calls } = deps({ fsPath: 'C:\\work\\app', trusted: false });
    expect(await reopenInWsl(made, 'key', 'Ubuntu')).toEqual({ ok: true, projectKey: 'wsl+Ubuntu|/mnt/c/work/app' });
    expect(made.wslpath).toHaveBeenCalledWith('Ubuntu', 'C:\\work\\app');
    expect(calls.at(-1)).toBe('open wsl+Ubuntu /mnt/c/work/app false');
  });

  it('answers each refusal with its code', async () => {
    expect(await reopenInWsl(deps({ fsPath: 'C:\\work\\app', trusted: true }).made, 'key')).toEqual({ ok: false, code: 'notWindowsFolder' });
    expect(await reopenInWsl(deps({ fsPath: '\\\\server\\share\\app', trusted: true }).made, 'key', 'Ubuntu')).toEqual({ ok: false, code: 'notWindowsFolder' });
    expect(await reopenInWsl(deps({ fsPath: 'C:\\work\\app', trusted: true }).made, 'key', 'Missing')).toEqual({ ok: false, code: 'unknownDistro' });
    const failing = deps({ fsPath: 'C:\\work\\app', trusted: true }, { wslpath: async () => ({ ok: false, message: 'wslpath: C:\\work\\app: Invalid argument' }) });
    expect(await reopenInWsl(failing.made, 'key', 'Ubuntu')).toEqual({ ok: false, code: 'wslpathFailed', message: 'wslpath: C:\\work\\app: Invalid argument' });
    const offline = deps({ fsPath: '\\\\wsl$\\Ubuntu\\srv', trusted: true }, { connect: async () => { throw new Error('down'); }, failureCode: () => 'timedOut' });
    expect(await reopenInWsl(offline.made, 'key')).toEqual({ ok: false, code: 'connectFailed', message: 'timedOut' });
    expect(offline.calls.some((call) => call.startsWith('open'))).toBe(false);
    await expect(reopenInWsl(deps(undefined).made, 'key')).rejects.toThrow('Not a local project');
  });
});
