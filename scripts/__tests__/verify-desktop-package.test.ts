import { createHash } from 'crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import {
  ASKPASS_SCRIPTS,
  checkAppUpdate,
  checkAsarEntries,
  checkAskpassScripts,
  checkChangelog,
  checkCoreHost,
  checkFuses,
  checkNodePtyLayout,
  checkShellIntegrationScripts,
  checkSpawnHelperMode,
  checkUnpackedSet,
  checkWakeModel,
  EXPECTED_FUSES,
  SHELL_INTEGRATION_FILES,
  verifyPackage,
  WINDOWS_PUBLISHER,
  WORKERS,
} from '../verify-desktop-package.mjs';
import { parse } from 'yaml';
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

describe('WORKERS', () => {
  it('names every top-level dist script the build writes but the extension and Damocles Core, which stays packed', () => {
    const config = readFileSync(join(__dirname, '..', '..', 'esbuild.config.mjs'), 'utf8');
    const outfiles = [...config.matchAll(/outfile: 'dist\/([^/']+\.js)'/g)].map((match) => match[1]).filter((name) => name !== 'extension.js' && name !== 'core-host.js');
    expect(outfiles).toContain('process-launcher-worker.js');
    expect([...WORKERS].sort()).toEqual(outfiles.sort());
  });
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
  const publisher = 'publisherName:\n  - SignPath Foundation\n';

  it('requires the per-arch channel on Windows and the default feed elsewhere', () => {
    expect(failures(checkAppUpdate(`${feed}channel: latest-arm64\n${publisher}`, 'win32', 'arm64'))).toEqual([]);
    expect(failures(checkAppUpdate(`${feed}channel: latest-x64\n${publisher}`, 'win32', 'arm64'))).toEqual(['app-update.yml']);
    expect(failures(checkAppUpdate(`${feed}${publisher}`, 'win32', 'x64'))).toEqual(['app-update.yml']);
    expect(failures(checkAppUpdate(feed, 'linux', 'arm64'))).toEqual([]);
    expect(failures(checkAppUpdate(`${feed}channel: latest-x64\n`, 'darwin', 'arm64'))).toEqual(['app-update.yml']);
  });

  it('requires the release certificate as the Windows update publisher, and no publisher elsewhere', () => {
    expect(failures(checkAppUpdate(`${feed}channel: latest-x64\n`, 'win32', 'x64'))).toEqual(['app-update.yml']);
    expect(failures(checkAppUpdate(`${feed}channel: latest-x64\npublisherName:\n  - Someone Else\n`, 'win32', 'x64'))).toEqual(['app-update.yml']);
    expect(failures(checkAppUpdate(`${feed}${publisher}`, 'linux', 'x64'))).toEqual(['app-update.yml']);
  });

  it('agrees with the publisher electron-builder.yml writes', () => {
    const config = parse(readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')) as { win: { signtoolOptions: { publisherName: string } } };
    expect(config.win.signtoolOptions.publisherName).toBe(WINDOWS_PUBLISHER);
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

// utilityProcess.fork loads the core host from inside app.asar; an unpacked copy would run outside asar integrity.
describe('checkCoreHost', () => {
  const packed = { path: 'dist/core-host.js', entry: {} };

  it('passes the bundle inside app.asar only', () => {
    expect(failures(checkCoreHost([packed], []))).toEqual([]);
  });

  it('fails a missing bundle, one marked unpacked and an unpacked copy', () => {
    expect(checkCoreHost([], [])[0].detail).toBe('not in app.asar');
    expect(checkCoreHost([{ path: 'dist/core-host.js', entry: { unpacked: true } }], [])[0].detail).toBe('marked unpacked in app.asar');
    expect(checkCoreHost([packed], ['dist/core-host.js'])[0].detail).toBe('has a copy in app.asar.unpacked');
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

describe('checkAskpassScripts', () => {
  const lf = Buffer.from('#!/bin/sh\nexec x\n');
  const mode = (value: number) => () => ({ mode: value });
  it('requires both scripts, LF and exactly 0755 where modes are kept', () => {
    expect(failures(checkAskpassScripts(() => lf, mode(0o100755), true))).toEqual([]);
    expect(failures(checkAskpassScripts(() => lf, mode(0o100644), false))).toEqual([]);
    expect(failures(checkAskpassScripts(() => lf, mode(0o100644), true))).toEqual(['askpass mode']);
    expect(failures(checkAskpassScripts(() => lf, mode(0o100775), true))).toEqual(['askpass mode']);
    expect(failures(checkAskpassScripts((file: string) => (file === 'ssh-askpass.sh' ? undefined : lf), () => undefined, true))).toEqual(['askpass scripts']);
    expect(failures(checkAskpassScripts(() => Buffer.from('#!/bin/sh\r\n'), mode(0o100755), true))).toEqual(['askpass line endings']);
  });

  it('names every script in resources/askpass, which the desktop build copies', () => {
    expect([...ASKPASS_SCRIPTS].sort()).toEqual(readdirSync(join(__dirname, '..', '..', 'resources', 'askpass')).sort());
  });

  it('passes the repository\'s own scripts for line endings', () => {
    const dir = join(__dirname, '..', '..', 'resources', 'askpass');
    expect(failures(checkAskpassScripts((file: string) => readFileSync(join(dir, file)), mode(0o100755), true))).toEqual([]);
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

const WAKE_FILES: Record<string, string> = { 'encoder.int8.onnx': 'encoder', 'tokens.txt': 'tokens', 'bpe.model': 'bpe' };
const WAKE_MANIFEST = JSON.stringify({
  wake_model: {
    files: Object.entries(WAKE_FILES).map(([filename, content]) => ({
      filename,
      archive_path: `kws/${filename}`,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
    })),
  },
});

describe('checkWakeModel', () => {
  function wakeDirs(): { manifest: string; packaged: string } {
    const root = mkdtempSync(join(tmpdir(), 'vdp-wake'));
    tempDirs.push(root);
    const manifest = join(root, 'MODEL_MANIFEST.json');
    put(manifest, WAKE_MANIFEST);
    const packaged = join(root, 'wake');
    for (const [file, content] of Object.entries(WAKE_FILES)) put(join(packaged, file), content);
    put(join(packaged, '__init__.py'), '');
    return { manifest, packaged };
  }

  it('passes exactly the listed files at their listed checksums, beside the package marker', () => {
    const { manifest, packaged } = wakeDirs();
    const result: Result = checkWakeModel(manifest, packaged);
    expect(result.ok).toBe(true);
  });

  it('fails a missing, a changed and an unlisted file', () => {
    const { manifest, packaged } = wakeDirs();
    rmSync(join(packaged, 'bpe.model'));
    put(join(packaged, 'tokens.txt'), 'tokenz');
    put(join(packaged, 'hey_jarvis.onnx'), 'old model');
    const result: Result = checkWakeModel(manifest, packaged);
    expect(result).toEqual({
      check: 'wake model',
      ok: false,
      detail: 'missing bpe.model; differ from the manifest: tokens.txt; not in the manifest: hey_jarvis.onnx',
    });
  });
});

describe('checkChangelog', () => {
  const changelog = ['# Changelog', '', '## [2.36.0] - 2026-01-02', '- notes', ''].join('\r\n');
  it('passes the repo copy with the packaged version section, and fails a missing, stale or versionless copy', () => {
    expect(failures(checkChangelog(changelog, changelog, '2.36.0'))).toEqual([]);
    expect(checkChangelog(undefined, changelog, '2.36.0')[0]!.detail).toBe('dist/desktop/CHANGELOG.md is not in app.asar');
    expect(checkChangelog(changelog.replace('notes', 'old'), changelog, '2.36.0')[0]!.detail).toBe("differs from the repo's CHANGELOG.md");
    expect(checkChangelog(changelog, changelog, '2.37.0')[0]!.detail).toBe('has no ## [2.37.0] section');
  });

  // An empty section would fail release-notes after Windows is signed; this check runs before signing.
  it('fails a section with no notes before the next heading', () => {
    const empty = ['# Changelog', '', '## [2.37.0] - 2026-02-01', '  ', '## [2.36.0] - 2026-01-02', '- notes', ''].join('\n');
    expect(checkChangelog(empty, empty, '2.37.0')[0]!.detail).toBe('has an empty ## [2.37.0] section');
    const last = ['# Changelog', '', '## [2.37.0] - 2026-02-01', ''].join('\n');
    expect(checkChangelog(last, last, '2.37.0')[0]!.detail).toBe('has an empty ## [2.37.0] section');
    expect(failures(checkChangelog(empty, empty, '2.36.0'))).toEqual([]);
  });

  // release.yml's "Extract changelog section" makes the same choice, so a dry run checks the notes the next release publishes.
  it('checks [Unreleased] outside a tag run while the changelog has it, and the version section on a tag run', () => {
    const unreleased = ['# Changelog', '', '## [Unreleased]', '', '- next', '', '## [2.36.0] - 2026-01-02', '- notes', ''].join('\r\n');
    expect(checkChangelog(unreleased, unreleased, '2.36.0', false)[0]!.detail).toBe('dist/desktop/CHANGELOG.md has the Unreleased section');
    expect(checkChangelog(unreleased, unreleased, '2.37.0', true)[0]!.detail).toBe('has no ## [2.37.0] section');
    expect(failures(checkChangelog(unreleased, unreleased, '2.36.0', true))).toEqual([]);
    const empty = ['# Changelog', '', '## [Unreleased]', '', '## [2.36.0] - 2026-01-02', '- notes', ''].join('\n');
    expect(checkChangelog(empty, empty, '2.36.0', false)[0]!.detail).toBe('has an empty ## [Unreleased] section');
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
    for (const file of ASKPASS_SCRIPTS) put(join(repoRoot, 'resources', 'askpass', file));
    put(join(repoRoot, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models', 'MODEL_MANIFEST.json'), WAKE_MANIFEST);
    put(platform === 'win32' ? join(app, 'Damocles.exe') : join(app, 'Contents', 'MacOS', 'Damocles'), 'binary');
    put(join(resources, 'monaco-editor-ThirdPartyNotices.txt'), 'notices');
    put(join(resources, 'app-update.yml'), `owner: AizenvoltPrime\nrepo: damocles\nprovider: github\n${platform === 'win32' ? 'channel: latest-x64\npublisherName:\n  - SignPath Foundation\n' : ''}updaterCacheDirName: damocles-updater\n`);
    const target = platform === 'win32' ? 'win32-x64' : 'darwin-arm64';
    const unpackedFiles = [
      'dist/compass-worker.js',
      'dist/usage-stats-worker.js',
      'dist/sentinel.js',
      'dist/process-launcher-worker.js',
      'dist/memory-integrity-worker.js',
      'dist/session-meta-index-worker.js',
      'dist/voice-extract-worker.js',
      'dist/formatter-host.js',
      'dist/pty-host.js',
      'dist/quick-open-worker.js',
      'dist/watch-worker.js',
      'dist/askpass-main.js',
      ...ASKPASS_SCRIPTS.map((file) => `dist/askpass/${file}`),
      'resources/grammars/tree-sitter-go.wasm',
      ...SHELL_INTEGRATION_FILES.map((file) => `resources/shell-integration/${file}`),
      'python/damocles_voice_sidecar/damocles_voice_sidecar/__main__.py',
      'python/damocles_voice_sidecar/damocles_voice_sidecar/models/MODEL_MANIFEST.json',
      ...Object.keys(WAKE_FILES).map((file) => `python/damocles_voice_sidecar/damocles_voice_sidecar/models/wake/${file}`),
      'node_modules/web-tree-sitter/tree-sitter.wasm',
      'node_modules/koffi/package.json',
      `node_modules/@vscode/ripgrep-${target}/bin/${platform === 'win32' ? 'rg.exe' : 'rg'}`,
      `node_modules/@koromix/koffi-${target}/${target.replace('-', '_')}/koffi.node`,
      ...(platform === 'win32' ? [] : [`node_modules/@parcel/watcher-${target}/watcher.node`]),
      ...(platform === 'win32' ? ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'] : ['pty.node', 'spawn-helper']).map(
        (file) => `node_modules/node-pty/prebuilds/${target}/${file}`,
      ),
    ];
    for (const file of unpackedFiles) put(join(unpacked, file));
    // the desktop build gives the askpass scripts 0755 for every target, and a POSIX host checks it
    for (const file of ASKPASS_SCRIPTS) chmodSync(join(unpacked, 'dist', 'askpass', file), 0o755);
    if (platform === 'darwin') {
      chmodSync(join(app, 'Contents', 'MacOS', 'Damocles'), 0o755);
      chmodSync(join(unpacked, 'node_modules', '@vscode', `ripgrep-${target}`, 'bin', 'rg'), 0o755);
      chmodSync(join(unpacked, 'node_modules', 'node-pty', 'prebuilds', target, 'spawn-helper'), 0o755);
    }
    put(join(unpacked, 'resources', 'grammars', 'tree-sitter-go.wasm'), 'go-grammar');
    for (const [file, content] of Object.entries(WAKE_FILES)) put(join(unpacked, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models', 'wake', file), content);
    const packed: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'damocles', version: '2.36.0', main: 'dist/desktop/main.js' }),
      'node_modules/node-pty/package.json': '{}',
      'node_modules/node-pty/lib/index.js': '',
      'dist/desktop/main.js': '',
      'dist/core-host.js': '',
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

  it('fails a packaged askpass script that differs from resources/askpass, as a stale dist/askpass would', async () => {
    const { repoRoot, app, unpacked } = fakeApp('win32');
    put(join(unpacked, 'dist', 'askpass', ASKPASS_SCRIPTS[0]!), 'stale');
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['askpass script contents']);
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
