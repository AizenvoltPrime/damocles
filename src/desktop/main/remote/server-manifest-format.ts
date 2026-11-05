// The server packages' manifest format, which app main reads and scripts/verify-desktop-package.mjs checks in a release
// app; no imports, so a script loads it with Node's type stripping.

// scripts/server-targets.mjs SERVER_TARGETS; server-manifest.test.ts fails on drift
export const SERVER_TARGETS = ['linux-x64', 'linux-arm64', 'alpine-x64', 'alpine-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'] as const;
export type ServerTarget = (typeof SERVER_TARGETS)[number];

export interface ServerPackage {
  // a bare file name: the release asset and the cache file
  readonly file: string;
  readonly sha256: string;
  readonly size: number;
  // `<version>+<build>` (scripts/build-server.mjs packageBuild): the host's install folder and the running server's version
  readonly serverVersion: string;
}

export interface ServerManifest {
  // an app version; the artifact cache names a folder after it
  readonly version: string;
  readonly protocolVersion: number;
  // true only for a release's manifest; hosts of an unpublished build never download
  readonly published: boolean;
  readonly packages: Readonly<Partial<Record<ServerTarget, ServerPackage>>>;
}

// no build metadata: a package's server version adds the build after the one +
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGE_FILE = /^damocles-server-[0-9A-Za-z.+-]+-[a-z0-9]+-[a-z0-9]+\.(?:zip|tar\.gz)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BUILD = /^[0-9a-f]{12}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parsePackage(value: unknown, version: string): ServerPackage | undefined {
  if (!isRecord(value)) return undefined;
  const { file, sha256, size, serverVersion } = value;
  if (typeof file !== 'string' || !PACKAGE_FILE.test(file)) return undefined;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return undefined;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return undefined;
  if (typeof serverVersion !== 'string' || !serverVersion.startsWith(`${version}+`) || !BUILD.test(serverVersion.slice(version.length + 1))) return undefined;
  return { file, sha256, size, serverVersion };
}

/** The manifest in `value`, or undefined when any field is malformed or names an unknown target. */
export function parseServerManifest(value: unknown): ServerManifest | undefined {
  if (!isRecord(value) || !isRecord(value['packages'])) return undefined;
  const { version, protocolVersion, published } = value;
  if (typeof version !== 'string' || !VERSION.test(version) || typeof protocolVersion !== 'number' || !Number.isSafeInteger(protocolVersion)) return undefined;
  if (typeof published !== 'boolean') return undefined;
  const packages: Partial<Record<ServerTarget, ServerPackage>> = {};
  for (const [target, entry] of Object.entries(value['packages'])) {
    const parsed = parsePackage(entry, version);
    if (!(SERVER_TARGETS as readonly string[]).includes(target) || !parsed) return undefined;
    packages[target as ServerTarget] = parsed;
  }
  return { version, protocolVersion, published, packages };
}

/** The server versions of `manifest`'s packages: a running server of any of them is this build's. */
export function serverVersionsOf(manifest: ServerManifest): ReadonlySet<string> {
  return new Set(Object.values(manifest.packages).map((pkg) => pkg.serverVersion));
}

/** The app version a server version names: the part before its `+<build>`, or all of a version without one. */
export function appVersionOf(serverVersion: string): string {
  const plus = serverVersion.indexOf('+');
  return plus === -1 ? serverVersion : serverVersion.slice(0, plus);
}
