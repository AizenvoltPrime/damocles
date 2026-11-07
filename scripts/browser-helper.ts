/**
 * Builds bin/helpers/browser.exe, the BROWSER of a Windows target's user terminals, from resources/server-bin/helpers/browser.c
 * with a pinned zig, which cross-compiles both Windows architectures from any build machine and writes the same bytes on each.
 *
 *   node scripts/browser-helper.ts --out <dir>    # <dir>/x64/browser.exe and <dir>/arm64/browser.exe, as server packages carry them
 *
 * The zig archive downloads into dist/server-packages/.cache/, checked against its pinned SHA-256, and unpacks beside it once.
 * Only Node built-ins and this folder's archive helpers are imported, so the release's signing job runs it without npm ci.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedDownload } from './cached-download.ts';
import { isEntryPoint } from './entry-point.ts';
import { readZip, sha256 } from './server-archive.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BROWSER_HELPER_SOURCE = join(ROOT, 'resources', 'server-bin', 'helpers', 'browser.c');
export const BROWSER_HELPER_CACHE = join(ROOT, 'dist', 'server-packages', '.cache');

export const ZIG_VERSION = '0.17.0';
// zig's builds for the machine that compiles, each SHA-256 from https://ziglang.org/download/index.json
export const ZIG_ARCHIVES: Record<string, { name: string; sha256: string }> = {
  'win32-x64': { name: 'zig-x86_64-windows-0.17.0.zip', sha256: 'b5663f69581dcf391293fbf16c06cb80d81d806545ce618b4d0bab7f0eb8c428' },
  'win32-arm64': { name: 'zig-aarch64-windows-0.17.0.zip', sha256: '0a59d91fa1cb40cf068e9b0954434ce973500c7a2ea749f1e01af62cdab52d26' },
  'linux-x64': { name: 'zig-x86_64-linux-0.17.0.tar.xz', sha256: '1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026' },
  'linux-arm64': { name: 'zig-aarch64-linux-0.17.0.tar.xz', sha256: '9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8' },
  'darwin-x64': { name: 'zig-x86_64-macos-0.17.0.tar.xz', sha256: '4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6' },
  'darwin-arm64': { name: 'zig-aarch64-macos-0.17.0.tar.xz', sha256: 'b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a' },
};

const ZIG_TARGETS: Record<string, string> = { x64: 'x86_64-windows-gnu', arm64: 'aarch64-windows-gnu' };
// IMAGE_FILE_MACHINE_AMD64 and IMAGE_FILE_MACHINE_ARM64
export const PE_MACHINES = { x64: 0x8664, arm64: 0xaa64 };

const packageVersion = () => (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

export interface ZigArguments { arch: string; checkout: boolean; include: string; source: string; resource: string; out: string }

export interface BrowserHelperBuild { arch: string; checkout?: boolean; version?: string; cacheDir?: string }

/**
 * The version resource SignPath's metadata condition checks, with the values ssh-askpass.exe carries (askpass-trampoline.ts
 * assemblyInfo): ProductName Damocles, FileVersion the x.y.z of the release and ProductVersion its four-part form.
 */
export function versionResource(version: string): string {
  const numeric = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!numeric) throw new Error(`${version} is not a release version`);
  const [, major, minor, patch] = numeric;
  const three = `${major}.${minor}.${patch}`;
  return [
    '#include <winver.h>',
    'VS_VERSION_INFO VERSIONINFO',
    `FILEVERSION ${major},${minor},${patch},0`,
    `PRODUCTVERSION ${major},${minor},${patch},0`,
    'FILEOS VOS_NT_WINDOWS32',
    'FILETYPE VFT_APP',
    'BEGIN',
    '  BLOCK "StringFileInfo"',
    '  BEGIN',
    '    BLOCK "040904B0"',
    '    BEGIN',
    '      VALUE "CompanyName", "AizenvoltPrime"',
    '      VALUE "FileDescription", "Damocles BROWSER helper"',
    `      VALUE "FileVersion", "${three}"`,
    '      VALUE "ProductName", "Damocles"',
    `      VALUE "ProductVersion", "${three}.0"`,
    '    END',
    '  END',
    '  BLOCK "VarFileInfo"',
    '  BEGIN',
    '    VALUE "Translation", 0x409, 1200',
    '  END',
    'END',
    '',
  ].join('\n');
}

/** zig's command line for `arch`: no C runtime, kernel32 only, stripped, entry point `entry`. */
export function zigArguments({ arch, checkout, include, source, resource, out }: ZigArguments): string[] {
  const target = ZIG_TARGETS[arch];
  if (!target) throw new Error(`No Windows target for ${arch}`);
  return [
    'cc', '-target', target, '-Os', '-Wall', '-Wextra', '-Werror', '-nostdlib', '-ffreestanding', '-fno-builtin', '-s',
    '-isystem', include, ...(checkout ? ['-DDAMOCLES_CHECKOUT'] : []), source, resource, '-lkernel32',
    '-Wl,--entry=entry', '-Wl,--subsystem,console', '-o', out,
  ];
}

/** The pinned zig for this machine, downloaded and unpacked into `cacheDir` on first use. */
export async function zigExecutable(cacheDir = BROWSER_HELPER_CACHE, host = `${process.platform}-${process.arch}`): Promise<string> {
  const pin = ZIG_ARCHIVES[host];
  if (!pin) throw new Error(`No zig is pinned for ${host} (ZIG_ARCHIVES in scripts/browser-helper.ts), so browser.exe cannot be built here`);
  const top = pin.name.replace(/\.(zip|tar\.xz)$/, '');
  const dir = join(cacheDir, top);
  const zig = join(dir, host.startsWith('win32-') ? 'zig.exe' : 'zig');
  const unpacked = join(cacheDir, `${top}.unpacked`);
  if (existsSync(unpacked) && readFileSync(unpacked, 'utf8') === pin.sha256 && existsSync(zig)) return zig;
  const archive = join(cacheDir, pin.name);
  const data = await cachedDownload(`https://ziglang.org/download/${ZIG_VERSION}/${pin.name}`, archive, (bytes) => sha256(bytes) === pin.sha256);
  rmSync(unpacked, { force: true });
  rmSync(dir, { recursive: true, force: true });
  if (pin.name.endsWith('.zip')) {
    for (const entry of readZip(data)) {
      if (!entry.path.startsWith(`${top}/`) || entry.path.split('/').includes('..')) throw new Error(`${pin.name} holds ${entry.path}, outside ${top}/`);
      const file = join(cacheDir, entry.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, entry.data);
    }
  } else {
    const result = spawnSync('tar', ['-xJf', archive, '-C', cacheDir], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`tar could not unpack ${archive}: ${result.error?.message ?? result.stderr}`);
  }
  writeFileSync(unpacked, pin.sha256);
  return zig;
}

/** browser.exe for `arch`: a server package's, or with `checkout` the loopback daemon's copy in a checkout's dist/server-bin. */
export async function compileBrowserHelper({ arch, checkout = false, version = packageVersion(), cacheDir = BROWSER_HELPER_CACHE }: BrowserHelperBuild): Promise<Buffer> {
  const zig = await zigExecutable(cacheDir);
  const scratch = mkdtempSync(join(tmpdir(), 'damocles-browser-helper-'));
  try {
    const resource = join(scratch, 'browser.rc');
    writeFileSync(resource, versionResource(version));
    const out = join(scratch, 'browser.exe');
    const include = join(dirname(zig), 'lib', 'libc', 'include', 'any-windows-any');
    const zigCache = join(cacheDir, 'zig-cache');
    const result = spawnSync(zig, zigArguments({ arch, checkout, include, source: BROWSER_HELPER_SOURCE, resource, out }), {
      encoding: 'utf8',
      env: { ...process.env, ZIG_GLOBAL_CACHE_DIR: zigCache, ZIG_LOCAL_CACHE_DIR: zigCache },
    });
    if (result.status !== 0) throw new Error(`zig could not build browser.exe for ${arch}: ${result.error?.message ?? result.stderr}`);
    return readFileSync(out);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function peHeader(data: Buffer): number | undefined {
  if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5a4d) return undefined;
  const at = data.readUInt32LE(0x3c);
  if (at + 24 > data.length || data.readUInt32LE(at) !== 0x00004550) return undefined;
  return at;
}

/** The COFF machine of a PE file, or undefined for anything else. */
export function peMachine(data: Buffer): number | undefined {
  const at = peHeader(data);
  return at === undefined ? undefined : data.readUInt16LE(at + 4);
}

/**
 * A PE32+ file as it was before Authenticode signing: the certificate table at its end cut off, and the optional header's
 * CheckSum and certificate directory zeroed, the only fields signing writes. `signed` says whether it had a certificate table.
 */
export function unsignedImage(data: Buffer): { image: Buffer; signed: boolean } {
  const at = peHeader(data);
  if (at === undefined) throw new Error('not a PE file');
  const optional = at + 24;
  if (data.readUInt16LE(optional) !== 0x20b) throw new Error('not a PE32+ file');
  // IMAGE_DIRECTORY_ENTRY_SECURITY, the fifth data directory, holds the table's file offset and size
  const directory = optional + 112 + 4 * 8;
  const offset = data.readUInt32LE(directory);
  const size = data.readUInt32LE(directory + 4);
  const signed = size !== 0;
  if (signed && offset + size !== data.length) throw new Error('the certificate table is not at the end of the file');
  const image = Buffer.from(signed ? data.subarray(0, offset) : data);
  image.writeUInt32LE(0, optional + 64);
  image.writeUInt32LE(0, directory);
  image.writeUInt32LE(0, directory + 4);
  return { image, signed };
}

/** Why `signed` is not `built` with an Authenticode signature added. */
export function signedHelperProblems(signed: Buffer, built: Buffer): string[] {
  let stripped: { image: Buffer; signed: boolean };
  try {
    stripped = unsignedImage(signed);
  } catch (err) {
    return [`the signed browser.exe: ${err instanceof Error ? err.message : err}`];
  }
  if (!stripped.signed) return ['the signed browser.exe carries no signature'];
  return stripped.image.equals(unsignedImage(built).image) ? [] : ['the signed browser.exe is not the browser.exe this checkout builds'];
}

/** A server package's browser.exe for `arch`: the one built here, or `signed` once it proves to be that one, signed. */
export async function packagedBrowserHelper(arch: string, version: string, signed: Buffer | undefined): Promise<Buffer> {
  const built = await compileBrowserHelper({ arch, version });
  if (signed === undefined) return built;
  const problems = signedHelperProblems(signed, built);
  if (problems.length) throw new Error(problems.join('; '));
  return signed;
}

async function main() {
  const at = process.argv.indexOf('--out');
  const out = at === -1 ? undefined : process.argv[at + 1];
  if (!out) throw new Error('Usage: browser-helper.ts --out <dir>');
  for (const arch of Object.keys(ZIG_TARGETS)) {
    const file = join(out, arch, 'browser.exe');
    mkdirSync(dirname(file), { recursive: true });
    const data = await compileBrowserHelper({ arch });
    writeFileSync(file, data);
    console.log(`${file}: ${data.length} bytes, sha256 ${sha256(data)}`);
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
