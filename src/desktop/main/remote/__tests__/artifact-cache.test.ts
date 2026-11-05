import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArtifactCache, releaseAssetUrl, releasesUrlOf, UnpublishedPackageMissingError } from '../artifact-cache';
import { RELEASES_URL } from '../../updater';
import type { ServerManifest } from '../server-manifest-format';

const BYTES = Buffer.from('a server package');
const FILE = 'damocles-server-3.7.0-linux-x64.tar.gz';
const RELEASES = 'https://github.com/AizenvoltPrime/damocles/releases';
const manifest: ServerManifest = {
  version: '3.7.0',
  protocolVersion: 1,
  published: true,
  packages: { 'linux-x64': { file: FILE, sha256: createHash('sha256').update(BYTES).digest('hex'), size: BYTES.length, serverVersion: '3.7.0+0123456789ab' } },
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'artifact-cache-'));
  dirs.push(dir);
  return dir;
}

function setUp(body: Buffer = BYTES, devDir?: string) {
  const cacheRoot = scratch();
  const fetch = vi.fn(async (_url: string) => new Response(new Uint8Array(body)));
  const cache = createArtifactCache({ cacheRoot, manifest, releasesUrl: RELEASES, fetch, log: () => undefined, ...(devDir !== undefined ? { devDir } : {}) });
  return { cache, cacheRoot, fetch };
}

describe('the server artifact cache', () => {
  it('downloads a missing package from the release into <cache>/<version>/ and reuses it after its hash check', async () => {
    const { cache, cacheRoot, fetch } = setUp();
    const file = await cache.packagePath('linux-x64');
    expect(file).toBe(path.join(cacheRoot, '3.7.0', FILE));
    expect(readFileSync(file)).toEqual(BYTES);
    expect(fetch).toHaveBeenCalledWith(releaseAssetUrl(RELEASES, '3.7.0', FILE), { signal: expect.any(AbortSignal) });
    expect(fetch.mock.calls[0]![0]).toBe(`${RELEASES}/download/v3.7.0/${FILE}`);
    await cache.packagePath('linux-x64');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shares one download between concurrent callers', async () => {
    const { cache, fetch } = setUp();
    await Promise.all([cache.packagePath('linux-x64'), cache.packagePath('linux-x64')]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a download whose hash or size differs and leaves no file behind', async () => {
    for (const body of [Buffer.from('a server packagX'), Buffer.from('a server package, longer')]) {
      const { cache, cacheRoot } = setUp(body);
      await expect(cache.packagePath('linux-x64')).rejects.toThrow(/does not match|more than/);
      expect(readdirSync(path.join(cacheRoot, '3.7.0'))).toEqual([]);
    }
  });

  it('replaces a cached file that no longer matches', async () => {
    const { cache, cacheRoot, fetch } = setUp();
    mkdirSync(path.join(cacheRoot, '3.7.0'), { recursive: true });
    writeFileSync(path.join(cacheRoot, '3.7.0', FILE), 'tampered');
    expect(readFileSync(await cache.packagePath('linux-x64'))).toEqual(BYTES);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serves an unpublished build only from its cache, never fetching, and fails without a copy that matches', async () => {
    const cacheRoot = scratch();
    const fetch = vi.fn(async (_url: string) => new Response(new Uint8Array(BYTES)));
    const cache = createArtifactCache({ cacheRoot, manifest: { ...manifest, published: false }, fetch, log: () => undefined });
    await expect(cache.packagePath('linux-x64')).rejects.toBeInstanceOf(UnpublishedPackageMissingError);
    mkdirSync(path.join(cacheRoot, '3.7.0'), { recursive: true });
    writeFileSync(path.join(cacheRoot, '3.7.0', FILE), 'another build');
    await expect(cache.packagePath('linux-x64')).rejects.toThrow(/an unpublished build has no release/);
    writeFileSync(path.join(cacheRoot, '3.7.0', FILE), BYTES);
    expect(await cache.packagePath('linux-x64')).toBe(path.join(cacheRoot, '3.7.0', FILE));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gives hosts the release to download from only for a published build, unless the e2e hook names one', () => {
    expect(releasesUrlOf({ published: true }, undefined)).toBe(RELEASES_URL);
    expect(releasesUrlOf({ published: false }, undefined)).toBeUndefined();
    expect(releasesUrlOf({ published: false }, 'http://127.0.0.1:4000/releases')).toBe('http://127.0.0.1:4000/releases');
    expect(releasesUrlOf({ published: true }, 'http://127.0.0.1:4000/releases')).toBe('http://127.0.0.1:4000/releases');
  });

  it('reads a dev build\'s package from dist/server-packages without downloading, after the same check', async () => {
    const devDir = scratch();
    writeFileSync(path.join(devDir, FILE), BYTES);
    const { cache, cacheRoot, fetch } = setUp(BYTES, devDir);
    expect(await cache.packagePath('linux-x64')).toBe(path.join(devDir, FILE));
    expect(existsSync(path.join(cacheRoot, '3.7.0'))).toBe(false);
    writeFileSync(path.join(devDir, FILE), 'stale');
    await expect(cache.packagePath('linux-x64')).rejects.toThrow(/npm run build:server -- --target linux-x64$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('names node-pty\'s musl build in the rebuild hint for an Alpine dev package', async () => {
    const devDir = scratch();
    const alpine = { ...manifest, packages: { 'alpine-x64': { ...manifest.packages['linux-x64']!, file: 'damocles-server-3.7.0-alpine-x64.tar.gz' } } };
    const cache = createArtifactCache({ cacheRoot: scratch(), manifest: alpine, releasesUrl: RELEASES, fetch: vi.fn(), log: () => undefined, devDir });
    await expect(cache.packagePath('alpine-x64')).rejects.toThrow(/--target alpine-x64 --node-pty-binary <pty\.node compiled against musl>$/);
  });

  it('refuses a target the manifest does not carry', async () => {
    const { cache } = setUp();
    await expect(cache.packagePath('win32-x64')).rejects.toThrow(/no server package for win32-x64/);
  });

  it('removes other versions\' folders and the partial files a crash left before it fills', async () => {
    const { cache, cacheRoot } = setUp();
    mkdirSync(path.join(cacheRoot, '3.6.0'), { recursive: true });
    writeFileSync(path.join(cacheRoot, '3.6.0', 'damocles-server-3.6.0-linux-x64.tar.gz'), 'old');
    mkdirSync(path.join(cacheRoot, '3.7.0'), { recursive: true });
    writeFileSync(path.join(cacheRoot, '3.7.0', `${FILE}.0123456789ab.partial`), 'half');
    await cache.packagePath('linux-x64');
    expect(readdirSync(cacheRoot)).toEqual(['3.7.0']);
    expect(readdirSync(path.join(cacheRoot, '3.7.0'))).toEqual([FILE]);
  });

  it('abandons a download that stalls, so the next ask starts it again', async () => {
    const cacheRoot = scratch();
    let calls = 0;
    const fetch = vi.fn(async (_url: string, init: { readonly signal: AbortSignal }) => {
      if (++calls > 1) return new Response(new Uint8Array(BYTES));
      // a body that sends nothing more until the signal errors it, as fetch's does
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new Uint8Array(BYTES.subarray(0, 4)));
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
        },
      });
      return new Response(body);
    });
    const cache = createArtifactCache({ cacheRoot, manifest, releasesUrl: RELEASES, fetch, idleTimeoutMs: 50, log: () => undefined });
    await expect(cache.packagePath('linux-x64')).rejects.toThrow(/sent nothing for 50 ms/);
    expect(readdirSync(path.join(cacheRoot, '3.7.0'))).toEqual([]);
    expect(readFileSync(await cache.packagePath('linux-x64'))).toEqual(BYTES);
  });
});
