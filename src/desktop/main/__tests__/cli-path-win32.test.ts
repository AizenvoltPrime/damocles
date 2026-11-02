import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adminScript, CLI_PATH_RECORD, createCliPath, pointsInto, shellWord } from '../cli-path';
import { promises as fsp } from 'node:fs';
import { broadcastEnvironmentChange, changePath, readStringValues, sameEntry, windowsRegistry, withEntry, withoutEntry, type PathRegistry, type PathValue } from '../cli-path-win32';
import { withInstallerLog } from '../cli-path';
import { log } from '../../../core/logger';

const BIN = 'C:\\Users\\ada\\AppData\\Local\\Programs\\damocles\\resources\\bin';

describe('the damocles entry in the user\'s Path', () => {
  it('adds the entry once, comparing without case or a trailing backslash', () => {
    expect(withEntry('%USERPROFILE%\\bin;C:\\Tools', BIN)).toBe(`%USERPROFILE%\\bin;C:\\Tools;${BIN}`);
    expect(withEntry('', BIN)).toBe(BIN);
    expect(withEntry('C:\\Tools;', BIN)).toBe(`C:\\Tools;${BIN};`);
    expect(withEntry(`C:\\Tools;${BIN.toUpperCase()}\\`, BIN)).toBeUndefined();
    expect(withEntry(`${BIN}\\\\;C:\\Tools`, BIN)).toBeUndefined();
    expect(sameEntry('', '')).toBe(false);
  });

  it('removes only Damocles\' entry, every copy of it, keeping the others byte for byte and in order', () => {
    expect(withoutEntry(`%USERPROFILE%\\bin;${BIN};C:\\Tools;;%LOCALAPPDATA%\\x`, BIN)).toBe('%USERPROFILE%\\bin;C:\\Tools;;%LOCALAPPDATA%\\x');
    expect(withoutEntry(`${BIN.toLowerCase()}\\;C:\\Tools;${BIN}`, BIN)).toBe('C:\\Tools');
    expect(withoutEntry('C:\\Tools;C:\\Users\\ada\\AppData\\Local\\Programs\\damocles\\resources\\bin2', BIN)).toBeUndefined();
  });

  it('gives back the value as it was seeded, byte for byte, after an add and a remove', () => {
    for (const seeded of ['%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;', 'C:\\Tools', 'C:\\Tools;;', ';']) {
      expect(withoutEntry(withEntry(seeded, BIN)!, BIN)).toBe(seeded);
    }
  });

  it('rewrites through the registry only when the entry changes, reading a missing value as empty and leaving it missing', () => {
    const written: string[] = [];
    let value: PathValue | undefined;
    const registry: PathRegistry = {
      read: () => value,
      write: (data) => { written.push(data); value = { type: 'REG_EXPAND_SZ', data }; },
      remove: () => { written.push('<removed>'); value = undefined; },
    };
    expect(changePath(registry, (current) => withEntry(current, BIN))).toBe(true);
    expect(changePath(registry, (current) => withEntry(current, BIN))).toBe(false);
    expect(changePath(registry, (current) => withoutEntry(current, BIN))).toBe(true);
    expect(written).toEqual([BIN, '<removed>']);
    expect(value).toBeUndefined();
  });

  it('broadcasts the change on koffi\'s worker thread, never blocking main\'s', async () => {
    const calls: unknown[][] = [];
    const send = {
      async: (...args: unknown[]): void => {
        calls.push(args.slice(0, -1));
        const done = args.at(-1) as (err: unknown, result: unknown) => void;
        setImmediate(() => done(null, 1));
      },
    };
    await expect(broadcastEnvironmentChange(send)).resolves.toBeUndefined();
    expect(calls).toEqual([[0xffff, 0x001a, 0, 'Environment', 0x0002, 5000, [0]]]);
    const failing = { async: (...args: unknown[]): void => (args.at(-1) as (err: unknown) => void)(new Error('no user32')) };
    await expect(broadcastEnvironmentChange(failing)).rejects.toThrow('no user32');
  });
});

describe('the PATH commands', () => {
  const folders: string[] = [];
  afterEach(async () => {
    await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })));
  });

  async function setup(initial: string) {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'damocles-cli-path-'));
    folders.push(userDataDir);
    let value: PathValue = { type: 'REG_EXPAND_SZ', data: initial };
    let broadcasts = 0;
    const cliPath = createCliPath({
      binDir: BIN,
      userDataDir,
      registry: () => ({ read: () => value, write: (data) => { value = { type: 'REG_EXPAND_SZ', data }; }, remove: () => { throw new Error('no test here removes the whole value'); } }),
      broadcast: async () => { broadcasts++; },
      log: () => undefined,
    });
    return { cliPath, userDataDir, value: () => value.data, broadcasts: () => broadcasts };
  }

  it('lets the installer add the entry and the uninstaller remove it, telling running programs each time', async () => {
    const { cliPath, value, broadcasts } = await setup('%USERPROFILE%\\bin');
    await expect(cliPath.add('installer')).resolves.toBe('added');
    await expect(cliPath.add('installer')).resolves.toBe('alreadyPresent');
    expect(value()).toBe(`%USERPROFILE%\\bin;${BIN}`);
    await expect(cliPath.remove('installer')).resolves.toBe('removed');
    await expect(cliPath.remove('installer')).resolves.toBe('notPresent');
    expect(value()).toBe('%USERPROFILE%\\bin');
    expect(broadcasts()).toBe(2);
  });

  it('records the user\'s removal so an update\'s installer leaves Path alone, until the user adds it again', async () => {
    const { cliPath, value, userDataDir } = await setup('C:\\Tools');
    await cliPath.add('installer');
    await expect(cliPath.remove('user')).resolves.toBe('removed');
    expect(JSON.parse(await fs.readFile(path.join(userDataDir, CLI_PATH_RECORD), 'utf8'))).toEqual({ removed: true });
    await expect(cliPath.add('installer')).resolves.toBe('keptRemoved');
    expect(value()).toBe('C:\\Tools');
    await expect(cliPath.add('user')).resolves.toBe('added');
    await expect(fs.stat(path.join(userDataDir, CLI_PATH_RECORD))).rejects.toThrow();
    // the uninstaller's removal records nothing
    await cliPath.remove('installer');
    await expect(cliPath.add('installer')).resolves.toBe('added');
  });

  it('writes the installer\'s --cli-path lines to main\'s log file, which no window has opened yet', async () => {
    const logsDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'damocles-cli-path-log-')), 'logs');
    folders.push(path.dirname(logsDir));
    await expect(withInstallerLog(logsDir, 'Damocles', async () => {
      log('[cli-path] --cli-path add: added');
      return 0;
    })).resolves.toBe(0);
    expect(await fsp.readFile(path.join(logsDir, 'Damocles.log'), 'utf8')).toContain('[cli-path] --cli-path add: added\n');
  });

  it('quotes the macOS administrator command for AppleScript and sh, and knows a link of the app\'s', () => {
    const target = "/Applications/Dam \"o\" 'cles'.app/Contents/Resources/bin/damocles";
    expect(shellWord(target)).toBe(`'/Applications/Dam "o" '\\''cles'\\''.app/Contents/Resources/bin/damocles'`);
    expect(adminScript(`ln -sfh ${shellWord(target)} '/usr/local/bin/damocles'`)).toBe(`do shell script "ln -sfh '/Applications/Dam \\"o\\" '\\\\''cles'\\\\''.app/Contents/Resources/bin/damocles' '/usr/local/bin/damocles'" with administrator privileges`);
    expect(pointsInto('/Applications/Damocles.app/Contents/Resources/bin/damocles', '/usr/local/bin', '/Applications/Damocles.app')).toBe(true);
    expect(pointsInto('../../../Applications/Damocles.app/Contents/Resources/bin/damocles', '/usr/local/bin', '/Applications/Damocles.app')).toBe(true);
    expect(pointsInto('/Applications/Damocles.app.evil/bin/damocles', '/usr/local/bin', '/Applications/Damocles.app')).toBe(false);
    expect(pointsInto('/opt/homebrew/bin/damocles', '/usr/local/bin', '/Applications/Damocles.app')).toBe(false);
  });
});

// The registry wrapper against a key this test makes and deletes; the user's Environment key is never opened here, and
// nothing is broadcast.
describe.runIf(process.platform === 'win32')('the registry wrapper on Windows', () => {
  const reg = (args: readonly string[]): string => execFileSync(path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe'), [...args], { encoding: 'utf8' });

  it('reads the raw value and writes it back as REG_EXPAND_SZ, keeping %USERPROFILE% entries unexpanded', () => {
    const subKey = `Software\\Damocles-e2e-${randomBytes(8).toString('hex')}`;
    reg(['add', `HKCU\\${subKey}`, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', '%USERPROFILE%\\bin;C:\\Tools', '/f']);
    try {
      const registry = windowsRegistry(subKey);
      expect(registry.read()).toEqual({ type: 'REG_EXPAND_SZ', data: '%USERPROFILE%\\bin;C:\\Tools' });
      expect(changePath(registry, (value) => withEntry(value, BIN))).toBe(true);
      expect(changePath(registry, (value) => withEntry(value, BIN))).toBe(false);
      const query = reg(['query', `HKCU\\${subKey}`, '/v', 'Path']);
      expect(query).toMatch(new RegExp(`Path\\s+REG_EXPAND_SZ\\s+%USERPROFILE%\\\\bin;C:\\\\Tools;${BIN.replace(/\\/g, '\\\\')}`));
      expect(changePath(registry, (value) => withoutEntry(value, BIN))).toBe(true);
      expect(registry.read()).toEqual({ type: 'REG_EXPAND_SZ', data: '%USERPROFILE%\\bin;C:\\Tools' });
      // a REG_SZ value is read as it is and written back as REG_EXPAND_SZ
      reg(['add', `HKCU\\${subKey}`, '/v', 'Path', '/t', 'REG_SZ', '/d', 'C:\\Tools', '/f']);
      expect(registry.read()).toEqual({ type: 'REG_SZ', data: 'C:\\Tools' });
      changePath(registry, (value) => withEntry(value, BIN));
      expect(reg(['query', `HKCU\\${subKey}`, '/v', 'Path'])).toMatch(/Path\s+REG_EXPAND_SZ\s+C:\\Tools;/);
      // a missing value reads as absent, and removing one is nothing
      expect(windowsRegistry(subKey, 'NoSuchValue').read()).toBeUndefined();
      windowsRegistry(subKey, 'NoSuchValue').remove();
      // removing the entry from a value that held only it leaves no value, as there was none before
      reg(['add', `HKCU\\${subKey}`, '/v', 'Lone', '/t', 'REG_EXPAND_SZ', '/d', BIN, '/f']);
      const lone = windowsRegistry(subKey, 'Lone');
      expect(changePath(lone, (value) => withoutEntry(value, BIN))).toBe(true);
      expect(lone.read()).toBeUndefined();
      // every string value of the key, raw, in its order, and nothing of another type
      reg(['add', `HKCU\\${subKey}`, '/v', 'Count', '/t', 'REG_DWORD', '/d', '7', '/f']);
      reg(['add', `HKCU\\${subKey}`, '/v', 'Big', '/t', 'REG_SZ', '/d', 'x'.repeat(5000), '/f']);
      expect(readStringValues('HKCU', subKey)).toEqual([
        { name: 'Path', type: 'REG_EXPAND_SZ', data: `C:\\Tools;${BIN}` },
        { name: 'Big', type: 'REG_SZ', data: 'x'.repeat(5000) },
      ]);
      // the machine's environment key reads too, and names Path
      expect(readStringValues('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment').some((value) => value.name.toUpperCase() === 'PATH')).toBe(true);
    } finally {
      reg(['delete', `HKCU\\${subKey}`, '/f']);
    }
    expect(() => windowsRegistry(subKey).read()).toThrow('RegOpenKeyExW');
  });
});
