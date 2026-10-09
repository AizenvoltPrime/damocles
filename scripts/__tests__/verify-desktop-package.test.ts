import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import {
  checkAppUpdate,
  checkAsarEntries,
  checkChangelog,
  checkFuses,
  checkNodePtyLayout,
  checkShellIntegrationScripts,
  checkSpawnHelperMode,
  checkUnpackedSet,
  EXPECTED_FUSES,
  SHELL_INTEGRATION_FILES,
  verifyPackage,
} from '../verify-desktop-package.mjs';
import { ASAR_UNPACK } from '../../src/desktop/main/platform/unpacked-assets';

type Result = { check: string; ok: boolean; detail: string };

const CHANGELOG = ['# Changelog', '', '## [2.36.0] - 2026-01-02', '- notes', ''].join('\n');

// FuseV1Options indexes and FuseState bytes from @electron/fuses 2.1.3.
const ENABLE = 49;
const DISABLE = 48;
const EXPECTED_WIRE = { version: '1', 0: ENABLE, 1: ENABLE, 2: DISABLE, 3: DISABLE, 4: ENABLE, 5: ENABLE, 6: DISABLE, 7: DISABLE, 8: ENABLE };

const failures = (results: Result[]): string[] => results.filter((r) => !r.ok).map((r) => r.check);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('checkFuses', () => {
  it('passes the expected wire and reports the two fuses electron-builder.yml leaves at Electron defaults', () => {
    const results: Result[] = checkFuses(EXPECTED_WIRE);
    expect(failures(results)).toEqual([]);
    expect(results.map((r) => r.check)).toEqual(expect.arrayContaining(['fuse LoadBrowserProcessSpecificV8Snapshot', 'fuse WasmTrapHandlers']));
    expect(Object.keys(EXPECTED_FUSES)).toHaveLength(7);
  });

  it('fails a flipped fuse, a missing fuse and a fuse index nobody reviewed', () => {
    expect(failures(checkFuses({ ...EXPECTED_WIRE, 3: ENABLE }))).toEqual(['fuse EnableNodeCliInspectArguments']);
    const { 7: _dropped, ...withoutGrant } = EXPECTED_WIRE;
    expect(failures(checkFuses(withoutGrant))).toEqual(['fuse GrantFileProtocolExtraPrivileges']);
    expect(failures(checkFuses({ ...EXPECTED_WIRE, 9: DISABLE }))).toEqual(['fuse #9']);
    expect(failures(checkFuses({ ...EXPECTED_WIRE, version: '2' }))).toEqual(['fuses']);
  });
});

describe('checkUnpackedSet', () => {
  it('fails a file outside the globs and a glob that matches nothing', () => {
    const files = ['dist/sentinel.js', 'node_modules/koffi/index.cjs'];
    expect(failures(checkUnpackedSet(files, ['dist/sentinel.js', 'python/**']))).toEqual(['unpacked set', 'unpacked globs']);
    expect(failures(checkUnpackedSet(['dist/sentinel.js'], ['dist/sentinel.js']))).toEqual([]);
  });
});

describe('checkAppUpdate', () => {
  const feed = 'owner: AizenvoltPrime\nrepo: damocles\nprovider: github\nupdaterCacheDirName: damocles-updater\n';

  it('requires the per-arch channel on Windows and the default feed elsewhere', () => {
    expect(failures(checkAppUpdate(`${feed}channel: latest-arm64\n`, 'win32', 'arm64'))).toEqual([]);
    expect(failures(checkAppUpdate(`${feed}channel: latest-x64\n`, 'win32', 'arm64'))).toEqual(['app-update.yml']);
    expect(failures(checkAppUpdate(feed, 'win32', 'x64'))).toEqual(['app-update.yml']);
    expect(failures(checkAppUpdate(feed, 'linux', 'arm64'))).toEqual([]);
    expect(failures(checkAppUpdate(`${feed}channel: latest-x64\n`, 'darwin', 'arm64'))).toEqual(['app-update.yml']);
  });

  it('fails a missing file and a different repository', () => {
    expect(failures(checkAppUpdate(undefined, 'linux', 'x64'))).toEqual(['app-update.yml']);
    expect(failures(checkAppUpdate(feed.replace('repo: damocles', 'repo: other'), 'linux', 'x64'))).toEqual(['app-update.yml']);
  });
});

describe('checkAsarEntries', () => {
  it('fails sources, source maps and build tooling', () => {
    expect(failures(checkAsarEntries(['dist/desktop/main.js', 'node_modules/zod/index.js']))).toEqual([]);
    for (const entry of ['src/core/x.ts', 'dist/desktop/main.js.map', 'node_modules/esbuild/package.json', 'node_modules/electron/index.js', 'e2e/desktop/a.spec.ts']) {
      expect(failures(checkAsarEntries([entry])), entry).toEqual(['asar contents']);
    }
  });
});

describe('checkNodePtyLayout', () => {
  const pty = 'node_modules/node-pty';
  const packedJs = [`${pty}/package.json`, `${pty}/lib/index.js`, `${pty}/lib/unixTerminal.js`];
  const linux = [`${pty}/prebuilds/linux-x64/pty.node`];

  it('passes the target prebuild, unpacked, with the loader in app.asar', () => {
    expect(failures(checkNodePtyLayout('linux', 'x64', [...packedJs, ...linux], linux))).toEqual([]);
    const win = [`${pty}/prebuilds/win32-arm64/conpty.node`, `${pty}/prebuilds/win32-arm64/conpty_console_list.node`, `${pty}/prebuilds/win32-arm64/conpty/conpty.dll`];
    expect(failures(checkNodePtyLayout('win32', 'arm64', [...packedJs, ...win], win))).toEqual([]);
  });

  it('fails a second prebuild directory and a prebuild for another target', () => {
    const extra = `${pty}/prebuilds/linux-arm64/pty.node`;
    expect(failures(checkNodePtyLayout('linux', 'x64', [...packedJs, ...linux, extra], [...linux, extra]))).toEqual(['node-pty prebuild']);
    expect(failures(checkNodePtyLayout('linux', 'arm64', [...packedJs, ...linux], linux))).toEqual(['node-pty prebuild', 'node-pty binaries']);
  });

  it('fails a missing native binary', () => {
    const helperOnly = [`${pty}/prebuilds/darwin-arm64/spawn-helper`];
    expect(checkNodePtyLayout('darwin', 'arm64', [...packedJs, ...helperOnly], helperOnly).find((r: Result) => !r.ok)?.detail).toBe('missing from app.asar.unpacked: pty.node');
  });

  it('fails debug symbols and native sources', () => {
    for (const junk of [`${pty}/prebuilds/linux-x64/pty.pdb`, `${pty}/build/Release/conpty/conpty.dll`, `${pty}/src/unix/pty.cc`, `${pty}/third_party/conpty/x.dll`, `${pty}/scripts/prebuild.js`, `${pty}/deps/x.h`]) {
      expect(failures(checkNodePtyLayout('linux', 'x64', [...packedJs, ...linux, junk], linux)), junk).toEqual(['node-pty trimmed']);
    }
  });

  // Loaded from app.asar.unpacked, node-pty would rewrite its spawn-helper path to app.asar.unpacked.unpacked.
  it('fails a loader that is unpacked or missing', () => {
    expect(failures(checkNodePtyLayout('linux', 'x64', [...packedJs, ...linux], [...linux, `${pty}/lib/index.js`]))).toEqual(['node-pty loader']);
    expect(failures(checkNodePtyLayout('linux', 'x64', linux, linux))).toEqual(['node-pty loader']);
  });
});

describe('checkShellIntegrationScripts', () => {
  const lf = Buffer.from('a\nb\n');
  it('requires every script, and LF in all but the PowerShell one', () => {
    expect(failures(checkShellIntegrationScripts(() => lf))).toEqual([]);
    expect(failures(checkShellIntegrationScripts((file: string) => (file.endsWith('.ps1') ? Buffer.from('a\r\nb\r\n') : lf)))).toEqual([]);
    expect(failures(checkShellIntegrationScripts((file: string) => (file === 'shellIntegration-rc.zsh' ? undefined : lf)))).toEqual(['shell integration scripts']);
    expect(failures(checkShellIntegrationScripts((file: string) => (file === 'shellIntegration-login.zsh' ? Buffer.alloc(0) : lf)))).toEqual(['shell integration scripts']);
    expect(checkShellIntegrationScripts((file: string) => (file === 'shellIntegration-bash.sh' ? Buffer.from('a\r\n') : lf)).find((r: Result) => !r.ok)?.detail).toBe('CR in shellIntegration-bash.sh');
  });

  it('passes the repository\'s own scripts', () => {
    const dir = join(__dirname, '..', '..', 'resources', 'shell-integration');
    expect(failures(checkShellIntegrationScripts((file: string) => readFileSync(join(dir, file))))).toEqual([]);
  });
});

describe('checkSpawnHelperMode', () => {
  it('requires exactly 0755', () => {
    expect(failures([checkSpawnHelperMode(0o100755)])).toEqual([]);
    for (const mode of [0o100644, 0o100775, 0o100777, 0o100700]) expect(failures([checkSpawnHelperMode(mode)]), mode.toString(8)).toEqual(['node-pty spawn-helper mode']);
  });
});

/** A minimal asar: the pickled JSON header, then the packed file bytes. */
function writeAsar(file: string, packed: Record<string, string>, unpacked: string[]): void {
  const root: { files: Record<string, unknown> } = { files: {} };
  const chunks: Buffer[] = [];
  let offset = 0;
  const place = (path: string, entry: object): void => {
    const parts = path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) node = ((node.files[part] as { files: Record<string, unknown> } | undefined) ??= { files: {} }) as typeof root;
    node.files[parts.at(-1)!] = entry;
  };
  for (const [path, content] of Object.entries(packed)) {
    const data = Buffer.from(content);
    place(path, { size: data.length, offset: String(offset) });
    chunks.push(data);
    offset += data.length;
  }
  for (const path of unpacked) place(path, { size: 1, unpacked: true });
  const json = Buffer.from(JSON.stringify(root));
  const aligned = Math.ceil(json.length / 4) * 4;
  const head = Buffer.alloc(16 + aligned);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + aligned, 4);
  head.writeUInt32LE(4 + aligned, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  writeFileSync(file, Buffer.concat([head, ...chunks]));
}

function put(file: string, content: string | Buffer = 'x'): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('checkChangelog', () => {
  const changelog = ['# Changelog', '', '## [2.36.0] - 2026-01-02', '- notes', ''].join('\r\n');
  it('passes the repo copy with the packaged version section, and fails a missing, stale or versionless copy', () => {
    expect(failures(checkChangelog(changelog, changelog, '2.36.0'))).toEqual([]);
    expect(checkChangelog(undefined, changelog, '2.36.0')[0]!.detail).toBe('dist/desktop/CHANGELOG.md is not in app.asar');
    expect(checkChangelog(changelog.replace('notes', 'old'), changelog, '2.36.0')[0]!.detail).toBe("differs from the repo's CHANGELOG.md");
    expect(checkChangelog(changelog, changelog, '2.37.0')[0]!.detail).toBe('has no ## [2.37.0] section');
  });
});

describe('verifyPackage', () => {
  function fakeApp(platform: 'win32' | 'darwin', omitPacked: string[] = []): { repoRoot: string; app: string; unpacked: string } {
    const root = mkdtempSync(join(tmpdir(), 'vdp'));
    tempDirs.push(root);
    const repoRoot = join(root, 'repo');
    const app = join(root, platform === 'win32' ? 'win-unpacked' : 'Damocles.app');
    const resources = platform === 'win32' ? join(app, 'resources') : join(app, 'Contents', 'Resources');
    const unpacked = join(resources, 'app.asar.unpacked');
    put(join(repoRoot, 'package.json'), JSON.stringify({ version: '2.36.0' }));
    put(join(repoRoot, 'CHANGELOG.md'), CHANGELOG);
    put(join(repoRoot, 'resources', 'grammars', 'tree-sitter-go.wasm'), 'go-grammar');
    put(join(repoRoot, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models', 'wake', 'hey_jarvis.onnx'), 'wake');
    put(platform === 'win32' ? join(app, 'Damocles.exe') : join(app, 'Contents', 'MacOS', 'Damocles'), 'binary');
    put(join(resources, 'monaco-editor-ThirdPartyNotices.txt'), 'notices');
    put(join(resources, 'app-update.yml'), `owner: AizenvoltPrime\nrepo: damocles\nprovider: github\n${platform === 'win32' ? 'channel: latest-x64\n' : ''}updaterCacheDirName: damocles-updater\n`);
    const target = platform === 'win32' ? 'win32-x64' : 'darwin-arm64';
    const unpackedFiles = [
      'dist/compass-worker.js',
      'dist/usage-stats-worker.js',
      'dist/sentinel.js',
      'dist/formatter-host.js',
      'dist/pty-host.js',
      'dist/quick-open-worker.js',
      'resources/grammars/tree-sitter-go.wasm',
      ...SHELL_INTEGRATION_FILES.map((file) => `resources/shell-integration/${file}`),
      'python/damocles_voice_sidecar/damocles_voice_sidecar/__main__.py',
      'python/damocles_voice_sidecar/damocles_voice_sidecar/models/MODEL_MANIFEST.json',
      'python/damocles_voice_sidecar/damocles_voice_sidecar/models/wake/hey_jarvis.onnx',
      'node_modules/web-tree-sitter/tree-sitter.wasm',
      `node_modules/@vscode/ripgrep-${target}/bin/${platform === 'win32' ? 'rg.exe' : 'rg'}`,
      `node_modules/@koromix/koffi-${target}/${target.replace('-', '_')}/koffi.node`,
      ...(platform === 'win32' ? [] : [`node_modules/@parcel/watcher-${target}/watcher.node`]),
      ...(platform === 'win32' ? ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'] : ['pty.node', 'spawn-helper']).map(
        (file) => `node_modules/node-pty/prebuilds/${target}/${file}`,
      ),
    ];
    for (const file of unpackedFiles) put(join(unpacked, file));
    if (platform === 'darwin') {
      chmodSync(join(app, 'Contents', 'MacOS', 'Damocles'), 0o755);
      chmodSync(join(unpacked, 'node_modules', '@vscode', `ripgrep-${target}`, 'bin', 'rg'), 0o755);
      chmodSync(join(unpacked, 'node_modules', 'node-pty', 'prebuilds', target, 'spawn-helper'), 0o755);
    }
    put(join(unpacked, 'resources', 'grammars', 'tree-sitter-go.wasm'), 'go-grammar');
    put(join(unpacked, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models', 'wake', 'hey_jarvis.onnx'), 'wake');
    const packed: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'damocles', version: '2.36.0', main: 'dist/desktop/main.js' }),
      'node_modules/koffi/package.json': '{}',
      'node_modules/node-pty/package.json': '{}',
      'node_modules/node-pty/lib/index.js': '',
      'dist/desktop/main.js': '',
      'dist/desktop/CHANGELOG.md': CHANGELOG,
      LICENSE: 'MIT',
      'THIRD-PARTY-NOTICES.md': '# Third-Party Notices',
    };
    for (const file of omitPacked) delete packed[file];
    writeAsar(join(resources, 'app.asar'), packed, unpackedFiles);
    return { repoRoot, app, unpacked };
  }

  it('passes a complete Windows layout and reads the fuses from the binary', async () => {
    const { repoRoot, app } = fakeApp('win32');
    let fuseTarget = '';
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async (target: string) => ((fuseTarget = target), EXPECTED_WIRE) });
    expect(failures(results)).toEqual([]);
    expect(fuseTarget).toBe(join(app, 'Damocles.exe'));
    expect(ASAR_UNPACK.length).toBeGreaterThan(0);
  });

  it('fails a Windows package that ships the @parcel/watcher prebuild, which nothing there loads', async () => {
    const { repoRoot, app, unpacked } = fakeApp('win32');
    put(join(unpacked, 'node_modules', '@parcel', 'watcher-win32-x64', 'watcher.node'));
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['unpacked set', '@parcel/watcher prebuild left out']);
  });

  it('fails a macOS package without its @parcel/watcher prebuild', async () => {
    const { repoRoot, app, unpacked } = fakeApp('darwin');
    rmSync(join(unpacked, 'node_modules', '@parcel', 'watcher-darwin-arm64', 'watcher.node'));
    const results: Result[] = await verifyPackage({ platform: 'darwin', arch: 'arm64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE, codesign: () => ({ ok: true, output: '' }) });
    expect(failures(results)).toEqual(['unpacked globs', '@parcel/watcher native']);
  });

  it('verifies the macOS node-pty binaries with codesign -v and fails an invalid signature', async () => {
    const { repoRoot, app, unpacked } = fakeApp('darwin');
    const signed: string[] = [];
    const prebuild = join(unpacked, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64');
    const codesign = (file: string) => (signed.push(file), { ok: !file.endsWith('pty.node'), output: 'pty.node: invalid signature' });
    const results: Result[] = await verifyPackage({ platform: 'darwin', arch: 'arm64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE, codesign });
    expect(signed).toEqual([join(prebuild, 'pty.node'), join(prebuild, 'spawn-helper')]);
    expect(failures(results)).toEqual(['node-pty codesign pty.node']);
  });

  it('fails a missing pty host and a Windows prebuild that kept its debug symbols', async () => {
    const { repoRoot, app, unpacked } = fakeApp('win32');
    rmSync(join(unpacked, 'dist', 'pty-host.js'));
    put(join(unpacked, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.pdb'));
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['unpacked globs', 'worker pty-host.js', 'node-pty trimmed']);
  });

  it('fails a grammar that differs from the repo, a missing worker and a missing update feed', async () => {
    const { repoRoot, app, unpacked } = fakeApp('win32');
    put(join(unpacked, 'resources', 'grammars', 'tree-sitter-go.wasm'), 'stale');
    rmSync(join(unpacked, 'dist', 'sentinel.js'));
    rmSync(join(app, 'resources', 'app-update.yml'));
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    // The removed worker also leaves its ASAR_UNPACK glob matching nothing.
    expect(failures(results)).toEqual(['unpacked globs', 'worker sentinel.js', 'grammars', 'app-update.yml']);
  });

  it.skipIf(process.platform === 'win32')('fails a Linux binary without the exec bit', async () => {
    const { repoRoot, app } = fakeApp('win32');
    put(join(app, 'damocles'), 'elf');
    const results: Result[] = await verifyPackage({ platform: 'linux', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['binary']);
  });

  it('fails a package without the changelog that What\'s new reads', async () => {
    const { repoRoot, app } = fakeApp('win32', ['dist/desktop/CHANGELOG.md']);
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['changelog']);
  });

  it('fails a package that ships without its license notices', async () => {
    const { repoRoot, app } = fakeApp('win32', ['THIRD-PARTY-NOTICES.md']);
    rmSync(join(app, 'resources', 'monaco-editor-ThirdPartyNotices.txt'));
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['notice THIRD-PARTY-NOTICES.md', 'notice monaco-editor-ThirdPartyNotices.txt']);
  });
});
