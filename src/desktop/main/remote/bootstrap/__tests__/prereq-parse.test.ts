import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStageOutput, MAX_STAGE_LINE_BYTES, parseStageLine, StageProtocolError } from '../probe-parse';
import { powerShell, runPowerShell, runSh, scratchDir, shellPath, stageMessages, withPosixDefinitions, withWindowsDefinitions } from './shells';

describe('parseStageLine', () => {
  it('reads failures and notices as codes with their parameters', () => {
    expect(parseStageLine('@@DAMOCLES {"kind":"fail","code":"glibcTooOld","params":{"found":"2.17","needed":"2.28"}}')).toEqual({ kind: 'fail', code: 'glibcTooOld', params: { found: '2.17', needed: '2.28' } });
    expect(parseStageLine('@@DAMOCLES {"kind":"fail","code":"lowSpace","params":{"folder":"/home/dev","freeMb":12,"neededMb":300}}')).toEqual({ kind: 'fail', code: 'lowSpace', params: { folder: '/home/dev', freeMb: 12, neededMb: 300 } });
    expect(parseStageLine('@@DAMOCLES {"kind":"notice","code":"lowInotify","params":{"limit":8192,"suggested":524288}}')).toEqual({ kind: 'notice', notice: { code: 'lowInotify', params: { limit: 8192, suggested: 524288 } } });
    expect(parseStageLine('@@DAMOCLES {"progress":0.5}')).toEqual({ kind: 'progress', fraction: 0.5 });
    expect(parseStageLine('@@DAMOCLES {"kind":"probe","target":"alpine-x64","install":"/home/dev/.damocles/server"}')).toEqual({ kind: 'probe', target: 'alpine-x64', install: '/home/dev/.damocles/server' });
  });

  it('finds the marker after a login script\'s output on the same line, and ignores unmarked lines', () => {
    expect(parseStageLine('Welcome to prod!@@DAMOCLES {"kind":"step","step":"checking"}')).toEqual({ kind: 'step', step: 'checking' });
    expect(parseStageLine('Welcome to prod!')).toBeUndefined();
  });

  it('throws on a marked line outside the protocol: unknown codes, missing or extra parameters, control characters', () => {
    for (const line of [
      '@@DAMOCLES {"kind":"fail","code":"rmRf","params":{}}',
      '@@DAMOCLES {"kind":"fail","code":"glibcTooOld","params":{"found":"2.17"}}',
      '@@DAMOCLES {"kind":"fail","code":"noexec","params":{"folder":"/x","html":"<b>"}}',
      '@@DAMOCLES {"kind":"notice","code":"noLinger","params":{"user":"dev\\u202e"}}',
      '@@DAMOCLES {"progress":2}',
      '@@DAMOCLES {"kind":"probe","target":"freebsd-x64","install":"/x"}',
      '@@DAMOCLES not json',
    ]) expect(() => parseStageLine(line)).toThrow(StageProtocolError);
  });

  it('reads a failed download try as its attempt and reason code, and nothing else', () => {
    expect(parseStageLine('@@DAMOCLES {"kind":"downloadFailed","attempt":1,"reason":"http503"}')).toEqual({ kind: 'downloadFailed', attempt: 1, reason: 'http503' });
    expect(parseStageLine('@@DAMOCLES {"kind":"downloadFailed","attempt":4,"reason":"nameResolutionFailure"}')).toEqual({ kind: 'downloadFailed', attempt: 4, reason: 'nameResolutionFailure' });
    for (const line of [
      '@@DAMOCLES {"kind":"downloadFailed","attempt":0,"reason":"timeout"}',
      '@@DAMOCLES {"kind":"downloadFailed","attempt":5,"reason":"timeout"}',
      '@@DAMOCLES {"kind":"downloadFailed","attempt":1.5,"reason":"timeout"}',
      '@@DAMOCLES {"kind":"downloadFailed","attempt":1,"reason":"connect failure"}',
      '@@DAMOCLES {"kind":"downloadFailed","attempt":1,"reason":"http5030"}',
      '@@DAMOCLES {"kind":"downloadFailed","attempt":1,"reason":"timeout","url":"https://x"}',
      '@@DAMOCLES {"kind":"downloadFailed","attempt":1}',
    ]) expect(() => parseStageLine(line)).toThrow(StageProtocolError);
  });
});

describe('createStageOutput', () => {
  it('hands over the bytes after the bridge line untouched, and never reads them as text', () => {
    const output = createStageOutput();
    const first = output.push(Buffer.from('motd\n@@DAMOCLES {"kind":"step","step":"starting"}\n@@DAMOCLES {"kind":"br'));
    expect(first).toEqual({ lines: [{ text: 'motd', message: undefined }, { text: '@@DAMOCLES {"kind":"step","step":"starting"}', message: { kind: 'step', step: 'starting' } }] });
    const second = output.push(Buffer.concat([Buffer.from('idge"}\n'), Buffer.from([0x02, 0xff, 0x0a, 0x00])]));
    expect(second.lines).toEqual([{ text: '@@DAMOCLES {"kind":"bridge"}', message: { kind: 'bridge' } }]);
    expect(Buffer.from(second.rest!)).toEqual(Buffer.from([0x02, 0xff, 0x0a, 0x00]));
    expect(Buffer.from(output.push(Buffer.from('\n@@DAMOCLES')).rest!)).toEqual(Buffer.from('\n@@DAMOCLES'));
  });

  it('keeps the lines before one that breaks the protocol, and reports that line as the error', () => {
    const output = createStageOutput();
    const pushed = output.push(Buffer.from('@@DAMOCLES {"kind":"fail","code":"hashMismatch","params":{}}\n@@DAMOCLES {"kind":"nonsense"}\n@@DAMOCLES {"kind":"settled"}\n'));
    expect(pushed.lines).toEqual([{ text: '@@DAMOCLES {"kind":"fail","code":"hashMismatch","params":{}}', message: { kind: 'fail', code: 'hashMismatch', params: {} } }]);
    expect(pushed.error).toBeInstanceOf(StageProtocolError);
  });

  it('reports a complete line past the bound as the error, even when one chunk holds all of it', () => {
    const output = createStageOutput();
    const marked = `@@DAMOCLES {"kind":"settled"}${' '.repeat(MAX_STAGE_LINE_BYTES)}`;
    const pushed = output.push(Buffer.from(`motd\n${marked}\n`));
    expect(pushed.lines).toEqual([{ text: 'motd', message: undefined }]);
    expect(pushed.error).toBeInstanceOf(StageProtocolError);
  });

  it('reports a line past the bound as the error, after the complete lines before it', () => {
    const output = createStageOutput();
    const pushed = output.push(Buffer.concat([Buffer.from('motd\n'), Buffer.alloc(MAX_STAGE_LINE_BYTES + 1, 0x61)]));
    expect(pushed.lines).toEqual([{ text: 'motd', message: undefined }]);
    expect(pushed.error).toBeInstanceOf(StageProtocolError);
  });
});

describe('the POSIX probe checks in a real sh', { timeout: 120_000 }, () => {
  const codes = async (body: string) => stageMessages(await runSh(withPosixDefinitions(body)));

  it('stops a NixOS host without nix-ld, and passes one with NIX_LD set', async () => {
    const dir = scratchDir('nixos-');
    writeFileSync(path.join(dir, 'NIXOS'), '');
    const marker = shellPath(path.join(dir, 'NIXOS'));
    expect(await codes(`unset NIX_LD; check_nixos '${marker}'; say '{"kind":"settled"}'`)).toEqual([{ kind: 'fail', code: 'nixLdMissing', params: {} }]);
    expect(await codes(`NIX_LD=/run/current-system/sw/share/nix-ld/lib/ld.so; export NIX_LD; check_nixos '${marker}'; say '{"kind":"settled"}'`)).toEqual([{ kind: 'settled' }]);
    expect(await codes(`unset NIX_LD; check_nixos '${shellPath(path.join(dir, 'absent'))}'; say '{"kind":"settled"}'`)).toEqual([{ kind: 'settled' }]);
  });

  it('notes no linger only where logind kills user processes, reading the last KillUserProcesses assignment', async () => {
    const dir = scratchDir('logind-');
    mkdirSync(path.join(dir, 'linger'));
    writeFileSync(path.join(dir, 'linger', 'lingers'), '');
    writeFileSync(path.join(dir, 'logind.conf'), '[Login]\n#KillUserProcesses=no\nKillUserProcesses=no\n');
    writeFileSync(path.join(dir, 'drop-in.conf'), '[Login]\n  KillUserProcesses = yes\n');
    const conf = `'${shellPath(path.join(dir, 'logind.conf'))}' '${shellPath(path.join(dir, 'drop-in.conf'))}'`;
    const linger = shellPath(path.join(dir, 'linger'));
    expect(await codes(`kill=$(logind_kill_user_processes ${conf}); check_linger dev "$kill" '${linger}'`)).toEqual([{ kind: 'notice', notice: { code: 'noLinger', params: { user: 'dev' } } }]);
    expect(await codes(`kill=$(logind_kill_user_processes ${conf}); check_linger lingers "$kill" '${linger}'`)).toEqual([]);
    expect(await codes(`kill=$(logind_kill_user_processes '${shellPath(path.join(dir, 'logind.conf'))}'); check_linger dev "$kill" '${linger}'`)).toEqual([]);
  });

  it('notes a low inotify limit with the suggested value', async () => {
    expect(await codes('check_inotify 8192; check_inotify 1048576; check_inotify ""')).toEqual([{ kind: 'notice', notice: { code: 'lowInotify', params: { limit: 8192, suggested: 524288 } } }]);
  });

  it('reads glibc\'s version from getconf, else from ldd\'s first line', async () => {
    const getconf = (answer: string): string => (answer === '' ? 'getconf() { return 1; }' : `getconf() { echo '${answer}'; }`);
    const ldd = (first: string): string => `ldd() { printf '%s\\nCopyright (C) 2014 Free Software Foundation, Inc.\\n' '${first}' >&2; }`;
    expect(await codes(`${getconf('glibc 2.17')}; ${ldd('ldd (GNU libc) 2.36')}; check_glibc`)).toEqual([{ kind: 'fail', code: 'glibcTooOld', params: { found: '2.17', needed: '2.28' } }]);
    expect(await codes(`${getconf('')}; ${ldd('ldd (GNU libc) 2.17')}; check_glibc`)).toEqual([{ kind: 'fail', code: 'glibcTooOld', params: { found: '2.17', needed: '2.28' } }]);
    expect(await codes(`${getconf('')}; ${ldd('ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35')}; check_glibc; say '{"kind":"settled"}'`)).toEqual([{ kind: 'settled' }]);
  });

  it('decides glibc before the musl loader, so a glibc host with musl installed stays glibc', async () => {
    const dir = scratchDir('libc-');
    writeFileSync(path.join(dir, 'ld-musl-x86_64.so.1'), '');
    const loaders = `'${shellPath(dir)}'`;
    const empty = `'${shellPath(scratchDir('libc-'))}'`;
    const libc = async (stubs: string, folder: string): Promise<string> => (await runSh(withPosixDefinitions(`${stubs}\ndetect_libc ${folder}`))).stdout.toString('utf8');
    // Debian or Ubuntu with the musl package
    expect(await libc("getconf() { echo 'glibc 2.36'; }", loaders)).toBe('glibc');
    // Alpine: no GNU_LIBC_VERSION, and ldd is musl's
    expect(await libc("getconf() { return 1; }; ldd() { printf 'musl libc (x86_64)\\nVersion 1.2.5\\n' >&2; return 1; }", empty)).toBe('musl');
    // Alpine without musl-utils: only the loader tells
    expect(await libc('getconf() { return 1; }; ldd() { return 127; }', loaders)).toBe('musl');
    expect(await libc('getconf() { return 1; }; ldd() { return 127; }', empty)).toBe('glibc');
  });

  it('compares glibc, kernel and macOS versions numerically', async () => {
    expect(await codes('check_kernel 3.10.0-1160.el7.x86_64')).toEqual([{ kind: 'fail', code: 'kernelTooOld', params: { found: '3.10.0', needed: '4.18' } }]);
    expect(await codes('check_kernel 5.15.0-91-generic; check_macos 14.2.1; say \'{"kind":"settled"}\'')).toEqual([{ kind: 'settled' }]);
    expect(await codes('check_macos 13.4')).toEqual([{ kind: 'fail', code: 'macosTooOld', params: { found: '13.4', needed: '13.5' } }]);
    expect(await codes('set_arch Linux riscv64')).toEqual([{ kind: 'fail', code: 'unsupportedOs', params: { os: 'Linux', arch: 'riscv64' } }]);
  });

  it('stops when libstdc++ lacks GLIBCXX_3.4.25', async () => {
    const dir = scratchDir('glibcxx-');
    writeFileSync(path.join(dir, 'old.so.6'), 'GLIBCXX_3.4.19\0GLIBCXX_3.4.21\0');
    writeFileSync(path.join(dir, 'new.so.6'), 'GLIBCXX_3.4.25\0GLIBCXX_3.4.30\0');
    expect(await codes(`check_glibcxx '${shellPath(path.join(dir, 'missing'))}' '${shellPath(path.join(dir, 'old.so.6'))}' '${shellPath(path.join(dir, 'new.so.6'))}'`)).toEqual([{ kind: 'fail', code: 'glibcxxMissing', params: {} }]);
    expect(await codes(`check_glibcxx '${shellPath(path.join(dir, 'new.so.6'))}'; say '{"kind":"settled"}'`)).toEqual([{ kind: 'settled' }]);
  });
});

describe('the Windows probe checks in a real PowerShell', { timeout: 120_000 }, async () => {
  const shell = await powerShell();
  const codes = async (body: string) => stageMessages(await runPowerShell(shell!, withWindowsDefinitions(body)));

  it.skipIf(shell === undefined)('refuses a build below 17763 naming the build it found', async () => {
    expect(await codes('Test-DamoclesWindowsBuild 17134')).toEqual([{ kind: 'fail', code: 'windowsBuildTooOld', params: { found: '17134', needed: '17763' } }]);
    expect(await codes("Test-DamoclesWindowsBuild 17763; Send-DamoclesLine '{\"kind\":\"settled\"}'")).toEqual([{ kind: 'settled' }]);
  });

  it.skipIf(shell === undefined)('notes a missing Git Bash, and finds one where Git for Windows installs it', async () => {
    const dir = scratchDir('gitbash-');
    mkdirSync(path.join(dir, 'Git', 'bin'), { recursive: true });
    writeFileSync(path.join(dir, 'Git', 'bin', 'bash.exe'), '');
    const empty = scratchDir('nogit-');
    expect(await codes(`Test-DamoclesGitBash @('${empty}') ''`)).toEqual([{ kind: 'notice', notice: { code: 'noGitBash', params: {} } }]);
    expect(await codes(`Test-DamoclesGitBash @('${empty}', '${dir}') ''`)).toEqual([]);
  });

  it.skipIf(shell === undefined)('refuses a CPU it has no package for', async () => {
    expect(await codes("Get-DamoclesArch 'x86'")).toEqual([{ kind: 'fail', code: 'unsupportedOs', params: { os: 'Windows', arch: 'x86' } }]);
  });
});
