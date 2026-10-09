import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_HOST_ARGS, MAX_HOST_PATH_CHARS } from '../../pty-host/protocol';
import { MAX_USER_TERMINAL_PROFILES } from '../../preload/terminal-channels';
import type { TerminalProfile } from '../terminal/profiles';
import {
  MAX_PROFILE_PATHS,
  MAX_TERMINAL_COMMAND_LINE_CHARS,
  profileFileKind,
  resolveTerminalProfiles,
  TerminalProfileCatalog,
  type ProfileFileKind,
  type UserProfileContext,
} from '../terminal/user-profiles';

const linkCheck = vi.hoisted(() => vi.fn<(base: string, segments: readonly string[]) => Promise<boolean>>());
vi.mock(import('../documents/confine'), async (importOriginal) => ({ ...(await importOriginal()), followsLocalLinksOnly: linkCheck }));

const PWSH: TerminalProfile = { id: 'pwsh', name: 'PowerShell', file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: [], icon: 'powershell' };
const CMD: TerminalProfile = { id: 'cmd', name: 'Command Prompt', file: 'C:\\Windows\\System32\\cmd.exe', args: [], icon: 'cmd' };
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function context(files: Record<string, ProfileFileKind>, overrides: Partial<UserProfileContext> = {}): UserProfileContext & { readonly checked: string[] } {
  const checked: string[] = [];
  return {
    platform: 'win32',
    env: { Path: 'C:\\Windows\\System32;relative\\bin;\\\\server\\share\\bin;C:\\Tools', PATHEXT: '.COM;.EXE;.BAT' },
    kind: (file) => {
      checked.push(file);
      return Promise.resolve(files[file.toLowerCase()] ?? 'missing');
    },
    checked,
    ...overrides,
  };
}

const lowerKeys = (files: Record<string, ProfileFileKind>): Record<string, ProfileFileKind> => Object.fromEntries(Object.entries(files).map(([file, kind]) => [file.toLowerCase(), kind]));

describe('user terminal profiles', () => {
  it('adds a profile with an absolute path and args, in its icon and color, after the detected ones', async () => {
    const ctx = context(lowerKeys({ [WINDOWS_POWERSHELL]: 'file' }));
    const setting = { 'VS Dev PowerShell': { path: WINDOWS_POWERSHELL, args: ['-NoExit', '-Command', '&{Import-Module "C:\\VS\\Microsoft.VisualStudio.DevShell.dll"}'], icon: 'code', color: 'magenta' } };
    const resolution = await resolveTerminalProfiles([PWSH, CMD], setting, ctx);
    expect(resolution.problems).toEqual([]);
    expect(resolution.profiles.map((profile) => profile.id)).toEqual(['pwsh', 'cmd', 'user:VS Dev PowerShell']);
    expect(resolution.profiles[2]).toEqual({
      id: 'user:VS Dev PowerShell',
      name: 'VS Dev PowerShell',
      file: WINDOWS_POWERSHELL,
      args: ['-NoExit', '-Command', '&{Import-Module "C:\\VS\\Microsoft.VisualStudio.DevShell.dll"}'],
      icon: 'powershell',
      source: 'user',
      customIcon: 'code',
      color: 'magenta',
    });
    expect(resolution.profiles[0]).toMatchObject({ source: 'detected', customIcon: null, color: null });
  });

  it('uses the first path that names a file, and finds a bare name on PATH, skipping relative and UNC entries', async () => {
    const ctx = context(lowerKeys({ 'C:\\Tools\\nu.exe': 'file', 'C:\\Windows\\System32\\bin': 'other' }));
    const resolution = await resolveTerminalProfiles([], { Nu: { path: ['C:\\missing\\nu.exe', 'nu'] } }, ctx);
    // PATHEXT's extensions as written, as VS Code's findExecutable appends them
    expect(resolution.profiles.map((profile) => [profile.file, profile.icon])).toEqual([['C:\\Tools\\nu.EXE', 'shell']]);
    expect(ctx.checked.some((file) => file.startsWith('\\\\') || file.startsWith('relative'))).toBe(false);
    expect(ctx.checked.every((file) => /^[A-Z]:\\/i.test(file))).toBe(true);
  });

  it('hides a detected profile set to null and replaces one an entry names, keeping its id and icon', async () => {
    const ctx = context(lowerKeys({ [WINDOWS_POWERSHELL]: 'file' }));
    const resolution = await resolveTerminalProfiles([PWSH, CMD], { 'Command Prompt': null, PowerShell: { path: WINDOWS_POWERSHELL, args: ['-NoLogo'], color: 'blue' }, Unknown: null }, ctx);
    expect(resolution.hidden).toEqual(['Command Prompt']);
    expect(resolution.profiles).toEqual([{ id: 'pwsh', name: 'PowerShell', file: WINDOWS_POWERSHELL, args: ['-NoLogo'], icon: 'powershell', source: 'user', customIcon: null, color: 'blue' }]);
    expect(resolution.problems).toEqual([]);
  });

  it.each([
    ['invalidName', { ' padded': { path: 'C:\\x.exe' } }, 'padded', null],
    ['invalidName', { 'evil\u202Etxt': { path: 'C:\\x.exe' } }, 'eviltxt', null],
    ['invalidName', { [`${'x'.repeat(65)}`]: { path: 'C:\\x.exe' } }, `${'x'.repeat(65)}`, null],
    ['invalidName', { '': { path: 'C:\\x.exe' } }, '', null],
    ['notAnObject', { Shell: 'C:\\x.exe' }, 'Shell', null],
    ['notAnObject', { Shell: ['C:\\x.exe'] }, 'Shell', null],
    ['unknownField', { Shell: { path: 'C:\\x.exe', env: { PATH: 'C:\\evil' } } }, 'Shell', 'env'],
    ['unknownField', { Shell: { path: 'C:\\x.exe', overrideName: true } }, 'Shell', 'overrideName'],
    ['missingPath', { Shell: { args: [] } }, 'Shell', null],
    ['invalidPath', { Shell: { path: 5 } }, 'Shell', null],
    ['invalidPath', { Shell: { path: [] } }, 'Shell', null],
    ['invalidPath', { Shell: { path: '' } }, 'Shell', null],
    ['invalidPath', { Shell: { path: ['C:\\x.exe', 7] } }, 'Shell', null],
    ['invalidPath', { Shell: { path: 'C:\\x\0.exe' } }, 'Shell', null],
    ['invalidPath', { Shell: { path: Array.from({ length: MAX_PROFILE_PATHS + 1 }, () => 'C:\\x.exe') } }, 'Shell', null],
    ['invalidPath', { Shell: { path: `C:\\${'x'.repeat(MAX_HOST_PATH_CHARS)}` } }, 'Shell', null],
    ['pathNotAllowed', { Shell: { path: '\\\\server\\share\\sh.exe' } }, 'Shell', '\\\\server\\share\\sh.exe'],
    ['pathNotAllowed', { Shell: { path: '//server/share/sh.exe' } }, 'Shell', '//server/share/sh.exe'],
    ['pathNotAllowed', { Shell: { path: '\\\\?\\C:\\sh.exe' } }, 'Shell', '\\\\?\\C:\\sh.exe'],
    ['pathNotAllowed', { Shell: { path: '\\\\.\\pipe\\sh' } }, 'Shell', '\\\\.\\pipe\\sh'],
    ['pathNotAllowed', { Shell: { path: 'C:sh.exe' } }, 'Shell', 'C:sh.exe'],
    ['pathNotAllowed', { Shell: { path: '\\Windows\\sh.exe' } }, 'Shell', '\\Windows\\sh.exe'],
    ['pathNotAllowed', { Shell: { path: '.\\node_modules\\.bin\\sh.exe' } }, 'Shell', '.\\node_modules\\.bin\\sh.exe'],
    ['pathNotAllowed', { Shell: { path: '~\\sh.exe' } }, 'Shell', '~\\sh.exe'],
    ['pathNotAllowed', { Shell: { path: 'C:\\tools\\CON' } }, 'Shell', 'C:\\tools\\CON'],
    ['pathNotAllowed', { Shell: { path: 'nul.exe' } }, 'Shell', 'nul.exe'],
    ['pathNotAllowed', { Shell: { path: 'sh.exe:stream' } }, 'Shell', 'sh.exe:stream'],
    ['pathNotAllowed', { Shell: { path: ['C:\\x.exe', '\\\\server\\x.exe'] } }, 'Shell', '\\\\server\\x.exe'],
    ['pathNotFound', { Shell: { path: ['C:\\missing.exe', 'nowhere'] } }, 'Shell', 'C:\\missing.exe'],
    ['pathNotAFile', { Shell: { path: 'C:\\folder' } }, 'Shell', 'C:\\folder'],
    ['pathNotAllowed', { Shell: { path: 'C:\\link-to-unc.exe' } }, 'Shell', 'C:\\link-to-unc.exe'],
    ['pathUnreadable', { Shell: { path: 'C:\\locked.exe' } }, 'Shell', 'C:\\locked.exe'],
    ['invalidArgs', { Shell: { path: 'C:\\x.exe', args: '-NoExit -Command evil' } }, 'Shell', null],
    ['invalidArgs', { Shell: { path: 'C:\\x.exe', args: ['-a', 1] } }, 'Shell', null],
    ['invalidArgs', { Shell: { path: 'C:\\x.exe', args: ['-a\0b'] } }, 'Shell', null],
    ['tooManyArgs', { Shell: { path: 'C:\\x.exe', args: Array.from({ length: MAX_HOST_ARGS + 1 }, () => '-a') } }, 'Shell', null],
    ['argsTooLong', { Shell: { path: 'C:\\x.exe', args: ['x'.repeat(MAX_HOST_PATH_CHARS + 1)] } }, 'Shell', null],
    ['argsTooLong', { Shell: { path: 'C:\\x.exe', args: Array.from({ length: MAX_HOST_ARGS }, () => 'x'.repeat(Math.ceil(MAX_TERMINAL_COMMAND_LINE_CHARS / MAX_HOST_ARGS))) } }, 'Shell', null],
    ['invalidIcon', { Shell: { path: 'C:\\x.exe', icon: '../../evil' } }, 'Shell', '../../evil'],
    ['invalidIcon', { Shell: { path: 'C:\\x.exe', icon: 'powershell' } }, 'Shell', 'powershell'],
    ['invalidColor', { Shell: { path: 'C:\\x.exe', color: '#ff0000' } }, 'Shell', '#ff0000'],
    ['invalidColor', { Shell: { path: 'C:\\x.exe', color: 3 } }, 'Shell', null],
  ])('refuses an entry with %s, lists it with its reason, and never launches it', async (reason, setting, name, detail) => {
    const ctx = context(lowerKeys({ 'C:\\x.exe': 'file', 'C:\\folder': 'other', 'C:\\link-to-unc.exe': 'refused', 'C:\\locked.exe': 'unreadable' }));
    const resolution = await resolveTerminalProfiles([PWSH], setting, ctx);
    expect(resolution.profiles.map((profile) => profile.id)).toEqual(['pwsh']);
    expect(resolution.problems).toEqual([{ name, reason, detail }]);
    if (reason !== 'pathNotFound' && reason !== 'pathNotAFile' && reason !== 'pathUnreadable' && !(reason === 'pathNotAllowed' && name === 'Shell' && detail === 'C:\\link-to-unc.exe')) expect(ctx.checked).toEqual([]);
  });

  it('refuses POSIX paths the same way: relative with a folder and ~ before any file system call', async () => {
    const ctx = context({ '/usr/bin/fish': 'file', '/opt/bin/xonsh': 'file' }, { platform: 'linux', env: { PATH: '/opt/bin:bin:.' } });
    const resolution = await resolveTerminalProfiles([], { Fish: { path: '/usr/bin/fish', args: ['-l'] }, Xonsh: { path: 'xonsh' }, Rel: { path: 'bin/sh' }, Home: { path: '~/sh' } }, ctx);
    expect(resolution.profiles.map((profile) => [profile.name, profile.file, profile.icon])).toEqual([['Fish', '/usr/bin/fish', 'fish'], ['Xonsh', '/opt/bin/xonsh', 'shell']]);
    expect(resolution.problems.map((problem) => [problem.name, problem.reason])).toEqual([['Rel', 'pathNotAllowed'], ['Home', 'pathNotAllowed']]);
    expect(ctx.checked).toEqual(['/usr/bin/fish', '/opt/bin/xonsh']);
  });

  it('refuses a setting that is not an object of entries, and entries past the limit', async () => {
    const ctx = context(lowerKeys({ 'C:\\x.exe': 'file' }));
    expect((await resolveTerminalProfiles([PWSH], ['x'], ctx)).problems).toEqual([{ name: null, reason: 'settingNotAnObject', detail: null }]);
    expect((await resolveTerminalProfiles([PWSH], 'x', ctx)).profiles.map((profile) => profile.id)).toEqual(['pwsh']);
    expect(await resolveTerminalProfiles([PWSH], undefined, ctx)).toMatchObject({ problems: [], hidden: [] });
    const many = Object.fromEntries(Array.from({ length: MAX_USER_TERMINAL_PROFILES + 3 }, (_, index) => [`Shell ${index}`, { path: 'C:\\x.exe' }]));
    const resolution = await resolveTerminalProfiles([], many, ctx);
    expect(resolution.profiles).toHaveLength(MAX_USER_TERMINAL_PROFILES);
    expect(resolution.problems).toEqual([{ name: null, reason: 'tooManyProfiles', detail: null }]);
  });

  it('infers the shell kind from the executable for the icon and the shell integration', async () => {
    const files = lowerKeys({ 'C:\\Git\\bin\\bash.exe': 'file', 'C:\\Windows\\System32\\cmd.exe': 'file', 'C:\\Windows\\System32\\wsl.exe': 'file', 'C:\\PS\\pwsh.exe': 'file' });
    const resolution = await resolveTerminalProfiles([], { A: { path: 'C:\\Git\\bin\\bash.exe' }, B: { path: 'C:\\Windows\\System32\\cmd.exe' }, C: { path: 'C:\\Windows\\System32\\wsl.exe' }, D: { path: 'C:\\PS\\pwsh.exe' } }, context(files));
    expect(resolution.profiles.map((profile) => profile.icon)).toEqual(['bash', 'cmd', 'wsl', 'powershell']);
  });

  it('cleans a problem\'s name and detail like a title', async () => {
    const resolution = await resolveTerminalProfiles([], { Shell: { path: 'C:\\x.exe', icon: `evil\u202E${'y'.repeat(300)}` } }, context({}));
    expect(resolution.problems[0]!.detail).not.toContain('\u202E');
    expect(resolution.problems[0]!.detail!.length).toBeLessThanOrEqual(100);
  });
});

describe('the profile catalog', () => {
  it('lists the detected profiles once they are known, applies the setting, and keeps only the latest validation', async () => {
    let setting: unknown = { Extra: { path: 'C:\\x.exe' } };
    const changes = vi.fn();
    let release: () => void = () => undefined;
    const files: Record<string, ProfileFileKind> = lowerKeys({ 'C:\\x.exe': 'file', 'C:\\y.exe': 'file' });
    const ctx = context(files, {
      kind: async (file) => {
        if (file === 'C:\\x.exe') await new Promise<void>((resolve) => { release = resolve; });
        return files[file.toLowerCase()] ?? 'missing';
      },
    });
    const catalog = new TerminalProfileCatalog({ setting: () => setting, context: ctx, log: () => undefined, onDidChange: changes });
    expect(catalog.profiles()).toEqual([]);
    const first = catalog.setDetected([PWSH]);
    setting = { Other: { path: 'C:\\y.exe' } };
    const second = catalog.refresh();
    await second;
    release();
    await first;
    expect(catalog.profiles().map((profile) => profile.id)).toEqual(['pwsh', 'user:Other']);
    expect(changes).toHaveBeenCalledOnce();
    setting = { PowerShell: null, Bad: { path: 7 } };
    await catalog.refresh();
    expect(catalog.profiles()).toEqual([]);
    expect(catalog.hidden()).toEqual(['PowerShell']);
    expect(catalog.problems()).toEqual([{ name: 'Bad', reason: 'invalidPath', detail: null }]);
  });

  it('settles detection only once the latest validation finished, when an overtaken one finishes first', async () => {
    let setting: unknown = { Extra: { path: 'C:\\x.exe' } };
    let release: () => void = () => undefined;
    const files: Record<string, ProfileFileKind> = lowerKeys({ 'C:\\x.exe': 'file', 'C:\\y.exe': 'file' });
    const ctx = context(files, {
      kind: async (file) => {
        if (file === 'C:\\y.exe') await new Promise<void>((resolve) => { release = resolve; });
        return files[file.toLowerCase()] ?? 'missing';
      },
    });
    const catalog = new TerminalProfileCatalog({ setting: () => setting, context: ctx, log: () => undefined, onDidChange: () => undefined });
    let detected = false;
    void catalog.setDetected([PWSH]).then(() => { detected = true; });
    setting = { Other: { path: 'C:\\y.exe' } };
    const second = catalog.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(detected).toBe(false);
    expect(catalog.profiles()).toEqual([]);
    release();
    await second;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(detected).toBe(true);
    expect(catalog.profiles().map((profile) => profile.id)).toEqual(['pwsh', 'user:Other']);
  });
});

describe('a profile executable on disk', () => {
  it('walks a Windows path\'s links for a UNC or device target whatever platform runs the test, and no other platform\'s', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-kind-'));
    const file = path.join(folder, 'shell.exe');
    await fs.writeFile(file, '');
    const root = path.parse(file).root;
    try {
      linkCheck.mockResolvedValue(false);
      expect(await profileFileKind(file, 'win32', () => undefined)).toBe('refused');
      expect(linkCheck).toHaveBeenCalledWith(root, path.relative(root, file).split(path.sep).filter(Boolean));
      linkCheck.mockResolvedValue(true);
      expect(await profileFileKind(file, 'win32', () => undefined)).toBe('file');
      linkCheck.mockClear();
      expect(await profileFileKind(file, 'linux', () => undefined)).toBe('file');
      expect(await profileFileKind(folder, 'darwin', () => undefined)).toBe('other');
      expect(linkCheck).not.toHaveBeenCalled();
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });
});
