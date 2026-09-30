import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

vi.mock('electron', () => ({ app: { getVersion: () => '9.8.7' } }));

import { createDesktopAppInfo } from '../platform/app-info';
import { createDesktopAppPaths, unpackagedResourceRoot } from '../platform/app-paths';
import { ASAR_UNPACK } from '../platform/unpacked-assets';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('desktop AppPaths', () => {
  it('resolves every root and worker to the checkout in the unpackaged layout', () => {
    const repoRoot = unpackagedResourceRoot(path.join(REPO_ROOT, 'dist', 'desktop'));
    expect(repoRoot).toBe(REPO_ROOT);
    const paths = createDesktopAppPaths({ packaged: false, repoRoot });
    expect(paths.resourceRoot).toBe(REPO_ROOT);
    expect(paths.unpackedRoot).toBe(REPO_ROOT);
    expect(paths.workerEntry('compass')).toBe(path.join(REPO_ROOT, 'dist', 'compass-worker.js'));
    expect(paths.workerEntry('usageStats')).toBe(path.join(REPO_ROOT, 'dist', 'usage-stats-worker.js'));
    expect(paths.workerEntry('sentinel')).toBe(path.join(REPO_ROOT, 'dist', 'sentinel.js'));
  });

  it('reads bundled files from app.asar and runs workers from its app.asar.unpacked sibling when packaged', () => {
    const asarPath = path.join(os.tmpdir(), 'Damocles', 'resources', 'app.asar');
    const unpacked = `${asarPath}.unpacked`;
    const paths = createDesktopAppPaths({ packaged: true, asarPath });
    expect(paths.resourceRoot).toBe(asarPath);
    expect(paths.unpackedRoot).toBe(unpacked);
    expect(paths.workerEntry('compass')).toBe(path.join(unpacked, 'dist', 'compass-worker.js'));
    expect(paths.workerEntry('usageStats')).toBe(path.join(unpacked, 'dist', 'usage-stats-worker.js'));
    expect(paths.workerEntry('sentinel')).toBe(path.join(unpacked, 'dist', 'sentinel.js'));
  });
});

describe('ASAR_UNPACK', () => {
  it('equals electron-builder.yml asarUnpack, in order', () => {
    const config = parse(fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8')) as { asarUnpack?: unknown; asar?: { smartUnpack?: unknown } };
    expect(config.asarUnpack).toEqual([...ASAR_UNPACK]);
    // smartUnpack would add native packages outside this list.
    expect(config.asar?.smartUnpack).toBe(false);
  });

  it('covers every path the packaged AppPaths promises under the unpacked root', () => {
    const paths = createDesktopAppPaths({ packaged: true, asarPath: '/app.asar' });
    const promised = [
      ...(['compass', 'usageStats', 'sentinel'] as const).map((name) => paths.workerEntry(name)),
      path.join(paths.unpackedRoot, 'resources', 'grammars', 'tree-sitter-typescript.wasm'),
      path.join(paths.unpackedRoot, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models', 'MODEL_MANIFEST.json'),
    ].map((p) => path.relative(paths.unpackedRoot, p).split(path.sep).join('/'));
    for (const file of promised) {
      expect(ASAR_UNPACK.some((pattern) => path.posix.matchesGlob(file, pattern)), file).toBe(true);
    }
  });
});

describe('desktop AppInfo', () => {
  it('reads the version from the checkout package.json when unpackaged', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai'));
    tempDirs.push(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    expect(createDesktopAppInfo({ packaged: false, repoRoot }).version).toBe('1.2.3');
  });

  it('fails when the checkout package.json has no version', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai'));
    tempDirs.push(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(() => createDesktopAppInfo({ packaged: false, repoRoot })).toThrow(/No version/);
  });

  it('uses app.getVersion() when packaged, which reports the packaged package.json version', () => {
    expect(createDesktopAppInfo({ packaged: true, asarPath: '/nonexistent/app.asar' }).version).toBe('9.8.7');
  });
});
