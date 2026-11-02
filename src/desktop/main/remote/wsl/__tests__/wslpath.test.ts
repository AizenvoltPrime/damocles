import { describe, expect, it } from 'vitest';
import { isWindowsDrivePath, parseWslpathOutput, wslpathInDistro, type WslpathRun } from '../reopen-in-wsl';

const env = { SystemRoot: 'C:\\Windows' };

describe('wslpath -u in a distro', () => {
  it('takes only one absolute Linux path on one line', () => {
    expect(parseWslpathOutput('/mnt/c/work/app\n')).toBe('/mnt/c/work/app');
    expect(parseWslpathOutput('/mnt/c/My Work/app')).toBe('/mnt/c/My Work/app');
    for (const untrusted of ['', '\n', 'mnt/c/app\n', '/mnt/c/app\n/etc\n', '/mnt/c/app\r\n', '/mnt/c/\u202eppa\n', '/mnt/c/../../etc\n', '/mnt/c/a\0b']) {
      expect(parseWslpathOutput(untrusted), JSON.stringify(untrusted)).toBeUndefined();
    }
  });

  it('maps only a folder on a Windows drive', () => {
    expect(isWindowsDrivePath('C:\\work\\app')).toBe(true);
    expect(isWindowsDrivePath('d:\\')).toBe(true);
    for (const other of ['\\\\wsl.localhost\\Ubuntu\\app', '\\\\server\\share', 'C:work', '/home/me', 'C:/work']) expect(isWindowsDrivePath(other), other).toBe(false);
  });

  it('runs System32\\wsl.exe -d <distro> --exec wslpath -u <folder> and reports its own message on a failure', async () => {
    const calls: Array<readonly string[]> = [];
    const run = (answer: Awaited<ReturnType<WslpathRun>>): WslpathRun => async (file, args) => {
      calls.push([file, ...args]);
      return answer;
    };
    expect(await wslpathInDistro('Ubuntu', 'C:\\work\\app', run({ code: 0, stdout: '/mnt/c/work/app\n', stderr: '' }), env)).toEqual({ ok: true, path: '/mnt/c/work/app' });
    expect(calls[0]).toEqual(['C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu', '--exec', 'wslpath', '-u', 'C:\\work\\app']);
    expect(await wslpathInDistro('Ubuntu', 'C:\\work\\app', run({ code: 1, stdout: '', stderr: 'wslpath: C:\\work\\app: No such file or directory\n' }), env))
      .toEqual({ ok: false, message: 'wslpath: C:\\work\\app: No such file or directory' });
    expect(await wslpathInDistro('Ubuntu', 'C:\\work\\app', run({ code: 0, stdout: '/mnt/c/app\n/etc/passwd\n', stderr: '' }), env)).toEqual({ ok: false, message: '/mnt/c/app /etc/passwd' });
    expect(await wslpathInDistro('Ubuntu', 'C:\\work\\app', () => Promise.reject(new Error('spawn failed')), env)).toEqual({ ok: false, message: 'spawn failed' });
    await expect(wslpathInDistro('-d', 'C:\\work\\app', run({ code: 0, stdout: '', stderr: '' }), env)).rejects.toThrow(RangeError);
    await expect(wslpathInDistro('Ubuntu', '\\\\server\\share', run({ code: 0, stdout: '', stderr: '' }), env)).rejects.toThrow(RangeError);
  });

  it('runs wsl.exe with WSL_UTF8=1 in place of an inherited one in any case, so a message of its own reads as UTF-8', async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const run: WslpathRun = async (_file, _args, given) => {
      seen.push(given);
      return { code: 0, stdout: '/mnt/c/work/app\n', stderr: '' };
    };
    await wslpathInDistro('Ubuntu', 'C:\\work\\app', run, { ...env, wsl_utf8: '0', PATH: 'C:\\bin' });
    expect(seen).toEqual([{ SystemRoot: 'C:\\Windows', PATH: 'C:\\bin', WSL_UTF8: '1' }]);
  });
});
