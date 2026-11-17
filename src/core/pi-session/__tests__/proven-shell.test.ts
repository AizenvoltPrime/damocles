import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { provenReadOnlyShell, shellLookupFolders, type ChatMachine, type PowerShellSearch } from '../proven-shell';
import { powerShellSearch, shellToolEnv } from '../tools/powershell-tool';

// The QueryDosDeviceW answer for a drive a test maps, by name (`Q:`); a thrown Error for a failing call; any other asks Windows.
const dosDevices = vi.hoisted(() => new Map<string, string | Error>());
vi.mock('../../dos-devices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../dos-devices')>();
  return {
    queryDosDevice: (name: string): string | undefined => {
      const answer = dosDevices.get(name);
      if (answer instanceof Error) throw answer;
      return answer ?? actual.queryDosDevice(name);
    },
  };
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proven-shell-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let folders = 0;

/** A fresh PATH folder holding `files`. */
function pathFolder(...files: string[]): string {
  const folder = path.join(root, `bin${folders++}`);
  fs.mkdirSync(folder);
  for (const file of files) fs.writeFileSync(path.join(folder, file), '');
  return folder;
}

function windowsMachine(search: Partial<PowerShellSearch> & { path: string }): ChatMachine {
  return {
    platform: 'win32',
    allowedNetworkHosts: () => Promise.resolve(new Set<string>()),
    powerShellSearch: () => Promise.resolve({ pathext: '.COM;.EXE;.BAT;.CMD', pwshHome: undefined, ...search }),
    lookupFolders: () => Promise.resolve(shellLookupFolders({ PATH: search.path })),
  };
}

const powershell = (command: string, machine: ChatMachine) => provenReadOnlyShell('PowerShell', { command }, machine, root);

// The PATH folders are real folders of this host, which a POSIX host spells as relative ones under win32's rules.
describe.runIf(process.platform === 'win32')('provenReadOnlyShell: what a PowerShell command runs on win32', () => {
  it('proves a command whose program PATH holds only as an .exe', async () => {
    const verdict = await powershell('rg TODO src', windowsMachine({ path: pathFolder('rg.exe') }));
    expect(verdict).toEqual({ readOnly: true, commandNames: ['rg', 'get-rg'], drives: [], home: false });
  });

  it('refuses one whose program a PATH folder holds as a .cmd, in any folder and any case', async () => {
    const verdict = await powershell('rg TODO src', windowsMachine({ path: [pathFolder('rg.exe'), pathFolder('RG.CMD')].join(';') }));
    expect(verdict.readOnly).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringMatching(/`rg` may run .*RG\.CMD, a script or document rather than the command/) });
  });

  it('notices a .cmd added to a PATH folder after a lookup', async () => {
    const folder = pathFolder('rg.exe');
    const machine = windowsMachine({ path: folder });
    expect((await powershell('rg TODO src', machine)).readOnly).toBe(true);
    fs.writeFileSync(path.join(folder, 'rg.cmd'), '@echo off');
    expect((await powershell('rg TODO src', machine)).readOnly).toBe(false);
  });

  it('refuses a cmdlet a PATH script shadows, as PowerShell runs it before loading the cmdlet\'s module, through an alias too', async () => {
    const machine = windowsMachine({ path: pathFolder('Get-Content.cmd') });
    expect((await powershell('Get-Content a.txt', machine)).readOnly).toBe(false);
    expect((await powershell('gc a.txt', machine)).readOnly).toBe(false);
    expect((await powershell('Get-ChildItem', machine)).readOnly).toBe(true);
  });

  it('refuses a Get- script PowerShell falls back to when the program is not found', async () => {
    expect((await powershell('rg TODO src', windowsMachine({ path: pathFolder('Get-rg.cmd') }))).readOnly).toBe(false);
  });

  it('refuses a .ps1, which PowerShell runs whatever PATHEXT holds, and a file with no extension', async () => {
    expect((await powershell('rg TODO src', windowsMachine({ path: pathFolder('rg.ps1') }))).readOnly).toBe(false);
    expect((await powershell('rg TODO src', windowsMachine({ path: pathFolder('rg') }))).readOnly).toBe(false);
  });

  it('refuses an extension the PATHEXT of the tool environment adds, and one of the stock list it leaves out', async () => {
    expect((await powershell('rg TODO src', windowsMachine({ path: pathFolder('rg.py'), pathext: '.COM;.EXE;.PY' }))).readOnly).toBe(false);
    expect((await powershell('rg TODO src', windowsMachine({ path: pathFolder('rg.vbs'), pathext: '.COM;.EXE' }))).readOnly).toBe(false);
  });

  it('looks in the folder pwsh puts ahead of PATH', async () => {
    expect((await powershell('rg TODO src', windowsMachine({ path: pathFolder('rg.exe'), pwshHome: pathFolder('rg.bat') }))).readOnly).toBe(false);
  });

  it('skips an empty PATH entry, which PowerShell never searches, and a missing folder', async () => {
    const verdict = await powershell('rg TODO src', windowsMachine({ path: `;${pathFolder('rg.exe')};;${path.join(root, 'missing')};` }));
    expect(verdict.readOnly).toBe(true);
  });

  it('reads a quoted PATH entry as its folder', async () => {
    expect((await powershell('rg TODO src', windowsMachine({ path: `"${pathFolder('rg.cmd')}"` }))).readOnly).toBe(false);
  });

  it('refuses when a PATH folder cannot be read', async () => {
    const file = path.join(pathFolder('x'), 'x');
    const machine: ChatMachine = { ...windowsMachine({ path: '' }), powerShellSearch: () => Promise.resolve({ path: `${file}\0`, pathext: undefined, pwshHome: undefined }) };
    expect(await powershell('rg TODO src', machine)).toMatchObject({ readOnly: false, reason: expect.stringContaining('could not be read') });
  });
});

describe('provenReadOnlyShell: the PowerShell lookup on any host', () => {
  it('refuses every program when PATH holds a relative folder, which PowerShell searches from a folder a command can change', async () => {
    for (const entry of ['.', 'bin', String.raw`\tools`, 'C:tools', '%SystemRoot%\\bin']) {
      const verdict = await powershell('rg TODO src', windowsMachine({ path: `${String.raw`C:\Program Files\ripgrep`};${entry}` }));
      expect(verdict).toMatchObject({ readOnly: false, reason: expect.stringContaining(`relative folder \`${entry}\``) });
    }
  });

  it('refuses a native program when the lookup is not available', async () => {
    const machine: ChatMachine = { platform: 'win32', allowedNetworkHosts: () => Promise.resolve(new Set()) };
    expect((await powershell('rg TODO src', machine)).readOnly).toBe(false);
  });

  it('looks nothing up for a command that runs no native program, for bash, and off win32', async () => {
    const lookups: string[] = [];
    const counting = (platform: NodeJS.Platform): ChatMachine => ({
      platform,
      allowedNetworkHosts: () => Promise.resolve(new Set()),
      lookupFolders: () => Promise.resolve([]),
      powerShellSearch: () => {
        lookups.push(platform);
        return Promise.resolve({ path: pathFolder('rg.cmd'), pathext: undefined, pwshHome: undefined });
      },
    });
    expect((await provenReadOnlyShell('Bash', { command: 'rg TODO src' }, counting('win32'), root)).readOnly).toBe(true);
    expect((await powershell('rg TODO src', counting('linux'))).readOnly).toBe(true);
    expect(lookups).toEqual([]);
  });

  it('passes the chat\'s hosts to the classifier', async () => {
    const machine = (hosts: string[]): ChatMachine => ({ platform: 'linux', allowedNetworkHosts: () => Promise.resolve(new Set(hosts)) });
    expect((await provenReadOnlyShell('Bash', { command: 'cat //nas/proj/a.txt' }, machine([]), root)).readOnly).toBe(false);
    expect((await provenReadOnlyShell('Bash', { command: 'cat //nas/proj/a.txt' }, machine(['nas']), root)).readOnly).toBe(true);
  });

  it('looks commands up in every PATH spelling and pwsh\'s install folder', () => {
    expect(shellLookupFolders({ Path: String.raw`C:\a;"C:\b c";;`, PATH: '/c/x', ProgramFiles: String.raw`C:\Program Files` })).toEqual([
      String.raw`C:\a`, String.raw`C:\b c`, '/c/x', String.raw`C:\Program Files\PowerShell\7`,
    ]);
  });

  it('is no shell verdict for another tool', async () => {
    expect(await provenReadOnlyShell('Read', { command: 'ls' }, windowsMachine({ path: '' }), root)).toEqual({ readOnly: false, reason: 'Read is not a shell tool' });
  });
});

// Q: a network drive on 192.0.2.7 and S: a subst drive onto a share on 192.0.2.8, neither one of the chat's hosts; U: a network
// drive on files.invalid, the chat's host; L: a subst drive onto a local folder; F: a drive QueryDosDeviceW cannot answer for.
describe.runIf(process.platform === 'win32')('provenReadOnlyShell: a drive Windows maps to another computer', () => {
  const local = fs.mkdtempSync(path.join(root, 'subst-'));
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  // null: a machine that cannot tell the shell's home folders
  const mapped = (homes: readonly string[] | null = [home]): ChatMachine => ({
    ...windowsMachine({ path: '' }),
    allowedNetworkHosts: () => Promise.resolve(new Set(['files.invalid'])),
    ...(homes === null ? {} : { homeFolders: () => Promise.resolve(homes) }),
  });
  const proven = async (tool: string, command: string, machine = mapped(), cwd = root): Promise<boolean> => (await provenReadOnlyShell(tool, { command }, machine, cwd)).readOnly;

  const mapDrives = (): void => {
    dosDevices.set('Q:', String.raw`\Device\LanmanRedirector\;Q:000000000004111a\192.0.2.7\data`);
    dosDevices.set('S:', String.raw`\??\UNC\192.0.2.8\s\dir`);
    dosDevices.set('U:', String.raw`\Device\LanmanRedirector\;U:000000000004111a\files.invalid\proj`);
    dosDevices.set('L:', `\\??\\${local}`);
    dosDevices.set('F:', new Error('QueryDosDeviceW(F:) failed with Win32 error 5'));
  };
  afterEach(() => dosDevices.clear());

  it.each([
    ['Bash', String.raw`cat 'Q:\x'`],
    ['Bash', String.raw`cat Q:\x`],
    ['Bash', 'cat q:x'],
    ['Bash', 'cat Q:/x'],
    ['Bash', 'ls Q:'],
    ['Bash', 'cat /q/x'],
    ['Bash', 'ls /q'],
    ['Bash', 'cat /proc/cygdrive/q/x'],
    ['Bash', 'cat /proc/self/root/q/x'],
    ['Bash', 'cat /proc/1/root/q/x'],
    ['Bash', 'cat /cygdrive/q/x'],
    ['Bash', 'cd / && cat q/x'],
    ['Bash', 'cat ../../q/x'],
    ['Bash', String.raw`cd /d 'Q:\' && ls`],
    ['Bash', 'grep -fQ:/p x'],
    ['Bash', 'grep --file=Q:/p x'],
    ['Bash', 'rg x Q:/'],
    ['Bash', String.raw`cat 'S:\x'`],
    ['PowerShell', String.raw`Get-Content Q:\x`],
    ['PowerShell', String.raw`type Q:\x`],
    ['PowerShell', 'dir Q:'],
    ['PowerShell', String.raw`cd Q:\x`],
    ['PowerShell', 'Get-Content q:x'],
    ['PowerShell', String.raw`Get-Content FileSystem::Q:\x`],
    ['PowerShell', String.raw`Get-Content Microsoft.PowerShell.Core\FileSystem::Q:\x`],
    ['PowerShell', String.raw`Get-Content -LiteralPath Q:\x`],
    ['PowerShell', String.raw`Get-Content -Path Q:\x`],
    ['PowerShell', String.raw`Resolve-Path Q:\x`],
    ['PowerShell', String.raw`Test-Path Q:\x`],
    ['PowerShell', String.raw`Get-ChildItem Q:\*`],
    ['PowerShell', String.raw`Get-ChildItem x,Q:\y`],
    ['PowerShell', String.raw`Select-String x Q:\y`],
    ['PowerShell', 'head /q/x'],
    ['PowerShell', String.raw`Get-Content S:\x`],
    // not in the read-only tables, so never proven
    ['PowerShell', 'Set-Location Q:'],
    ['PowerShell', 'sl Q:'],
    ['PowerShell', 'pushd Q:\\'],
    ['PowerShell', 'Push-Location Q:\\'],
    ['Bash', String.raw`pushd 'Q:\'`],
  ])('does not prove %s: %s, which opens a share off the chat\'s hosts', async (tool, command) => {
    mapDrives();
    expect(await proven(tool, command)).toBe(false);
  });

  it('names the drive and the host it reaches', async () => {
    mapDrives();
    const verdict = await provenReadOnlyShell('Bash', { command: 'cat /q/x' }, mapped(), root);
    expect(verdict).toMatchObject({ readOnly: false, reason: expect.stringMatching(/Q:.*192\.0\.2\.7/) });
  });

  it.each([
    ['Bash', String.raw`cat 'U:\x'`],
    ['Bash', 'cat /u/x'],
    ['PowerShell', String.raw`Get-Content U:\x`],
    ['Bash', String.raw`cat 'L:\x'`],
    ['PowerShell', String.raw`Get-Content L:\x`],
    ['Bash', 'cat a.txt src/q/x'],
    ['Bash', 'tr q z'],
    ['PowerShell', 'Get-Content /q/x'],
  ])('proves %s: %s, which opens this computer\'s drives or the chat\'s host only', async (tool, command) => {
    mapDrives();
    expect(await proven(tool, command)).toBe(true);
  });

  it('proves a command on a local drive', async () => {
    mapDrives();
    const system = `${process.env['SystemDrive'] ?? 'C:'}\\`;
    expect(await proven('Bash', `cat '${system}x'`)).toBe(true);
    expect(await proven('PowerShell', `Get-Content ${system}x`)).toBe(true);
  });

  it('does not prove a command naming a drive QueryDosDeviceW cannot answer for', async () => {
    mapDrives();
    const verdict = await provenReadOnlyShell('Bash', { command: String.raw`cat 'F:\x'` }, mapped(), root);
    expect(verdict).toMatchObject({ readOnly: false, reason: expect.stringContaining('Win32 error 5') });
  });

  it('does not prove any command whose working folder is on such a drive', async () => {
    mapDrives();
    expect(await proven('Bash', 'ls', mapped(), String.raw`Q:\proj`)).toBe(false);
    expect(await proven('PowerShell', 'Get-ChildItem', mapped(), String.raw`Q:\proj`)).toBe(false);
    expect(await proven('Bash', 'ls', mapped(), String.raw`F:\proj`)).toBe(false);
    expect(await proven('Bash', 'ls', mapped(), String.raw`U:\proj`)).toBe(true);
  });

  it('does not prove a command that reads the home when a home folder of the shell\'s environment is on such a drive, or unknown', async () => {
    mapDrives();
    for (const command of ['cat ~/x', 'cd && ls', 'cd ~ && ls']) {
      expect(await proven('Bash', command), command).toBe(true);
      expect(await proven('Bash', command, mapped([home, String.raw`Q:\Users\me`])), command).toBe(false);
      expect(await proven('Bash', command, mapped([])), command).toBe(false);
      expect(await proven('Bash', command, mapped(null)), command).toBe(false);
    }
    expect(await proven('PowerShell', String.raw`Get-Content ~\x`)).toBe(true);
    expect(await proven('PowerShell', String.raw`Get-Content ~\x`, mapped([String.raw`\\192.0.2.9\home\me`]))).toBe(false);
    expect(await proven('Bash', 'cat a.txt', mapped([String.raw`Q:\Users\me`]))).toBe(true);
  });

  it('places each PowerShell PATH folder before reading it, and never reads one off the chat\'s hosts', async () => {
    mapDrives();
    const read: string[] = [];
    const readdir = fs.promises.readdir.bind(fs.promises) as (folder: string) => Promise<string[]>;
    // a mapped letter here names no real drive, so its folder answers empty instead of being read
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(((folder: string) => {
      read.push(String(folder));
      return /^[QSUF]:/i.test(String(folder)) ? Promise.resolve([]) : readdir(folder);
    }) as unknown as typeof fs.promises.readdir);
    onTestFinished(() => {
      spy.mockRestore();
    });
    const searching = (search: Partial<PowerShellSearch> & { path: string }): ChatMachine => ({ ...mapped(), powerShellSearch: windowsMachine(search).powerShellSearch! });
    for (const folder of [String.raw`Q:\tools`, String.raw`S:\tools`, String.raw`F:\tools`]) {
      expect(await proven('PowerShell', 'rg TODO src', searching({ path: `${pathFolder('rg.exe')};${folder}` })), folder).toBe(false);
    }
    expect(await proven('PowerShell', 'rg TODO src', searching({ path: pathFolder('rg.exe'), pwshHome: String.raw`Q:\pwsh` }))).toBe(false);
    expect(read.filter((folder) => /^[QSF]:/i.test(folder))).toEqual([]);
    expect(await proven('PowerShell', 'rg TODO src', searching({ path: String.raw`U:\tools` }))).toBe(true);
    expect(read).toContain(String.raw`U:\tools`);
    expect(await proven('PowerShell', 'rg TODO src', searching({ path: pathFolder('rg.cmd') }))).toBe(false);
  });

  it('places every PATH folder before the pwsh search reads one, and reads none on a drive off the chat\'s hosts', async () => {
    mapDrives();
    const touched: string[] = [];
    const lstat = fs.promises.lstat.bind(fs.promises) as (file: string) => Promise<fs.Stats>;
    const stat = fs.promises.stat.bind(fs.promises) as (file: string) => Promise<fs.Stats>;
    const readdir = fs.promises.readdir.bind(fs.promises) as (folder: string) => Promise<string[]>;
    const missing = (file: string): Promise<never> => Promise.reject(Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' }));
    // a mapped letter here names no real drive, so its paths answer missing instead of being read
    const spies = [
      vi.spyOn(fs.promises, 'lstat').mockImplementation(((file: string) => (touched.push(String(file)), /^[QSUF]:/i.test(String(file)) ? missing(file) : lstat(file))) as unknown as typeof fs.promises.lstat),
      vi.spyOn(fs.promises, 'stat').mockImplementation(((file: string) => (touched.push(String(file)), /^[QSUF]:/i.test(String(file)) ? missing(file) : stat(file))) as unknown as typeof fs.promises.stat),
      vi.spyOn(fs.promises, 'readdir').mockImplementation(((folder: string) => (touched.push(String(folder)), /^[QSUF]:/i.test(String(folder)) ? missing(folder) : readdir(folder))) as unknown as typeof fs.promises.readdir),
    ];
    onTestFinished(() => {
      for (const spy of spies) spy.mockRestore();
    });
    // the chat's own lookup: both reads come from the one environment the shell tools start with
    const pi = { getAgentDir: () => root };
    const chat = (pathValue: string): ChatMachine => {
      const extra = { PATH: pathValue, ProgramFiles: root };
      return {
        ...mapped(),
        powerShellSearch: () => powerShellSearch(pi, extra),
        lookupFolders: () => Promise.resolve(shellLookupFolders(shellToolEnv(pi, extra))),
      };
    };
    expect(await proven('PowerShell', 'rg TODO src', chat(`${String.raw`Q:\tools`};${pathFolder('rg.exe')}`))).toBe(false);
    expect(await proven('Bash', 'cat a.txt', chat(`${String.raw`Q:\tools`};${pathFolder()}`))).toBe(false);
    expect(touched.filter((file) => /^[QSF]:/i.test(file))).toEqual([]);
    expect(await proven('PowerShell', 'rg TODO src', chat(`${String.raw`U:\tools`};${pathFolder('rg.exe')}`))).toBe(true);
    expect(touched.some((file) => /^U:\\tools/i.test(file))).toBe(true);
  });

  it.each([
    [String.raw`Q:\tools`],
    ['/q/tools'],
    ['/cygdrive/q/tools'],
    ['//192.0.2.9/s/bin'],
    [String.raw`\\192.0.2.9\s\bin`],
    [String.raw`S:\bin`],
    [String.raw`F:\bin`],
  ])('does not prove a bash command while the shell\'s PATH holds %s', async (folder) => {
    mapDrives();
    const machine: ChatMachine = { ...mapped(), lookupFolders: () => Promise.resolve([String.raw`U:\tools`, folder, 'bin', '/usr/bin']) };
    expect(await proven('Bash', 'cat a.txt', machine)).toBe(false);
  });

  it('proves a bash command whose PATH folders stay on this computer and the chat\'s hosts, and none whose folders are unknown', async () => {
    mapDrives();
    const folders = [String.raw`U:\tools`, String.raw`L:\bin`, '/u/tools', 'bin', '/usr/bin', String.raw`\tools`];
    expect(await proven('Bash', 'cat a.txt', { ...mapped(), lookupFolders: () => Promise.resolve(folders) })).toBe(true);
    const unknown: ChatMachine = { platform: 'win32', allowedNetworkHosts: () => Promise.resolve(new Set(['files.invalid'])), homeFolders: () => Promise.resolve([home]) };
    expect(await proven('Bash', 'cat a.txt', unknown)).toBe(false);
  });

  it('does not prove a command that reads every drive while one is mapped off the chat\'s hosts, and proves it while none is', async () => {
    const commands: Array<[string, string]> = [
      ['Bash', 'df'],
      ['Bash', 'df .'],
      ['PowerShell', 'df'],
      ['Bash', "find . -fstype ntfs"],
      ['Bash', "find . -printf '%F'"],
      ['Bash', 'cat /proc/mounts'],
      ['Bash', 'cat /proc/self/mountinfo'],
      ['Bash', 'cat /etc/mtab'],
      ['Bash', 'ls /cygdrive'],
      ['Bash', 'ls /proc/cygdrive'],
    ];
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') dosDevices.set(`${letter}:`, String.raw`\Device\HarddiskVolume3`);
    for (const [tool, command] of commands) expect(await proven(tool, command), command).toBe(true);
    dosDevices.set('Q:', String.raw`\Device\LanmanRedirector\;Q:000000000004111a\192.0.2.7\data`);
    for (const [tool, command] of commands) expect(await proven(tool, command), command).toBe(false);
    dosDevices.set('Q:', new Error('QueryDosDeviceW(Q:) failed with Win32 error 5'));
    for (const [tool, command] of commands) expect(await proven(tool, command), command).toBe(false);
  });
});
