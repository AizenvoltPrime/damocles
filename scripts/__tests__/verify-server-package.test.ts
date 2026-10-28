import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import { credentialRelayProblems, dynamicLinkage, muslLinkageProblems, selfTestCommand, selfTestPlan } from '../verify-server-package.mjs';

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

describe('the git credential relay in a server package', () => {
  const entry = (path: string, text: string) => ({ path, data: Buffer.from(text, 'utf8') });
  const sh = entry('dist/git-credential/git-credential-relay.sh', '#!/bin/sh\nexec x\n');
  const cmd = entry('dist/git-credential/git-credential-relay.cmd', '@echo off\r\n');

  it('passes with the LF .sh and the CRLF .cmd, and names each missing helper or wrong line end', () => {
    expect(credentialRelayProblems([sh, cmd])).toEqual([]);
    expect(credentialRelayProblems([cmd])).toEqual(['no dist/git-credential/git-credential-relay.sh']);
    expect(credentialRelayProblems([sh])).toEqual(['no dist/git-credential/git-credential-relay.cmd']);
    expect(credentialRelayProblems([entry(sh.path, '#!/bin/sh\r\nexec x\r\n'), cmd])).toEqual(['dist/git-credential/git-credential-relay.sh is not an LF sh script']);
    for (const text of ['@echo off\nexit /b 0\n', '@echo off\r\nexit /b 0\n']) {
      expect(credentialRelayProblems([sh, entry(cmd.path, text)])).toEqual(['dist/git-credential/git-credential-relay.cmd is not a CRLF batch file']);
    }
  });
});
