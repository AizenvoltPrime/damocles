// The server packages this app installs on targets: <userData>/server-cache/<version>/, this app version's only, filled on
// demand from the release and accepted only with the manifest's SHA-256 and size. An unpackaged app reads
// <repo>/dist/server-packages/.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ServerManifest, ServerPackage, ServerTarget } from './server-manifest-format';

// a download that receives nothing for this long is abandoned, so the next ask starts it again
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const PARTIAL_SUFFIX = '.partial';

export interface ArtifactCacheOptions {
  // <userData>/server-cache
  readonly cacheRoot: string;
  readonly manifest: ServerManifest;
  // updater.ts RELEASES_URL; an asset is <releasesUrl>/download/v<version>/<file>
  readonly releasesUrl: string;
  // <repo>/dist/server-packages in an unpackaged app, which never downloads
  readonly devDir?: string;
  readonly fetch: (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;
  readonly idleTimeoutMs?: number;
  readonly log: (line: string) => void;
}

export interface ArtifactCache {
  /** The verified package of `target` on this computer, downloaded first when the cache lacks it. */
  packagePath(target: ServerTarget): Promise<string>;
}

async function digestOf(file: string): Promise<{ readonly sha256: string; readonly size: number } | undefined> {
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of createReadStream(file)) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return { sha256: hash.digest('hex'), size };
}

const matches = (found: { readonly sha256: string; readonly size: number } | undefined, expected: ServerPackage): boolean =>
  found !== undefined && found.sha256 === expected.sha256 && found.size === expected.size;

export function releaseAssetUrl(releasesUrl: string, version: string, file: string): string {
  return `${releasesUrl}/download/v${encodeURIComponent(version)}/${encodeURIComponent(file)}`;
}

export function createArtifactCache(options: ArtifactCacheOptions): ArtifactCache {
  const { manifest, log } = options;
  const idleTimeoutMs = options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
  const pending = new Map<ServerTarget, Promise<string>>();

  // Other versions' folders and partial files a crash left; runs once, before this cache's first download.
  const prune = async (): Promise<void> => {
    let names: string[];
    try {
      names = await fs.readdir(options.cacheRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const name of names.filter((entry) => entry !== manifest.version)) await fs.rm(path.join(options.cacheRoot, name), { recursive: true, force: true });
    const own = path.join(options.cacheRoot, manifest.version);
    if (!names.includes(manifest.version)) return;
    for (const name of (await fs.readdir(own)).filter((entry) => entry.endsWith(PARTIAL_SUFFIX))) await fs.rm(path.join(own, name), { force: true });
  };
  let pruned: Promise<void> | undefined;

  // streams the asset to a partial file, refusing more bytes than the manifest names, then checks it and renames it in place
  const download = async (pkg: ServerPackage, dest: string): Promise<void> => {
    const url = releaseAssetUrl(options.releasesUrl, manifest.version, pkg.file);
    log(`[server-cache] downloading ${url}`);
    const controller = new AbortController();
    let idle: NodeJS.Timeout | undefined;
    const waiting = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(new Error(`${url} sent nothing for ${idleTimeoutMs} ms`)), idleTimeoutMs);
    };
    waiting();
    try {
      const response = await options.fetch(url, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
      const partial = `${dest}.${randomBytes(6).toString('hex')}${PARTIAL_SUFFIX}`;
      const hash = createHash('sha256');
      let size = 0;
      // the abort errors the body, so a stalled read() rejects
      const reader = response.body.getReader();
      const handle = await fs.open(partial, 'wx');
      try {
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          waiting();
          const chunk = read.value;
          size += chunk.length;
          if (size > pkg.size) throw new Error(`${url} sent more than the ${pkg.size} bytes the manifest names`);
          hash.update(chunk);
          await handle.write(chunk);
        }
        await handle.close();
        if (!matches({ sha256: hash.digest('hex'), size }, pkg)) throw new Error(`${url} does not match the SHA-256 and size this app carries`);
        await fs.rename(partial, dest);
      } catch (err) {
        await reader.cancel().catch(() => undefined);
        await handle.close().catch(() => undefined);
        await fs.rm(partial, { force: true });
        throw err;
      }
    } finally {
      clearTimeout(idle);
    }
  };

  const fill = async (target: ServerTarget): Promise<string> => {
    const pkg = manifest.packages[target];
    if (!pkg) throw new Error(`This build carries no server package for ${target}`);
    if (options.devDir !== undefined) {
      const file = path.join(options.devDir, pkg.file);
      if (!matches(await digestOf(file), pkg)) throw new Error(`${file} is missing or differs from the dev manifest; run npm run build:server -- --target ${target}`);
      return file;
    }
    pruned ??= prune();
    await pruned;
    const dir = path.join(options.cacheRoot, manifest.version);
    const dest = path.join(dir, pkg.file);
    if (matches(await digestOf(dest), pkg)) return dest;
    await fs.rm(dest, { force: true });
    await fs.mkdir(dir, { recursive: true });
    await download(pkg, dest);
    return dest;
  };

  return {
    packagePath: (target) => {
      let filling = pending.get(target);
      if (!filling) {
        filling = fill(target).finally(() => pending.delete(target));
        pending.set(target, filling);
      }
      return filling;
    },
  };
}
