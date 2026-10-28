import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerManifest } from '../../server-manifest-format';
import { parseStageLine, StageProtocolError } from '../probe-parse';
import { POSIX_STAGE0, stage1Frame, WINDOWS_STAGE0_SCRIPT, windowsStage0 } from '../stage0';
import POSIX_TEMPLATE from '../stage1-posix.sh';
import WINDOWS_TEMPLATE from '../stage1-windows.ps1';
import { buildPosixStage1, buildWindowsStage1, validateInstallFolder } from '../stage1';
import REMOVE_POSIX from '../remove-posix.sh';
import REMOVE_WINDOWS from '../remove-windows.ps1';
import { LOCK_STALE_MS } from '../../../../daemon/singleton';
import { posixShell, powerShell, runWithBytes } from './shells';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const manifest: ServerManifest = {
  version: '3.7.0',
  protocolVersion: 1,
  packages: {
    'linux-x64': { file: 'damocles-server-3.7.0-linux-x64.tar.gz', sha256: sha('linux'), size: 76_500_000 },
    'alpine-arm64': { file: 'damocles-server-3.7.0-alpine-arm64.tar.gz', sha256: sha('alpine'), size: 70_000_000 },
    'win32-x64': { file: 'damocles-server-3.7.0-win32-x64.zip', sha256: sha('win'), size: 73_875_504 },
  },
};
const RELEASES = 'https://github.com/AizenvoltPrime/damocles/releases';

describe('stage 0', () => {
  it('is the fixed POSIX line carrying no user data', () => {
    expect(POSIX_STAGE0).toBe(`/bin/sh -c 'IFS= read -r n; s=$(dd bs=1 count="$n" 2>/dev/null); eval "$s"'`);
  });

  it('is under cmd PowerShell with the script as UTF-16LE base64, and under PowerShell the script itself', () => {
    const encoded = Buffer.from(WINDOWS_STAGE0_SCRIPT, 'utf16le').toString('base64');
    expect(windowsStage0('cmd')).toBe(`powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`);
    expect(windowsStage0('powershell')).toBe(WINDOWS_STAGE0_SCRIPT);
    // Win32-OpenSSH hands a PowerShell default shell the command inside double quotes
    expect(WINDOWS_STAGE0_SCRIPT).not.toMatch(/["\r\n]/);
  });

  it('frames stage 1 as its UTF-8 byte length on a line, then the bytes', () => {
    expect(stage1Frame('h\u00e9').toString('latin1')).toBe('3\nh\u00c3\u00a9');
  });

  it('runs an exact-length stage 1 under a real sh and leaves every byte after it on stdin', async () => {
    const sh = await posixShell();
    const input = Buffer.concat([stage1Frame("printf 'stage1:'; cat"), Buffer.from('after the stage')]);
    const { exit, stdout } = await runWithBytes({ file: sh, args: ['-c', POSIX_STAGE0], windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, input);
    expect(exit?.code).toBe(0);
    expect(stdout.toString('utf8')).toBe('stage1:after the stage');
  });
});

describe('Windows stage 0 under a real PowerShell', async () => {
  const shell = process.platform === 'win32' ? await powerShell() : undefined;
  // every byte value, then random bytes, echoed through the raw console streams after stage 1 is read
  const payload = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, index) => index)), randomBytes(64 * 1024)]);
  const echo = [
    `$left = ${payload.length}`,
    '$buffer = New-Object byte[] 65536',
    'while ($left -gt 0) { $read = $DamoclesIn.Read($buffer, 0, [Math]::Min($buffer.Length, $left)); if ($read -le 0) { exit 4 }; $DamoclesOut.Write($buffer, 0, $read); $left -= $read }',
    '$DamoclesOut.Flush()',
  ].join('\n');
  const run = async (args: string[]): Promise<Buffer> => {
    const { exit, stdout } = await runWithBytes({ file: shell!, args, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, Buffer.concat([stage1Frame(echo), payload]));
    expect(exit?.code).toBe(0);
    return stdout;
  };

  it.skipIf(shell === undefined)('passes every byte value through unchanged as cmd launches it (-EncodedCommand)', async () => {
    const [, ...args] = windowsStage0('cmd').split(' ');
    expect((await run(args)).equals(payload)).toBe(true);
  });

  it.skipIf(shell === undefined)('passes every byte value through unchanged as a PowerShell default shell runs it (-Command)', async () => {
    expect((await run(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsStage0('powershell')])).equals(payload)).toBe(true);
  });
});

describe('stage 1 text', () => {
  it('replaces only the POSIX parameter block, with each value as a quoted literal', () => {
    const text = buildPosixStage1({ manifest, releasesUrl: RELEASES, installFolder: "/opt/my 'tools' $x", previousInstallFolder: null });
    const block = [
      "D_VERSION='3.7.0'",
      "D_INSTALL_FOLDER='/opt/my '\\''tools'\\'' $x'",
      "D_PREVIOUS_KIND='default'",
      "D_PREVIOUS_FOLDER=''",
      `D_LINUX_X64='damocles-server-3.7.0-linux-x64.tar.gz ${sha('linux')} 76500000 ${RELEASES}/download/v3.7.0/damocles-server-3.7.0-linux-x64.tar.gz'`,
      "D_LINUX_ARM64=''",
      "D_ALPINE_X64=''",
      `D_ALPINE_ARM64='damocles-server-3.7.0-alpine-arm64.tar.gz ${sha('alpine')} 70000000 ${RELEASES}/download/v3.7.0/damocles-server-3.7.0-alpine-arm64.tar.gz'`,
      "D_DARWIN_X64=''",
      "D_DARWIN_ARM64=''",
    ].join('\n');
    expect(text).toBe(POSIX_TEMPLATE.replace(/# BEGIN PARAMETERS\n[\s\S]*?# END PARAMETERS/, `# BEGIN PARAMETERS\n${block}\n# END PARAMETERS`));
  });

  it('replaces only the Windows parameter block, with each value as a PowerShell literal', () => {
    const text = buildWindowsStage1({ manifest, releasesUrl: RELEASES, previousInstallFolder: "C:\\it's" });
    const block = [
      "$D_VERSION = '3.7.0'",
      "$D_INSTALL_FOLDER = ''",
      "$D_PREVIOUS_KIND = 'folder'",
      "$D_PREVIOUS_FOLDER = 'C:\\it''s'",
      `$D_WIN32_X64 = 'damocles-server-3.7.0-win32-x64.zip ${sha('win')} 73875504 ${RELEASES}/download/v3.7.0/damocles-server-3.7.0-win32-x64.zip'`,
      "$D_WIN32_ARM64 = ''",
    ].join('\n');
    expect(text).toBe(WINDOWS_TEMPLATE.replace(/# BEGIN PARAMETERS\r?\n[\s\S]*?# END PARAMETERS/, `# BEGIN PARAMETERS\n${block}\n# END PARAMETERS`));
  });

  it('refuses an install folder holding a newline before any stage text is built', () => {
    expect(() => buildPosixStage1({ manifest, releasesUrl: RELEASES, installFolder: '/opt/a\nb' })).toThrow();
    expect(() => buildWindowsStage1({ manifest, releasesUrl: RELEASES, installFolder: 'C:\\a\rb' })).toThrow();
  });
});

describe('the stage scripts\' shared rules', () => {
  const body = (script: string, start: string, end: string): string => {
    const at = script.indexOf(start);
    expect(at).toBeGreaterThanOrEqual(0);
    return script.slice(at, script.indexOf(end, at));
  };

  it('read a version folder with the same function in stage 1 and the removal, on each platform', () => {
    expect(body(POSIX_TEMPLATE, 'version_of_dir() {', '\n}\n')).toBe(body(REMOVE_POSIX, 'version_of_dir() {', '\n}\n'));
    expect(body(WINDOWS_TEMPLATE, 'function Get-DamoclesDirVersion', '\n}\n')).toBe(body(REMOVE_WINDOWS, 'function Get-DamoclesDirVersion', '\n}\n'));
  });

  it('take a daemon lock as stale only once the daemon would', () => {
    expect(REMOVE_POSIX).toContain(`\nDAEMON_LOCK_STALE_S=${LOCK_STALE_MS / 1000}\n`);
    expect(REMOVE_WINDOWS).toContain(`\n$DAEMON_LOCK_STALE_S = ${LOCK_STALE_MS / 1000}\n`);
  });
});

describe('validateInstallFolder', () => {
  it('takes absolute POSIX and Windows paths and ~-prefixed ones', () => {
    for (const folder of ['/opt/damocles', '~', '~/tools', '~\\tools', 'C:\\tools', 'D:/tools', "/opt/my 'x' $y"]) expect(validateInstallFolder(folder)).toEqual({ ok: true, folder });
  });

  it('names why it refuses a folder', () => {
    expect(validateInstallFolder('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateInstallFolder('tools')).toEqual({ ok: false, reason: 'relative' });
    expect(validateInstallFolder('/a\nb')).toEqual({ ok: false, reason: 'newline' });
    expect(validateInstallFolder('/a\0b')).toEqual({ ok: false, reason: 'nul' });
    expect(validateInstallFolder('/a\tb')).toEqual({ ok: false, reason: 'controlChars' });
    expect(validateInstallFolder('/a\u202eb')).toEqual({ ok: false, reason: 'controlChars' });
  });

  it('refuses every format character the probe parser refuses in the install folder', () => {
    for (const char of ['\u200b', '\u200e', '\u200f', '\u061c', '\ufeff']) {
      expect(validateInstallFolder(`/opt/a${char}b`)).toEqual({ ok: false, reason: 'controlChars' });
      expect(() => parseStageLine(`@@DAMOCLES ${JSON.stringify({ kind: 'probe', target: 'linux-x64', install: `/opt/a${char}b/dev` })}`)).toThrow(StageProtocolError);
    }
  });
});
