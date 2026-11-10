import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { provenReadOnlyShell, type ChatMachine, type PowerShellSearch } from '../proven-shell';

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
  };
}

const powershell = (command: string, machine: ChatMachine) => provenReadOnlyShell('PowerShell', { command }, machine);

// The PATH folders are real folders of this host, which a POSIX host spells as relative ones under win32's rules.
describe.runIf(process.platform === 'win32')('provenReadOnlyShell: what a PowerShell command runs on win32', () => {
  it('proves a command whose program PATH holds only as an .exe', async () => {
    const verdict = await powershell('rg TODO src', windowsMachine({ path: pathFolder('rg.exe') }));
    expect(verdict).toEqual({ readOnly: true, commandNames: ['rg', 'get-rg'] });
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
      powerShellSearch: () => {
        lookups.push(platform);
        return Promise.resolve({ path: pathFolder('rg.cmd'), pathext: undefined, pwshHome: undefined });
      },
    });
    expect((await provenReadOnlyShell('Bash', { command: 'rg TODO src' }, counting('win32'))).readOnly).toBe(true);
    expect((await powershell('rg TODO src', counting('linux'))).readOnly).toBe(true);
    expect(lookups).toEqual([]);
  });

  it('passes the chat\'s hosts to the classifier', async () => {
    const machine = (hosts: string[]): ChatMachine => ({ platform: 'linux', allowedNetworkHosts: () => Promise.resolve(new Set(hosts)) });
    expect((await provenReadOnlyShell('Bash', { command: 'cat //nas/proj/a.txt' }, machine([]))).readOnly).toBe(false);
    expect((await provenReadOnlyShell('Bash', { command: 'cat //nas/proj/a.txt' }, machine(['nas']))).readOnly).toBe(true);
  });

  it('is no shell verdict for another tool', async () => {
    expect(await provenReadOnlyShell('Read', { command: 'ls' }, windowsMachine({ path: '' }))).toEqual({ readOnly: false, reason: 'Read is not a shell tool' });
  });
});
