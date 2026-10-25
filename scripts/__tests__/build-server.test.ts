import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
// @ts-expect-error -- plain .mjs helper, no types
import { launchers, modeOf, nodeEntries, npmPackageEntries, packageEntries, serverClosure, serverFlavor, serverRoots, selfTestExternals } from '../build-server.mjs';
// @ts-expect-error -- plain .mjs helper, no types
import { FIXED_MTIME, gzipHeader, readTarGz, readZip, tarGz, zip } from '../server-archive.mjs';
// @ts-expect-error -- plain .mjs helper, no types
import { SERVER_TARGETS } from '../server-targets.mjs';
// @ts-expect-error -- plain .mjs helper, no types
import { DESKTOP_ONLY_PACKAGES } from '../sync-vscodeignore.mjs';
// @ts-expect-error -- plain .mjs helper, no types
import { EXTENSION_EXTERNALS } from '../extension-externals.mjs';

type Entry = { path: string; mode: number; data?: Buffer; source?: string; type?: string };
type Spec = { platform: string; arch: string; libc: string | null; natives: string[]; ptyPrebuild: string };

const FAKE_LINUX: Spec = { platform: 'linux', arch: 'x64', libc: 'glibc', natives: ['@vscode/ripgrep-linux-x64', '@parcel/watcher-linux-x64-glibc'], ptyPrebuild: 'linux-x64' };
const FAKE_WINDOWS: Spec = { platform: 'win32', arch: 'x64', libc: null, natives: ['@vscode/ripgrep-win32-x64', '@koromix/koffi-win32-x64'], ptyPrebuild: 'win32-x64' };

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'build-server-'));
  scratch.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

describe('the node_modules closure', () => {
  it('takes the desktop externals without Electron, with node-pty, @parcel/watcher off Windows and koffi only on Windows', () => {
    expect(serverRoots(FAKE_LINUX)).toEqual(expect.arrayContaining(['@parcel/watcher', 'node-pty', 'patchright', 'zod', '@earendil-works/pi-mcp', 'typebox', 'jiti', 'web-tree-sitter', '@vscode/ripgrep']));
    expect(serverRoots(FAKE_LINUX)).not.toEqual(expect.arrayContaining(['koffi']));
    expect(serverRoots(FAKE_WINDOWS)).toContain('koffi');
    for (const spec of [FAKE_LINUX, FAKE_WINDOWS]) {
      const roots = serverRoots(spec) as string[];
      expect(roots.filter((name) => ['electron', 'electron-updater', 'node:sqlite', '@earendil-works/pi-mcp/*'].includes(name))).toEqual([]);
      expect(selfTestExternals(spec)).toEqual(roots.filter((name) => name !== 'node-pty'));
    }
    expect(serverRoots(FAKE_WINDOWS)).not.toContain('@parcel/watcher');
  });

  it('keeps every server-only package out of the VSIX', () => {
    for (const spec of Object.values(SERVER_TARGETS as Record<string, Spec>)) {
      const serverOnly = (serverRoots(spec) as string[]).filter((name) => !(EXTENSION_EXTERNALS as string[]).includes(name));
      expect(serverOnly.filter((name) => !(DESKTOP_ONLY_PACKAGES as string[]).includes(name))).toEqual([]);
    }
  });

  it('swaps the build machine\'s platform packages for the target\'s natives', () => {
    const host = ['zod', '@parcel/watcher', 'detect-libc', '@parcel/watcher-win32-x64', '@vscode/ripgrep', '@vscode/ripgrep-win32-x64'];
    const closure = serverClosure(FAKE_LINUX, () => ({ packages: host }), (name: string) => /-(win32|linux)-/.test(name));
    expect(closure).toEqual({ portable: ['zod', '@parcel/watcher', 'detect-libc', '@vscode/ripgrep'], natives: FAKE_LINUX.natives });
  });

  it('fails on a platform package the target names no native for', () => {
    const host = ['zod', '@img/sharp-win32-x64'];
    expect(() => serverClosure(FAKE_LINUX, () => ({ packages: host }), (name: string) => name.includes('win32'))).toThrow(/@img\/sharp-win32-x64/);
  });

  it('walks the real closure without a desktop-only or platform package left in it', () => {
    const { portable } = serverClosure((SERVER_TARGETS as Record<string, Spec>)['linux-x64']) as { portable: string[] };
    expect(portable).toEqual(expect.arrayContaining(['@earendil-works/pi-coding-agent', 'patchright', 'patchright-core', 'node-pty', '@parcel/watcher']));
    expect(portable.filter((name) => /^(electron|electron-updater|@electron\/|@xterm\/|@parcel\/watcher-|@vscode\/ripgrep-|@koromix\/)/.test(name))).toEqual([]);
  });
});

describe('the package file list', () => {
  const repo = () => tree({
    'package.json': '{"version":"1.0.0"}', 'package.nls.json': '{}', 'package.nls.el.json': '{}', LICENSE: 'MIT', 'THIRD-PARTY-NOTICES.md': '#',
    'l10n/bundle.l10n.json': '{}', 'resources/shell-integration/shellIntegration-bash.sh': 'x', 'resources/grammars/tree-sitter-go.wasm': 'w',
    'resources/icon.png': 'not shipped',
  });
  const dist = () => tree({ 'daemon.js': '1', 'daemon.js.map': '{}', 'core-host.js': '2', 'askpass/askpass.sh': '#!/bin/sh' });
  const nodeModules = () => tree({
    'zod/package.json': '{}', 'zod/index.js': '', 'zod/index.js.map': '', 'zod/node_modules/.bin/x': '',
    'node-pty/package.json': '{}', 'node-pty/lib/index.js': '', 'node-pty/src/unix/pty.cc': '', 'node-pty/build/Release/pty.node': '',
    'node-pty/prebuilds/linux-x64/pty.node': '', 'node-pty/prebuilds/win32-x64/conpty.node': '', 'node-pty/prebuilds/win32-x64/conpty.pdb': '',
  });

  it('lists the launchers, dist without maps, the portable closure with one node-pty prebuild, and the root files', () => {
    const entries = packageEntries({ spec: FAKE_LINUX, target: 'linux-x64', version: '1.0.0', nodeVersion: '24.22.0', distDir: dist(), nodeModules: nodeModules(), root: repo(), portable: ['node-pty', 'zod'], externals: ['zod'] }) as Entry[];
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      'LICENSE', 'THIRD-PARTY-NOTICES.md', 'bin/damocles-server', 'dist/askpass/askpass.sh', 'dist/core-host.js', 'dist/daemon.js',
      'l10n/bundle.l10n.json', 'node_modules/node-pty/lib/index.js', 'node_modules/node-pty/package.json', 'node_modules/node-pty/prebuilds/linux-x64/pty.node',
      'node_modules/zod/index.js', 'node_modules/zod/package.json', 'package.json', 'package.nls.el.json', 'package.nls.json',
      'resources/grammars/tree-sitter-go.wasm', 'resources/shell-integration/shellIntegration-bash.sh', 'server-package.json',
    ]);
    const info = JSON.parse(entries.find((entry) => entry.path === 'server-package.json')!.data!.toString('utf8'));
    expect(info).toEqual({ name: 'damocles-server', version: '1.0.0', target: 'linux-x64', node: '24.22.0', externals: ['zod'] });
  });

  it('keeps the Windows prebuild without its debug symbols, and adds the .cmd launcher', () => {
    const entries = packageEntries({ spec: FAKE_WINDOWS, target: 'win32-x64', version: '1.0.0', nodeVersion: '24.22.0', distDir: dist(), nodeModules: nodeModules(), root: repo(), portable: ['node-pty'], externals: [] }) as Entry[];
    const paths = entries.map((entry) => entry.path);
    expect(paths.filter((path) => path.startsWith('node_modules/node-pty/prebuilds/'))).toEqual(['node_modules/node-pty/prebuilds/win32-x64/conpty.node']);
    expect(paths).toContain('bin/damocles-server.cmd');
    expect(launchers(FAKE_WINDOWS)[0].data.toString()).toContain('node/node.exe');
  });

  it('marks only the launcher, Node, rg, spawn-helper and the askpass scripts executable', () => {
    for (const path of ['bin/damocles-server', 'node/node', 'node_modules/@vscode/ripgrep-linux-x64/bin/rg', 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper', 'dist/askpass/askpass.sh']) expect({ path, mode: modeOf(path) }).toEqual({ path, mode: 0o755 });
    for (const path of ['bin/damocles-server.cmd', 'node/node.exe', 'dist/daemon.js', 'node_modules/node-pty/prebuilds/linux-x64/pty.node', 'resources/shell-integration/shellIntegration-bash.sh']) expect({ path, mode: modeOf(path) }).toEqual({ path, mode: 0o644 });
  });

  it('takes node and its license from a Node archive, and an npm tarball\'s files under node_modules', () => {
    const top = 'node-v24.22.0-linux-x64';
    const archive = tarGz([{ path: `${top}/bin/node`, mode: 0o755, data: Buffer.from('ELF') }, { path: `${top}/LICENSE`, mode: 0o644, data: Buffer.from('MIT') }, { path: `${top}/bin/npm`, mode: 0o755, data: Buffer.from('') }]);
    expect((nodeEntries(FAKE_LINUX, `${top}.tar.gz`, archive) as Entry[]).map((entry) => [entry.path, entry.mode])).toEqual([['node/LICENSE', 0o644], ['node/node', 0o755]]);
    const winTop = 'node-v24.22.0-win-x64';
    const winArchive = zip([{ path: `${winTop}/node.exe`, mode: 0o644, data: Buffer.from('MZ') }, { path: `${winTop}/LICENSE`, mode: 0o644, data: Buffer.from('MIT') }]);
    expect((nodeEntries(FAKE_WINDOWS, `${winTop}.zip`, winArchive) as Entry[]).map((entry) => entry.path)).toEqual(['node/LICENSE', 'node/node.exe']);
    const tarball = tarGz([{ path: 'package/bin/rg', mode: 0o755, data: Buffer.from('rg') }, { path: 'package/package.json', mode: 0o644, data: Buffer.from('{}') }, { path: 'package/x.js.map', mode: 0o644, data: Buffer.from('') }]);
    expect((npmPackageEntries('@vscode/ripgrep-linux-x64', tarball) as Entry[]).map((entry) => [entry.path, entry.mode])).toEqual([
      ['node_modules/@vscode/ripgrep-linux-x64/bin/rg', 0o755], ['node_modules/@vscode/ripgrep-linux-x64/package.json', 0o644],
    ]);
  });
});

describe('the archives are reproducible', () => {
  const entries: Entry[] = [
    { path: 'z/last.txt', mode: 0o644, data: Buffer.from('z') },
    { path: 'bin/damocles-server', mode: 0o755, data: Buffer.from('#!/bin/sh\n') },
    { path: `node_modules/${'deep/'.repeat(40)}file.js`, mode: 0o644, data: Buffer.alloc(700, 1) },
  ];

  it('writes a normalized gzip header and ustar headers owned by 0:0 at the fixed mtime, in sorted order', () => {
    const archive = tarGz(entries);
    expect(gzipHeader(archive)).toEqual({ mtime: 0, os: 3 });
    const tar = gunzipSync(archive);
    const octal = (at: number, length: number) => Number.parseInt(tar.toString('ascii', at, at + length).replace(/\0.*$/, '').trim(), 8);
    // the first entry's header: bin/damocles-server
    expect(tar.toString('utf8', 0, 19)).toBe('bin/damocles-server');
    expect([octal(100, 8), octal(108, 8), octal(116, 8), octal(136, 12)]).toEqual([0o755, 0, 0, FIXED_MTIME]);
    expect(tar.toString('ascii', 257, 263)).toBe('ustar\0');
    expect((readTarGz(archive) as Entry[]).map((entry) => [entry.path, entry.mode, entry.data!.length])).toEqual([
      ['bin/damocles-server', 0o755, 10], [`node_modules/${'deep/'.repeat(40)}file.js`, 0o644, 700], ['z/last.txt', 0o644, 1],
    ]);
  });

  it('writes the same bytes whatever order the entries come in', () => {
    expect(tarGz([...entries].reverse()).equals(tarGz(entries))).toBe(true);
    expect(zip([...entries].reverse()).equals(zip(entries))).toBe(true);
  });

  it('writes a zip with Unix modes and the fixed time that its reader round-trips', () => {
    const archive = zip(entries);
    expect((readZip(archive) as Entry[]).map((entry) => [entry.path, entry.mode, entry.data!.toString('utf8').length])).toEqual([
      ['bin/damocles-server', 0o755, 10], [`node_modules/${'deep/'.repeat(40)}file.js`, 0o644, 700], ['z/last.txt', 0o644, 1],
    ]);
    // the first local header's DOS time and date: 2000-01-01 00:00
    expect([archive.readUInt16LE(10), archive.readUInt16LE(12)]).toEqual([0, (20 << 9) | (1 << 5) | 1]);
  });

  it('refuses an entry twice', () => {
    expect(() => tarGz([entries[0], entries[0]])).toThrow(/twice/);
  });
});

describe('the server flavor', () => {
  it('builds the daemon\'s flag as true, so a packaged daemon refuses e2e hooks', async () => {
    const result = await esbuild.build({ entryPoints: [join(__dirname, '..', '..', 'src', 'desktop', 'daemon', 'server-package.ts')], bundle: true, write: false, format: 'cjs', platform: 'node', plugins: [serverFlavor] });
    const text = result.outputFiles[0]!.text;
    expect(text).toContain('SERVER_PACKAGE = true');
    const loaded: { exports: { daemonE2eHooks?: (env: Record<string, string>) => boolean } } = { exports: {} };
    new Function('module', 'exports', text)(loaded, loaded.exports);
    expect(loaded.exports.daemonE2eHooks!({ DAMOCLES_E2E_HOOKS: '1' })).toBe(false);
  });
});
