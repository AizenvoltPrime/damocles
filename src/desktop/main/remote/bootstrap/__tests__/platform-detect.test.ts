import { describe, expect, it, vi } from 'vitest';
import { parseUname, parseWindowsShell, resolvePlatform, UNAME_COMMAND, WINDOWS_SHELL_COMMAND } from '../platform-detect';

describe('parseUname', () => {
  it('reads Linux and Darwin as POSIX, the BSDs as refused, and anything else as other', () => {
    expect(parseUname('Linux\n')).toEqual({ kind: 'posix', os: 'linux' });
    expect(parseUname('\nDarwin\r\n')).toEqual({ kind: 'posix', os: 'darwin' });
    for (const name of ['FreeBSD', 'OpenBSD', 'NetBSD', 'DragonFly']) expect(parseUname(`${name}\n`)).toEqual({ kind: 'bsd', name });
    expect(parseUname("'uname' is not recognized as an internal or external command,\r\n")).toEqual({ kind: 'other' });
    expect(parseUname('MINGW64_NT-10.0-26100\n')).toEqual({ kind: 'other' });
    expect(parseUname('')).toEqual({ kind: 'other' });
  });

  it('finds the kernel name after or before what a login script printed', () => {
    expect(parseUname('conda init done\nWelcome to the lab cluster\r\nLinux\n')).toEqual({ kind: 'posix', os: 'linux' });
    expect(parseUname('Darwin\nlast login: today\n')).toEqual({ kind: 'posix', os: 'darwin' });
    expect(parseUname('motd\nFreeBSD\n')).toEqual({ kind: 'bsd', name: 'FreeBSD' });
    expect(parseUname("Welcome\r\n'uname' is not recognized as an internal or external command,\r\n")).toEqual({ kind: 'other' });
  });
});

describe('parseWindowsShell', () => {
  it('tells cmd from PowerShell by which half of the echo each expands', () => {
    expect(parseWindowsShell('C:\\Windows\\system32\\cmd.exe~$PSHOME\r\n')).toBe('cmd');
    expect(parseWindowsShell('%COMSPEC%~C:\\Windows\\System32\\WindowsPowerShell\\v1.0\r\n')).toBe('powershell');
    expect(parseWindowsShell('%COMSPEC%~C:\\Program Files\\PowerShell\\7\r\n')).toBe('powershell');
  });

  it('runs a POSIX default shell (Git Bash), which expands neither, as cmd launches stage 0', () => {
    expect(parseWindowsShell('%COMSPEC%~\n')).toBe('cmd');
  });
});

describe('resolvePlatform', () => {
  const answering = (answers: Record<string, string>) => vi.fn(async (command: string) => answers[command] ?? '');

  it('runs uname -s alone on a host it has not seen, and nothing more on a POSIX answer', async () => {
    const run = answering({ [UNAME_COMMAND]: 'Linux\n' });
    expect(await resolvePlatform(undefined, undefined, { run })).toEqual({ ok: true, platform: { os: 'linux' } });
    expect(run.mock.calls).toEqual([[UNAME_COMMAND]]);
  });

  it('follows a Windows reply with the shell echo', async () => {
    const run = answering({ [UNAME_COMMAND]: "'uname' is not recognized\r\n", [WINDOWS_SHELL_COMMAND]: '%COMSPEC%~C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\r\n' });
    expect(await resolvePlatform(undefined, undefined, { run })).toEqual({ ok: true, platform: { os: 'win32', windowsShell: 'powershell' } });
    expect(run.mock.calls).toEqual([[UNAME_COMMAND], [WINDOWS_SHELL_COMMAND]]);
  });

  it('refuses a BSD by name', async () => {
    expect(await resolvePlatform(undefined, undefined, { run: answering({ [UNAME_COMMAND]: 'FreeBSD\n' }) })).toEqual({ ok: false, os: 'FreeBSD' });
  });

  it('reuses a cached detection without running anything', async () => {
    const run = answering({});
    expect(await resolvePlatform(undefined, { os: 'darwin' }, { run })).toEqual({ ok: true, platform: { os: 'darwin' } });
    expect(await resolvePlatform(undefined, { os: 'win32', windowsShell: 'cmd' }, { run })).toEqual({ ok: true, platform: { os: 'win32', windowsShell: 'cmd' } });
    expect(run).not.toHaveBeenCalled();
  });

  it('lets the override win over the cache, and still asks a Windows override which shell it has', async () => {
    const run = answering({ [WINDOWS_SHELL_COMMAND]: 'C:\\Windows\\system32\\cmd.exe~$PSHOME\r\n' });
    expect(await resolvePlatform('linux', { os: 'win32', windowsShell: 'cmd' }, { run })).toEqual({ ok: true, platform: { os: 'linux' } });
    expect(run).not.toHaveBeenCalled();
    expect(await resolvePlatform('win32', { os: 'linux' }, { run })).toEqual({ ok: true, platform: { os: 'win32', windowsShell: 'cmd' } });
    expect(run.mock.calls).toEqual([[WINDOWS_SHELL_COMMAND]]);
  });
});
