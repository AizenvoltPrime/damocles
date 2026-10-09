import { describe, expect, it } from 'vitest';
import { detectProfiles, parseWslList, systemProfileProbe, windowsBuildNumber, type ProfileProbe } from '../terminal/profiles';

interface FakeMachine {
  readonly files?: readonly string[];
  readonly dirs?: Readonly<Record<string, readonly string[]>>;
  readonly texts?: Readonly<Record<string, string>>;
  readonly wsl?: Buffer | Error;
}

function probe(platform: NodeJS.Platform, env: Record<string, string | undefined>, machine: FakeMachine, windowsBuild = 22631): ProfileProbe & { runs: Array<{ file: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>> }> } {
  const files = new Set(machine.files ?? []);
  const runs: Array<{ file: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>> }> = [];
  return {
    platform,
    env,
    homedir: platform === 'win32' ? 'C:\\Users\\ada' : '/home/ada',
    windowsBuild: platform === 'win32' ? windowsBuild : 0,
    isFile: async (file) => files.has(file),
    readDir: async (dir) => [...(machine.dirs?.[dir] ?? [])],
    readText: async (file) => machine.texts?.[file],
    run: async (file, args, runEnv) => {
      runs.push({ file, args, env: runEnv });
      if (!machine.wsl) throw new Error('not installed');
      if (machine.wsl instanceof Error) throw machine.wsl;
      return machine.wsl;
    },
    log: () => undefined,
    runs,
  };
}

const WINDOWS_ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local',
  Path: 'C:\\Windows\\system32;"C:\\Program Files\\Git\\cmd";C:\\tools',
  WSL_UTF8: '1',
};
const SYSTEM32 = 'C:\\Windows\\System32';

function utf16(text: string): Buffer {
  return Buffer.from(text, 'utf16le');
}

describe('Windows profiles', () => {
  it('finds PowerShell 7 at its highest major, Windows PowerShell, cmd, Git Bash beside git on PATH and the WSL distros, in that order', async () => {
    const machine = probe('win32', WINDOWS_ENV, {
      dirs: { 'C:\\Program Files\\PowerShell': ['6', '7', '7-preview', 'Modules'] },
      files: [
        'C:\\Program Files\\PowerShell\\6\\pwsh.exe',
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        `${SYSTEM32}\\WindowsPowerShell\\v1.0\\powershell.exe`,
        `${SYSTEM32}\\cmd.exe`,
        `${SYSTEM32}\\wsl.exe`,
        // WSL's own bash.exe sits on PATH in System32 and must not be taken for Git Bash
        `${SYSTEM32}\\bash.exe`,
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe',
      ],
      wsl: utf16('\uFEFFUbuntu-24.04\r\ndocker-desktop\r\ndocker-desktop-data\r\nDebian\r\n\r\n'),
    });
    const profiles = await detectProfiles(machine);
    expect(profiles).toEqual([
      { id: 'pwsh', name: 'PowerShell', file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: [], icon: 'powershell' },
      { id: 'windows-powershell', name: 'Windows PowerShell', file: `${SYSTEM32}\\WindowsPowerShell\\v1.0\\powershell.exe`, args: [], icon: 'powershell' },
      { id: 'cmd', name: 'Command Prompt', file: `${SYSTEM32}\\cmd.exe`, args: [], icon: 'cmd' },
      { id: 'git-bash', name: 'Git Bash', file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'], icon: 'git-bash' },
      { id: 'wsl:Ubuntu-24.04', name: 'Ubuntu-24.04', file: `${SYSTEM32}\\wsl.exe`, args: ['-d', 'Ubuntu-24.04'], icon: 'wsl' },
      { id: 'wsl:Debian', name: 'Debian', file: `${SYSTEM32}\\wsl.exe`, args: ['-d', 'Debian'], icon: 'wsl' },
    ]);
    // A user's WSL_UTF8=1 would switch the list to UTF-8.
    expect(machine.runs).toEqual([{ file: `${SYSTEM32}\\wsl.exe`, args: ['-l', '-q'], env: { ...WINDOWS_ENV, WSL_UTF8: '0' } }]);
  });

  it('finds pwsh in the other Program Files, the Store alias, the .NET tool or Scoop when Program Files has none', async () => {
    const find = async (files: string[], dirs: Record<string, string[]> = {}) => (await detectProfiles(probe('win32', WINDOWS_ENV, { files, dirs }))).find((profile) => profile.id === 'pwsh')?.file;
    expect(await find(['C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe'], { 'C:\\Program Files (x86)\\PowerShell': ['7'] })).toBe('C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe');
    const store = 'C:\\Users\\ada\\AppData\\Local\\Microsoft\\WindowsApps';
    expect(await find([`${store}\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe`], { [store]: ['Microsoft.PowerShellPreview_8wekyb3d8bbwe', 'Microsoft.PowerShell_8wekyb3d8bbwe'] })).toBe(`${store}\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe`);
    expect(await find(['C:\\Users\\ada\\.dotnet\\tools\\pwsh.exe'])).toBe('C:\\Users\\ada\\.dotnet\\tools\\pwsh.exe');
    expect(await find(['C:\\Users\\ada\\scoop\\apps\\pwsh\\current\\pwsh.exe'])).toBe('C:\\Users\\ada\\scoop\\apps\\pwsh\\current\\pwsh.exe');
    expect(await find([])).toBeUndefined();
  });

  it('finds Git Bash beside git.exe in cmd, bin or mingw64\\bin, and none without git on PATH', async () => {
    const gitBash = async (gitExe: string | undefined) => {
      const env = { ...WINDOWS_ENV, Path: gitExe ? gitExe.slice(0, gitExe.lastIndexOf('\\')) : 'C:\\tools' };
      const files = ['D:\\Git\\bin\\bash.exe', ...(gitExe ? [gitExe] : [])];
      return (await detectProfiles(probe('win32', env, { files }))).find((profile) => profile.id === 'git-bash')?.file;
    };
    expect(await gitBash('D:\\Git\\cmd\\git.exe')).toBe('D:\\Git\\bin\\bash.exe');
    expect(await gitBash('D:\\Git\\bin\\git.exe')).toBe('D:\\Git\\bin\\bash.exe');
    expect(await gitBash('D:\\Git\\mingw64\\bin\\git.exe')).toBe('D:\\Git\\bin\\bash.exe');
    expect(await gitBash(undefined)).toBeUndefined();
  });

  it('finds git only in absolute local PATH entries, never through the working folder or a share', async () => {
    const env = { ...WINDOWS_ENV, Path: '.;relative\\Git\\cmd;\\\\server\\share\\Git\\cmd;C:relative\\cmd;\\Git\\cmd' };
    const files = ['git.exe', 'bin\\bash.exe', 'relative\\Git\\cmd\\git.exe', 'relative\\Git\\bin\\bash.exe', '\\\\server\\share\\Git\\cmd\\git.exe', '\\\\server\\share\\Git\\bin\\bash.exe'];
    const machine = probe('win32', env, { files });
    const checked: string[] = [];
    const isFile = machine.isFile;
    const tracked = { ...machine, isFile: (file: string) => { checked.push(file); return isFile(file); } };
    expect((await detectProfiles(tracked)).find((profile) => profile.id === 'git-bash')).toBeUndefined();
    expect(checked.every((file) => /^[A-Z]:\\/i.test(file))).toBe(true);
  });

  it('lists no WSL distro before Windows 10 2004, without wsl.exe, or when wsl.exe fails with no distro installed', async () => {
    const files = [`${SYSTEM32}\\cmd.exe`, `${SYSTEM32}\\wsl.exe`];
    const wsl = utf16('Ubuntu\r\n');
    const ids = async (machine: ProfileProbe) => (await detectProfiles(machine)).map((profile) => profile.id);
    expect(await ids(probe('win32', WINDOWS_ENV, { files, wsl }, 18363))).toEqual(['cmd']);
    expect(await ids(probe('win32', WINDOWS_ENV, { files: [`${SYSTEM32}\\cmd.exe`], wsl }))).toEqual(['cmd']);
    expect(await ids(probe('win32', WINDOWS_ENV, { files, wsl: new Error('exit code 4294967295') }))).toEqual(['cmd']);
    expect(await ids(probe('win32', WINDOWS_ENV, { files, wsl }))).toEqual(['cmd', 'wsl:Ubuntu']);
  });

  it('reaches the 64-bit System32 through Sysnative from a 32-bit process', async () => {
    const env = { ...WINDOWS_ENV, PROCESSOR_ARCHITEW6432: 'AMD64' };
    const profiles = await detectProfiles(probe('win32', env, { files: ['C:\\Windows\\Sysnative\\cmd.exe'] }));
    expect(profiles.map((profile) => profile.file)).toEqual(['C:\\Windows\\Sysnative\\cmd.exe']);
  });

  it('logs the message of a failing wsl.exe as text, decoded from UTF-16LE, so the app log holds no NUL', async () => {
    const lines: string[] = [];
    // A real child that fails as wsl.exe does with no distro installed: a UTF-16LE message on stderr and a non-zero exit.
    const message = 'The Windows Subsystem for Linux is not installed.\r\n\r\nFor more information please visit https://aka.ms/wslinstall\r\n';
    const script = `process.stderr.write(Buffer.from(${JSON.stringify(message)}, 'utf16le')); process.exitCode = 1;`;
    const real = systemProfileProbe(process.env, () => undefined);
    const machine = probe('win32', WINDOWS_ENV, { files: [`${SYSTEM32}\\cmd.exe`, `${SYSTEM32}\\wsl.exe`] });
    await detectProfiles({ ...machine, run: () => real.run(process.execPath, ['-e', script], process.env), log: (line) => lines.push(line) });
    expect(lines).toEqual(['[terminal] no WSL distros: exit code 1: The Windows Subsystem for Linux is not installed. For more information please visit https://aka.ms/wslinstall']);
  });

  it('reads wsl.exe -l -q as UTF-16LE with stray NULs, a BOM and blank lines', () => {
    expect(parseWslList(utf16('\uFEFFUbuntu\0\r\n\r\nArch Linux\nDocker-Desktop\r\n'))).toEqual(['Ubuntu', 'Arch Linux']);
    expect(parseWslList(Buffer.alloc(0))).toEqual([]);
  });
});

describe('macOS and Linux profiles', () => {
  const shells = '# /etc/shells\n/bin/sh\n/bin/bash\n/usr/bin/bash\n/bin/zsh\n';

  it('lists $SHELL first, then zsh, bash and fish once each from /etc/shells or PATH, as login shells on macOS', async () => {
    const machine = probe('darwin', { SHELL: '/opt/homebrew/bin/fish', PATH: '/opt/homebrew/bin:/usr/bin:/bin' }, {
      texts: { '/etc/shells': shells },
      files: ['/opt/homebrew/bin/fish', '/bin/bash', '/bin/zsh', '/usr/bin/bash'],
    });
    expect(await detectProfiles(machine)).toEqual([
      { id: 'fish', name: 'fish', file: '/opt/homebrew/bin/fish', args: ['-l'], icon: 'fish' },
      { id: 'zsh', name: 'zsh', file: '/bin/zsh', args: ['-l'], icon: 'zsh' },
      { id: 'bash', name: 'bash', file: '/bin/bash', args: ['-l'], icon: 'bash' },
    ]);
  });

  it('starts non-login shells on Linux, keeps an unusual $SHELL with the generic icon, and skips what is not installed', async () => {
    const machine = probe('linux', { SHELL: '/usr/bin/nu', PATH: '/usr/bin:/bin' }, {
      texts: { '/etc/shells': shells },
      files: ['/usr/bin/nu', '/usr/bin/bash'],
    });
    expect(await detectProfiles(machine)).toEqual([
      { id: 'nu', name: 'nu', file: '/usr/bin/nu', args: [], icon: 'shell' },
      { id: 'bash', name: 'bash', file: '/usr/bin/bash', args: [], icon: 'bash' },
    ]);
  });

  it('looks for shells only in absolute PATH entries, never in the working folder', async () => {
    const machine = probe('linux', { PATH: 'bin:.::/usr/bin' }, { files: ['bin/zsh', 'zsh', 'fish', '/usr/bin/bash'] });
    const checked: string[] = [];
    const isFile = machine.isFile;
    const tracked = { ...machine, isFile: (file: string) => { checked.push(file); return isFile(file); } };
    expect((await detectProfiles(tracked)).map((profile) => profile.file)).toEqual(['/usr/bin/bash']);
    expect(checked.every((file) => file.startsWith('/'))).toBe(true);
  });

  it('ignores a relative or missing $SHELL and a missing /etc/shells', async () => {
    const machine = probe('linux', { SHELL: 'bash', PATH: '/bin' }, { files: ['/bin/bash'] });
    expect((await detectProfiles(machine)).map((profile) => profile.file)).toEqual(['/bin/bash']);
    expect(await detectProfiles(probe('linux', { SHELL: '/bin/zsh' }, {}))).toEqual([]);
  });
});

describe('the Windows build', () => {
  it('reads the third field of os.release(), and 0 elsewhere or for a release it cannot read', () => {
    expect(windowsBuildNumber('10.0.19045', 'win32')).toBe(19045);
    expect(windowsBuildNumber('10.0.26100.1', 'win32')).toBe(26100);
    expect(windowsBuildNumber('10.0', 'win32')).toBe(0);
    expect(windowsBuildNumber('10.0.x', 'win32')).toBe(0);
    expect(windowsBuildNumber('6.8.0-45-generic', 'linux')).toBe(0);
  });
});
