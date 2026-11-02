import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStringValues } from '../../cli-path-win32';
import { windowsTerminalEnvironment } from '../windows-terminal-environment';

// The registry read against keys this test makes and deletes under HKCU\Software; the user's and the machine's environment keys
// are never opened here.
describe.runIf(process.platform === 'win32')('a new local terminal\'s environment on Windows', () => {
  const reg = (args: readonly string[]): string => execFileSync(path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe'), [...args], { encoding: 'utf8' });

  it('is built from the registry at each spawn, so a Path entry added since Damocles started reaches the next terminal', () => {
    const root = `Software\\Damocles-e2e-${randomBytes(8).toString('hex')}`;
    const machine = `${root}\\Machine`;
    const user = `${root}\\User`;
    reg(['add', `HKCU\\${machine}`, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', '%SystemRoot%\\system32', '/f']);
    reg(['add', `HKCU\\${user}`, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', '%USERPROFILE%\\bin', '/f']);
    try {
      const keys = { HKLM: machine, HKCU: user } as const;
      const read: typeof readStringValues = (hive) => readStringValues('HKCU', keys[hive]);
      const inherited = { Path: 'C:\\started-with', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\ada' };
      expect(windowsTerminalEnvironment(inherited, () => undefined, read)['Path']).toBe('C:\\Windows\\system32;C:\\Users\\ada\\bin');
      // the installer adds the damocles command while Damocles runs
      reg(['add', `HKCU\\${user}`, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', '%USERPROFILE%\\bin;C:\\Damocles\\resources\\bin', '/f']);
      expect(windowsTerminalEnvironment(inherited, () => undefined, read)['Path']).toBe('C:\\Windows\\system32;C:\\Users\\ada\\bin;C:\\Damocles\\resources\\bin');
    } finally {
      reg(['delete', `HKCU\\${root}`, '/f']);
    }
  });

  it('keeps what Damocles inherited, saying why, when the registry cannot be read', () => {
    const lines: string[] = [];
    const inherited = { Path: 'C:\\started-with' };
    expect(windowsTerminalEnvironment(inherited, (line) => lines.push(line), () => readStringValues('HKCU', `Software\\Damocles-e2e-missing-${randomBytes(8).toString('hex')}`))).toBe(inherited);
    expect(lines).toEqual([expect.stringMatching(/^\[terminal\] the registry's environment could not be read, so the terminal starts with Damocles' own: RegOpenKeyExW /)]);
  });
});
