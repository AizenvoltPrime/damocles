import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { REPO_ROOT } from '../../desktop/support/hermetic';
import { containerReachableAddress, HOST_FROM_CONTAINER } from './sshd';

export const SERVER_PACKAGES_DIR = path.join(REPO_ROOT, 'dist', 'server-packages');
export const APP_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const CPU = process.arch === 'arm64' ? 'arm64' : 'x64';
// The fixtures' targets, on this computer's CPU architecture.
export const LINUX_TARGET = `linux-${CPU}`;
export const ALPINE_TARGET = `alpine-${CPU}`;
/** scripts/server-targets.mjs serverArtifact for a POSIX target. */
export const serverPackage = (target: string): string => `damocles-server-${APP_VERSION}-${target}.tar.gz`;
/** An installed version's folder in `<install>`: `<version>-<target>`. */
export const installedVersion = (target: string): string => `${APP_VERSION}-${target}`;

// serve: the packages as built; block: every download fails, so the app uploads; tamper: the bytes differ in one place.
export type MirrorMode = 'serve' | 'block' | 'tamper';

export interface ReleaseMirror {
  /** The release base the app gets as DAMOCLES_E2E_RELEASE_URL, as the fixtures' containers reach it. */
  readonly url: string;
  mode: MirrorMode;
  /** The package files requested so far, one entry per request, in order. */
  readonly downloads: readonly string[];
  /**
   * Holds every download after its first half until `release`, so the target sits at Installing with a progress between 0 and
   * 100%; `reached` resolves once a download is held.
   */
  holdDownloads(): { readonly reached: Promise<void>; release(): void };
  close(): Promise<void>;
}

// artifact-cache.ts releaseAssetUrl: <base>/download/v<version>/<file>
const ASSET = /^\/download\/v[^/]+\/(damocles-server-[\w.-]+\.(?:tar\.gz|zip))$/;

/** A request path with its percent escapes decoded; undefined when an escape is malformed. */
export function decodedPath(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}

/** The release's download host on this computer's loopback, serving dist/server-packages/. */
export async function startReleaseMirror(): Promise<ReleaseMirror> {
  const downloads: string[] = [];
  const mirror = { mode: 'serve' as MirrorMode };
  let hold: { reached: () => void; released: Promise<void> } | undefined;
  const server = http.createServer((req, res) => {
    const url = decodedPath(req.url ?? '');
    if (url === undefined) {
      res.writeHead(400).end(`malformed path ${req.url}`);
      return;
    }
    const file = ASSET.exec(url)?.[1];
    const archive = file === undefined ? undefined : path.join(SERVER_PACKAGES_DIR, file);
    if (req.method !== 'GET' || archive === undefined || !fs.existsSync(archive)) {
      res.writeHead(404).end(`no release asset ${req.url}`);
      return;
    }
    downloads.push(file!);
    if (mirror.mode === 'block') {
      res.writeHead(503).end('downloads are blocked');
      return;
    }
    const bytes = fs.readFileSync(archive);
    // same size, one flipped byte past the gzip header: only the hash check can tell
    if (mirror.mode === 'tamper') bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    if (!hold) {
      res.end(bytes);
      return;
    }
    const { reached, released } = hold;
    const half = Math.floor(bytes.length / 2);
    res.write(bytes.subarray(0, half), () => reached());
    void released.then(() => res.end(bytes.subarray(half)));
  });
  const address = await containerReachableAddress();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, address, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${HOST_FROM_CONTAINER}:${port}`,
    get mode() {
      return mirror.mode;
    },
    set mode(mode: MirrorMode) {
      mirror.mode = mode;
    },
    downloads,
    holdDownloads: () => {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      hold = { reached, released };
      return {
        reached: reachedPromise,
        release: () => {
          hold = undefined;
          release();
        },
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
