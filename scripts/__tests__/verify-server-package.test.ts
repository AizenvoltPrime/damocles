import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import { selfTestCommand, selfTestPlan } from '../verify-server-package.mjs';

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
