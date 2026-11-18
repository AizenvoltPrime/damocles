import { MAX_RELEASE_VERSION_LENGTH } from '../preload/updates';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface Version {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

function parseVersion(version: string): Version | undefined {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split('.') ?? [] };
}

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_RELEASE_VERSION_LENGTH && parseVersion(value) !== undefined;
}

// SemVer 2.0.0 section 11 precedence: core numbers, then a release above its prereleases, then identifier by identifier.
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a[i]!, b[i]!];
    if (x === y) continue;
    const [xNumeric, yNumeric] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Negative when a precedes b, positive when it follows, 0 when equal; throws on a string that is not a version. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) throw new Error(`Not a version: ${JSON.stringify(x ? b : a)}`);
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  }
  return comparePrerelease(x.prerelease, y.prerelease);
}
