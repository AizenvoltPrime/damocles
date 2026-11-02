import { describe, expect, it } from 'vitest';
import { decodeWslMessages, decodeWslOutput, listWslDistros, parseWslList, type WslListRun } from '../wsl-list';

// `wsl.exe --list --verbose` as WSL 3.0.3 wrote it on Windows 11: UTF-16LE, no byte-order mark, CRLF rows
const CAPTURED = [
  '  NAME                   STATE           VERSION',
  '* Debian                 Running         2',
  '  Ubuntu-24.04           Running         2',
  '  damocles-e2e-wsl1      Stopped         1',
  '  damocles-e2e-alpine    Stopped         2',
  '  Ubuntu                 Running         2',
  '  docker-desktop         Running         2',
  '',
].join('\r\n');
const capturedBytes = Buffer.from(CAPTURED, 'utf16le');

describe('wsl.exe --list --verbose', () => {
  it('reads the UTF-16LE bytes wsl.exe writes', () => {
    expect([...capturedBytes.subarray(0, 6)]).toEqual([0x20, 0x00, 0x20, 0x00, 0x4e, 0x00]);
    expect(decodeWslOutput(capturedBytes)).toBe(CAPTURED);
    expect(decodeWslOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), capturedBytes]))).toBe(CAPTURED);
  });

  it('reads the default marker, the state and the VERSION column, and hides docker-desktop', () => {
    expect(parseWslList(decodeWslOutput(capturedBytes))).toEqual([
      { distro: 'Debian', state: 'running', version: 2, isDefault: true },
      { distro: 'Ubuntu-24.04', state: 'running', version: 2, isDefault: false },
      { distro: 'damocles-e2e-wsl1', state: 'stopped', version: 1, isDefault: false },
      { distro: 'damocles-e2e-alpine', state: 'stopped', version: 2, isDefault: false },
      { distro: 'Ubuntu', state: 'running', version: 2, isDefault: false },
    ]);
  });

  it('hides every docker-desktop* distro, in any case', () => {
    const text = ['  NAME STATE VERSION', '  docker-desktop-data Stopped 2', '  Docker-Desktop Running 2', '* Alpine Stopped 1'].join('\r\n');
    expect(parseWslList(text).map((distro) => distro.distro)).toEqual(['Alpine']);
  });

  it('reads a localized state of several words as other, and skips rows that name no distro', () => {
    const text = ['  NAME      STATUS              VERSION', '* Debian    Wird ausgeführt     2', '  -bad  Stopped  2', '  Odd       Stopped  3', 'garbage'].join('\r\n');
    expect(parseWslList(text)).toEqual([{ distro: 'Debian', state: 'other', version: 2, isDefault: true }]);
  });

  it('runs System32\\wsl.exe with --list --verbose, and reports a failure instead of an empty list', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const run = (code: number | null, stdout: Buffer, stderr = Buffer.alloc(0)): WslListRun => async (file, args) => {
      calls.push({ file, args });
      return { code, stdout, stderr };
    };
    const env = { SystemRoot: 'C:\\Windows' };
    expect(await listWslDistros('win32', run(0, capturedBytes), env)).toMatchObject({ ok: true, distros: { length: 5 } });
    expect(calls[0]).toEqual({ file: 'C:\\Windows\\System32\\wsl.exe', args: ['--list', '--verbose'] });
    const none = await listWslDistros('win32', run(4294967295, Buffer.from('Windows Subsystem for Linux has no installed distributions.\r\n', 'utf16le')), env);
    expect(none).toEqual({ ok: false, reason: expect.stringContaining('has no installed distributions') as unknown as string });
    // what wsl.exe wrote to stderr stays in the logged reason
    const failed = await listWslDistros('win32', run(1, Buffer.alloc(0), Buffer.from('Error code: Wsl/Service/E_ACCESSDENIED\r\n', 'utf16le')), env);
    expect(failed).toEqual({ ok: false, reason: 'wsl.exe --list exited with 1: Error code: Wsl/Service/E_ACCESSDENIED' });
    expect(await listWslDistros('win32', run(null, Buffer.alloc(0)), env)).toEqual({ ok: false, reason: expect.stringContaining('in time') as unknown as string });
    expect(await listWslDistros('win32', () => Promise.reject(new Error('ENOENT')), env)).toEqual({ ok: false, reason: expect.stringContaining('ENOENT') as unknown as string });
    expect(await listWslDistros('linux', run(0, capturedBytes), env)).toEqual({ ok: false, reason: 'notWindows' });
  });

  it('runs the list without WSL_UTF8, in any case, so wsl.exe writes the UTF-16LE it is decoded as', async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const run: WslListRun = async (_file, _args, env) => {
      seen.push(env);
      return { code: 0, stdout: capturedBytes, stderr: Buffer.alloc(0) };
    };
    for (const name of ['WSL_UTF8', 'wsl_utf8']) {
      expect(await listWslDistros('win32', run, { SystemRoot: 'C:\\Windows', PATH: 'C:\\bin', [name]: '1' })).toMatchObject({ ok: true, distros: { length: 5 } });
      expect(seen.at(-1)).toEqual({ SystemRoot: 'C:\\Windows', PATH: 'C:\\bin' });
    }
  });

  it('tells wsl.exe\'s own UTF-16LE message from the distro\'s UTF-8, non-ASCII text included', () => {
    const greek = 'Σφάλμα: η διανομή δεν βρέθηκε.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n';
    expect(decodeWslMessages(Buffer.from(greek, 'utf16le'))).toBe(greek);
    expect(decodeWslMessages(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(greek, 'utf16le')]))).toBe(greek);
    // UTF-8 Greek holds no NUL, and is never read as UTF-16LE
    expect(decodeWslMessages(Buffer.from(greek, 'utf8'))).toBe(greek);
    expect(decodeWslMessages(Buffer.from('/mnt/c/Έργα/app\n', 'utf8'))).toBe('/mnt/c/Έργα/app\n');
    // Cyrillic U+0400 puts its NUL at an even offset, which the ASCII around it outweighs
    expect(decodeWslMessages(Buffer.from('Ѐ: not found\r\n', 'utf16le'))).toBe('Ѐ: not found\r\n');
    expect(decodeWslMessages(Buffer.alloc(0))).toBe('');
  });
});
