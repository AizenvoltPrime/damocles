import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import { compileBrowserHelper, PE_MACHINES, peMachine, signedHelperProblems, unsignedImage, versionResource, ZIG_ARCHIVES, zigArguments } from '../browser-helper.mjs';
// @ts-expect-error -- plain .mjs helper, no types
import { SERVER_TARGETS } from '../server-targets.mjs';

// A minimal PE32+ image of `size` bytes for `machine`, unsigned.
function image(machine: number, size = 0x400): Buffer {
  const data = Buffer.alloc(size, 0x90);
  data.fill(0, 0, 0x200);
  data.writeUInt16LE(0x5a4d, 0);
  data.writeUInt32LE(0x40, 0x3c);
  data.writeUInt32LE(0x00004550, 0x40);
  data.writeUInt16LE(machine, 0x44);
  data.writeUInt16LE(0x20b, 0x58);
  return data;
}

// What Authenticode signing does to a file: a certificate table appended, its directory entry and the CheckSum set.
function signed(data: Buffer): Buffer {
  const table = Buffer.alloc(24, 0x30);
  const out = Buffer.concat([data, table]);
  out.writeUInt32LE(0x1234abcd, 0x58 + 64);
  out.writeUInt32LE(data.length, 0x58 + 112 + 32);
  out.writeUInt32LE(table.length, 0x58 + 112 + 36);
  return out;
}

describe('the BROWSER helper build', () => {
  it('writes the version resource SignPath checks, as ssh-askpass.exe carries it', () => {
    const rc = versionResource('3.8.0-beta.1') as string;
    expect(rc).toContain('VALUE "ProductName", "Damocles"');
    expect(rc).toContain('VALUE "FileVersion", "3.8.0"');
    expect(rc).toContain('VALUE "ProductVersion", "3.8.0.0"');
    expect(rc).toContain('FILEVERSION 3,8,0,0');
    expect(() => versionResource('next')).toThrow('next is not a release version');
  });

  it('compiles without a C runtime, with kernel32 only, for each Windows architecture', () => {
    const args = zigArguments({ arch: 'arm64', checkout: false, include: 'I', source: 'browser.c', resource: 'browser.rc', out: 'browser.exe' }) as string[];
    expect(args.slice(0, 3)).toEqual(['cc', '-target', 'aarch64-windows-gnu']);
    expect(args).toEqual(expect.arrayContaining(['-nostdlib', '-ffreestanding', '-fno-builtin', '-s', '-lkernel32', '-Wl,--entry=entry', '-Werror']));
    expect(args).not.toContain('-DDAMOCLES_CHECKOUT');
    expect(zigArguments({ arch: 'x64', checkout: true, include: 'I', source: 's', resource: 'r', out: 'o' })).toEqual(expect.arrayContaining(['x86_64-windows-gnu', '-DDAMOCLES_CHECKOUT']));
    expect(() => zigArguments({ arch: 'ia32', checkout: false, include: 'I', source: 's', resource: 'r', out: 'o' })).toThrow('No Windows target for ia32');
  });

  // the release builds each Windows package on that target's own runner
  it('pins a zig for every machine that builds a Windows server package', () => {
    const hosts = Object.values(SERVER_TARGETS as Record<string, { platform: string; arch: string }>).filter((spec) => spec.platform === 'win32').map((spec) => `win32-${spec.arch}`);
    for (const host of hosts) expect(ZIG_ARCHIVES[host], host).toMatchObject({ name: expect.stringMatching(/^zig-[a-z0-9_]+-windows-[0-9.]+\.zip$/), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('reads the PE machine, and nothing from a file that is no PE', () => {
    expect(peMachine(image(PE_MACHINES.x64))).toBe(0x8664);
    expect(peMachine(image(PE_MACHINES.arm64))).toBe(0xaa64);
    expect(peMachine(Buffer.from('#!/bin/sh\n'))).toBeUndefined();
  });

  it('takes a signed helper only when it is the built one with a signature added', () => {
    const built = image(0x8664);
    expect(unsignedImage(signed(built))).toEqual({ image: built, signed: true });
    expect(signedHelperProblems(signed(built), built)).toEqual([]);
    expect(signedHelperProblems(built, built)).toEqual(['the signed browser.exe carries no signature']);
    const other = Buffer.from(built);
    other[0x300] = 0xcc;
    expect(signedHelperProblems(signed(other), built)).toEqual(['the signed browser.exe is not the browser.exe this checkout builds']);
    expect(signedHelperProblems(signed(image(0xaa64)), built)).toEqual(['the signed browser.exe is not the browser.exe this checkout builds']);
    const trailing = Buffer.concat([signed(built), Buffer.alloc(8)]);
    expect(signedHelperProblems(trailing, built)).toEqual(['the signed browser.exe: the certificate table is not at the end of the file']);
    expect(signedHelperProblems(Buffer.from('MZ'), built)).toEqual(['the signed browser.exe: not a PE file']);
  });
});

// The built helper run as a terminal's tool runs BROWSER: by CreateProcess, with the address as one argument.
describe.runIf(process.platform === 'win32')('browser.exe on Windows', () => {
  // stands in for dist/cli-remote.js: prints its arguments and exits with 7
  const RELAY = 'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;\n';
  // cmd.exe would end the command at &, run ^ and % as its own syntax and split at the quote
  const ARGS = ['https://idp.test/authorize?client_id=a&state=b^c%PATH%&redirect="x y"', 'two words', '', 'C:\\dir\\', '"', 'a\\"b', '!x!'];
  let root: string;
  let builds: { readonly package: Buffer; readonly checkout: Buffer };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'damocles browser exe-'));
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    builds = { package: await compileBrowserHelper({ arch, version: '1.2.3' }), checkout: await compileBrowserHelper({ arch, checkout: true, version: '1.2.3' }) };
  }, 600_000);

  afterAll(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  const place = (relative: string, data: Buffer | string): string => {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    return file;
  };

  it('passes a server package\'s relay every argument byte for byte, keeps its exit code, and is the same build twice', async () => {
    place('package/dist/cli-remote.js', RELAY);
    mkdirSync(join(root, 'package', 'node'), { recursive: true });
    copyFileSync(process.execPath, join(root, 'package', 'node', 'node.exe'));
    const exe = place('package/bin/helpers/browser.exe', builds.package);
    const result = spawnSync(exe, ARGS, { encoding: 'utf8', env: { SystemRoot: process.env['SystemRoot'] ?? '' }, windowsHide: true });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 7, stdout: JSON.stringify(['--open-external', ...ARGS]), stderr: '' });
    expect(peMachine(builds.package)).toBe(PE_MACHINES[process.arch === 'arm64' ? 'arm64' : 'x64']);
    expect(await compileBrowserHelper({ arch: process.arch === 'arm64' ? 'arm64' : 'x64', version: '1.2.3' })).toEqual(builds.package);
  }, 120_000);

  it('runs a checkout\'s relay under the Node on PATH, never a node.exe in the working folder', () => {
    place('checkout/dist/cli-remote.js', RELAY);
    const exe = place('checkout/dist/server-bin/helpers/browser.exe', builds.checkout);
    const cwd = join(root, 'cwd');
    mkdirSync(cwd);
    copyFileSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'where.exe'), join(cwd, 'node.exe'));
    const result = spawnSync(exe, ARGS, { cwd, encoding: 'utf8', env: { SystemRoot: process.env['SystemRoot'] ?? '', PATH: dirname(process.execPath) }, windowsHide: true });
    expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 7, stdout: JSON.stringify(['--open-external', ...ARGS]) });
  });

  it('fails with the system\'s message when the package has no Node', () => {
    const exe = place('broken/bin/helpers/browser.exe', builds.package);
    const result = spawnSync(exe, ['https://example.test/'], { encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`browser.exe: ${join(root, 'broken', 'node', 'node.exe')}: `);
  });
});
