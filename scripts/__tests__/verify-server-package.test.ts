import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import { credentialRelayProblems, selfTestCommand, selfTestPlan } from '../verify-server-package.mjs';

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
