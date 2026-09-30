import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import { checkAppUpdate, checkAsarEntries, checkFuses, checkUnpackedSet, EXPECTED_FUSES, verifyPackage } from '../verify-desktop-package.mjs';
import { ASAR_UNPACK } from '../../src/desktop/main/platform/unpacked-assets';

type Result = { check: string; ok: boolean; detail: string };

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

describe('verifyPackage', () => {
  function fakeWindowsApp(omitPacked: string[] = []): { repoRoot: string; app: string; unpacked: string } {
    const root = mkdtempSync(join(tmpdir(), 'vdp'));
    tempDirs.push(root);
    const repoRoot = join(root, 'repo');
    const app = join(root, 'win-unpacked');
    const unpacked = join(app, 'resources', 'app.asar.unpacked');
    put(join(repoRoot, 'package.json'), JSON.stringify({ version: '2.36.0' }));
    put(join(repoRoot, 'resources', 'grammars', 'tree-sitter-go.wasm'), 'go-grammar');
    put(join(repoRoot, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models', 'wake', 'hey_jarvis.onnx'), 'wake');
    put(join(app, 'Damocles.exe'), 'exe');
    put(join(app, 'resources', 'monaco-editor-ThirdPartyNotices.txt'), 'notices');
    put(join(app, 'resources', 'app-update.yml'), 'owner: AizenvoltPrime\nrepo: damocles\nprovider: github\nchannel: latest-x64\nupdaterCacheDirName: damocles-updater\n');
    const unpackedFiles = [
      'dist/compass-worker.js',
      'dist/usage-stats-worker.js',
      'dist/sentinel.js',
      'resources/grammars/tree-sitter-go.wasm',
      'python/damocles_voice_sidecar/damocles_voice_sidecar/__main__.py',
      'python/damocles_voice_sidecar/damocles_voice_sidecar/models/MODEL_MANIFEST.json',
      'python/damocles_voice_sidecar/damocles_voice_sidecar/models/wake/hey_jarvis.onnx',
      'node_modules/web-tree-sitter/tree-sitter.wasm',
      'node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe',
      'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
      'node_modules/@parcel/watcher-win32-x64/watcher.node',
    ];
    for (const file of unpackedFiles) put(join(unpacked, file));
    put(join(unpacked, 'resources', 'grammars', 'tree-sitter-go.wasm'), 'go-grammar');
    put(join(unpacked, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models', 'wake', 'hey_jarvis.onnx'), 'wake');
    const packed: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'damocles', version: '2.36.0', main: 'dist/desktop/main.js' }),
      'node_modules/koffi/package.json': '{}',
      'dist/desktop/main.js': '',
      LICENSE: 'MIT',
      'THIRD-PARTY-NOTICES.md': '# Third-Party Notices',
    };
    for (const file of omitPacked) delete packed[file];
    writeAsar(join(app, 'resources', 'app.asar'), packed, unpackedFiles);
    return { repoRoot, app, unpacked };
  }

  it('passes a complete Windows layout and reads the fuses from the binary', async () => {
    const { repoRoot, app } = fakeWindowsApp();
    let fuseTarget = '';
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async (target: string) => ((fuseTarget = target), EXPECTED_WIRE) });
    expect(failures(results)).toEqual([]);
    expect(fuseTarget).toBe(join(app, 'Damocles.exe'));
    expect(ASAR_UNPACK.length).toBeGreaterThan(0);
  });

  it('fails a grammar that differs from the repo, a missing worker and a missing update feed', async () => {
    const { repoRoot, app, unpacked } = fakeWindowsApp();
    put(join(unpacked, 'resources', 'grammars', 'tree-sitter-go.wasm'), 'stale');
    rmSync(join(unpacked, 'dist', 'sentinel.js'));
    rmSync(join(app, 'resources', 'app-update.yml'));
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    // The removed worker also leaves its ASAR_UNPACK glob matching nothing.
    expect(failures(results)).toEqual(['unpacked globs', 'worker sentinel.js', 'grammars', 'app-update.yml']);
  });

  it.skipIf(process.platform === 'win32')('fails a Linux binary without the exec bit', async () => {
    const { repoRoot, app } = fakeWindowsApp();
    put(join(app, 'damocles'), 'elf');
    const results: Result[] = await verifyPackage({ platform: 'linux', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['binary']);
  });

  it('fails a package that ships without its license notices', async () => {
    const { repoRoot, app } = fakeWindowsApp(['THIRD-PARTY-NOTICES.md']);
    rmSync(join(app, 'resources', 'monaco-editor-ThirdPartyNotices.txt'));
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['notice THIRD-PARTY-NOTICES.md', 'notice monaco-editor-ThirdPartyNotices.txt']);
  });
});
