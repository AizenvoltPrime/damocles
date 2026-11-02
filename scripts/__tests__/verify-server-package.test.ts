import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import { browserHelperProblems, cliScriptProblems, credentialRelayProblems, devcontainersCliProblems, dynamicLinkage, loadAlignProblems, muslLinkageProblems, selfTestCommand, selfTestPlan } from '../verify-server-package.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('selfTestPlan', () => {
  it('self-tests on the target\'s own machine', () => {
    for (const mode of ['auto', 'require']) expect(selfTestPlan(mode, 'linux-x64', 'linux-x64')).toEqual({ run: true });
  });

  it('fails a required self-test on another machine, which auto only notes', () => {
    expect(selfTestPlan('require', 'win32-x64', 'win32-arm64')).toEqual({ run: false, problem: 'this machine is win32-x64, not win32-arm64, and --require-self-test needs the self-test here' });
    expect(selfTestPlan('auto', 'win32-x64', 'win32-arm64')).toMatchObject({ run: false, note: expect.stringMatching(/skipped/) });
  });

  it('leaves the self-test to the caller with skip', () => {
    expect(selfTestPlan('skip', 'alpine-x64', 'alpine-x64')).toMatchObject({ run: false, note: expect.stringMatching(/--skip-self-test/) });
  });
});

describe('selfTestCommand', () => {
  it.runIf(process.platform === 'win32')('runs the Windows launcher from a folder whose path holds a space', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dm-self-test-')), 'with space');
    dirs.push(dir);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'damocles-server.cmd'), '@echo ran %1\r\n');
    const [file, args, options] = selfTestCommand('win32', dir) as [string, string[], object];
    const run = spawnSync(file, args, options);
    expect({ status: run.status, stdout: String(run.stdout).trim() }).toEqual({ status: 0, stdout: 'ran self-test' });
  });
});

// Excerpts of `readelf -l -d -V --wide` on the binaries each case names, in readelf's own line formats.
function readelfOutput(interpreter: string | null, needed: string[], versionNeeds: Record<string, string[]>): string {
  const lines = ['Program Headers:'];
  if (interpreter) lines.push(`      [Requesting program interpreter: ${interpreter}]`);
  lines.push('', "Dynamic section at offset 0x7c5d68 contains 33 entries:");
  for (const name of needed) lines.push(` 0x0000000000000001 (NEEDED)             Shared library: [${name}]`);
  lines.push('', "Version symbols section '.gnu.version' contains 3 entries:", '  000:   0 (*local*)       4 (GLIBC_2.0)     1 (*global*)', '');
  lines.push(`Version needs section '.gnu.version_r' contains ${Object.keys(versionNeeds).length} entries:`, ' Addr: 0x00000000007e5e80  Offset: 0x003e5e80  Link: 6 (.dynstr)');
  for (const [file, versions] of Object.entries(versionNeeds)) {
    lines.push(`  000000: Version: 1  File: ${file}  Cnt: ${versions.length}`);
    for (const version of versions) lines.push(`  0x0010:   Name: ${version}  Flags: none  Version: 2`);
  }
  return `${lines.join('\n')}\n\n`;
}

describe('the musl linkage of an Alpine package\'s natives', () => {
  const problemsOf = (output: string) => muslLinkageProblems('node/node', dynamicLinkage(output));

  it('passes Alpine\'s and upstream musl\'s sonames, and libgcc_s\'s GLIBC_2.0 version on aarch64', () => {
    // unofficial-builds' node-v24.22.0-linux-x64-musl
    expect(problemsOf(readelfOutput('/lib/ld-musl-x86_64.so.1', ['libstdc++.so.6', 'libgcc_s.so.1', 'libc.musl-x86_64.so.1'], { 'libgcc_s.so.1': ['GCC_3.4', 'GCC_3.0'] }))).toEqual([]);
    // unofficial-builds' node-v24.22.0-linux-arm64-musl
    const arm64Node = readelfOutput('/lib/ld-musl-aarch64.so.1', ['libgcc_s.so.1', 'libc.so'], { 'libgcc_s.so.1': ['GCC_3.3', 'GCC_4.2.0', 'GLIBC_2.0', 'GCC_3.0'] });
    expect(dynamicLinkage(arm64Node)).toEqual({
      interpreter: '/lib/ld-musl-aarch64.so.1',
      needed: ['libgcc_s.so.1', 'libc.so'],
      versionNeeds: ['GCC_3.3', 'GCC_4.2.0', 'GLIBC_2.0', 'GCC_3.0'].map((version) => ({ library: 'libgcc_s.so.1', version })),
    });
    expect(problemsOf(arm64Node)).toEqual([]);
    // @parcel/watcher-linux-arm64-musl 2.6.0, and node-pty compiled in node:24-alpine on arm64
    for (const libc of ['libc.so', 'libc.musl-aarch64.so.1']) {
      expect(problemsOf(readelfOutput(null, ['libstdc++.so.6', 'libgcc_s.so.1', libc], { 'libgcc_s.so.1': ['GCC_3.0', 'GLIBC_2.0'], 'libstdc++.so.6': ['GLIBCXX_3.4.21'] }))).toEqual([]);
    }
  });

  it('fails a glibc executable or library, and one that names no musl', () => {
    // Ubuntu 24.04's /usr/bin/ls and libz.so.1
    expect(problemsOf(readelfOutput('/lib64/ld-linux-x86-64.so.2', ['libselinux.so.1', 'libc.so.6'], { 'libc.so.6': ['GLIBC_2.28'] }))).toEqual(['node/node links against glibc', 'node/node shows no musl linkage']);
    expect(problemsOf(readelfOutput(null, ['libc.so.6'], { 'libc.so.6': ['GLIBC_2.14'] }))).toEqual(['node/node links against glibc', 'node/node shows no musl linkage']);
    expect(problemsOf(readelfOutput('/lib/ld-musl-x86_64.so.1', ['libm.so.6', 'libc.musl-x86_64.so.1'], { 'libm.so.6': ['GLIBC_2.29'] }))).toEqual(['node/node links against glibc']);
    expect(problemsOf(readelfOutput(null, ['libstdc++.so.6'], {}))).toEqual(['node/node shows no musl linkage']);
  });
});

describe('the PT_LOAD alignment of an x64 Linux package\'s executables', () => {
  // `readelf -l --wide` of node-v24.22.0-linux-x64-musl's bin/node, as shipped
  const shipped = [
    'Program Headers:',
    '  Type           Offset   VirtAddr           PhysAddr           FileSiz  MemSiz   Flg Align',
    '  PHDR           0x000040 0x0000000000000040 0x0000000000000040 0x000348 0x000348 R   0x8',
    '  LOAD           0x000000 0x0000000000000000 0x0000000000000000 0x5a43b0 0x5a43b0 R   0x1000',
    '  LOAD           0x5a5000 0x00000000005a5000 0x00000000005a5000 0x2cca821 0x2cca821 R E 0x2000',
    '  LOAD           0x3400000 0x0000000003400000 0x0000000003400000 0x000726 0x000726 R E 0x200000',
    '  LOAD           0x3401000 0x0000000003401000 0x0000000003401000 0x379d470 0x379d470 R   0x1000',
    '  LOAD           0x6b9eb50 0x0000000006b9fb50 0x0000000006b9fb50 0x16c100 0x1a4528 RW  0x1000',
    '  GNU_STACK      0x000000 0x0000000000000000 0x0000000000000000 0x000000 0x000000 RW  0x10',
  ].join('\n');

  it('fails a PT_LOAD aligned past 4 KiB, naming each alignment', () => {
    expect(loadAlignProblems('node/node', shipped)).toEqual(['node/node has PT_LOAD alignments 0x2000, 0x200000, above the 4 KiB WSL 1 loads']);
  });

  it('passes the clamped Node, whose other headers keep their alignment', () => {
    expect(loadAlignProblems('node/node', shipped.replace(/R E 0x2000$/m, 'R E 0x1000').replace(/R E 0x200000$/m, 'R E 0x1000'))).toEqual([]);
  });

  it('fails output that lists no PT_LOAD, rather than passing it', () => {
    expect(loadAlignProblems('node/node', 'There are no program headers in this file.\n')).toEqual(['readelf lists no PT_LOAD of node/node']);
  });
});

describe('the Dev Containers CLI in a server package', () => {
  const entry = (path: string, text: string) => ({ path, data: Buffer.from(text, 'utf8') });
  const cli = [
    entry('node_modules/@devcontainers/cli/devcontainer.js', "require('./dist/spec-node/devContainersSpecCLI');\n"),
    entry('node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js', 'module.exports = {};\n'),
    entry('node_modules/@devcontainers/cli/package.json', '{"name":"@devcontainers/cli","version":"0.90.0"}'),
  ];

  it('passes the pinned entry and bundle, and names a missing file or another version', () => {
    expect(devcontainersCliProblems(cli, '0.90.0')).toEqual([]);
    expect(devcontainersCliProblems(cli.slice(1), '0.90.0')).toEqual(['no node_modules/@devcontainers/cli/devcontainer.js']);
    expect(devcontainersCliProblems([cli[0]!, cli[2]!], '0.90.0')).toEqual(['no node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js']);
    expect(devcontainersCliProblems(cli, '0.91.0')).toEqual(['@devcontainers/cli is 0.90.0, package-lock.json pins 0.91.0']);
    expect(devcontainersCliProblems(cli.slice(0, 2), '0.90.0')).toEqual(['@devcontainers/cli is missing, package-lock.json pins 0.90.0']);
  });
});

describe('the damocles command in a server package', () => {
  const entry = (path: string, text: string) => ({ path, data: Buffer.from(text, 'utf8') });
  const cli = entry('dist/cli-remote.js', 'run()');
  const posix = [cli, entry('bin/remote-cli/damocles', '#!/bin/sh\nexec x\n'), entry('bin/helpers/browser.sh', '#!/bin/sh\nexec x\n')];
  const windows = [...posix, entry('bin/remote-cli/damocles.cmd', '@echo off\r\nsetlocal DisableDelayedExpansion\r\nx\r\n')];

  it('needs dist/cli-remote.js and the LF sh scripts, and on Windows the CRLF damocles.cmd too', () => {
    expect(cliScriptProblems({ platform: 'linux' }, posix)).toEqual([]);
    expect(cliScriptProblems({ platform: 'win32' }, windows)).toEqual([]);
    expect(cliScriptProblems({ platform: 'darwin' }, posix.slice(1))).toEqual(['no dist/cli-remote.js']);
    // Git Bash, MSYS2 and Cygwin find no .cmd
    expect(cliScriptProblems({ platform: 'win32' }, [cli, windows[3]!])).toEqual(['no bin/remote-cli/damocles', 'no bin/helpers/browser.sh']);
    expect(cliScriptProblems({ platform: 'win32' }, posix)).toEqual(['no bin/remote-cli/damocles.cmd']);
    expect(cliScriptProblems({ platform: 'win32' }, [cli, posix[1]!, entry('bin/helpers/browser.sh', '#!/bin/sh\r\nexec x\r\n'), windows[3]!])).toEqual(['bin/helpers/browser.sh is not an LF sh script']);
    expect(cliScriptProblems({ platform: 'win32' }, [...posix, entry('bin/remote-cli/damocles.cmd', '@echo off\nx\n')])).toEqual(['bin/remote-cli/damocles.cmd is not a CRLF batch file']);
    // a registry DelayedExpansion=1 would eat a ! in the arguments
    expect(cliScriptProblems({ platform: 'win32' }, [...posix, entry('bin/remote-cli/damocles.cmd', '@echo off\r\nsetlocal\r\nx\r\n')])).toEqual(['bin/remote-cli/damocles.cmd does not turn delayed expansion off']);
  });

  it('passes the repository\'s own scripts', () => {
    const read = (from: string, to: string) => ({ path: to, data: readFileSync(join(__dirname, '..', '..', 'resources', 'server-bin', from)) });
    const scripts = [cli, read('remote-cli/damocles', 'bin/remote-cli/damocles'), read('helpers/browser.sh', 'bin/helpers/browser.sh')];
    expect(cliScriptProblems({ platform: 'linux' }, scripts)).toEqual([]);
    expect(cliScriptProblems({ platform: 'win32' }, [...scripts, read('remote-cli/damocles.cmd', 'bin/remote-cli/damocles.cmd')])).toEqual([]);
  });
});

describe('the BROWSER helper of a Windows server package', () => {
  // a PE header naming `machine`, which is all the check reads
  const pe = (machine: number): Buffer => {
    const data = Buffer.alloc(0x200);
    data.writeUInt16LE(0x5a4d, 0);
    data.writeUInt32LE(0x40, 0x3c);
    data.writeUInt32LE(0x00004550, 0x40);
    data.writeUInt16LE(machine, 0x44);
    return data;
  };
  const helper = (data: Buffer) => [{ path: 'bin/helpers/browser.exe', data }];

  it('needs bin/helpers/browser.exe built for the target\'s architecture', () => {
    expect(browserHelperProblems({ platform: 'win32', arch: 'x64' }, helper(pe(0x8664)))).toEqual([]);
    expect(browserHelperProblems({ platform: 'win32', arch: 'arm64' }, helper(pe(0xaa64)))).toEqual([]);
    expect(browserHelperProblems({ platform: 'win32', arch: 'arm64' }, helper(pe(0x8664)))).toEqual(['bin/helpers/browser.exe is built for machine 0x8664, arm64 needs 0xaa64']);
    expect(browserHelperProblems({ platform: 'win32', arch: 'x64' }, [])).toEqual(['no bin/helpers/browser.exe']);
    expect(browserHelperProblems({ platform: 'win32', arch: 'x64' }, helper(Buffer.from('@echo off\r\n')))).toEqual(['bin/helpers/browser.exe is not a PE executable']);
  });

  it('refuses it in a POSIX package, whose BROWSER is browser.sh', () => {
    expect(browserHelperProblems({ platform: 'linux', arch: 'x64' }, [])).toEqual([]);
    expect(browserHelperProblems({ platform: 'darwin', arch: 'arm64' }, helper(pe(0xaa64)))).toEqual(['bin/helpers/browser.exe in a darwin package']);
  });
});

describe('the git credential relay in a server package', () => {
  const entry = (path: string, text: string) => ({ path, data: Buffer.from(text, 'utf8') });
  const sh = entry('dist/git-credential/git-credential-relay.sh', '#!/bin/sh\nexec x\n');
  const cmd = entry('dist/git-credential/git-credential-relay.cmd', '@echo off\r\nsetlocal DisableDelayedExpansion\r\n');

  it('passes with the LF .sh and the CRLF .cmd, and names each missing helper or wrong line end', () => {
    expect(credentialRelayProblems([sh, cmd])).toEqual([]);
    expect(credentialRelayProblems([cmd])).toEqual(['no dist/git-credential/git-credential-relay.sh']);
    expect(credentialRelayProblems([sh])).toEqual(['no dist/git-credential/git-credential-relay.cmd']);
    expect(credentialRelayProblems([entry(sh.path, '#!/bin/sh\r\nexec x\r\n'), cmd])).toEqual(['dist/git-credential/git-credential-relay.sh is not an LF sh script']);
    for (const text of ['@echo off\nexit /b 0\n', '@echo off\r\nexit /b 0\n']) {
      expect(credentialRelayProblems([sh, entry(cmd.path, text)])).toEqual(['dist/git-credential/git-credential-relay.cmd is not a CRLF batch file']);
    }
    expect(credentialRelayProblems([sh, entry(cmd.path, '@echo off\r\n')])).toEqual(['dist/git-credential/git-credential-relay.cmd does not turn delayed expansion off']);
    expect(credentialRelayProblems([sh, { path: cmd.path, data: readFileSync(join(__dirname, '..', '..', 'resources', 'git-credential', 'git-credential-relay.cmd')) }])).toEqual([]);
  });
});
