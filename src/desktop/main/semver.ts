import { compareAppVersions, isAppVersion } from '../../shared/app-version';
import { MAX_RELEASE_VERSION_LENGTH } from '../preload/updates';

export function isVersion(value: unknown): value is string {
  return isAppVersion(value) && value.length <= MAX_RELEASE_VERSION_LENGTH;
}

/** Negative when a precedes b, positive when it follows, 0 when equal; throws on a string that is not a version. */
export function compareVersions(a: string, b: string): number {
  for (const version of [a, b]) if (!isVersion(version)) throw new Error(`Not a version: ${JSON.stringify(version)}`);
  return compareAppVersions(a, b);
}
