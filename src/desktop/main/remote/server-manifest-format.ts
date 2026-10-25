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
}

export interface ServerManifest {
  // an app version; the artifact cache names a folder after it
  readonly version: string;
  readonly protocolVersion: number;
  readonly packages: Readonly<Partial<Record<ServerTarget, ServerPackage>>>;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_FILE = /^damocles-server-[0-9A-Za-z.+-]+-[a-z0-9]+-[a-z0-9]+\.(?:zip|tar\.gz)$/;
const SHA256 = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parsePackage(value: unknown): ServerPackage | undefined {
  if (!isRecord(value)) return undefined;
  const { file, sha256, size } = value;
  if (typeof file !== 'string' || !PACKAGE_FILE.test(file)) return undefined;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return undefined;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return undefined;
  return { file, sha256, size };
}

/** The manifest in `value`, or undefined when any field is malformed or names an unknown target. */
export function parseServerManifest(value: unknown): ServerManifest | undefined {
  if (!isRecord(value) || !isRecord(value['packages'])) return undefined;
  const { version, protocolVersion } = value;
  if (typeof version !== 'string' || !VERSION.test(version) || typeof protocolVersion !== 'number' || !Number.isSafeInteger(protocolVersion)) return undefined;
  const packages: Partial<Record<ServerTarget, ServerPackage>> = {};
  for (const [target, entry] of Object.entries(value['packages'])) {
    const parsed = parsePackage(entry);
    if (!(SERVER_TARGETS as readonly string[]).includes(target) || !parsed) return undefined;
    packages[target as ServerTarget] = parsed;
  }
  return { version, protocolVersion, packages };
}
